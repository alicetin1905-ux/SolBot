import { settings, saveSettings, resetSettings, paper, tokens, on, log } from './store.js';
import { SniperBot, fmt } from './sniper.js';
import { SecurityBot } from './security.js';
import { RealCheckBot } from './realcheck.js';
import { PaperBot } from './paper.js';
import { initFlow, updateFlow, exchangeOf } from './flow.js';

const sniper = new SniperBot();
const security = new SecurityBot();
const real = new RealCheckBot();
const trader = new PaperBot();
const bots = { sniper, security, real, paper: trader };

// ---------- pipeline wiring ----------
on('candidate', (t) => security.enqueue(t));
on('secured', (t) => real.add(t));
on('confirmed', (t) => trader.onConfirmed(t));

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 1) => `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%</span>`;
const sol = (v, d = 3) => `${Number(v).toFixed(d)} ◎`;
const short = (m) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const ago = (ms) => {
  const m = ms / 60000;
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}u`;
  return `${(m / 1440).toFixed(1)}d`;
};
const pill = (status, text) => `<span class="pill ${status}">${esc(text ?? status)}</span>`;
const bar = (v) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></div>`;
const dexUrl = (mint) => `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

// ---------- settings schema ----------
const SCHEMA = {
  sniper: [
    ['intervalSec', 'Scan interval (sec)'], ['minScore', 'Min. score (0-100)'],
    ['minLiq', 'Min. liquiditeit ($)'], ['minVolH1', 'Min. volume 1u ($)'],
    ['minMcap', 'Min. market cap ($)'], ['maxMcap', 'Max. market cap ($)'],
    ['maxAgeH', 'Max. leeftijd pair (uur)'], ['minBuySell', 'Min. buy/sell ratio'],
    ['useGecko', 'GeckoTerminal nieuwe pools meenemen', 'bool'],
  ],
  security: [
    ['maxTop10', 'Max. top 10 holders (%)'], ['maxSingleHolder', 'Max. grootste holder (%)'],
    ['minLpLocked', 'Min. LP locked/burned (%)'], ['maxRiskScore', 'Max. RugCheck score'],
    ['minHolders', 'Min. holders (waarschuwing)'], ['maxRoundTrip', 'Max. round-trip verlies (%)'],
    ['testSol', 'Honeypot test bedrag (SOL)'], ['maxTransferFee', 'Max. transfer tax (%)'],
    ['maxInsiders', 'Max. insider wallets'],
  ],
  real: [
    ['rounds', 'Observatie rondes'], ['intervalSec', 'Tijd tussen rondes (sec)'],
    ['maxLiqDrop', 'Max. liquiditeit daling (%)'], ['minPriceChange', 'Min. prijs verandering (%)'],
    ['maxPriceDev', 'Max. prijsverschil Dex/Jupiter (%)'], ['minBuySell', 'Min. gem. buy/sell ratio'],
    ['minScore', 'Min. real score (0-100)'],
  ],
  paper: [
    ['autoTrade', 'Automatisch kopen bij bevestiging', 'bool'],
    ['startSol', 'Startsaldo (SOL, bij reset)'], ['sizeSol', 'Positiegrootte (SOL)'],
    ['maxPos', 'Max. open posities'], ['tp', 'Take profit (%)'], ['sl', 'Stop loss (%)'],
    ['trailAct', 'Trailing activeert bij (+%)'], ['trail', 'Trailing afstand (%)'],
    ['maxHoldMin', 'Max. houdtijd (min)'], ['slippageBps', 'Slippage (bps)'],
    ['feeSol', 'Fee per trade (SOL)'], ['tickSec', 'Prijs update (sec)'],
  ],
};

function buildForms() {
  for (const [bot, fields] of Object.entries(SCHEMA)) {
    const form = $(`[data-bot="${bot}"] [data-form]`);
    const first = !form.dataset.bound;
    form.dataset.bound = '1';
    form.innerHTML = fields.map(([key, label, type]) => type === 'bool'
      ? `<label class="check"><input type="checkbox" name="${key}" ${settings[bot][key] ? 'checked' : ''}> ${esc(label)}</label>`
      : `<label>${esc(label)}<input type="number" step="any" name="${key}" value="${esc(settings[bot][key])}"></label>`).join('');
    if (!first) continue;
    form.addEventListener('change', (e) => {
      const el = e.target;
      if (!el.name) return;
      if (el.type === 'checkbox') settings[bot][el.name] = el.checked;
      else if (el.value !== '' && Number.isFinite(Number(el.value))) settings[bot][el.name] = Number(el.value);
      saveSettings();
      log(bot, `Instelling ${el.name} = ${settings[bot][el.name]}`);
    });
    form.addEventListener('submit', (e) => e.preventDefault());
  }
}

// ---------- renderers ----------
function renderStats() {
  const s = trader.stats();
  const items = [
    ['Paper saldo', sol(s.balance)],
    ['Equity', sol(s.equity)],
    ['Totaal P&L', pct(s.totalPct, 2)],
    ['Gerealiseerd', `<span class="${s.realized >= 0 ? 'pos' : 'neg'}">${s.realized >= 0 ? '+' : ''}${s.realized.toFixed(4)} ◎</span>`],
    ['Open posities', `${paper.positions.length} · ${sol(s.open)}`],
    ['Win rate', `${s.winRate.toFixed(0)}% <small class="mint">(${s.trades} trades)</small>`],
    ['SOL prijs', s.solUsd ? `$${s.solUsd.toFixed(2)}` : '—'],
  ];
  const html = items.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  $$('.stats').forEach((el) => { el.innerHTML = html; });
}

const confirmedCount = () => real.done.filter((t) => t.real && t.stage !== 'rejected').length;

function renderBotHead(id) {
  const b = bots[id];
  for (const card of $$(`[data-bot="${id}"],[data-mini="${id}"]`)) {
    const status = $('[data-status]', card);
    status.className = `status ${b.running ? 'run' : ''} ${b.busy ? 'busy' : ''}`;
    status.textContent = b.running ? (b.busy ? 'bezig…' : 'actief') : 'gestopt';
    const t = $('[data-toggle]', card);
    t.textContent = b.running ? '■ Stop' : '▶ Start';
    t.classList.toggle('on', b.running);
  }
  $(`[data-dot="${id}"]`).classList.toggle('run', b.running);
  const counts = {
    sniper: sniper.results.filter((r) => r.pass).length,
    security: security.queue.length,
    real: real.watch.length,
    paper: paper.positions.length,
  };
  $(`[data-cnt="${id}"]`).textContent = counts[id] || '';
}

// ---------- flow map ----------
function renderFlow() {
  const s = trader.stats();
  const pass = sniper.results.filter((r) => r.pass).length;
  const rejected = real.done.filter((t) => t.stage === 'rejected').length;
  const exchanges = {};
  for (const r of sniper.results) {
    const e = (exchanges[exchangeOf(r.dex).id] ||= { total: 0, pass: 0 });
    e.total++;
    if (r.pass) e.pass++;
  }
  updateFlow({
    running: Object.fromEntries(Object.entries(bots).map(([k, b]) => [k, b.running])),
    exchanges,
    bots: {
      sniper: { big: String(pass), label: 'kandidaten', sub: `${sniper.results.length} gescand · scan #${sniper.scans}` },
      security: {
        big: `<span class="pos">${security.stats.pass}✓</span> <span class="neg">${security.stats.fail}✗</span>`,
        label: 'veilig / afgekeurd', sub: `wachtrij ${security.queue.length}`,
      },
      real: { big: String(real.watch.length), label: 'in observatie', sub: `${confirmedCount()} bevestigd · ${rejected} afgewezen` },
      paper: { big: pct(s.totalPct, 2), label: `${sol(s.equity, 2)} equity`, sub: `${paper.positions.length} open · ${s.trades} trades` },
    },
  });
}

// ---------- dashboard mini cards ----------
const metrics = (items) => `<div class="metrics">${items.map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`;
const miniBody = (id) => $(`[data-mini="${id}"] [data-mini-body]`);

function renderMiniSniper() {
  const pass = sniper.results.filter((r) => r.pass);
  miniBody('sniper').innerHTML = metrics([
    ['Gescand', sniper.results.length], ['Kandidaten', pass.length], ['Scans', sniper.scans],
    ['Laatste scan', sniper.lastRun ? ago(Date.now() - sniper.lastRun) : '—'],
  ]) + (pass.length ? `<table><thead><tr><th>Top kandidaten</th><th>Score</th><th class="r">Liq</th><th class="r">1u</th></tr></thead><tbody>
    ${pass.slice(0, 5).map((r) => `<tr class="click" data-mint="${esc(r.mint)}"><td class="sym">${esc(r.symbol)}</td><td>${r.score} ${bar(r.score)}</td><td class="r">$${fmt(r.liq)}</td><td class="r">${pct(r.mom, 0)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="empty">${sniper.busy ? 'Scannen…' : 'Nog geen kandidaten.'}</div>`);
}

function renderMiniSecurity() {
  const rows = security.checked.slice(0, 5);
  miniBody('security').innerHTML = metrics([
    ['Wachtrij', security.queue.length], ['Veilig', security.stats.pass], ['Afgekeurd', security.stats.fail],
    ['Slagingskans', security.stats.pass + security.stats.fail ? `${Math.round(security.stats.pass / (security.stats.pass + security.stats.fail) * 100)}%` : '—'],
  ]) + (rows.length ? `<table><thead><tr><th>Laatst gecheckt</th><th>Score</th><th>Resultaat</th></tr></thead><tbody>
    ${rows.map((t) => { const fails = (t.security?.checks || []).filter((c) => c.status === 'fail'); return `<tr class="click" data-mint="${esc(t.mint)}"><td class="sym">${esc(t.symbol || short(t.mint))}</td><td>${t.security.score}</td>
      <td>${fails.length ? `<span class="reason" title="${esc(fails.map((c) => c.name).join(', '))}">${esc(fails[0].name)}${fails.length > 1 ? ` +${fails.length - 1}` : ''}</span>` : pill('pass', 'veilig')}</td></tr>`; }).join('')}
    </tbody></table>` : '<div class="empty">Nog niets gecontroleerd.</div>');
}

function renderMiniReal() {
  const s = settings.real;
  const done = real.done.slice(0, 5);
  const rejected = real.done.filter((t) => t.stage === 'rejected').length;
  miniBody('real').innerHTML = metrics([
    ['Observatie', real.watch.length], ['Bevestigd', confirmedCount()], ['Afgewezen', rejected], ['Rondes', s.rounds],
  ]) + (real.watch.length ? `<div class="sectionlbl">Nu in observatie</div><div>${real.watch.map((w) => pill('info', `${w.symbol || short(w.mint)} ${w.snaps.length}/${s.rounds}`)).join(' ')}</div>` : '')
    + (done.length ? `<table><thead><tr><th>Resultaat</th><th>Real</th><th>Totaal</th><th></th></tr></thead><tbody>
    ${done.map((t) => `<tr class="click" data-mint="${esc(t.mint)}"><td class="sym">${esc(t.symbol || short(t.mint))}</td><td>${t.real.score}</td><td><b>${t.rank ?? '—'}</b></td>
      <td>${t.stage === 'rejected' ? pill('fail', 'afgewezen') : pill('pass', 'bevestigd')}</td></tr>`).join('')}
    </tbody></table>` : (real.watch.length ? '' : '<div class="empty">Nog geen coins geobserveerd.</div>'));
}

function renderMiniPaper() {
  const st = trader.stats();
  const pos = paper.positions;
  miniBody('paper').innerHTML = metrics([
    ['Equity', sol(st.equity, 2)], ['P&L', pct(st.totalPct)], ['Open', `${pos.length}/${settings.paper.maxPos}`], ['Win rate', st.trades ? `${st.winRate.toFixed(0)}%` : '—'],
  ]) + (pos.length ? `<table><thead><tr><th>Open positie</th><th class="r">Waarde</th><th class="r">P&L</th><th class="r">Tijd</th></tr></thead><tbody>
    ${pos.slice(0, 5).map((p) => `<tr class="click" data-mint="${esc(p.mint)}"><td class="sym">${esc(p.symbol)}</td><td class="r">${sol(p.lastValueSol)}</td><td class="r">${pct(p.pnlPct)}</td><td class="r">${ago(Date.now() - p.entryTs)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">Geen open posities.</div>');
}

function renderRecentTrades() {
  const h = paper.history.slice(0, 6);
  $('[data-recent-trades]').innerHTML = h.length ? `<table><thead><tr><th>Token</th><th class="r">P&L</th><th class="r">Duur</th><th>Reden</th></tr></thead><tbody>
    ${h.map((t) => `<tr class="click" data-mint="${esc(t.mint)}"><td class="sym">${esc(t.symbol)}</td><td class="r">${pct(t.pnlPct)}</td><td class="r">${ago(t.exitTs - t.entryTs)}</td><td class="reason" title="${esc(t.reason)}">${esc(t.reason)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">Nog geen gesloten trades.</div>';
}

// ---------- equity chart (single series SVG line + hover crosshair) ----------
function renderEquity() {
  const pts = [...paper.equityHist];
  const live = trader.stats().equity;
  pts.push({ t: Date.now(), v: live });
  for (const el of $$('.equity-chart')) {
    if (el.offsetParent === null) continue; // not visible
    const W = el.clientWidth || 600, H = 200;
    const key = `${W}|${pts.length}|${live.toFixed(5)}|${pts[0].t}`;
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    let lo = Math.min(paper.startSol, ...pts.map((p) => p.v)), hi = Math.max(paper.startSol, ...pts.map((p) => p.v));
    const span = Math.max(hi - lo, paper.startSol * 0.01);
    lo -= span * 0.1; hi += span * 0.1;
    const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const area = `${line}L${x(t1).toFixed(1)},${H - pad.b}L${x(t0).toFixed(1)},${H - pad.b}Z`;
    const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
    const tfmt = (t) => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Equity verloop in SOL">
      ${ticks.map((v) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`).join('')}
      <line class="base-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(paper.startSol)}" y2="${y(paper.startSol)}"/>
      <text x="${W - pad.r}" y="${y(paper.startSol) - 5}" text-anchor="end">start ${paper.startSol} ◎</text>
      <path class="eq-area" d="${area}"/><path class="eq-line" d="${line}"/>
      <text x="${pad.l}" y="${H - 5}">${tfmt(t0)}</text><text x="${W - pad.r}" y="${H - 5}" text-anchor="end">${tfmt(t1)}</text>
      <g class="hover" visibility="hidden"><line class="cross" y1="${pad.t}" y2="${H - pad.b}"/><circle class="marker" r="5"/></g>
      <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent"/>
    </svg><div class="tip" hidden></div>`;
    const svg = $('svg', el), g = $('.hover', el), tip = $('.tip', el);
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(x(p.t) - mx) < Math.abs(x(best.t) - mx)) best = p;
      const px = x(best.t), py = y(best.v);
      g.setAttribute('visibility', 'visible');
      $('.cross', g).setAttribute('x1', px); $('.cross', g).setAttribute('x2', px);
      $('.marker', g).setAttribute('cx', px); $('.marker', g).setAttribute('cy', py);
      const chg = (best.v / paper.startSol - 1) * 100;
      tip.hidden = false;
      tip.style.left = `${(px / W) * r.width}px`; tip.style.top = `${(py / H) * r.height}px`;
      tip.innerHTML = `${new Date(best.t).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}<br><b>${best.v.toFixed(4)} ◎</b> ${pct(chg, 2)}`;
    });
    svg.addEventListener('pointerleave', () => { g.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }
}

function renderSniper() {
  const rows = sniper.results.slice(0, 30);
  $('[data-bot="sniper"] [data-body]').innerHTML = rows.length ? `
    <table><thead><tr><th>Token</th><th>Score</th><th class="r">Liq</th><th class="r">Vol 1u</th><th class="r">B/S</th><th class="r">1u</th><th class="r">Leeftijd</th><th>Status</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="click ${r.pass ? '' : 'dim'}" data-mint="${esc(r.mint)}">
        <td><span class="sym">${esc(r.symbol)}</span><div class="mint">${short(r.mint)}</div></td>
        <td>${r.score} ${bar(r.score)}</td>
        <td class="r">$${fmt(r.liq)}</td><td class="r">$${fmt(r.volH1)}</td>
        <td class="r">${r.bs.toFixed(2)}</td><td class="r">${pct(r.mom, 0)}</td>
        <td class="r">${r.ageH < 999 ? ago(r.ageH * 3.6e6) : '?'}</td>
        <td>${r.pass ? pill('pass', 'kandidaat') : `<span class="reason" title="${esc(r.reason)}">${esc(r.reason)}</span>`}</td>
      </tr>`).join('')}</tbody></table>
    <p class="mint">Scan #${sniper.scans} · ${sniper.lastRun ? ago(Date.now() - sniper.lastRun) + ' geleden' : ''}</p>`
    : `<div class="empty">${sniper.busy ? 'Scannen…' : 'Nog geen scan. Klik op Start of Nu scannen.'}</div>`;
}

function renderSecurity() {
  const q = security.queue;
  const rows = security.checked.slice(0, 25);
  const counts = (t) => {
    const c = t.security?.checks || [];
    return { f: c.filter((x) => x.status === 'fail').length, w: c.filter((x) => x.status === 'warn').length };
  };
  $('[data-bot="security"] [data-body]').innerHTML = `
    <div class="sectionlbl">Wachtrij (${q.length})</div>
    <div>${q.length ? q.map((t) => pill('info', t.symbol || short(t.mint))).join(' ') : '<span class="mint">leeg</span>'}</div>
    <div class="sectionlbl">Gecontroleerd</div>
    ${rows.length ? `<table><thead><tr><th>Token</th><th>Score</th><th class="r">Round-trip</th><th>Fails / warns</th><th>Resultaat</th></tr></thead><tbody>
    ${rows.map((t) => { const c = counts(t); const ok = t.stage !== 'rejected' || !t.security?.checks?.some((x) => x.status === 'fail'); return `
      <tr class="click" data-mint="${esc(t.mint)}">
        <td><span class="sym">${esc(t.symbol || '?')}</span><div class="mint">${short(t.mint)}</div></td>
        <td>${t.security.score} ${bar(t.security.score)}</td>
        <td class="r">${t.security.roundTrip == null ? '—' : t.security.roundTrip.toFixed(1) + '%'}</td>
        <td>${c.f ? pill('fail', c.f + ' fail') : ''} ${c.w ? pill('warn', c.w + ' warn') : ''} ${!c.f && !c.w ? pill('pass', 'schoon') : ''}</td>
        <td>${ok ? pill('pass', 'veilig') : `<span class="reason" title="${esc(t.rejectReason)}">${esc(t.rejectReason)}</span>`}</td>
      </tr>`; }).join('')}</tbody></table>` : '<div class="empty">Nog niets gecontroleerd.</div>'}`;
}

function renderReal() {
  const s = settings.real;
  const w = real.watch;
  const done = real.done.slice(0, 20);
  $('[data-bot="real"] [data-body]').innerHTML = `
    <div class="sectionlbl">Wordt geobserveerd (${w.length})</div>
    ${w.length ? `<table><thead><tr><th>Token</th><th>Ronde</th><th class="r">Prijs</th><th class="r">Liq</th><th class="r">Volgende</th></tr></thead><tbody>
      ${w.map((x) => { const a = x.snaps[0], b = x.snaps[x.snaps.length - 1]; return `
        <tr class="click" data-mint="${esc(x.mint)}">
          <td class="sym">${esc(x.symbol || short(x.mint))}</td>
          <td>${x.snaps.length}/${s.rounds} ${bar((x.snaps.length / s.rounds) * 100)}</td>
          <td class="r">${a && b && a.price ? pct((b.price / a.price - 1) * 100) : '—'}</td>
          <td class="r">${a && b && a.liq ? pct((b.liq / a.liq - 1) * 100) : '—'}</td>
          <td class="r">${x.next ? ago(Math.max(0, x.next - Date.now())) : 'nu'}</td>
        </tr>`; }).join('')}</tbody></table>` : '<div class="mint">Geen tokens in observatie.</div>'}
    <div class="sectionlbl">Resultaat</div>
    ${done.length ? `<table><thead><tr><th>Token</th><th>Real score</th><th>Totaal</th><th>Resultaat</th></tr></thead><tbody>
      ${done.map((t) => `
        <tr class="click" data-mint="${esc(t.mint)}">
          <td class="sym">${esc(t.symbol || short(t.mint))}</td>
          <td>${t.real.score} ${bar(t.real.score)}</td><td><b>${t.rank ?? '—'}</b></td>
          <td>${t.stage === 'rejected' ? `<span class="reason" title="${esc(t.rejectReason)}">${esc(t.rejectReason)}</span>` : pill('pass', '🏆 bevestigd')}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">Nog geen resultaten.</div>'}`;
}

function renderPaper() {
  const pos = paper.positions;
  const sig = trader.signals.filter((t) => !pos.some((p) => p.mint === t.mint));
  $('[data-bot="paper"] [data-body]').innerHTML = `
    <div class="sectionlbl">Open posities (${pos.length}/${settings.paper.maxPos})</div>
    ${pos.length ? `<table><thead><tr><th>Token</th><th class="r">In</th><th class="r">Waarde</th><th class="r">P&L</th><th class="r">Piek</th><th class="r">Tijd</th><th></th></tr></thead><tbody>
      ${pos.map((p) => `
        <tr>
          <td class="click" data-mint="${esc(p.mint)}"><span class="sym">${esc(p.symbol)}</span><div class="mint">${short(p.mint)}</div></td>
          <td class="r">${sol(p.entrySol)}</td><td class="r">${sol(p.lastValueSol)}</td>
          <td class="r">${pct(p.pnlPct)}</td><td class="r">${pct(p.peakPct)}</td>
          <td class="r">${ago(Date.now() - p.entryTs)}</td>
          <td><button class="btn small" data-close="${esc(p.id)}">Verkoop</button></td>
        </tr>`).join('')}</tbody></table>` : '<div class="mint">Geen open posities.</div>'}
    <div class="sectionlbl">Signalen (bevestigd, niet gekocht)</div>
    ${sig.length ? `<table><tbody>${sig.map((t) => `
        <tr><td class="sym click" data-mint="${esc(t.mint)}">${esc(t.symbol)}</td><td>totaal score <b>${t.rank}</b></td>
        <td class="r"><button class="btn small primary" data-buy="${esc(t.mint)}">Paper buy ${settings.paper.sizeSol} ◎</button></td></tr>`).join('')}</tbody></table>`
      : `<div class="mint">${settings.paper.autoTrade ? 'Auto-trade aan: bevestigde coins worden direct gekocht zolang de trader draait.' : 'Nog geen signalen.'}</div>`}`;
}

function renderHistory() {
  const h = paper.history.slice(0, 50);
  $('#history').innerHTML = h.length ? `
    <table><thead><tr><th>Token</th><th>Gekocht</th><th class="r">In</th><th class="r">Uit</th><th class="r">P&L</th><th class="r">Duur</th><th>Reden</th></tr></thead><tbody>
    ${h.map((t) => `
      <tr class="click" data-mint="${esc(t.mint)}">
        <td class="sym">${esc(t.symbol)}</td><td>${new Date(t.entryTs).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td class="r">${sol(t.entrySol)}</td><td class="r">${sol(t.exitSol)}</td>
        <td class="r">${pct(t.pnlPct)} <span class="mint">${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)}</span></td>
        <td class="r">${ago(t.exitTs - t.entryTs)}</td><td class="reason" title="${esc(t.reason)}">${esc(t.reason)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">Nog geen gesloten paper trades.</div>';
}

let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderStats(); renderFlow();
    Object.keys(bots).forEach(renderBotHead);
    renderMiniSniper(); renderMiniSecurity(); renderMiniReal(); renderMiniPaper(); renderRecentTrades();
    renderSniper(); renderSecurity(); renderReal(); renderPaper(); renderHistory();
    renderEquity();
  });
}

// ---------- log ----------
on('log', ({ bot, msg, level, ts }) => {
  const html = `<span class="t">${new Date(ts).toLocaleTimeString('nl-NL')}</span><span class="b">[${esc(bot)}]</span><span class="${level}">${esc(msg)}</span>`;
  for (const el of $$('[data-log]')) {
    if (el.dataset.log && el.dataset.log !== bot) continue;
    const div = document.createElement('div');
    div.innerHTML = html;
    el.prepend(div);
    while (el.childElementCount > 300) el.lastChild.remove();
  }
  render();
});

// ---------- detail dialog ----------
function checkTable(checks) {
  return `<table class="checklist"><tbody>${checks.map((c) => `<tr><td>${pill(c.status, c.status === 'pass' ? 'OK' : c.status.toUpperCase())}</td><td><b>${esc(c.name)}</b><div class="mint">${esc(c.detail)}</div></td></tr>`).join('')}</tbody></table>`;
}
function showDetail(mint) {
  const t = tokens.get(mint) || { mint, ...(sniper.results.find((r) => r.mint === mint) || {}) };
  const p = t.pair;
  $('#detailBody').innerHTML = `
    <h3>${esc(t.symbol || '?')} <span class="mint">${esc(t.name || '')}</span></h3>
    <div class="mint">${esc(mint)}</div>
    <div class="links">
      <a href="${dexUrl(mint)}" target="_blank" rel="noopener">DexScreener ↗</a>
      <a href="https://rugcheck.xyz/tokens/${encodeURIComponent(mint)}" target="_blank" rel="noopener">RugCheck ↗</a>
      <a href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener">Solscan ↗</a>
      <a href="https://jup.ag/swap/SOL-${encodeURIComponent(mint)}" target="_blank" rel="noopener">Jupiter ↗</a>
    </div>
    ${p ? `<p>Prijs $${esc(p.priceUsd)} · Liq $${fmt(p.liquidity?.usd || 0)} · MC $${fmt(p.marketCap || p.fdv || 0)} · Vol 24u $${fmt(p.volume?.h24 || 0)} · DEX ${esc(p.dexId)}</p>` : ''}
    <p>Status: ${pill(t.stage === 'rejected' ? 'fail' : 'info', t.stage || 'gescand')} ${t.rejectReason ? `<span class="mint">${esc(t.rejectReason)}</span>` : ''}
       ${t.sniperScore != null ? ` · Sniper ${t.sniperScore}` : ''}${t.security ? ` · Security ${t.security.score}` : ''}${t.real ? ` · Real ${t.real.score}` : ''}${t.rank != null ? ` · <b>Totaal ${t.rank}</b>` : ''}</p>
    ${t.security ? `<div class="sectionlbl">2 · Security check</div>${checkTable(t.security.checks)}` : ''}
    ${t.real ? `<div class="sectionlbl">3 · Real check</div>${checkTable(t.real.checks)}` : ''}
    ${!t.security && !tokens.has(mint) ? `<p><button class="btn primary" data-check="${esc(mint)}">Security check uitvoeren</button></p>` : ''}`;
  $('#detail').showModal();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-mint],[data-close],[data-buy],[data-check],[data-toggle],[data-once],[data-settings],[data-clear-log],[data-goto]');
  if (!el) return;
  const card = el.closest('[data-bot],[data-mini]');
  if (el.hasAttribute('data-clear-log')) {
    $('[data-log]', el.closest('.card')).innerHTML = '';
  } else if (el.hasAttribute('data-toggle')) {
    const b = bots[card.dataset.bot || card.dataset.mini];
    b.running ? b.stop() : b.start();
    persistRunning();
  } else if (el.hasAttribute('data-once')) {
    bots[card.dataset.bot].runOnce();
  } else if (el.hasAttribute('data-settings')) {
    const f = $('[data-form]', card); f.hidden = !f.hidden;
  } else if (el.dataset.close) {
    const pos = paper.positions.find((p) => p.id === el.dataset.close);
    if (pos) { el.disabled = true; await trader.sell(pos, 'Handmatig verkocht'); }
  } else if (el.dataset.buy) {
    const t = tokens.get(el.dataset.buy);
    if (t) { el.disabled = true; try { await trader.buy(t); } catch (err) { log('paper', `Koop fout: ${err.message}`, 'err'); } render(); }
  } else if (el.dataset.check) {
    $('#detail').close();
    security.addManual(el.dataset.check).catch((err) => log('security', err.message, 'err'));
  } else if (el.dataset.mint) {
    showDetail(el.dataset.mint);
  } else if (el.dataset.goto) {
    location.hash = `#/${el.dataset.goto}`;
  }
});

$$('form.manual').forEach((form) => form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = form.elements.mint;
  const mint = input.value.trim();
  if (!mint) return;
  try {
    await security.addManual(mint);
    input.value = '';
    if (!security.running) log('security', 'Tip: start de Security bot om de wachtrij te verwerken', 'warn');
  } catch (err) { log('security', err.message, 'err'); }
}));

const RUN_KEY = 'solbot.running.v1';
function persistRunning() {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(Object.keys(bots).filter((k) => bots[k].running))); } catch { /* ignore */ }
}
$('#startAll').onclick = () => { Object.values(bots).forEach((b) => b.start()); persistRunning(); };
$('#stopAll').onclick = () => { Object.values(bots).forEach((b) => b.running && b.stop()); persistRunning(); };
$('#resetPaper').onclick = () => { if (confirm('Paper account resetten? Alle posities en historie worden gewist.')) trader.reset(); };
$('#resetSettings').onclick = () => {
  if (!confirm('Alle instellingen terugzetten naar standaard?')) return;
  resetSettings(); buildForms(); log('app', 'Instellingen hersteld', 'warn');
};

on('bot', render);
on('sniper:results', render);
on('security:done', render);

// ---------- router: one page app, so the bots keep running across pages ----------
const ROUTES = { dashboard: 'Dashboard', sniper: 'Sniper', security: 'Security check', real: 'Real check', paper: 'Paper trader' };
function route() {
  const r = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const page = ROUTES[r] ? r : 'dashboard';
  $$('[data-page]').forEach((s) => { s.hidden = s.dataset.page !== page; });
  $$('[data-route]').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === page);
    if (a.dataset.route === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = page === 'dashboard' ? 'SolBot' : `SolBot · ${ROUTES[page]}`;
  window.scrollTo(0, 0);
  render();
}
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => render());

document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('[data-goto]');
  if (t && (e.key === 'Enter' || e.key === ' ') && e.target === t) { e.preventDefault(); location.hash = `#/${t.dataset.goto}`; }
});

// ---------- boot ----------
initFlow($('#flow'));
buildForms();
route();
setInterval(render, 3000);
log('app', 'SolBot geladen — PAPER MODE (geen echt geld).', 'ok');
try {
  const prev = JSON.parse(localStorage.getItem(RUN_KEY) || '[]');
  prev.forEach((k) => bots[k]?.start());
} catch { /* ignore */ }
