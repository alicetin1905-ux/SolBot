// Outcome tracker: follows every coin the sniper looked at (also the rejected
// ones) and stores what its price did after 5m … 6h. This tells you whether the
// filters keep the winners and block the rugs.
import { Bot } from './bot.js?v=20261102182229';
import * as api from './api.js?v=20261102182229';
import { on } from './store.js?v=20261102182229';

export const CHECKPOINTS = [5, 15, 30, 60, 120, 240, 360]; // minutes
export const WIN_PCT = 50;   // "winner" = ever >= +50% after first seen
export const RUG_PCT = -80;  // "rug" = price <= -80% or liquidity -80%
const KEY = 'solbot.tracker.v1';
const MAX = 1500;

export const STAGES = {
  filtered: 'Gefilterd (sniper)',
  pending: 'In behandeling',
  'security-fail': 'Afgekeurd (security)',
  'real-fail': 'Afgewezen (real check)',
  confirmed: 'Bevestigd',
  traded: 'Gekocht (paper)',
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export class TrackerBot extends Bot {
  constructor() {
    super('tracker', 'Uitkomst tracker');
    this.records = load(); // mint -> record
    this.dirty = false;
    on('sniper:results', (batch) => batch.forEach((r) => this.add(r)));
    on('candidate', (t) => this.set(t.mint, { stage: 'pending' }));
    on('security:done', (t) => {
      const fails = (t.security?.checks || []).filter((c) => c.status === 'fail').map((c) => c.name);
      if (t.stage === 'rejected' && fails.length) this.set(t.mint, { stage: 'security-fail', fails, sec: t.security?.score });
      else this.set(t.mint, { sec: t.security?.score });
    });
    on('real:done', (t) => this.set(t.mint, {
      stage: t.stage === 'rejected' ? 'real-fail' : 'confirmed', real: t.real?.score, rank: t.rank,
      reason: t.stage === 'rejected' ? t.rejectReason : undefined,
    }));
    on('paper:buy', (p) => this.set(p.mint, { stage: 'traded' }));
  }

  intervalMs() { return 30000; }

  add(r) {
    if (this.records[r.mint] || !r.price) return;
    // Skip dust launches that never got going; keep everything from the lists.
    if (r.origin !== 'lijst' && r.mcap < 5000) return;
    this.records[r.mint] = {
      mint: r.mint, sym: r.symbol, dex: r.dex, origin: r.origin || 'lijst', t0: Date.now(),
      p0: r.price, liq0: r.liq, mc0: r.mcap, score: r.score,
      stage: r.pass ? 'pending' : 'filtered', reason: r.pass ? null : r.reason,
      cp: {}, max: 0, min: 0, rug: false, done: false,
    };
    this.dirty = true;
  }

  set(mint, patch) {
    const rec = this.records[mint];
    if (!rec) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) rec[k] = v;
    this.dirty = true;
  }

  async tick() {
    const now = Date.now();
    const due = Object.values(this.records).filter((r) => !r.done && CHECKPOINTS.some((c) => r.cp[c] === undefined && now >= r.t0 + c * 60000));
    if (due.length) {
      const pairs = api.bestPairs(await api.dsPairsForTokens(due.slice(0, 600).map((r) => r.mint)));
      for (const r of due.slice(0, 600)) {
        const p = pairs.get(r.mint);
        const ageMin = (now - r.t0) / 60000;
        const price = Number(p?.priceUsd) || 0;
        const chg = price && r.p0 ? (price / r.p0 - 1) * 100 : null;
        const liq = p ? (p.liquidity?.usd || (p.marketCap || 0) * 0.2) : null;
        for (const c of CHECKPOINTS) if (r.cp[c] === undefined && ageMin >= c) r.cp[c] = chg;
        if (chg !== null) {
          r.max = Math.max(r.max, chg);
          r.min = Math.min(r.min, chg);
          r.last = chg;
        }
        if (liq !== null) r.liqLast = liq;
        if ((chg !== null && chg <= RUG_PCT) || (r.liq0 > 0 && liq !== null && liq < r.liq0 * 0.2)) r.rug = true;
        if (CHECKPOINTS.every((c) => r.cp[c] !== undefined)) r.done = true;
      }
      this.dirty = true;
    }
    // Stop following very old records that somehow missed checkpoints.
    for (const r of Object.values(this.records)) if (!r.done && now - r.t0 > 7 * 3.6e6) { r.done = true; this.dirty = true; }
    this.prune();
    this.save();
  }

  prune() {
    const list = Object.values(this.records);
    if (list.length <= MAX) return;
    list.sort((a, b) => (a.done === b.done ? a.t0 - b.t0 : a.done ? -1 : 1));
    for (const r of list.slice(0, list.length - MAX)) delete this.records[r.mint];
  }

  save() {
    if (!this.dirty) return;
    try { localStorage.setItem(KEY, JSON.stringify(this.records)); } catch { /* full or blocked */ }
    this.dirty = false;
  }

  reset() {
    this.records = {};
    this.dirty = true;
    this.save();
    this.changed();
  }

  list() { return Object.values(this.records); }
}
