import { Bot } from './bot.js?v=20261103190516';
import * as api from './api.js?v=20261103190516';
import { devBalance } from './dev.js?v=20261103190516';
import { settings, paper, savePaper, freshPaper, upsertToken, emit, log, currentProfile } from './store.js?v=20261103190516';

/**
 * Paper trader: simulates trades with fake SOL, but uses real Jupiter quotes
 * for fills (so price impact and token tax are included). Open positions are
 * re-priced every few seconds via Jupiter (fast) and DexScreener (liquidity,
 * buy/sell pressure). No wallet, no real money.
 *
 * Entries: score-based size, pool-size cap, round-trip cost cap, wait for a dip
 * after a pump, risk rules (daily loss limit, losing-streak cooldown, no re-buys).
 * Exits: stop loss, break-even stop, partial take profit, full take profit,
 * trailing stop, sell pressure, dead coin, max hold time, rug alarm.
 */
const liqOf = (pair) => pair?.liquidity?.usd || (pair?.marketCap || pair?.fdv || 0) * 0.2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Groups a free-text exit reason into a stable category for the analysis. */
export function exitKind(reason = '') {
  const r = reason.toLowerCase();
  if (r.startsWith('take profit')) return 'Take profit';
  if (r.startsWith('stop loss')) return 'Stop loss';
  if (r.startsWith('break-even')) return 'Break-even stop';
  if (r.startsWith('trailing')) return 'Trailing stop';
  if (r.startsWith('verkoopdruk')) return 'Verkoopdruk';
  if (r.startsWith('dev verkoopt')) return 'Dev verkoopt';
  if (r.startsWith('dode coin')) return 'Dode coin';
  if (r.startsWith('max houdtijd')) return 'Max houdtijd';
  if (r.includes('rug')) return 'Rug alarm';
  if (r.startsWith('handmatig')) return 'Handmatig';
  return 'Overig';
}

export class PaperBot extends Bot {
  constructor() {
    super('paper', 'Paper trader');
    this.signals = [];          // confirmed tokens not (yet) traded
    this.waiting = new Map();   // mint -> { t, since, high, last } waiting for a dip after a pump
    this.solAt = 0;
    this.liqAt = 0;
    this.blockLogged = new Set();
  }

  intervalMs() { return Math.max(1, settings.paper.exitTickSec) * 1000; }

  onConfirmed(t) {
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    this.signals = [t, ...this.signals.filter((x) => x.mint !== t.mint)].slice(0, 30);
    this.changed();
    if (this.running && settings.paper.autoTrade) this.tryBuy(t).catch((e) => log(this.id, `Koop fout: ${e.message}`, 'err'));
  }

  async refreshSolPrice() {
    const p = await api.jupPrices([api.SOL_MINT]);
    const v = p[api.SOL_MINT]?.usdPrice;
    if (v) { paper.solUsd = v; this.solAt = Date.now(); }
  }

  // ---------- risk rules ----------
  /** Returns why new buys are blocked right now, or null. */
  riskBlock() {
    const s = settings.paper;
    const now = Date.now();
    if (s.dailyLossPct > 0) {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const today = paper.history.filter((t) => t.exitTs >= midnight.getTime()).reduce((a, t) => a + t.pnlSol, 0);
      if (today <= -(s.dailyLossPct / 100) * paper.startSol) return `daglimiet: vandaag ${today.toFixed(3)} SOL verlies (max −${s.dailyLossPct}%)`;
    }
    if (s.maxLossStreak > 0 && paper.history.length >= s.maxLossStreak) {
      const last = paper.history.slice(0, s.maxLossStreak);
      const until = last[0].exitTs + s.cooldownMin * 60000;
      if (last.every((t) => t.pnlSol < 0) && now < until) return `${s.maxLossStreak} verliezen op rij: pauze tot ${new Date(until).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
    }
    return null;
  }

  // ---------- entries ----------
  async tryBuy(t, fromWait = false) {
    const s = settings.paper;
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    if (s.noRebuy && paper.history.some((h) => h.mint === t.mint)) {
      log(this.id, `${t.symbol} overgeslagen: al eerder verhandeld (niet opnieuw kopen)`, 'warn');
      return;
    }
    const block = this.riskBlock();
    if (block) {
      if (!this.blockLogged.has(block)) { this.blockLogged.add(block); log(this.id, `⏸ Kopen gepauzeerd: ${block}`, 'warn'); }
      return;
    }
    let pair = t.pair;
    try { pair = api.bestPairs(await api.dsPairsForTokens([t.mint])).get(t.mint) || pair; } catch { /* use last known */ }

    // Don't buy the top of a pump: wait for a pullback first.
    const ch5 = pair?.priceChange?.m5 ?? 0, ch1 = pair?.priceChange?.h1 ?? 0;
    if (!fromWait && s.dipWaitMin > 0 && (ch1 > s.maxPump1h || ch5 > s.maxPump5m)) {
      const px = Number(pair?.priceUsd) || 0;
      this.waiting.set(t.mint, { t, since: Date.now(), high: px, last: px });
      log(this.id, `⏳ ${t.symbol} pompt (5m ${ch5 >= 0 ? '+' : ''}${ch5}%, 1u ${ch1 >= 0 ? '+' : ''}${ch1}%): wacht op ${s.dipPct}% terugval`, 'warn');
      this.changed();
      return;
    }
    await this.buy({ ...t, pair });
  }

  /**
   * Simulates sending a transaction: it lands after latencyMs at the price of that moment,
   * can fail (failPct) and fails when the price moved more than the slippage tolerance.
   * Every attempt pays the network/priority fee, also failed ones.
   * Returns { q } on success or { failed: 'tx' | 'slip' }.
   */
  async land(quoteFn, decisionOut, ignoreSlip = false) {
    const s = settings.paper;
    if (s.latencyMs > 0) await sleep(s.latencyMs);
    const fails = (paper.fails ||= { tx: 0, slip: 0, feesSol: 0 });
    if (s.failPct > 0 && Math.random() * 100 < s.failPct) {
      paper.balance -= s.feeSol; fails.tx++; fails.feesSol += s.feeSol;
      return { failed: 'tx' };
    }
    const q = await quoteFn();
    if (!ignoreSlip && decisionOut && Number(q.outAmount) < Number(decisionOut) * (1 - s.slippageBps / 10000)) {
      paper.balance -= s.feeSol; fails.slip++; fails.feesSol += s.feeSol;
      return { failed: 'slip', moved: (1 - Number(q.outAmount) / Number(decisionOut)) * 100 };
    }
    return { q };
  }

  async buy(t) {
    const s = settings.paper;
    if (paper.positions.some((p) => p.mint === t.mint)) return;
    if (paper.positions.length >= s.maxPos) { log(this.id, `Max ${s.maxPos} posities bereikt, ${t.symbol} overgeslagen`, 'warn'); return; }
    if (!paper.solUsd) await this.refreshSolPrice();

    // Size: base size scaled by total score (50 → 0.5×, 70 → 1×, 90 → 1.5×) and capped by pool size.
    let size = s.sizeSol;
    let factor = 1;
    if (s.scoreSizing && t.rank != null) factor = clamp(0.5 + (t.rank - 50) / 40, 0.3, 1.5);
    size *= factor;
    const liqUsd = liqOf(t.pair);
    if (liqUsd && paper.solUsd) size = Math.min(size, (liqUsd * s.maxLiqPct / 100) / paper.solUsd);
    size = Math.min(size, paper.balance - s.feeSol);
    size = Math.floor(size * 1000) / 1000;
    if (size < s.minSizeSol) { log(this.id, `${t.symbol} overgeslagen: positie te klein (${size} SOL; pool of saldo te klein)`, 'warn'); return; }

    const lamports = Math.round(size * 1e9);
    const q = await api.jupQuote(api.SOL_MINT, t.mint, lamports, s.slippageBps);
    // Cost check: what would we get back if we sold right away? (tax + price impact + spread)
    let rt = null;
    try {
      const back = await api.jupQuote(t.mint, api.SOL_MINT, q.outAmount, s.slippageBps);
      // Can come out slightly negative (price moved between quotes / better sell route): count that as 0.
      rt = Math.max(0, (1 - Number(back.outAmount) / lamports) * 100);
    } catch (e) { if (!api.isTransient(e)) { log(this.id, `${t.symbol} overgeslagen: geen verkoop-route`, 'err'); return; } }
    if (rt != null && s.maxTradeCost > 0 && rt > s.maxTradeCost) {
      log(this.id, `${t.symbol} overgeslagen: te duur (direct verkopen kost ${rt.toFixed(1)}%, max ${s.maxTradeCost}%)`, 'warn');
      return;
    }
    // Send the "transaction": latency, possible failure, slippage check against the decision quote.
    const res = await this.land(() => api.jupQuote(api.SOL_MINT, t.mint, lamports, s.slippageBps), q.outAmount);
    if (res.failed) {
      log(this.id, `❌ Koop ${t.symbol} mislukt: ${res.failed === 'tx' ? 'transactie mislukt' : `prijs liep ${res.moved.toFixed(1)}% weg (slippage ${s.slippageBps / 100}%)`} · fee ${s.feeSol} SOL betaald`, 'err');
      savePaper(); this.changed();
      return;
    }
    const fill = res.q;
    const decimals = t.decimals ?? 6;
    const ui = Number(fill.outAmount) / 10 ** decimals;
    if (!ui) throw new Error('quote gaf 0 tokens');
    const cost = size + s.feeSol;
    paper.balance -= cost;
    const pos = {
      id: `${Date.now()}-${t.mint.slice(0, 4)}`, mint: t.mint, symbol: t.symbol, decimals,
      tokensRaw: fill.outAmount, entrySol: cost, entryTs: Date.now(),
      entryPriceUsd: (size * paper.solUsd) / ui, entryLiq: liqUsd, dex: t.pair?.dexId, origin: t.origin,
      priceImpact: Number(fill.priceImpactPct || 0) * 100, entryCost: rt, sizeFactor: factor,
      dev: t.dev, devStart: t.devAtCheck?.bal, devHoldPct: t.devAtCheck?.holdPct, devNow: t.devAtCheck?.bal, devAt: Date.now(),
      lastPriceUsd: Number(t.pair?.priceUsd) || 0, lastValueSol: size, pnlPct: 0, peakPct: 0,
      realizedSol: 0, partialDone: false, rank: t.rank, url: t.pair?.url, profile: currentProfile() || 'aangepast',
    };
    paper.positions.push(pos);
    this.signals = this.signals.filter((x) => x.mint !== t.mint);
    this.waiting.delete(t.mint);
    upsertToken(t.mint, { stage: 'traded' });
    this.recordEquity(true);
    savePaper();
    emit('paper:buy', pos);
    log(this.id, `🟢 PAPER BUY ${t.symbol}: ${size} SOL${factor !== 1 ? ` (${factor.toFixed(2)}× door score ${t.rank})` : ''} → ${fmtNum(ui)} tokens · kosten ${rt == null ? '?' : rt.toFixed(1) + '%'}`, 'ok');
    this.changed();
  }

  // ---------- exits ----------
  /** Sells `fraction` (0-1] of the position. Returns true when something was sold. */
  async sell(pos, reason, fraction = 1) {
    const s = settings.paper;
    const partial = fraction < 1;
    const amountRaw = partial ? String((BigInt(pos.tokensRaw) * BigInt(Math.round(fraction * 1000))) / 1000n) : pos.tokensRaw;
    let outSol;
    try {
      const q = await api.jupQuote(pos.mint, api.SOL_MINT, amountRaw, s.slippageBps);
      // After 2 failed attempts a real bot raises its slippage: then accept any fill.
      const res = await this.land(() => api.jupQuote(pos.mint, api.SOL_MINT, amountRaw, s.slippageBps), q.outAmount, (pos.sellFails || 0) >= 2);
      if (res.failed) {
        pos.sellFails = (pos.sellFails || 0) + 1;
        log(this.id, `❌ Verkoop ${pos.symbol} mislukt (${res.failed === 'tx' ? 'transactie mislukt' : `prijs liep ${res.moved.toFixed(1)}% weg`}), volgende tick opnieuw · fee betaald`, 'warn');
        savePaper();
        return false;
      }
      pos.sellFails = 0;
      outSol = Number(res.q.outAmount) / 1e9;
    } catch (e) {
      if (api.isTransient(e) || partial) { log(this.id, `Verkoop ${pos.symbol} uitgesteld (${e.message})`, 'warn'); return false; }
      // No sell route = would be stuck in real life. Book it at value minus a heavy haircut.
      outSol = pos.lastValueSol * 0.5;
      reason += ` (geen verkoop-route: ${e.message})`;
    }
    outSol = Math.max(0, outSol - s.feeSol);
    paper.balance += outSol;

    if (partial) {
      pos.tokensRaw = String(BigInt(pos.tokensRaw) - BigInt(amountRaw));
      pos.realizedSol += outSol;
      pos.partialDone = true;
      pos.lastValueSol *= 1 - fraction;
      this.recordEquity(true);
      savePaper();
      emit('paper:partial', { ...pos, soldSol: outSol });
      log(this.id, `🟡 DEELVERKOOP ${Math.round(fraction * 100)}% ${pos.symbol} bij ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}% → ${outSol.toFixed(4)} SOL veiliggesteld`, 'ok');
      this.changed();
      return true;
    }

    paper.positions = paper.positions.filter((p) => p.id !== pos.id);
    const total = pos.realizedSol + outSol;
    const pnlSol = total - pos.entrySol;
    const trade = {
      ...pos, exitTs: Date.now(), exitSol: total, pnlSol, pnlPct: (pnlSol / pos.entrySol) * 100, reason, exitKind: exitKind(reason),
    };
    paper.history.unshift(trade);
    paper.history = paper.history.slice(0, 500);
    this.recordEquity(true);
    savePaper();
    emit('paper:sell', trade);
    log(this.id, `${pnlSol >= 0 ? '💰' : '🔻'} PAPER SELL ${pos.symbol}: ${reason} · ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${trade.pnlPct.toFixed(1)}%)`, pnlSol >= 0 ? 'ok' : 'err');
    this.changed();
    return true;
  }

  /** Decides what to do with an open position. Returns [reason, fraction] or null. */
  exitDecision(pos) {
    const s = settings.paper;
    const pnl = pos.pnlPct, peak = pos.peakPct;
    const ageMin = (Date.now() - pos.entryTs) / 60000;
    if (pnl <= -s.sl) return [`Stop loss -${s.sl}%`, 1];
    if (s.devExitPct > 0 && pos.devStart > 0 && (pos.devHoldPct ?? 0) >= 0.5 && pos.devNow != null
      && pos.devNow < pos.devStart * (1 - s.devExitPct / 100)) {
      return [`Dev verkoopt (${((1 - pos.devNow / pos.devStart) * 100).toFixed(0)}% van zijn bag)`, 1];
    }
    if (s.beAct > 0 && peak >= s.beAct && pnl <= 1) return [`Break-even stop (piek +${peak.toFixed(1)}%)`, 1];
    if (s.partialTp > 0 && !pos.partialDone && pnl >= s.partialTp && s.partialSell > 0 && s.partialSell < 100) {
      return [`Deelverkoop +${s.partialTp}%`, s.partialSell / 100];
    }
    if (pnl >= s.tp) return [`Take profit +${s.tp}%`, 1];
    if (peak >= s.trailAct && pnl <= peak - s.trail) return [`Trailing stop (piek +${peak.toFixed(1)}%)`, 1];
    const m5 = pos.m5;
    if (s.sellPressure > 0 && m5 && ageMin >= 2 && m5.sells >= 10 && m5.sells >= m5.buys * s.sellPressure) {
      return [`Verkoopdruk (${m5.sells} sells / ${m5.buys} buys in 5m)`, 1];
    }
    if (s.staleMin > 0 && ageMin >= s.staleMin && peak < s.staleBand && Math.abs(pnl) < s.staleBand) {
      return [`Dode coin (na ${s.staleMin} min tussen ±${s.staleBand}%)`, 1];
    }
    if (ageMin >= s.maxHoldMin) return [`Max houdtijd ${s.maxHoldMin} min`, 1];
    if (pos.entryLiq && pos.liq && pos.liq < pos.entryLiq * 0.5) return ['Liquiditeit -50% (rug alarm)', 1];
    return null;
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
    const waitMints = [...this.waiting.keys()];
    // SOL price from Jupiter every 30s; coin prices, liquidity and 5m buy/sell counts from
    // DexScreener every tick (its rate limit is 5× higher, which leaves Jupiter free for quotes).
    if (now - this.solAt > 30000) await this.refreshSolPrice().catch(() => {});
    let pairs = new Map();
    if (mints.length || waitMints.length) {
      try { pairs = api.bestPairs(await api.dsPairsForTokens([...mints, ...waitMints])); } catch { /* next tick */ }
    }
    const prices = Object.fromEntries([...pairs].map(([m, p]) => [m, { usdPrice: Number(p.priceUsd) || 0 }]));

    await this.checkWaiting(prices);
    if (!mints.length) { this.recordEquity(); savePaper(); return; }

    // Dev wallets of open positions: checked every 30s (exit when the dev dumps).
    for (const pos of paper.positions) {
      if (pos.dev && pos.devStart > 0 && now - (pos.devAt || 0) >= 30000) {
        pos.devAt = now;
        const bal = await devBalance(pos.dev, pos.mint, 25000);
        if (bal != null) pos.devNow = bal;
      }
    }

    for (const pos of [...paper.positions]) {
      const p = pairs.get(pos.mint);
      const px = prices[pos.mint]?.usdPrice || 0;
      if (p) { pos.liq = liqOf(p); pos.m5 = { buys: p.txns?.m5?.buys || 0, sells: p.txns?.m5?.sells || 0 }; }
      if (px && paper.solUsd) {
        pos.lastPriceUsd = px;
        const ui = Number(pos.tokensRaw) / 10 ** pos.decimals;
        pos.lastValueSol = (ui * pos.lastPriceUsd) / paper.solUsd;
        pos.pnlPct = ((pos.realizedSol + pos.lastValueSol) / pos.entrySol - 1) * 100;
        pos.peakPct = Math.max(pos.peakPct, pos.pnlPct);
      }
      const d = this.exitDecision(pos);
      if (d) await this.sell(pos, d[0], d[1]);
    }
    this.recordEquity();
    savePaper();
    this.changed();
  }

  /** Buys coins from the dip-wait list once they pulled back and stopped falling. */
  async checkWaiting(prices) {
    const s = settings.paper;
    for (const [mint, w] of [...this.waiting]) {
      const px = prices[mint]?.usdPrice;
      if (Date.now() - w.since > s.dipWaitMin * 60000) {
        this.waiting.delete(mint);
        log(this.id, `${w.t.symbol}: geen terugval binnen ${s.dipWaitMin} min, overgeslagen`, 'warn');
        continue;
      }
      if (!px) continue;
      w.high = Math.max(w.high || px, px);
      const pulledBack = px <= w.high * (1 - s.dipPct / 100);
      const bouncing = w.last && px >= w.last; // stopped falling
      w.last = px;
      if (pulledBack && bouncing) {
        this.waiting.delete(mint);
        log(this.id, `📉 ${w.t.symbol} is ${((1 - px / w.high) * 100).toFixed(0)}% teruggevallen en stabiliseert: kopen`, 'ok');
        await this.tryBuy(w.t, true).catch((e) => log(this.id, `Koop fout: ${e.message}`, 'err'));
      }
    }
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
      paused: this.riskBlock(),
    };
  }

  reset() {
    Object.assign(paper, freshPaper());
    this.waiting.clear();
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
