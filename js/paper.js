import { Bot } from './bot.js';
import * as api from './api.js';
import { settings, paper, savePaper, freshPaper, upsertToken, log } from './store.js';

/**
 * Paper trader: simulates trades with fake SOL, but uses real Jupiter quotes
 * for fills (so price impact and token tax are included) and live
 * DexScreener prices for mark-to-market. No wallet, no real money.
 */
export class PaperBot extends Bot {
  constructor() {
    super('paper', 'Paper trader');
    this.signals = []; // confirmed tokens not (yet) traded
  }

  intervalMs() { return settings.paper.tickSec * 1000; }

  onConfirmed(t) {
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    this.signals = [t, ...this.signals.filter((x) => x.mint !== t.mint)].slice(0, 30);
    this.changed();
    if (this.running && settings.paper.autoTrade) this.buy(t).catch((e) => log(this.id, `Koop fout: ${e.message}`, 'err'));
  }

  async refreshSolPrice() {
    const p = await api.jupPrices([api.SOL_MINT]);
    const v = p[api.SOL_MINT]?.usdPrice;
    if (v) paper.solUsd = v;
  }

  async buy(t) {
    const s = settings.paper;
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    if (paper.positions.length >= s.maxPos) { log(this.id, `Max ${s.maxPos} posities bereikt, ${t.symbol} overgeslagen`, 'warn'); return; }
    if (paper.balance < s.sizeSol + s.feeSol) { log(this.id, `Onvoldoende paper saldo voor ${t.symbol}`, 'warn'); return; }
    if (!paper.solUsd) await this.refreshSolPrice();

    const lamports = Math.round(s.sizeSol * 1e9);
    const q = await api.jupQuote(api.SOL_MINT, t.mint, lamports, s.slippageBps);
    const decimals = t.decimals ?? 6;
    const ui = Number(q.outAmount) / 10 ** decimals;
    if (!ui) throw new Error('quote gaf 0 tokens');
    const cost = s.sizeSol + s.feeSol;
    paper.balance -= cost;
    const pos = {
      id: `${Date.now()}-${t.mint.slice(0, 4)}`, mint: t.mint, symbol: t.symbol, decimals,
      tokensRaw: q.outAmount, entrySol: cost, entryTs: Date.now(),
      entryPriceUsd: (s.sizeSol * paper.solUsd) / ui, entryLiq: t.pair?.liquidity?.usd || 0,
      priceImpact: Number(q.priceImpactPct || 0) * 100,
      lastPriceUsd: Number(t.pair?.priceUsd) || 0, lastValueSol: s.sizeSol, pnlPct: 0, peakPct: 0,
      rank: t.rank, url: t.pair?.url,
    };
    paper.positions.push(pos);
    this.signals = this.signals.filter((x) => x.mint !== t.mint);
    upsertToken(t.mint, { stage: 'traded' });
    this.recordEquity(true);
    savePaper();
    log(this.id, `🟢 PAPER BUY ${t.symbol}: ${s.sizeSol} SOL → ${fmtNum(ui)} tokens (impact ${pos.priceImpact.toFixed(2)}%)`, 'ok');
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
    await this.refreshSolPrice().catch(() => {});
    if (!paper.positions.length) { this.recordEquity(); savePaper(); return; }
    const pairs = api.bestPairs(await api.dsPairsForTokens(paper.positions.map((p) => p.mint)));

    for (const pos of [...paper.positions]) {
      const p = pairs.get(pos.mint);
      if (p && paper.solUsd) {
        pos.lastPriceUsd = Number(p.priceUsd) || pos.lastPriceUsd;
        const ui = Number(pos.tokensRaw) / 10 ** pos.decimals;
        pos.lastValueSol = (ui * pos.lastPriceUsd) / paper.solUsd;
        pos.pnlPct = (pos.lastValueSol / pos.entrySol - 1) * 100;
        pos.peakPct = Math.max(pos.peakPct, pos.pnlPct);
        pos.liq = p.liquidity?.usd || 0;
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

