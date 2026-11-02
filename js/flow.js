// Flow map: exchange tiles -> bot tiles, joined by wires. Every coin is a
// pulse that travels along the wires while it keeps getting approved.
import { on } from './store.js?v=20261102235128';

export const EXCHANGES = [
  { id: 'pump', name: 'Pump.fun', short: 'Pump', logo: 'P', match: /pump/i },
  { id: 'raydium', name: 'Raydium', short: 'Ray', logo: 'R', match: /raydium|launchlab/i },
  { id: 'meteora', name: 'Meteora', short: 'Met', logo: 'M', match: /meteora/i },
  { id: 'orca', name: 'Orca', short: 'Orca', logo: 'O', match: /orca|whirlpool/i },
  { id: 'other', name: 'Overige DEX', short: 'Overig', logo: '•', match: /.*/ },
];
export const exchangeOf = (dexId = '') => EXCHANGES.find((e) => e.match.test(dexId)) || EXCHANGES[EXCHANGES.length - 1];

const BOTS = [
  { id: 'sniper', n: 1, icon: '🎯', name: 'Sniper' },
  { id: 'security', n: 2, icon: '🛡️', name: 'Security check' },
  { id: 'real', n: 3, icon: '👀', name: 'Real check' },
  { id: 'paper', n: 4, icon: '📈', name: 'Paper trader' },
];

const EDGES = [
  ...EXCHANGES.map((e) => [`ex:${e.id}`, 'sniper']),
  ['sniper', 'security'], ['security', 'real'], ['real', 'paper'],
];

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let root, svg, wireLayer, pulseLayer;
const wires = new Map(); // "from>to" -> { base, flow }
const pulses = [];
const arrivals = new Map(); // `${mint}@${stage}` -> Promise resolved when the pulse arrived
const newCandidates = new Set();
let raf = 0;

export function initFlow(container) {
  root = container;
  root.innerHTML = `
    <svg class="flow-svg" aria-hidden="true"><g class="flow-wires"></g><g class="flow-pulses"></g></svg>
    <div class="flow-grid">
      <div class="flow-ex">
        <div class="flow-col-title">Exchanges</div>
        ${EXCHANGES.map((e) => `
          <div class="ex-tile" data-node="ex:${e.id}" data-ex="${e.id}" data-goto="sniper" title="${e.name}: coins uit de laatste 20 min">
            <span class="ex-logo">${e.logo}</span>
            <div class="ex-txt">
              <div class="ex-row"><b class="ex-name">${e.name}</b><b class="ex-short">${e.short}</b><span class="ex-num" data-ex-num>0</span></div>
              <div class="ex-bar"><i data-ex-bar></i></div>
              <small data-ex-count>geen coins</small>
            </div>
          </div>`).join('')}
      </div>
      ${BOTS.map((b) => `
        <div class="flow-bot" data-node="${b.id}" data-mini="${b.id}" data-goto="${b.id}" tabindex="0" role="link" aria-label="Open ${b.name} pagina">
          <div class="fb-head">
            <span class="fb-icon">${b.icon}</span>
            <div class="fb-titles">
              <div class="fb-name"><span class="fb-n">${b.n}</span>${b.name}</div>
              <span class="status" data-status></span>
            </div>
          </div>
          <div class="fb-kpi"><div class="fb-big" data-big>—</div><div class="fb-label" data-label></div></div>
          <div class="fb-detail" data-detail></div>
          <div class="fb-event" data-event></div>
          <div class="fb-foot"><button class="btn small primary" data-toggle>Start</button><span class="fb-open">Openen →</span></div>
        </div>`).join('')}
    </div>
    <div class="flow-bottom">
      <div class="flow-an" data-node="analyse" data-goto="analyse" tabindex="0" role="link" aria-label="Open Analyse pagina">
        <span class="fb-icon">🔬</span>
        <div class="an-main">
          <div class="fb-name">Analyse <span class="fb-label">werken de filters?</span></div>
          <div class="an-stats" data-an-stats></div>
          <div class="an-insight" data-an-insight></div>
        </div>
        <span class="fb-open">Openen →</span>
      </div>
      <div class="flow-legend">
        <span><i class="lg scan"></i>gescand</span>
        <span><i class="lg cand"></i>kandidaat</span>
        <span><i class="lg safe"></i>veilig</span>
        <span><i class="lg conf"></i>bevestigd</span>
        <span><i class="lg bad"></i>afgekeurd</span>
      </div>
    </div>`;
  svg = root.querySelector('.flow-svg');
  wireLayer = svg.querySelector('.flow-wires');
  pulseLayer = svg.querySelector('.flow-pulses');

  for (const [a, b] of EDGES) {
    const base = document.createElementNS(SVGNS, 'path');
    base.setAttribute('class', 'wire');
    const flow = document.createElementNS(SVGNS, 'path');
    flow.setAttribute('class', 'wire-flow');
    wireLayer.append(base, flow);
    wires.set(`${a}>${b}`, { base, flow, to: b });
  }
  new ResizeObserver(layout).observe(root);
  layout();
  bindEvents();
}

const node = (key) => root.querySelector(`[data-node="${key}"]`);
const visible = () => root && root.offsetParent !== null && !document.hidden;

function layout() {
  const box = root.getBoundingClientRect();
  if (!box.width) return;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  for (const [key, w] of wires) {
    const [a, b] = key.split('>');
    const ra = node(a).getBoundingClientRect();
    const rb = node(b).getBoundingClientRect();
    const A = { l: ra.left - box.left, r: ra.right - box.left, t: ra.top - box.top, b: ra.bottom - box.top };
    const B = { l: rb.left - box.left, r: rb.right - box.left, t: rb.top - box.top, b: rb.bottom - box.top };
    let d;
    if (B.l >= A.r - 4) { // target to the right
      const y1 = (A.t + A.b) / 2, y2 = (B.t + B.b) / 2, dx = (B.l - A.r) * 0.55;
      d = `M${A.r},${y1} C${A.r + dx},${y1} ${B.l - dx},${y2} ${B.l},${y2}`;
    } else { // target below
      const x1 = (A.l + A.r) / 2, x2 = (B.l + B.r) / 2, dy = Math.max(16, (B.t - A.b) * 0.55);
      d = `M${x1},${A.b} C${x1},${A.b + dy} ${x2},${B.t - dy} ${x2},${B.t}`;
    }
    w.base.setAttribute('d', d);
    w.flow.setAttribute('d', d);
    w.len = w.base.getTotalLength();
  }
}

// ---------- pulses ----------
function spawn(from, to, opts = {}) {
  const w = wires.get(`${from}>${to}`);
  if (!w || !visible() || reduceMotion() || pulses.length > 160) {
    setTimeout(() => opts.onArrive?.(), opts.delay || 0);
    return;
  }
  pulses.push({ w, start: performance.now() + (opts.delay || 0), dur: opts.dur || 1500, ...opts });
  if (!raf) raf = requestAnimationFrame(step);
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function step(now) {
  raf = 0;
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    if (now < p.start) continue;
    if (!p.el) {
      p.el = document.createElementNS(SVGNS, 'g');
      p.el.setAttribute('class', `pulse ${p.kind || ''}`);
      p.el.innerHTML = `<circle class="halo" r="${(p.r || 5) * 2.4}"/><circle class="core" r="${p.r || 5}"/>${p.label ? `<text y="-${(p.r || 5) + 7}">${esc(p.label)}</text>` : ''}`;
      pulseLayer.append(p.el);
    }
    const t = Math.min(1, (now - p.start) / p.dur);
    const pt = p.w.base.getPointAtLength(ease(t) * (p.w.len || 0));
    p.el.setAttribute('transform', `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)})`);
    if (t >= 1) {
      p.el.remove();
      pulses.splice(i, 1);
      p.onArrive?.();
    }
  }
  if (pulses.length) raf = requestAnimationFrame(step);
}

function flash(key, kind) {
  const el = node(key);
  if (!el) return;
  el.classList.remove('hit-ok', 'hit-bad', 'hit-info', 'hit-gold');
  void el.offsetWidth; // restart animation
  el.classList.add(`hit-${kind}`);
  clearTimeout(el._hit);
  el._hit = setTimeout(() => el.classList.remove(`hit-${kind}`), 900);
}

function setEvent(key, kind, text) {
  const el = node(key)?.querySelector('[data-event]');
  if (!el) return;
  el.className = `fb-event ${kind}`;
  el.textContent = text;
}

function arrive(mint, stage) {
  let done;
  const p = new Promise((r) => { done = r; });
  arrivals.set(`${mint}@${stage}`, p);
  setTimeout(() => done(), 15000); // safety net
  return () => { done(); };
}
const whenArrived = (mint, stage) => arrivals.get(`${mint}@${stage}`) || Promise.resolve();

function bindEvents() {
  on('candidate', (t) => newCandidates.add(t.mint));

  // Live launches / migrations arrive from Pump.fun as tiny pulses.
  on('sniper:launch', (l) => spawn('ex:pump', 'sniper', {
    kind: l.kind === 'migratie' ? 'cand' : 'scan', r: l.kind === 'migratie' ? 4 : 2.5,
    label: l.kind === 'migratie' ? `🎓 ${l.symbol || ''}`.trim() : null, dur: 1100,
  }));

  on('sniper:results', (results) => {
    const list = results.slice(0, 60);
    list.forEach((r, i) => {
      const ex = exchangeOf(r.dex);
      const isNew = newCandidates.has(r.mint);
      const doneAtSecurity = isNew ? arrive(r.mint, 'security') : null;
      spawn(`ex:${ex.id}`, 'sniper', {
        kind: r.pass ? 'cand' : 'scan', r: r.pass ? 5 : 3, label: r.pass ? r.symbol : null,
        delay: i * 70, dur: 1300,
        onArrive: () => {
          if (r.pass) flash('sniper', 'info');
          if (!isNew) return;
          setEvent('sniper', 'info', `🎯 ${r.symbol} → security`);
          spawn('sniper', 'security', {
            kind: 'cand', r: 6, label: r.symbol, dur: 1500,
            onArrive: () => { flash('security', 'info'); doneAtSecurity(); },
          });
        },
      });
    });
    newCandidates.clear();
  });

  on('security:done', (t) => {
    whenArrived(t.mint, 'security').then(() => {
      if (t.stage === 'rejected') {
        flash('security', 'bad');
        setEvent('security', 'bad', `✗ ${t.symbol}: ${t.rejectReason || 'afgekeurd'}`);
        return;
      }
      setEvent('security', 'ok', `✓ ${t.symbol} veilig → real check`);
      const done = arrive(t.mint, 'real');
      spawn('security', 'real', {
        kind: 'safe', r: 6, label: t.symbol, dur: 1500,
        onArrive: () => { flash('real', 'ok'); done(); },
      });
    });
  });

  on('real:done', (t) => {
    whenArrived(t.mint, 'real').then(() => {
      if (t.stage === 'rejected') {
        flash('real', 'bad');
        setEvent('real', 'bad', `✗ ${t.symbol}: ${t.rejectReason || 'afgewezen'}`);
        return;
      }
      setEvent('real', 'gold', `🏆 ${t.symbol} bevestigd (${t.rank})`);
      spawn('real', 'paper', {
        kind: 'conf', r: 7, label: t.symbol, dur: 1600,
        onArrive: () => flash('paper', 'gold'),
      });
    });
  });

  on('paper:buy', (p) => setEvent('paper', 'ok', `🟢 BUY ${p.symbol}`));
  on('paper:sell', (t) => {
    flash('paper', t.pnlSol >= 0 ? 'ok' : 'bad');
    setEvent('paper', t.pnlSol >= 0 ? 'ok' : 'bad', `${t.pnlSol >= 0 ? '💰' : '🔻'} SELL ${t.symbol} ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`);
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) layout(); });
}

/** Called from the app render loop with fresh numbers (HTML is pre-escaped by the caller). */
export function updateFlow({ bots, exchanges, running, analyse }) {
  if (!root) return;
  for (const [id, v] of Object.entries(bots)) {
    const el = node(id);
    el.querySelector('[data-big]').innerHTML = v.big;
    el.querySelector('[data-label]').textContent = v.label;
    const det = el.querySelector('[data-detail]');
    if (det._html !== v.detail) { det.innerHTML = v.detail; det._html = v.detail; }
    el.classList.toggle('running', !!running[id]);
  }
  const total = Object.values(exchanges).reduce((a, c) => a + c.total, 0);
  for (const e of EXCHANGES) {
    const c = exchanges[e.id] || { total: 0, pass: 0 };
    const el = node(`ex:${e.id}`);
    el.querySelector('[data-ex-num]').textContent = c.total;
    el.querySelector('[data-ex-bar]').style.width = `${total ? (c.total / total) * 100 : 0}%`;
    el.querySelector('[data-ex-count]').textContent = c.total
      ? `${c.pass} kandidaat${c.pass === 1 ? '' : 'en'}${c.last ? ` · ${c.last}` : ''}` : 'geen coins';
    el.classList.toggle('active', c.total > 0);
  }
  if (analyse) {
    const an = node('analyse');
    an.querySelector('[data-an-stats]').innerHTML = analyse.stats;
    an.querySelector('[data-an-insight]').innerHTML = analyse.insight;
  }
  for (const w of wires.values()) w.flow.classList.toggle('live', !!running[w.to]);
}
