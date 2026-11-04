// Automatisch leren: once an hour the bot checks whether its own measurements show a
// better setting, and applies it itself — with guardrails:
//   * only with enough data,
//   * the new setting must also win on a holdout (the newest 30% of coins, not used to pick it),
//   * each area changes at most once per cooldown (default 24h), sizing only in small steps,
//   * every change is logged (+ notification) and can be reverted with one click.
import { settings, saveSettings, paper, log, emit } from './store.js?v=20261104184641';
import { simulate, optimize, filterSearch, filterKeys, passesFilters } from './inzichten.js?v=20261104184641';
import { getModel } from './model.js?v=20261104184641';
import { WIN_PCT } from './metingen.js?v=20261104184641';

const KEY = 'solbot.learn.v1';
export const AREAS = {
  exits: '💰 Verkoopregels',
  filters: '🎯 Sniper-filters',
  model: '🧠 Geleerde score',
  sizing: '📏 Positiegrootte',
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export class AutoLearner {
  constructor(tracker) {
    this.tracker = tracker;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
    this.state = { changes: [], last: {}, blockedUntil: {}, status: {}, lastRun: 0, ...(saved || {}) };
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* ignore */ } }

  /** One learning round. `manual` ignores the cooldown (not the data and holdout checks). */
  run(manual = false) {
    const L = settings.learn;
    if (!L.auto && !manual) return this.state;
    const now = Date.now();
    for (const area of Object.keys(AREAS)) {
      const waitUntil = Math.max((this.state.last[area] || 0) + L.cooldownH * 3.6e6, this.state.blockedUntil[area] || 0);
      if (!manual && now < waitUntil) {
        this.state.status[area] = { at: now, msg: `wacht tot ${new Date(waitUntil).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (max. 1 aanpassing per ${L.cooldownH}u)` };
        continue;
      }
      let res;
      try { res = this[area](L); } catch (e) { res = { msg: `fout: ${e.message}` }; }
      this.state.status[area] = { at: now, msg: res.msg, ready: !!res.ready };
      if (res.change) this.apply(area, res.change);
    }
    this.state.lastRun = now;
    this.save();
    emit('learn:update', this.state);
    return this.state;
  }

  apply(area, { bot, patch, reason, evidence }) {
    const from = Object.fromEntries(Object.keys(patch).map((k) => [k, settings[bot][k]]));
    Object.assign(settings[bot], patch);
    saveSettings();
    const entry = { id: `${Date.now().toString(36)}${area}`, t: Date.now(), area, bot, from, to: patch, reason, evidence };
    this.state.changes.unshift(entry);
    this.state.changes = this.state.changes.slice(0, 50);
    this.state.last[area] = Date.now();
    log('app', `🧠 Automatisch geleerd · ${AREAS[area]}: ${reason} (${evidence})`, 'ok');
    emit('learn:change', entry);
  }

  revert(id) {
    const e = this.state.changes.find((c) => c.id === id);
    if (!e || e.reverted) throw new Error('wijziging niet gevonden of al teruggedraaid');
    Object.assign(settings[e.bot], e.from);
    saveSettings();
    e.reverted = Date.now();
    this.state.blockedUntil[e.area] = Date.now() + 3 * 864e5; // don't re-apply for 3 days
    this.save();
    log('app', `↩️ Teruggedraaid: ${AREAS[e.area]} (${e.reason}); 3 dagen geen nieuwe aanpassing hier`, 'warn');
    emit('learn:update', this.state);
  }

  // ---------- 1. exit rules: replay recorded price paths ----------
  exits(L) {
    const recs = this.tracker.list().filter((r) => r.path && r.path.length >= 10 && r.conf).sort((a, b) => a.conf.t - b.conf.t);
    if (recs.length < L.minPaths) return { msg: `verzamelt data: ${recs.length}/${L.minPaths} bevestigde coins met prijsverloop` };
    const cut = Math.floor(recs.length * 0.7);
    const train = recs.slice(0, cut).map((r) => r.path), test = recs.slice(cut).map((r) => r.path);
    const costs = paper.history.map((t) => t.entryCost).filter((x) => x != null);
    const cost = costs.length ? mean(costs) : 3;
    const s = settings.paper;
    const frac = (s.partialSell || 50) / 100;
    const cur = { tp: s.tp, sl: s.sl, trailAct: s.trailAct, trail: s.trail, partialTp: s.partialTp };
    const best = optimize(train, cost, frac).results[0].cfg;
    if (JSON.stringify(best) === JSON.stringify(cur)) return { ready: true, msg: 'huidige verkoopregels zijn al de beste' };
    const avg = (paths, cfg) => mean(paths.map((p) => simulate(p, cfg, cost, frac)));
    const gTrain = avg(train, best) - avg(train, cur);
    // per test coin: how much better would the new rules have done? Must be clearly > 0 (t >= 2.5), not luck.
    const d = test.map((p) => simulate(p, best, cost, frac) - simulate(p, cur, cost, frac));
    const gTest = mean(d);
    const sd = Math.sqrt(mean(d.map((x) => (x - gTest) ** 2))) || 1e-9;
    const t = gTest / (sd / Math.sqrt(d.length));
    if (gTest >= L.minExitGain && t >= 2.5 && gTrain > 0) {
      return {
        ready: true, msg: 'aangepast',
        change: {
          bot: 'paper', patch: best,
          reason: `TP +${best.tp}%, SL −${best.sl}%, trailing ${best.trailAct ? `${best.trail}% na +${best.trailAct}%` : 'uit'}, deelverkoop ${best.partialTp ? `+${best.partialTp}%` : 'uit'}`,
          evidence: `+${r1(gTest)}% per trade beter op ${test.length} nieuwe coins`,
        },
      };
    }
    return { ready: true, msg: `geen aanpassing: beste alternatief is ${gTest >= 0 ? '+' : ''}${r1(gTest)}% per trade op de testcoins (nodig: +${L.minExitGain}% en duidelijk, t ${r1(t)} van 2,5)` };
  }

  // ---------- 2. sniper thresholds: replay all measured coins ----------
  filters(L) {
    const measured = this.tracker.list().filter((r) => r.f && r.cp && r.cp[15] != null).sort((a, b) => a.t0 - b.t0);
    if (measured.length < L.minMeasured) return { msg: `verzamelt data: ${measured.length}/${L.minMeasured} gemeten coins` };
    const cut = Math.floor(measured.length * 0.7);
    const train = measured.slice(0, cut), test = measured.slice(cut);
    const evalOn = (set, c) => {
      const p = set.filter((r) => passesFilters(r, c));
      const win = p.length ? (p.filter((r) => r.max >= WIN_PCT).length / p.length) * 100 : 0;
      const rug = p.length ? (p.filter((r) => r.rug).length / p.length) * 100 : 0;
      return { n: p.length, edge: win - rug, win, rug };
    };
    const { results } = filterSearch(train);
    if (!results.length) return { ready: true, msg: 'geen combinatie laat genoeg coins door' };
    const cur = filterKeys(settings.sniper);
    const best = results[0];
    if (JSON.stringify(best.c) === JSON.stringify(cur)) return { ready: true, msg: 'huidige sniper-filters zijn al de beste' };
    const tb = evalOn(test, best.c), tc = evalOn(test, cur), trc = evalOn(train, cur);
    // must win in BOTH halves of the test coins, not just on average (protects against luck)
    const half = Math.floor(test.length / 2);
    const halves = [test.slice(0, half), test.slice(half)].map((h) => ({ b: evalOn(h, best.c), c: evalOn(h, cur) }));
    const bothHalves = halves.every(({ b, c }) => b.n >= 6 && b.edge - c.edge >= L.minEdgeGain);
    if (tb.n >= 8 && bothHalves && tb.edge - tc.edge >= L.minEdgeGain && best.edge > trc.edge) {
      return {
        ready: true, msg: 'aangepast',
        change: {
          bot: 'sniper', patch: best.c,
          reason: `score ≥ ${best.c.minScore} (jong ${best.c.youngMinScore}), liq ≥ $${best.c.minLiq}, vol ≥ $${best.c.minVolH1}, B/S ≥ ${best.c.minBuySell}`,
          evidence: `op ${test.length} nieuwe coins: ${Math.round(tb.win)}% winnaar / ${Math.round(tb.rug)}% rug, was ${Math.round(tc.win)}% / ${Math.round(tc.rug)}%`,
        },
      };
    }
    return { ready: true, msg: `geen aanpassing: beste alternatief ${tb.edge - tc.edge >= 0 ? '+' : ''}${Math.round(tb.edge - tc.edge)} punten voorsprong op testcoins (nodig: +${L.minEdgeGain} in beide helften)` };
  }

  // ---------- 3. learned score on/off ----------
  model(L) {
    const m = getModel();
    const s = settings.sniper;
    if (!m) return { msg: 'nog geen model (wacht op genoeg metingen)' };
    if (!s.useModel && m.auc != null && m.auc >= L.minAuc) {
      const minProb = Math.max(5, Math.round(m.baseRate * 100 * 0.8));
      return { ready: true, msg: 'aangezet', change: { bot: 'sniper', patch: { useModel: true, minProb }, reason: `geleerde score aan als filter, min. kans ${minProb}%`, evidence: `betrouwbaarheid AUC ${m.auc.toFixed(2)} op ${m.n} coins` } };
    }
    if (s.useModel && m.auc != null && m.auc < 0.55) {
      return { ready: true, msg: 'uitgezet', change: { bot: 'sniper', patch: { useModel: false }, reason: 'geleerde score uit als filter', evidence: `betrouwbaarheid gezakt naar AUC ${m.auc.toFixed(2)}` } };
    }
    return { ready: true, msg: s.useModel ? `in gebruik (AUC ${m.auc?.toFixed(2)})` : `nog niet betrouwbaar genoeg (AUC ${m.auc?.toFixed(2)}, nodig ${L.minAuc})` };
  }

  // ---------- 4. position size from the bot's own trades (small steps) ----------
  sizing(L) {
    const trades = paper.history.filter((t) => t.rank != null);
    if (trades.length < L.minTrades) return { msg: `verzamelt data: ${trades.length}/${L.minTrades} gesloten trades` };
    const s = settings.paper;
    const patch = {};
    const why = [];
    const hi = trades.filter((t) => t.rank >= 70).map((t) => t.pnlPct), lo = trades.filter((t) => t.rank < 60).map((t) => t.pnlPct);
    if (hi.length >= 5 && lo.length >= 5) {
      const diff = mean(hi) - mean(lo);
      const slope = s.sizeSlope ?? 1;
      const next = diff >= 10 ? Math.min(2, slope * 1.25) : diff <= -10 ? Math.max(0, slope * 0.75) : slope;
      if (r2(next) !== r2(slope)) { patch.sizeSlope = r2(next); why.push(`score-invloed ${r2(slope)} → ${r2(next)} (hoge scores ${diff >= 0 ? '+' : ''}${r1(diff)}% beter)`); }
    }
    const overall = mean(trades.map((t) => t.pnlPct));
    for (const [src, key] of [['lijst', 'multLijst'], ['launch', 'multLaunch'], ['migratie', 'multMigratie']]) {
      const ts = trades.filter((t) => (t.origin || 'lijst') === src).map((t) => t.pnlPct);
      if (ts.length < 8) continue;
      const d = mean(ts) - overall;
      const cur = s[key] ?? 1;
      const next = d >= 10 ? Math.min(1.5, cur * 1.2) : d <= -10 ? Math.max(0.3, cur * 0.8) : cur;
      if (r2(next) !== r2(cur)) { patch[key] = r2(next); why.push(`${src} ${r2(cur)}× → ${r2(next)}× (${d >= 0 ? '+' : ''}${r1(d)}% t.o.v. gemiddeld)`); }
    }
    if (!Object.keys(patch).length) return { ready: true, msg: 'geen duidelijk verschil tussen scores of bronnen' };
    return { ready: true, msg: 'aangepast', change: { bot: 'paper', patch, reason: why.join('; '), evidence: `${trades.length} eigen trades` } };
  }
}
