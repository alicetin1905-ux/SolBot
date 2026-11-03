// Learned score: a small logistic-regression model trained in the browser on the
// tracker's measured coins. It predicts the chance that a coin becomes a winner
// (ever >= +50% after first seen) without rugging, from the sniper's features.
import { WIN_PCT } from './metingen.js?v=20261103190705';

const KEY = 'solbot.model.v1';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const FEATURES = [
  ['Liquiditeit', (f) => Math.log10(1 + (f.liq || 0))],
  ['Volume 1u', (f) => Math.log10(1 + (f.vol || 0))],
  ['Volume / liquiditeit', (f) => clamp((f.vol || 0) / Math.max(1, f.liq || 0), 0, 5)],
  ['Buy/sell ratio', (f) => clamp(f.bs || 0, 0, 5)],
  ['Stijging 1u', (f) => clamp((f.mom || 0) / 100, -1, 5)],
  ['Leeftijd', (f) => Math.log10(0.05 + Math.min(f.age ?? 1, 500))],
  ['Market cap', (f) => Math.log10(1 + (f.mc || 0))],
  ['Bonding curve', (f) => (f.curve ? 1 : 0)],
  ['Live launch', (f) => (f.origin === 'launch' ? 1 : 0)],
  ['Migratie', (f) => (f.origin === 'migratie' ? 1 : 0)],
  ['Sniper score', (f) => (f.score || 0) / 100],
];

export const MIN_SAMPLES = 80;
const vec = (f) => FEATURES.map(([, fn]) => fn(f));
const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

/** Records usable for training: have features and at least 1 hour of measurements. */
export function labeled(records) {
  return records.filter((r) => r.f && r.cp && r.cp[60] !== undefined)
    .map((r) => ({ x: vec({ ...r.f, origin: r.origin }), y: r.max >= WIN_PCT && !r.rug ? 1 : 0, t0: r.t0 }));
}

function auc(scores, ys) {
  const pos = scores.filter((_, i) => ys[i]), neg = scores.filter((_, i) => !ys[i]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Trains on the oldest 80%, reports AUC on the newest 20%, then refits on everything. */
export function train(records) {
  const data = labeled(records).sort((a, b) => a.t0 - b.t0);
  const pos = data.filter((d) => d.y).length;
  if (data.length < MIN_SAMPLES || pos < 8 || data.length - pos < 8) {
    return { error: `Te weinig data: ${data.length}/${MIN_SAMPLES} gemeten coins (${pos} winnaars). Laat de bots langer draaien.` };
  }
  const fit = (rows) => {
    const k = FEATURES.length;
    const mean = Array(k).fill(0), std = Array(k).fill(0);
    rows.forEach((r) => r.x.forEach((v, i) => { mean[i] += v / rows.length; }));
    rows.forEach((r) => r.x.forEach((v, i) => { std[i] += (v - mean[i]) ** 2 / rows.length; }));
    for (let i = 0; i < k; i++) std[i] = Math.sqrt(std[i]) || 1;
    const X = rows.map((r) => r.x.map((v, i) => (v - mean[i]) / std[i]));
    const w = Array(k).fill(0); let b = 0;
    const lr = 0.1, l2 = 0.01;
    // class weights: winners are rare, so they count more
    const pw = rows.length / (2 * Math.max(1, rows.filter((r) => r.y).length));
    const nw = rows.length / (2 * Math.max(1, rows.filter((r) => !r.y).length));
    for (let it = 0; it < 600; it++) {
      const gw = Array(k).fill(0); let gb = 0;
      X.forEach((x, n) => {
        const y = rows[n].y, cw = y ? pw : nw;
        const err = (sigmoid(b + x.reduce((a, v, i) => a + v * w[i], 0)) - y) * cw;
        for (let i = 0; i < k; i++) gw[i] += err * x[i];
        gb += err;
      });
      for (let i = 0; i < k; i++) w[i] -= lr * (gw[i] / rows.length + l2 * w[i]);
      b -= lr * gb / rows.length;
    }
    return { w, b, mean, std };
  };
  const cut = Math.floor(data.length * 0.8);
  const test = data.slice(cut);
  const m1 = fit(data.slice(0, cut));
  const testAuc = auc(test.map((d) => predictVec(m1, d.x)), test.map((d) => d.y));
  const m = fit(data);
  return { ...m, n: data.length, pos, auc: testAuc, trainedAt: Date.now(), baseRate: pos / data.length };
}

function predictVec(m, x) {
  return sigmoid(m.b + x.reduce((a, v, i) => a + ((v - m.mean[i]) / m.std[i]) * m.w[i], 0));
}

/** Probability (0-1) that a coin with sniper features `f` becomes a clean winner. */
export const predict = (m, f) => (m && !m.error ? predictVec(m, vec(f)) : null);

let current = null;
try { current = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { current = null; }
export const getModel = () => current;
export function setModel(m) {
  current = m && !m.error ? m : current;
  try { if (current) localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage full */ }
}
