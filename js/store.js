// Shared state, settings and a tiny event bus that links the 4 bots together.

export const DEFAULTS = {
  sniper: {
    intervalSec: 60, minLiq: 10000, minVolH1: 3000, minMcap: 20000, maxMcap: 5000000,
    maxAgeH: 72, minBuySell: 1.0, minScore: 55, useGecko: true,
  },
  security: {
    maxTop10: 35, maxSingleHolder: 15, minLpLocked: 80, maxRiskScore: 50, minHolders: 100,
    maxRoundTrip: 10, testSol: 0.1, maxTransferFee: 0, maxInsiders: 30,
  },
  real: {
    rounds: 4, intervalSec: 45, maxLiqDrop: 15, minPriceChange: -8, maxPriceDev: 6,
    minBuySell: 1.05, minScore: 60,
  },
  paper: {
    startSol: 10, sizeSol: 0.5, maxPos: 5, tp: 50, sl: 20, trailAct: 20, trail: 12,
    maxHoldMin: 180, slippageBps: 300, feeSol: 0.0005, tickSec: 10, autoTrade: true,
  },
};

const KEY_SETTINGS = 'solbot.settings.v1';
const KEY_PAPER = 'solbot.paper.v1';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function mergeDefaults(saved) {
  const out = {};
  for (const [bot, defs] of Object.entries(DEFAULTS)) out[bot] = { ...defs, ...(saved?.[bot] || {}) };
  return out;
}

export const settings = mergeDefaults(load(KEY_SETTINGS, {}));
export const saveSettings = () => save(KEY_SETTINGS, settings);
export function resetSettings() {
  for (const [bot, defs] of Object.entries(DEFAULTS)) settings[bot] = { ...defs };
  saveSettings();
}

export function freshPaper() {
  return {
    balance: settings.paper.startSol, startSol: settings.paper.startSol,
    positions: [], history: [], solUsd: 0,
    equityHist: [{ t: Date.now(), v: settings.paper.startSol }],
  };
}
export const paper = Object.assign(freshPaper(), load(KEY_PAPER, {}));
export const savePaper = () => save(KEY_PAPER, paper);

/** Every token that enters the pipeline, keyed by mint. */
export const tokens = new Map();

export function upsertToken(mint, patch) {
  const t = tokens.get(mint) || { mint, foundAt: Date.now(), stage: 'found' };
  Object.assign(t, patch);
  tokens.set(mint, t);
  return t;
}

// ---------- event bus ----------
const handlers = {};
export function on(evt, fn) { (handlers[evt] ||= []).push(fn); }
export function emit(evt, data) { for (const fn of handlers[evt] || []) { try { fn(data); } catch (e) { console.error(e); } } }

// ---------- logging ----------
export function log(bot, msg, level = 'info') {
  emit('log', { bot, msg, level, ts: Date.now() });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
