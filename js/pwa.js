// Home-screen app (PWA) helpers: service worker, iOS install tip, keep the screen
// awake while bots run, and notifications for trades.
import { on, log } from './store.js?v=20261104174655';

const NOTIFY_KEY = 'solbot.notify';
const HINT_KEY = 'solbot.installHintClosed';

export const isStandalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// ---------- service worker ----------
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { swReg = await navigator.serviceWorker.register('./sw.js', { scope: './' }); } catch { /* not critical */ }
}

// ---------- install tip (iOS Safari only, until closed) ----------
function installHint() {
  if (!isIOS() || isStandalone() || store.get(HINT_KEY)) return;
  const el = document.createElement('div');
  el.className = 'install-hint';
  el.innerHTML = `<span class="ih-icon"><img src="icons/apple-touch-icon.png" alt=""></span>
    <div><b>Zet SolBot op je beginscherm</b><span>Tik op <b>Deel</b> <span class="ih-share">⬆︎</span> en kies <b>Zet op beginscherm</b>. Dan opent SolBot als app, fullscreen.</span></div>
    <button class="btn ghost small" aria-label="Sluiten">✕</button>`;
  el.querySelector('button').onclick = () => { store.set(HINT_KEY, '1'); el.remove(); };
  document.body.append(el);
}

// ---------- keep the screen on while bots run ----------
let wakeLock = null;
let wantAwake = false;
async function applyWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (wantAwake && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!wantAwake && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}
/** Called by the app whenever bots start/stop. */
export function keepAwake(on) {
  if (wantAwake === on) return;
  wantAwake = on;
  applyWakeLock();
}
document.addEventListener('visibilitychange', applyWakeLock);

// ---------- notifications ----------
const supported = () => 'Notification' in window;
export const notifyState = () => {
  if (!supported()) return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && store.get(NOTIFY_KEY) === '1' ? 'on' : 'off';
};

export async function toggleNotify() {
  const st = notifyState();
  if (st === 'install') { alert('Meldingen werken op de iPhone alleen in de beginscherm-app (iOS 16.4 of nieuwer). Zet SolBot eerst op je beginscherm via Deel → Zet op beginscherm.'); return; }
  if (st === 'unsupported') { alert('Deze browser ondersteunt geen meldingen.'); return; }
  if (st === 'denied') { alert('Meldingen zijn geblokkeerd. Zet ze aan in Instellingen → Meldingen → SolBot.'); return; }
  if (st === 'on') { store.set(NOTIFY_KEY, '0'); log('app', '🔕 Meldingen uit'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    store.set(NOTIFY_KEY, '1');
    log('app', '🔔 Meldingen aan', 'ok');
    notify('SolBot meldingen staan aan', 'Je krijgt een melding bij elke koop, verkoop en dev-dump.', 'test');
  }
}

export async function notify(title, body, tag) {
  if (notifyState() !== 'on') return;
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
  try {
    const reg = swReg || (await navigator.serviceWorker?.getRegistration());
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch { /* ignore */ }
}

function hookTradeEvents() {
  on('paper:buy', (p) => notify(`🟢 Gekocht: ${p.symbol}`, `${p.entrySol.toFixed(3)} SOL · score ${p.rank ?? '?'}`, `buy-${p.mint}`));
  on('paper:partial', (p) => notify(`🟡 Deel verkocht: ${p.symbol}`, `+${p.pnlPct.toFixed(1)}% · ${p.soldSol.toFixed(3)} SOL veiliggesteld`, `partial-${p.mint}`));
  on('paper:sell', (t) => notify(
    `${t.reason.startsWith('Dev verkoopt') ? '🚨' : t.pnlSol >= 0 ? '💰' : '🔻'} Verkocht: ${t.symbol} ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`,
    `${t.reason} · ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL`, `sell-${t.mint}`));
}

export function initPWA() {
  registerSW();
  installHint();
  hookTradeEvents();
  if (isStandalone()) document.documentElement.classList.add('standalone');
}
