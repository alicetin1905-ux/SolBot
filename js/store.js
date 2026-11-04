// Shared state, settings and a tiny event bus that links the 4 bots together.

export const DEFAULTS = {
  sniper: {
    intervalSec: 60, minLiq: 10000, minVolH1: 3000, minMcap: 20000, maxMcap: 5000000,
    maxAgeH: 72, minBuySell: 1.0, minScore: 55, useGecko: true,
    useLaunches: true, useMigrations: true, launchMinAgeMin: 2, launchMaxAgeMin: 30, curveMinMcap: 12000,
    youngMinScore: 50, useModel: false, minProb: 10,
  },
  security: {
    maxTop10: 35, maxSingleHolder: 15, minLpLocked: 80, maxRiskScore: 50, minHolders: 100,
    maxRoundTrip: 10, testSol: 0.1, maxTransferFee: 0, maxInsiders: 30, minOrganic: 15, strictDanger: true,
    maxDevHold: 10, devSoldFail: 0, maxDevMints: 50, lpUnlockDays: 7,
  },
  real: {
    rounds: 4, intervalSec: 45, maxLiqDrop: 15, minPriceChange: -8, maxPriceDev: 6,
    minBuySell: 1.05, minScore: 60,
  },
  learn: {
    // Automatisch leren: apply what the measurements show, with guardrails
    auto: true, minPaths: 30, minMeasured: 150, minTrades: 20, minAuc: 0.6, cooldownH: 24, minExitGain: 3, minEdgeGain: 6,
  },
  paper: {
    startSol: 10, sizeSol: 0.5, maxPos: 5, tp: 100, sl: 20, trailAct: 20, trail: 12,
    maxHoldMin: 180, slippageBps: 1000, feeSol: 0.001, exitTickSec: 3, autoTrade: true,
    maxLiqPct: 2, minSizeSol: 0.05,
    // smarter exits
    partialTp: 25, partialSell: 50, beAct: 15, staleMin: 20, staleBand: 5, sellPressure: 2.5,
    // smarter entries
    scoreSizing: true, maxTradeCost: 6, maxPump5m: 50, maxPump1h: 300, dipPct: 15, dipWaitMin: 10,
    // risk rules
    dailyLossPct: 15, maxLossStreak: 3, cooldownMin: 30, noRebuy: true,
    // realism + dev
    latencyMs: 1500, failPct: 5, devExitPct: 25,
    // learned position sizing (changed by Automatisch leren)
    sizeSlope: 1, multLijst: 1, multLaunch: 1, multMigratie: 1,
  },
};

/**
 * One-click profiles. "Voorzichtig" equals the defaults; the others open the funnel
 * step by step (more coins, more risk). Only the keys listed here are changed.
 */
export const PROFILES = {
  voorzichtig: {
    label: '🛡️ Voorzichtig', desc: 'Strenge filters: weinig coins, minste risico',
    sniper: { minScore: 55, youngMinScore: 50, minLiq: 10000, minMcap: 20000, curveMinMcap: 12000, minVolH1: 3000, minBuySell: 1.0, launchMaxAgeMin: 30 },
    security: { minOrganic: 15, maxTop10: 35, maxSingleHolder: 15, maxInsiders: 30, strictDanger: true, maxRiskScore: 50, minLpLocked: 80, maxRoundTrip: 10, maxDevHold: 10, maxDevMints: 50 },
    real: { rounds: 4, intervalSec: 45, minScore: 60, maxLiqDrop: 15, minPriceChange: -8 },
    paper: { sizeSol: 0.5, maxPos: 5 },
  },
  normaal: {
    label: '⚖️ Normaal', desc: 'Ruimere filters voor jonge coins, sneller bevestigen',
    sniper: { minScore: 50, youngMinScore: 42, minLiq: 7000, minMcap: 15000, curveMinMcap: 9000, minVolH1: 1500, minBuySell: 1.0, launchMaxAgeMin: 60 },
    security: { minOrganic: 8, maxTop10: 40, maxSingleHolder: 18, maxInsiders: 40, strictDanger: false, maxRiskScore: 55, minLpLocked: 80, maxRoundTrip: 12, maxDevHold: 15, maxDevMints: 150 },
    real: { rounds: 3, intervalSec: 30, minScore: 55, maxLiqDrop: 18, minPriceChange: -10 },
    paper: { sizeSol: 0.3, maxPos: 8 },
  },
  agressief: {
    label: '🔥 Agressief', desc: 'Zoveel mogelijk coins: veel trades, veel rugs',
    sniper: { minScore: 42, youngMinScore: 35, minLiq: 5000, minMcap: 8000, curveMinMcap: 6000, minVolH1: 500, minBuySell: 0.9, launchMaxAgeMin: 90 },
    security: { minOrganic: 0, maxTop10: 50, maxSingleHolder: 20, maxInsiders: 60, strictDanger: false, maxRiskScore: 70, minLpLocked: 70, maxRoundTrip: 15, maxDevHold: 20, maxDevMints: 500 },
    real: { rounds: 2, intervalSec: 30, minScore: 45, maxLiqDrop: 25, minPriceChange: -15 },
    paper: { sizeSol: 0.2, maxPos: 10 },
  },
};

export function applyProfile(name) {
  const p = PROFILES[name];
  if (!p) return;
  for (const bot of ['sniper', 'security', 'real', 'paper']) Object.assign(settings[bot], p[bot]);
  saveSettings();
}

/** Name of the profile the current settings match exactly, or null ("aangepast"). */
export function currentProfile() {
  for (const [name, p] of Object.entries(PROFILES)) {
    if (['sniper', 'security', 'real', 'paper'].every((bot) => Object.entries(p[bot]).every(([k, v]) => settings[bot][k] === v))) return name;
  }
  return null;
}

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
    positions: [], history: [], solUsd: 0, fails: { tx: 0, slip: 0, feesSol: 0 },
    equityHist: [{ t: Date.now(), v: settings.paper.startSol }],
  };
}
export const paper = Object.assign(freshPaper(), load(KEY_PAPER, {}));
export const savePaper = () => save(KEY_PAPER, paper);
// Positions saved by older versions lack the partial-sell fields.
for (const p of paper.positions || []) {
  if (p.realizedSol == null) p.realizedSol = 0;
  if (p.partialDone == null) p.partialDone = false;
}

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
