// State sync between the Mac server (runs the bots) and dashboards (view + send commands).
// "state" is small and polled every few seconds; "slow" holds the big parts (trade history,
// equity curve, tracker measurements, model) and is only sent when something changed.
import { settings, paper, tokens, on } from './store.js?v=20261103192235';
import { getModel, setModel } from './model.js?v=20261103192235';

export const SYNC_EVENTS = ['log', 'candidate', 'sniper:results', 'sniper:launch', 'security:done', 'real:done', 'paper:buy', 'paper:sell', 'paper:partial'];
const BOT_IDS = ['sniper', 'security', 'real', 'paper'];

const slimPair = (p) => p && {
  dexId: p.dexId, url: p.url, priceUsd: p.priceUsd, pairCreatedAt: p.pairCreatedAt,
  liquidity: { usd: p.liquidity?.usd || 0 }, marketCap: p.marketCap, fdv: p.fdv,
  volume: { h24: p.volume?.h24, h1: p.volume?.h1, m5: p.volume?.m5 },
  priceChange: { m5: p.priceChange?.m5, h1: p.priceChange?.h1 }, txns: { m5: p.txns?.m5, h1: p.txns?.h1 },
  baseToken: p.baseToken && { address: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name },
};
const slimToken = (t) => t && { ...t, pair: slimPair(t.pair) };
const slim = (data) => (Array.isArray(data) ? data : data && typeof data === 'object' && data.mint && data.pair ? slimToken(data) : data);

// ---------- server side ----------
/** Keeps the last events (logs + pipeline events) with a sequence number. */
export function createEventLog(max = 600) {
  const events = [];
  let seq = 0;
  for (const evt of SYNC_EVENTS) on(evt, (data) => {
    events.push({ seq: ++seq, evt, data: slim(data) });
    if (events.length > max) events.splice(0, events.length - max);
  });
  return { since: (s) => events.filter((e) => e.seq > s).slice(-300), get seq() { return seq; } };
}

/** Small, fast string hash (FNV-1a) used to skip sections the client already has. */
const hash = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};
const slimResult = ({ name, url, ...r }) => r;

const trackerKey = (tracker) => {
  let n = 0, t = 0, p = 0, c = 0;
  for (const r of Object.values(tracker.records)) { n++; t = Math.max(t, r.t0); p += r.path?.length || 0; c += Object.keys(r.cp || {}).length; }
  return `${n}:${t}:${p}:${c}`;
};

export function buildState(eng, eventLog, since = 0, have = {}) {
  const { sniper, security, real, trader, bots } = eng;
  // Big sections are only sent when they changed since the client's last copy.
  const sections = {
    settings,
    results: sniper.results.slice(0, 80).map(slimResult),
    checked: security.checked.slice(0, 30).map(slimToken),
    done: real.done.slice(0, 24).map(slimToken),
    watch: real.watch,
    signals: trader.signals.slice(0, 20).map(slimToken),
    positions: paper.positions,
  };
  const hashes = {};
  const send = {};
  for (const [k, v] of Object.entries(sections)) {
    hashes[k] = hash(JSON.stringify(v));
    if (have[k] !== hashes[k]) send[k] = v;
  }
  return {
    hashes,
    t: Date.now(),
    seq: eventLog.seq,
    events: eventLog.since(since),
    running: Object.fromEntries(BOT_IDS.map((k) => [k, { running: bots[k].running, busy: bots[k].busy, lastRun: bots[k].lastRun }])),
    ...send,
    sniper: { scans: sniper.scans, live: sniper.live, sources: sniper.sources, launches: sniper.launches.size },
    security: { queue: security.queue.map((t) => ({ mint: t.mint, symbol: t.symbol, sniperScore: t.sniperScore, manual: t.manual })), stats: security.stats, active: security.active },
    trader: { waiting: [...trader.waiting].map(([m, w]) => [m, { ...w, t: slimToken(w.t) }]) },
    paper: { balance: paper.balance, startSol: paper.startSol, solUsd: paper.solUsd, fails: paper.fails },
    keys: { hist: `${paper.history.length}:${paper.history[0]?.exitTs || 0}`, eq: `${paper.equityHist.length}:${paper.equityHist.at(-1)?.t}`, model: getModel()?.trainedAt || 0 },
  };
}

/** Big parts, only those whose key differs from what the client already has. */
export function buildSlow(eng, have = {}) {
  const out = { keys: {} };
  const hist = `${paper.history.length}:${paper.history[0]?.exitTs || 0}`;
  const eq = `${paper.equityHist.length}:${paper.equityHist.at(-1)?.t}`;
  const tr = trackerKey(eng.tracker);
  const model = String(getModel()?.trainedAt || 0);
  if (have.hist !== hist) out.history = paper.history;
  if (have.eq !== eq) out.equityHist = paper.equityHist;
  if (have.tr !== tr) out.tracker = eng.tracker.records;
  if (have.model !== model) out.model = getModel();
  out.keys = { hist, eq, tr, model };
  return out;
}

// ---------- client side ----------
export function applyState(eng, s) {
  const { sniper, security, real, trader, bots } = eng;
  for (const k of BOT_IDS) Object.assign(bots[k], s.running[k]);
  // sections are missing when unchanged: keep what we have
  if (s.settings) for (const k of Object.keys(s.settings)) Object.assign(settings[k], s.settings[k]);
  if (s.results) sniper.results = s.results;
  if (s.checked) security.checked = s.checked;
  if (s.done) real.done = s.done;
  if (s.watch) real.watch = s.watch;
  if (s.signals) trader.signals = s.signals;
  if (s.positions) paper.positions = s.positions;
  Object.assign(sniper, { scans: s.sniper.scans, live: s.sniper.live, sources: s.sniper.sources, launches: { size: s.sniper.launches } });
  Object.assign(security, { queue: s.security.queue, stats: s.security.stats, active: s.security.active });
  trader.waiting = new Map(s.trader.waiting);
  Object.assign(paper, s.paper);
  // token details for the detail dialog, rebuilt from what we have (no extra data to send)
  tokens.clear();
  for (const t of [...security.checked, ...real.done, ...trader.signals, ...[...trader.waiting.values()].map((w) => w.t)]) {
    if (t?.mint) tokens.set(t.mint, { ...tokens.get(t.mint), ...t });
  }
}

export function applySlow(eng, s) {
  if (s.history) paper.history = s.history;
  if (s.equityHist) paper.equityHist = s.equityHist;
  if (s.tracker) eng.tracker.records = s.tracker;
  if (s.model) setModel(s.model);
}
