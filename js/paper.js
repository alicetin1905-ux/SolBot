import { Bot } from './bot.js?v=20261102182229';
import * as api from './api.js?v=20261102182229';
import { settings, paper, savePaper, freshPaper, upsertToken, emit, log } from './store.js?v=20261102182229';

/**
 * Paper trader: simulates trades with fake SOL, but uses real Jupiter quotes
 * for fills (so price impact and token tax are included). Open positions are
 * re-priced every few seconds via Jupiter (fast) and DexScreener (liquidity).
 * No wallet, no real money.
 */
const liqOf = (pair) => pair?.liquidity?.usd || (pair?.marketCap || pair?.fdv || 0) * 0.2;

export class PaperBot extends Bot {
  constructor() {
    super('paper', 'Paper trader');
    this.signals = []; // confirmed tokens not (yet) traded
    this.solAt = 0;
    this.liqAt = 0;
  }

  intervalMs() { return Math.max(1, settings.paper.exitTickSec) * 1000; }

  onConfirmed(t) {
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    this.signals = [t, ...this.signals.filter((x) => x.mint !== t.mint)].slice(0, 30);
    this.changed();
    if (this.running && settings.paper.autoTrade) this.buy(t).catch((e) => log(this.id, `Koop fout: ${e.message}`, 'err'));
  }

  async refreshSolPrice() {
    const p = await api.jupPrices([api.SOL_MINT]);
    const v = p[api.SOL_MINT]?.usdPrice;
    if (v) { paper.solUsd = v; this.solAt = Date.now(); }
  }

  async buy(t) {
    const s = settings.paper;
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    if (paper.positions.length >= s.maxPos) { log(this.id, `Max ${s.maxPos} posities bereikt, ${t.symbol} overgeslagen`, 'warn'); return; }
    if (paper.balance < s.sizeSol + s.feeSol) { log(this.id, `Onvoldoende paper saldo voor ${t.symbol}`, 'warn'); return; }
    if (!paper.solUsd) await this.refreshSolPrice();

    // Never take more than maxLiqPct of the pool: big orders in thin pools are unsellable.
    const liqUsd = liqOf(t.pair);
    let size = s.sizeSol;
    if (liqUsd && paper.solUsd) size = Math.min(size, (liqUsd * s.maxLiqPct / 100) / paper.solUsd);
    size = Math.floor(size * 1000) / 1000;
    if (size < s.minSizeSol) { log(this.id, `${t.symbol} overgeslagen: pool te klein (max ${s.maxLiqPct}% = ${size} SOL)`, 'warn'); return; }

    const lamports = Math.round(size * 1e9);
    const q = await api.jupQuote(api.SOL_MINT, t.mint, lamports, s.slippageBps);
    const decimals = t.decimals ?? 6;
    const ui = Number(q.outAmount) / 10 ** decimals;
    if (!ui) throw new Error('quote gaf 0 tokens');
    const cost = size + s.feeSol;
    paper.balance -= cost;
    const pos = {
      id: `${Date.now()}-${t.mint.slice(0, 4)}`, mint: t.mint, symbol: t.symbol, decimals,
      tokensRaw: q.outAmount, entrySol: cost, entryTs: Date.now(),
      entryPriceUsd: (size * paper.solUsd) / ui, entryLiq: liqUsd, dex: t.pair?.dexId, origin: t.origin,
      priceImpact: Number(q.priceImpactPct || 0) * 100,
      lastPriceUsd: Number(t.pair?.priceUsd) || 0, lastValueSol: size, pnlPct: 0, peakPct: 0,
      rank: t.rank, url: t.pair?.url,
    };
    paper.positions.push(pos);
    this.signals = this.signals.filter((x) => x.mint !== t.mint);
    upsertToken(t.mint, { stage: 'traded' });
    this.recordEquity(true);
    savePaper();
    emit('paper:buy', pos);
    log(this.id, `🟢 PAPER BUY ${t.symbol}: ${size} SOL → ${fmtNum(ui)} tokens (impact ${pos.priceImpact.toFixed(2)}%)`, 'ok');
    this.changed();
  }

  async sell(pos, reason) {
    const s = settings.paper;
    let outSol;
    try {
      const q = await api.jupQuote(pos.mint, api.SOL_MINT, pos.tokensRaw, s.slippageBps);
      outSol = Number(q.outAmount) / 1e9;
    } catch (e) {
      if (api.isTransient(e)) { log(this.id, `Verkoop ${pos.symbol} uitgesteld (${e.message}), volgende tick opnieuw`, 'warn'); return; }
      // No sell route = would be stuck in real life. Book it at value minus a heavy haircut.
      outSol = pos.lastValueSol * 0.5;
      reason += ` (geen verkoop-route: ${e.message})`;
    }
    outSol = Math.max(0, outSol - s.feeSol);
    paper.balance += outSol;
    paper.positions = paper.positions.filter((p) => p.id !== pos.id);
    const pnlSol = outSol - pos.entrySol;
    const trade = {
      ...pos, exitTs: Date.now(), exitSol: outSol, pnlSol, pnlPct: (pnlSol / pos.entrySol) * 100, reason,
    };
    paper.history.unshift(trade);
    paper.history = paper.history.slice(0, 300);
    this.recordEquity(true);
    savePaper();
    emit('paper:sell', trade);
    log(this.id, `${pnlSol >= 0 ? '💰' : '🔻'} PAPER SELL ${pos.symbol}: ${reason} · ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${trade.pnlPct.toFixed(1)}%)`, pnlSol >= 0 ? 'ok' : 'err');
    this.changed();
  }

  /** Stores an equity point for the chart (at most one per 30s unless forced). */
  recordEquity(force = false) {
    const h = paper.equityHist;
    const v = this.stats().equity;
    const last = h[h.length - 1];
    if (!force && last && Date.now() - last.t < 30000 && Math.abs(last.v - v) < 1e-6) return;
    if (!force && last && Date.now() - last.t < 30000) { last.v = v; return; }
    h.push({ t: Date.now(), v });
    if (h.length > 1500) h.splice(0, h.length - 1500);
  }

  async tick() {
    const s = settings.paper;
    const now = Date.now();
    const mints = paper.positions.map((p) => p.mint);
    // One Jupiter call gives fresh prices for SOL + all open positions.
    const wantSol = now - this.solAt > 30000;
    let prices = {};
    if (mints.length || wantSol) {
      try {
        prices = await api.jupPrices(wantSol ? [api.SOL_MINT, ...mints] : mints);
        if (prices[api.SOL_MINT]?.usdPrice) { paper.solUsd = prices[api.SOL_MINT].usdPrice; this.solAt = now; }
      } catch { /* fall back to DexScreener below */ }
    }
    if (!mints.length) { this.recordEquity(); savePaper(); return; }

    // DexScreener for liquidity (rug alarm) every ~15s, or when Jupiter has no price.
    let pairs = new Map();
    if (now - this.liqAt > 15000 || mints.some((m) => !prices[m]?.usdPrice)) {
      pairs = api.bestPairs(await api.dsPairsForTokens(mints));
      this.liqAt = now;
    }

    for (const pos of [...paper.positions]) {
      const p = pairs.get(pos.mint);
      const px = prices[pos.mint]?.usdPrice || Number(p?.priceUsd) || 0;
      if (p) pos.liq = liqOf(p);
      if (px && paper.solUsd) {
        pos.lastPriceUsd = px;
        const ui = Number(pos.tokensRaw) / 10 ** pos.decimals;
        pos.lastValueSol = (ui * pos.lastPriceUsd) / paper.solUsd;
        pos.pnlPct = (pos.lastValueSol / pos.entrySol - 1) * 100;
        pos.peakPct = Math.max(pos.peakPct, pos.pnlPct);
      }
      const ageMin = (Date.now() - pos.entryTs) / 60000;
      let reason = null;
      if (pos.pnlPct >= s.tp) reason = `Take profit +${s.tp}%`;
      else if (pos.pnlPct <= -s.sl) reason = `Stop loss -${s.sl}%`;
      else if (pos.peakPct >= s.trailAct && pos.pnlPct <= pos.peakPct - s.trail) reason = `Trailing stop (piek +${pos.peakPct.toFixed(1)}%)`;
      else if (ageMin >= s.maxHoldMin) reason = `Max houdtijd ${s.maxHoldMin} min`;
      else if (pos.entryLiq && pos.liq && pos.liq < pos.entryLiq * 0.5) reason = 'Liquiditeit -50% (rug alarm)';
      if (reason) await this.sell(pos, reason);
    }
    this.recordEquity();
    savePaper();
    this.changed();
  }

  stats() {
    const open = paper.positions.reduce((a, p) => a + p.lastValueSol, 0);
    const equity = paper.balance + open;
    const realized = paper.history.reduce((a, t) => a + t.pnlSol, 0);
    const wins = paper.history.filter((t) => t.pnlSol > 0).length;
    return {
      balance: paper.balance, equity, open, realized,
      totalPct: (equity / paper.startSol - 1) * 100,
      trades: paper.history.length,
      winRate: paper.history.length ? (wins / paper.history.length) * 100 : 0,
      solUsd: paper.solUsd,
    };
  }

  reset() {
    Object.assign(paper, freshPaper());
    savePaper();
    log(this.id, `Paper account gereset naar ${paper.startSol} SOL`, 'warn');
    this.changed();
  }
}

function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

