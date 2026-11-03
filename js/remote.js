// Remote ("Mac") mode: when the dashboard is served by the SolBot server on the Mac,
// it shows the Mac's live bots instead of running its own, and sends every action
// as a command to the Mac.
import { emit } from './store.js?v=20261103192235';
import { applyState, applySlow } from './sync.js?v=20261103192235';

const KEY = 'solbot.remoteKey';
export const remote = { active: false, name: '', online: false, lastOk: 0, seq: 0, slowKeys: {}, hashes: {}, error: '' };

const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setKey = (k) => { try { localStorage.setItem(KEY, k); } catch { /* ignore */ } };

async function api(path, opts = {}) {
  const used = getKey();
  const res = await fetch(`./api/${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-solbot-key': used, ...(opts.headers || {}) },
    cache: 'no-store',
  });
  if (res.status === 401 && getKey() !== used) return api(path, opts); // code was just entered by a parallel request
  if (res.status === 401) {
    const k = prompt('Toegangscode van je SolBot-Mac (staat in Terminal na de installatie):', '');
    if (k) { setKey(k.trim()); return api(path, opts); }
    throw new Error('geen toegang');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** True when this page is served by the SolBot server (then the app runs in remote mode). */
export async function detectRemote() {
  try {
    const res = await fetch('./api/hello', { cache: 'no-store' });
    if (!res.ok) return false;
    const j = await res.json();
    if (j.solbot) Object.assign(remote, { active: true, name: j.name || 'Mac' });
  } catch { /* GitHub Pages / offline: local mode */ }
  return remote.active;
}

export async function remoteCmd(name, args = {}) {
  return api('cmd', { method: 'POST', body: JSON.stringify({ name, args }) });
}

/** One sync round: small state (+ new events) and, when due, the big parts. */
export async function pull(eng, { slow = false } = {}) {
  try {
    const h = Object.entries(remote.hashes || {}).map(([k, v]) => `${k}:${v}`).join(',');
    const s = await api(`state?since=${remote.seq}&h=${encodeURIComponent(h)}`);
    remote.hashes = s.hashes;
    if (s.seq < remote.seq) remote.seq = 0; // server restarted: resync events
    applyState(eng, s);
    const first = remote.seq === 0;
    // first contact: only replay the logs, not hundreds of old pulses at once
    for (const e of s.events) if (e.seq > remote.seq && (!first || e.evt === 'log')) emit(e.evt, e.data);
    remote.seq = Math.max(remote.seq, s.seq);
    const k = s.keys;
    if (slow || k.hist !== remote.slowKeys.hist || k.eq !== remote.slowKeys.eq || String(k.model) !== remote.slowKeys.model) {
      const q = new URLSearchParams(remote.slowKeys).toString();
      const big = await api(`slow?${q}`);
      applySlow(eng, big);
      remote.slowKeys = big.keys;
    }
    Object.assign(remote, { online: true, lastOk: Date.now(), error: '' });
  } catch (e) {
    Object.assign(remote, { online: false, error: e.message });
  }
}

/** Starts polling: every 3s while visible, tracker data every 30s. */
export function startRemote(eng, onUpdate) {
  let n = 0;
  const loop = async () => {
    if (document.visibilityState === 'visible') {
      await pull(eng, { slow: n++ % 10 === 0 });
      onUpdate();
    }
    setTimeout(loop, 3000);
  };
  loop();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(eng).then(onUpdate); });
}

// ---------- backup / restore ----------
export async function exportBackup() {
  if (remote.active) return api('export');
  const out = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('solbot.') && k !== KEY) out[k] = localStorage.getItem(k); } } catch { /* ignore */ }
  return { solbotBackup: 1, at: Date.now(), data: out };
}

export async function importBackup(backup) {
  if (!backup?.solbotBackup || !backup.data) throw new Error('Dit is geen SolBot-backup');
  if (remote.active) return api('import', { method: 'POST', body: JSON.stringify(backup) });
  for (const [k, v] of Object.entries(backup.data)) if (k.startsWith('solbot.')) localStorage.setItem(k, v);
  return { ok: true };
}
