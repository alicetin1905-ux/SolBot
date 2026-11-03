// Dev (token creator) wallet monitoring via Jupiter's holdings endpoint (free, CORS-enabled).
// Used by security (how much does the dev still hold / already sold), real check (dev selling
// during observation) and the paper trader (exit as soon as the dev dumps).
import * as api from './api.js?v=20261103104710';

const cache = new Map(); // dev wallet -> { at, data }
const TTL = 20000;

/** Raw token amount (as Number, UI units) the wallet holds of `mint`, or null if unknown. */
export async function devBalance(dev, mint, maxAge = TTL) {
  if (!dev || !mint) return null;
  let c = cache.get(dev);
  if (!c || Date.now() - c.at > maxAge) {
    try {
      c = { at: Date.now(), data: await api.jupHoldings(dev) };
      cache.set(dev, c);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
    } catch { return null; }
  }
  const accounts = c.data?.tokens?.[mint] || [];
  return accounts.reduce((a, x) => a + (Number(x.uiAmount) || 0), 0);
}

/** Percentage helper: part of total, null-safe. */
export const pctOf = (part, total) => (part == null || !total ? null : (part / total) * 100);
