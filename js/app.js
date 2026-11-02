import { settings, saveSettings, resetSettings, paper, tokens, on, log } from './store.js';
import { SniperBot, fmt } from './sniper.js';
import { SecurityBot } from './security.js';
import { RealCheckBot } from './realcheck.js';
import { PaperBot } from './paper.js';

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
  $('#stats').innerHTML = items.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

function renderPipeline() {
  const all = [...tokens.values()];
  const st = (name) => all.filter((t) => t.stage === name).length;
  const stages = [
    ['🎯 Gevonden', sniper.results.filter((r) => r.pass).length, `${sniper.results.length} gescand`],
    ['🛡️ Security', security.queue.length + st('security'), `${security.stats.pass} ✓ · ${security.stats.fail} ✗`],
    ['👀 Real check', real.watch.length, `${real.done.filter((t) => t.stage !== 'rejected').length} bevestigd`],
    ['📈 Paper trades', paper.positions.length, `${paper.history.length} gesloten`],
  ];
  $('#pipeline').innerHTML = stages.map(([l, n, sub], i) =>
    `${i ? '<div class="arrow">➜</div>' : ''}<div class="stage"><div><div class="lbl">${l}</div><div class="lbl">${sub}</div></div><b>${n}</b></div>`).join('');
}

function renderBotHead(id) {
  const b = bots[id];
  const card = $(`[data-bot="${id}"]`);
  const status = $('[data-status]', card);
  status.className = `status ${b.running ? 'run' : ''} ${b.busy ? 'busy' : ''}`;
  status.textContent = b.running ? (b.busy ? 'bezig…' : 'actief') : 'gestopt';
  const t = $('[data-toggle]', card);
  t.textContent = b.running ? '■ Stop' : '▶ Start';
  t.classList.toggle('on', b.running);
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
    renderStats(); renderPipeline();
    Object.keys(bots).forEach(renderBotHead);
    renderSniper(); renderSecurity(); renderReal(); renderPaper(); renderHistory();
  });
}

// ---------- log ----------
const logEl = $('#log');
on('log', ({ bot, msg, level, ts }) => {
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${new Date(ts).toLocaleTimeString('nl-NL')}</span><span class="b">[${esc(bot)}]</span><span class="${level}">${esc(msg)}</span>`;
  logEl.prepend(div);
  while (logEl.childElementCount > 400) logEl.lastChild.remove();
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
  const el = e.target.closest('[data-mint],[data-close],[data-buy],[data-check],[data-toggle],[data-once],[data-settings]');
  if (!el) return;
  const card = el.closest('[data-bot]');
  if (el.hasAttribute('data-toggle')) {
    const b = bots[card.dataset.bot];
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
  }
});

$('#manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mint = $('#manualMint').value.trim();
  if (!mint) return;
  try {
    await security.addManual(mint);
    $('#manualMint').value = '';
    if (!security.running) log('security', 'Tip: start de Security bot om de wachtrij te verwerken', 'warn');
  } catch (err) { log('security', err.message, 'err'); }
});

const RUN_KEY = 'solbot.running.v1';
function persistRunning() {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(Object.keys(bots).filter((k) => bots[k].running))); } catch { /* ignore */ }
}
$('#startAll').onclick = () => { Object.values(bots).forEach((b) => b.start()); persistRunning(); };
$('#stopAll').onclick = () => { Object.values(bots).forEach((b) => b.running && b.stop()); persistRunning(); };
$('#resetPaper').onclick = () => { if (confirm('Paper account resetten? Alle posities en historie worden gewist.')) trader.reset(); };
$('#clearLog').onclick = () => { logEl.innerHTML = ''; };
$('#resetSettings').onclick = () => {
  if (!confirm('Alle instellingen terugzetten naar standaard?')) return;
  resetSettings(); buildForms(); log('app', 'Instellingen hersteld', 'warn');
};

on('bot', render);
on('sniper:results', render);
on('security:done', render);

// ---------- boot ----------
buildForms();
render();
setInterval(render, 3000);
log('app', 'SolBot geladen — PAPER MODE (geen echt geld).', 'ok');
try {
  const prev = JSON.parse(localStorage.getItem(RUN_KEY) || '[]');
  prev.forEach((k) => bots[k]?.start());
} catch { /* ignore */ }
