import { settings, paper, tokens, on, log, PROFILES, currentProfile } from './store.js?v=20261104174655';
import { fmt } from './sniper.js?v=20261104174655';
import { initFlow, updateFlow, exchangeOf } from './flow.js?v=20261104174655';
import { initPWA, keepAwake, notifyState, toggleNotify } from './pwa.js?v=20261104174655';
import { getModel } from './model.js?v=20261104174655';
import { createEngine } from './engine.js?v=20261104174655';
import { remote, detectRemote, remoteCmd, startRemote, pull, exportBackup, importBackup } from './remote.js?v=20261104174655';
import { renderAnalyse, exportTracker, exportTrades, agg, insights } from './inzichten.js?v=20261104174655';

const eng = createEngine();
const { sniper, security, real, trader, tracker, bots } = eng;

/** Runs a user action: locally, or on the Mac when the dashboard is connected to it. */
async function run(name, args = {}) {
  try {
    if (remote.active) {
      const r = await remoteCmd(name, args);
      await pull(eng);
      return r;
    }
    return await eng.commands[name](args);
  } catch (err) {
    log('app', `Actie mislukt: ${err.message}`, 'err');
    return { error: err.message };
  } finally {
    buildForms();
    render();
  }
}

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
    ['useLaunches', 'Live: nieuwe Pump.fun launches', 'bool'],
    ['useMigrations', 'Live: migraties naar PumpSwap', 'bool'],
    ['launchMinAgeMin', 'Launch: eerst checken na (min)'], ['launchMaxAgeMin', 'Launch: volgen tot (min)'],
    ['curveMinMcap', 'Bonding curve: min. mcap ($)'],
    ['youngMinScore', 'Min. score jonge coins (launch/curve/<1u)'],
    ['useModel', 'Geleerde score gebruiken als filter', 'bool'], ['minProb', 'Geleerde score: min. kans (%)'],
  ],
  security: [
    ['maxTop10', 'Max. top 10 holders (%)'], ['maxSingleHolder', 'Max. grootste holder (%)'],
    ['minLpLocked', 'Min. LP locked/burned (%)'], ['maxRiskScore', 'Max. RugCheck score'],
    ['minHolders', 'Min. holders (waarschuwing)'], ['maxRoundTrip', 'Max. round-trip verlies (%)'],
    ['testSol', 'Honeypot test bedrag (SOL)'], ['maxTransferFee', 'Max. transfer tax (%)'],
    ['maxInsiders', 'Max. insider wallets'],
    ['minOrganic', 'Min. organic score (Jupiter, 0-100)'],
    ['strictDanger', 'RugCheck "danger" risico = afkeuren', 'bool'],
    ['maxDevHold', 'Max. dev bezit (% supply)'], ['devSoldFail', 'Afkeuren als dev ≥ X% verkocht · 0 = alleen waarschuwen'],
    ['maxDevMints', 'Max. tokens gemaakt door dev'], ['lpUnlockDays', 'Waarschuwen als LP-lock afloopt binnen (dagen)'],
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
    ['maxHoldMin', 'Max. houdtijd (min)'], ['slippageBps', 'Slippage tolerantie (bps, 1000 = 10%)'],
    ['feeSol', 'Fee per transactie incl. priority/Jito (SOL)'],
    ['latencyMs', 'Realisme: vertraging transactie (ms)'], ['failPct', 'Realisme: kans mislukte transactie (%)'],
    ['devExitPct', 'Verkopen als dev ≥ X% van zijn bag dumpt · 0 = uit'], ['exitTickSec', 'Exit check elke (sec)'],
    ['maxLiqPct', 'Max. % van de pool per trade'], ['minSizeSol', 'Min. positie (SOL)'],
    ['partialTp', 'Deelverkoop bij (+%) · 0 = uit'], ['partialSell', 'Deelverkoop: % verkopen'],
    ['beAct', 'Break-even stop vanaf piek (+%) · 0 = uit'],
    ['staleMin', 'Dode coin na (min) · 0 = uit'], ['staleBand', 'Dode coin: binnen ±%'],
    ['sellPressure', 'Verkoopdruk: sells ≥ × buys (5m) · 0 = uit'],
    ['scoreSizing', 'Positiegrootte op basis van score', 'bool'],
    ['maxTradeCost', 'Max. kosten round-trip (%)'],
    ['maxPump5m', 'Pump-filter: max. stijging 5m (%)'], ['maxPump1h', 'Pump-filter: max. stijging 1u (%)'],
    ['dipPct', 'Na pump: wacht op terugval (%)'], ['dipWaitMin', 'Na pump: max. wachten (min) · 0 = uit'],
    ['dailyLossPct', 'Daglimiet verlies (% van start) · 0 = uit'],
    ['maxLossStreak', 'Pauze na X verliezen op rij · 0 = uit'], ['cooldownMin', 'Pauze duur (min)'],
    ['noRebuy', 'Nooit dezelfde coin opnieuw kopen', 'bool'],
    ['sizeSlope', 'Geleerd: invloed score op grootte (1 = normaal)'],
    ['multLijst', 'Geleerd: grootte × lijst-coins'], ['multLaunch', 'Geleerd: grootte × launches'], ['multMigratie', 'Geleerd: grootte × migraties'],
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
      if (el.type === 'checkbox') run('setting', { bot, key: el.name, value: el.checked });
      else if (el.value !== '' && Number.isFinite(Number(el.value))) run('setting', { bot, key: el.name, value: Number(el.value) });
    });
    form.addEventListener('submit', (e) => e.preventDefault());
  }
}

// ---------- shared UI pieces ----------
const hue = (str) => { let h = 7; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (sym, mint, big = false) => `<span class="av${big ? ' big' : ''}" style="--h:${hue(mint || sym || '?')}">${esc(String(sym || '?').replace(/^\$/, '').slice(0, 2).toUpperCase())}</span>`;
const tokenCell = (sym, mint, extra = '') => `<div class="tok">${avatar(sym, mint)}<div class="tok-txt"><b>${esc(sym || '?')}</b><span class="mint">${short(mint)}${extra}</span></div></div>`;
const scoreTone = (v) => (v >= 70 ? 'good' : v >= 50 ? 'mid' : 'low');
function ring(v, tone = scoreTone(v), label = Math.round(v || 0)) {
  const r = 16, c = 2 * Math.PI * r, f = Math.max(0, Math.min(100, v || 0)) / 100;
  return `<svg class="ring ${tone}" viewBox="0 0 40 40" role="img" aria-label="${esc(label)}"><circle cx="20" cy="20" r="${r}" class="bg"/><circle cx="20" cy="20" r="${r}" class="fg" stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 20 20)"/><text x="20" y="24" text-anchor="middle">${esc(label)}</text></svg>`;
}
const chip = (text, tone = '') => `<span class="chip ${tone}">${text}</span>`;
const kpiHtml = (items) => items.map(([icon, label, value, sub = '', tone = '']) => `
  <div class="kpi ${tone}"><span class="kpi-icon">${icon}</span><div class="kpi-txt"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div></div>`).join('');
const setKpis = (sel, items) => { const el = $(sel); if (el) el.innerHTML = kpiHtml(items); };
function miniSpark(vals, w = 120, h = 28) {
  if (vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || Math.abs(hi) * 0.01 || 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join('');
  return `<svg class="mspark ${vals[vals.length - 1] >= vals[0] ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}"/></svg>`;
}

function renderProfiles() {
  const cur = currentProfile();
  $('#profiles').innerHTML = Object.entries(PROFILES).map(([k, p]) =>
    `<button class="pchip ${cur === k ? 'on' : ''}" data-profile="${k}" title="${esc(p.desc)}">${p.label}</button>`).join('')
    + (cur ? '' : '<span class="pchip custom" title="Je hebt instellingen handmatig aangepast">✏️ Aangepast</span>');
}

function renderKpis() {
  const pass = sniper.results.filter((r) => r.pass).length;
  const l = sniper.live;
  setKpis('[data-bot="sniper"] [data-kpis]', [
    ['🎯', 'Kandidaten', pass, `van ${sniper.results.length} gescand`, 'accent'],
    ['🆕', 'Live launches', l.creates, `${sniper.launches.size} in de wacht`],
    ['🎓', 'Migraties', l.migrations, 'naar PumpSwap'],
    ['📡', 'Live feed', esc(l.status), l.lastMsg ? `laatste ${ago(Date.now() - l.lastMsg)} geleden` : '', l.status === 'verbonden' ? 'good' : l.status === 'uit' ? '' : 'warn'],
    ['⏱', 'Laatste check', sniper.lastRun ? ago(Date.now() - sniper.lastRun) : '—', `lijst-scan #${sniper.scans}`],
  ]);
  const st = security.stats, done = st.pass + st.fail;
  const checking = [...tokens.values()].find((t) => t.stage === 'security');
  setKpis('[data-bot="security"] [data-kpis]', [
    ['✅', 'Veilig', st.pass, 'door naar real check', 'good'],
    ['⛔', 'Afgekeurd', st.fail, 'gestopt', 'bad'],
    ['📊', 'Slagingskans', done ? `${Math.round((st.pass / done) * 100)}%` : '—', `${done} gecheckt`],
    ['⏳', 'Wachtrij', security.queue.length, 'coins wachten'],
    ['🔍', 'Nu bezig', checking ? esc(checking.symbol || short(checking.mint)) : '—', checking ? 'wordt gecheckt' : 'idle'],
  ]);
  const conf = real.done.filter((t) => t.stage !== 'rejected');
  const avg = conf.length ? Math.round(conf.reduce((a, t) => a + (t.rank || 0), 0) / conf.length) : null;
  setKpis('[data-bot="real"] [data-kpis]', [
    ['👀', 'In observatie', real.watch.length, `${settings.real.rounds} rondes × ${settings.real.intervalSec}s`, 'accent'],
    ['🏆', 'Bevestigd', conf.length, 'naar paper trader', 'gold'],
    ['✖', 'Afgewezen', real.done.length - conf.length, 'niet echt genoeg', 'bad'],
    ['⭐', 'Gem. totaalscore', avg ?? '—', 'van bevestigde coins'],
  ]);
  const s = trader.stats();
  setKpis('[data-bot="paper"] [data-kpis]', [
    ['💼', 'Equity', sol(s.equity, 3), pct(s.totalPct, 2), s.totalPct >= 0 ? 'good' : 'bad'],
    ['💰', 'Vrij saldo', sol(s.balance, 3), `start ${paper.startSol} ◎`],
    ['📈', 'Gerealiseerd', `<span class="${s.realized >= 0 ? 'pos' : 'neg'}">${s.realized >= 0 ? '+' : ''}${s.realized.toFixed(4)} ◎</span>`, `${s.trades} trades`],
    ['❌', 'Mislukte tx', (paper.fails?.tx || 0) + (paper.fails?.slip || 0), `${paper.fails?.slip || 0}× slippage · ${(paper.fails?.feesSol || 0).toFixed(3)} ◎ fees`],
    ['🎯', 'Win rate', s.trades ? `${Math.round(s.winRate)}%` : '—', `${paper.history.filter((t) => t.pnlSol > 0).length} gewonnen`],
    ['📂', 'Open posities', `${paper.positions.length}/${settings.paper.maxPos}`, sol(s.open, 3)],
    s.paused ? ['⏸', 'Status', 'gepauzeerd', esc(s.paused), 'warn'] : ['▶', 'Status', 'kopen actief', `${trader.waiting.size} wacht op terugval`, 'good'],
  ]);
  const recs = tracker.list(), a = agg(recs);
  setKpis('[data-kpis-analyse]', [
    ['🧾', 'Gevolgd', recs.length, 'coins'],
    ['📏', 'Gemeten', a.m, '≥ 15 min data'],
    ['🏆', 'Winnaar', a.win == null ? '—' : `${Math.round(a.win)}%`, 'ooit ≥ +50%', 'good'],
    ['💀', 'Rug', a.rug == null ? '—' : `${Math.round(a.rug)}%`, '≤ −80% of liq weg', 'bad'],
    ['⏱', 'Mediaan 1u', a.med60 == null ? '—' : pct(a.med60), 'na eerste keer gezien'],
  ]);
}

const confirmedCount = () => real.done.filter((t) => t.real && t.stage !== 'rejected').length;

function renderRemoteBadge() {
  const el = $('#remoteBadge');
  if (!remote.active) { el.hidden = true; return; }
  el.hidden = false;
  const stale = !remote.online || Date.now() - remote.lastOk > 15000;
  el.className = `badge remote ${stale ? 'off' : 'on'}`;
  el.textContent = stale ? `⚠️ ${remote.name} offline` : `🖥 ${remote.name}`;
  el.title = stale ? `Geen verbinding met de Mac: ${remote.error || 'geen antwoord'}` : 'Bots draaien 24/7 op de Mac';
}

function renderNotifyBtn() {
  if (remote.active) {
    const b = $('#notifyBtn');
    b.textContent = remote.ntfy ? '🔔' : '🔕';
    b.classList.toggle('on', !!remote.ntfy);
    b.title = remote.ntfy ? `Push via ntfy aan (${remote.ntfy})` : 'Pushmeldingen naar je iPhone instellen';
    return;
  }
  const st = notifyState();
  const btn = $('#notifyBtn');
  btn.textContent = st === 'on' ? '🔔' : '🔕';
  btn.classList.toggle('on', st === 'on');
  btn.title = { on: 'Meldingen staan aan (tik om uit te zetten)', off: 'Meldingen aanzetten', denied: 'Meldingen geblokkeerd in iOS-instellingen', install: 'Meldingen: zet SolBot eerst op je beginscherm', unsupported: 'Meldingen niet ondersteund' }[st];
}

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

// ---------- dashboard tiles ----------
const SRC = { lijst: '📋', launch: '🆕', migratie: '🎓' };
const srcTag = (o) => `<span title="${esc(o || 'lijst')}">${SRC[o] || '📋'}</span>`;
function liveFeedLine() {
  const l = sniper.live;
  const cls = l.status === 'verbonden' ? 'pass' : l.status === 'uit' ? 'info' : 'warn';
  return `<div class="livefeed">${pill(cls, `📡 live feed: ${l.status}`)} <span class="mint">${l.creates} launches · ${l.migrations} migraties · ${sniper.launches.size} in de wacht</span></div>`;
}

const chips = (items) => `<div class="fb-chips">${items.map(([k, v]) => `<span><b>${v}</b>${k}</span>`).join('')}</div>`;
const miniList = (rows, empty) => (rows.length
  ? `<ul class="fb-list">${rows.map(([l, r]) => `<li><span>${l}</span><span>${r}</span></li>`).join('')}</ul>`
  : `<div class="fb-empty">${empty}</div>`);
const meter = (v, cls = '') => `<div class="fb-meter ${cls}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></div>`;

function sparkline(points, w = 220, h = 40) {
  if (points.length < 2) return '';
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs, paper.startSol), hi = Math.max(...vs, paper.startSol);
  if (hi - lo < 1e-9) { hi += 0.01; lo -= 0.01; }
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const up = vs[vs.length - 1] >= paper.startSol;
  return `<svg class="fb-spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Equity verloop">
    <line x1="0" x2="${w}" y1="${y(paper.startSol)}" y2="${y(paper.startSol)}" class="base"/><path d="${d}"/></svg>`;
}

function renderFlow() {
  const s = trader.stats();
  const pass = sniper.results.filter((r) => r.pass);
  const rejected = real.done.filter((t) => t.stage === 'rejected').length;

  // exchanges
  const exchanges = {};
  for (const r of sniper.results) {
    const e = (exchanges[exchangeOf(r.dex).id] ||= { total: 0, pass: 0, last: null, lastAt: 0 });
    e.total++;
    if (r.pass) e.pass++;
    if (r.seenAt >= e.lastAt) { e.lastAt = r.seenAt; e.last = r.symbol; }
  }

  // sniper
  const sniperDetail = chips([['gescand', sniper.results.length], ['launches', sniper.live.creates], ['migraties', sniper.live.migrations]])
    + `<div class="fb-feed ${sniper.live.status === 'verbonden' ? 'on' : ''}">📡 live feed ${esc(sniper.live.status)}</div>`
    + miniList(pass.slice(0, 3).map((r) => [`${srcTag(r.origin)} ${esc(r.symbol)}`, `<b>${r.score}</b>`]), 'nog geen kandidaten');

  // security
  const st = security.stats, done = st.pass + st.fail;
  const checking = [...tokens.values()].find((t) => t.stage === 'security');
  const reasonCount = new Map();
  for (const t of security.checked) for (const c of t.security?.checks || []) if (c.status === 'fail') reasonCount.set(c.name, (reasonCount.get(c.name) || 0) + 1);
  const topReasons = [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const securityDetail = `<div class="fb-meter-row"><span>slagingskans</span><b>${done ? Math.round((st.pass / done) * 100) + '%' : '—'}</b></div>${meter(done ? (st.pass / done) * 100 : 0, 'ok')}`
    + chips([['wachtrij', security.queue.length], ['gecheckt', done]])
    + (checking ? `<div class="fb-feed on">🔍 checkt nu ${esc(checking.symbol || short(checking.mint))}</div>` : '')
    + miniList(topReasons.map(([k, n]) => [`✗ ${esc(k.replace(/^Risico: /, ''))}`, n]), 'nog geen afkeuringen');

  // real check
  const rounds = settings.real.rounds;
  const lastConf = real.done.find((t) => t.stage !== 'rejected');
  const realDetail = chips([['bevestigd', confirmedCount()], ['afgewezen', rejected]])
    + (real.watch.length
      ? `<ul class="fb-list">${real.watch.slice(0, 3).map((w) => `<li class="prog"><span>${esc(w.symbol || short(w.mint))}</span><span>${w.snaps.length}/${rounds}</span>${meter((w.snaps.length / rounds) * 100)}</li>`).join('')}</ul>`
      : '<div class="fb-empty">geen coins in observatie</div>')
    + (lastConf ? `<div class="fb-feed gold">🏆 laatst: ${esc(lastConf.symbol)} (${lastConf.rank})</div>` : '');

  // paper
  const pts = [...paper.equityHist.slice(-120), { t: Date.now(), v: s.equity }];
  const paperDetail = sparkline(pts)
    + chips([['saldo', s.balance.toFixed(2) + '◎'], ['open', `${paper.positions.length}/${settings.paper.maxPos}`], ['win', s.trades ? Math.round(s.winRate) + '%' : '—']])
    + (s.paused ? `<div class="fb-feed">⏸ ${esc(s.paused)}</div>` : '')
    + miniList(paper.positions.slice(0, 3).map((p) => [`${p.partialDone ? '🟡 ' : ''}${esc(p.symbol)}`, pct(p.pnlPct)]), 'geen open posities');

  // analyse
  const recs = tracker.list();
  const a = agg(recs);
  const ins = insights(recs)[0];
  updateFlow({
    running: Object.fromEntries(Object.entries(bots).map(([k, b]) => [k, b.running])),
    exchanges,
    bots: {
      sniper: { big: String(pass.length), label: 'kandidaten', detail: sniperDetail },
      security: {
        big: `<span class="pos">${st.pass}✓</span> <span class="neg">${st.fail}✗</span>`,
        label: 'veilig / afgekeurd', detail: securityDetail,
      },
      real: { big: String(real.watch.length), label: 'in observatie', detail: realDetail },
      paper: { big: pct(s.totalPct, 2), label: `${s.equity.toFixed(3)} ◎ equity`, detail: paperDetail },
    },
    analyse: {
      stats: chips([['gevolgd', recs.length], ['gemeten', a.m], ['winnaar', a.win == null ? '—' : Math.round(a.win) + '%'], ['rug', a.rug == null ? '—' : Math.round(a.rug) + '%']]),
      insight: ins ? `${ins[0] === 'ok' ? '✅' : ins[0] === 'warn' ? '⚠️' : '💡'} ${esc(ins[1])}` : '',
    },
  });
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

let sniperFilter = 'all';
const SNIPER_FILTERS = [
  ['all', 'Alle', () => true],
  ['cand', '🎯 Kandidaten', (r) => r.pass],
  ['launch', '🆕 Launches', (r) => r.origin === 'launch'],
  ['migratie', '🎓 Migraties', (r) => r.origin === 'migratie'],
  ['lijst', '📋 Lijsten', (r) => (r.origin || 'lijst') === 'lijst'],
];
const srcBadge = (r) => {
  const o = r.origin || 'lijst';
  const label = o === 'launch' ? '🆕 Launch' : o === 'migratie' ? '🎓 Migratie' : '📋 Lijst';
  return `<div class="src"><span class="chip ${o}">${label}</span><span class="mint">${esc(r.dex || '')}${r.curve ? ' · curve' : ''}</span></div>`;
};

function renderSniper() {
  $('[data-filters="sniper"]').innerHTML = SNIPER_FILTERS.map(([k, l, f]) =>
    `<button class="fchip ${sniperFilter === k ? 'on' : ''}" data-filter="${k}">${l} <span>${sniper.results.filter(f).length}</span></button>`).join('');
  const f = (SNIPER_FILTERS.find((x) => x[0] === sniperFilter) || SNIPER_FILTERS[0])[2];
  const rows = sniper.results.filter(f).slice(0, 50);
  const srcs = Object.entries(sniper.sources);
  const srcLine = `<div class="srcline"><span class="mint">Bronnen laatste scan:</span> ${chip(`🆕 PumpPortal live <b>${sniper.live.creates}</b>`, 'launch')}${chip(`🎓 migraties <b>${sniper.live.migrations}</b>`, 'migratie')}${srcs.map(([k, n]) => chip(`${esc(k)} <b>${n}</b>`)).join('')}</div>`;
  $('[data-bot="sniper"] [data-body]').innerHTML = srcLine + (rows.length ? `
    <table class="nice"><thead><tr><th>Token</th><th>Bron</th><th>Score</th><th class="r" title="Bij bonding curve: ~20% van market cap">Liq</th><th class="r">Vol 1u</th><th class="r">B/S</th><th class="r">1u</th><th class="r">Leeftijd</th>${getModel() ? '<th class="r" title="Kans op een winnaar volgens de geleerde score">Kans</th>' : ''}<th>Status</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="click ${r.pass ? '' : 'dim'}" data-mint="${esc(r.mint)}">
        <td>${tokenCell(r.symbol, r.mint)}</td>
        <td>${srcBadge(r)}</td>
        <td>${ring(r.score)}</td>
        <td class="r">$${fmt(r.liq)}</td><td class="r">$${fmt(r.volH1)}</td>
        <td class="r">${r.bs.toFixed(2)}</td><td class="r">${pct(r.mom, 0)}</td>
        <td class="r">${r.ageH < 999 ? ago(r.ageH * 3.6e6) : '?'}</td>
        ${getModel() ? `<td class="r">${r.prob == null ? '—' : `${Math.round(r.prob * 100)}%`}</td>` : ''}
        <td>${r.pass ? chip('✓ kandidaat', 'good') : `<span class="reason" title="${esc(r.reason)}">${esc(r.reason)}</span>`}</td>
      </tr>`).join('')}</tbody></table>`
    : `<div class="empty big">${sniper.busy ? '⏳ Scannen…' : sniper.results.length ? 'Geen coins in dit filter.' : '🎯 Nog geen scan. Klik op Start of Nu scannen.'}</div>`);
}

function renderSecurity() {
  const q = security.queue;
  const cards = security.checked.slice(0, 30);
  $('[data-bot="security"] [data-body]').innerHTML = `
    <div class="sectionlbl">Wachtrij · ${q.length}</div>
    <div class="queue">${q.length ? q.map((t) => `<span class="qchip click" data-mint="${esc(t.mint)}">${avatar(t.symbol, t.mint)}${esc(t.symbol || short(t.mint))}</span>`).join('') : '<span class="mint">leeg</span>'}</div>
    <div class="sectionlbl">Gecontroleerd · ${security.checked.length}</div>
    ${cards.length ? `<div class="tgrid">${cards.map((t) => {
      const c = t.security?.checks || [];
      const fails = c.filter((x) => x.status === 'fail'), warns = c.filter((x) => x.status === 'warn');
      const ok = !fails.length;
      return `<div class="tcard click ${ok ? 'ok' : 'bad'}" data-mint="${esc(t.mint)}">
        <div class="tc-head">${tokenCell(t.symbol, t.mint)}${ring(t.security.score)}</div>
        <div class="tc-chips">${chip(`✓ ${c.length - fails.length - warns.length}`, 'good')}${warns.length ? chip(`! ${warns.length}`, 'warn') : ''}${fails.length ? chip(`✗ ${fails.length}`, 'bad') : ''}${t.security.roundTrip != null ? chip(`round-trip ${t.security.roundTrip.toFixed(1)}%`) : ''}</div>
        <ul class="tc-list">${ok ? `<li class="good">✓ Alle harde checks OK${warns.length ? ` (${warns.length} waarschuwing${warns.length > 1 ? 'en' : ''})` : ''}</li>` : fails.slice(0, 3).map((x) => `<li class="bad">✗ ${esc(x.name.replace(/^Risico: /, ''))}</li>`).join('')}${fails.length > 3 ? `<li class="mint">+${fails.length - 3} meer</li>` : ''}</ul>
        <div class="tc-foot">${ok ? chip('🛡️ veilig', 'good') : chip('⛔ afgekeurd', 'bad')}<span class="mint">${t.security.at ? ago(Date.now() - t.security.at) + ' geleden' : ''}</span></div>
      </div>`; }).join('')}</div>` : '<div class="empty big">🛡️ Nog niets gecontroleerd.</div>'}`;
}

function renderReal() {
  const s = settings.real;
  const done = real.done.slice(0, 24);
  $('[data-bot="real"] [data-body]').innerHTML = `
    <div class="sectionlbl">In observatie · ${real.watch.length}</div>
    ${real.watch.length ? `<div class="tgrid">${real.watch.map((w) => {
      const a = w.snaps[0], b = w.snaps[w.snaps.length - 1];
      return `<div class="tcard click watch" data-mint="${esc(w.mint)}">
        <div class="tc-head">${tokenCell(w.symbol, w.mint)}${ring((w.snaps.length / s.rounds) * 100, 'accent', `${w.snaps.length}/${s.rounds}`)}</div>
        ${miniSpark(w.snaps.map((x) => x.price)) || '<div class="mint">wacht op eerste meting…</div>'}
        <div class="tc-chips">${a && b && a.price ? chip(`prijs ${pct((b.price / a.price - 1) * 100)}`) : ''}${a && b && a.liq ? chip(`liq ${pct((b.liq / a.liq - 1) * 100)}`) : ''}${b ? chip(`B/S ${((b.bsM5 + b.bsH1) / 2).toFixed(2)}`) : ''}</div>
        <div class="tc-foot">${chip('👀 observeren', 'accent')}<span class="mint">volgende ${w.next ? ago(Math.max(0, w.next - Date.now())) : 'nu'}</span></div>
      </div>`; }).join('')}</div>` : '<div class="empty">Geen coins in observatie.</div>'}
    <div class="sectionlbl">Resultaten · ${real.done.length}</div>
    ${done.length ? `<div class="tgrid">${done.map((t) => {
      const ok = t.stage !== 'rejected' || !t.real.checks.some((c) => c.status === 'fail');
      const fails = t.real.checks.filter((c) => c.status === 'fail');
      return `<div class="tcard click ${ok ? 'gold' : 'bad'}" data-mint="${esc(t.mint)}">
        <div class="tc-head">${tokenCell(t.symbol, t.mint)}${ring(t.real.score)}</div>
        <div class="tc-total"><span>Totaalscore</span><b>${t.rank ?? '—'}</b></div>
        <ul class="tc-list">${ok ? t.real.checks.slice(0, 3).map((c) => `<li class="${c.status === 'pass' ? 'good' : 'warn'}">${c.status === 'pass' ? '✓' : '!'} ${esc(c.name)} <span class="mint">${esc(c.detail)}</span></li>`).join('') : fails.slice(0, 3).map((c) => `<li class="bad">✗ ${esc(c.name)} <span class="mint">${esc(c.detail)}</span></li>`).join('')}</ul>
        <div class="tc-foot">${ok ? chip('🏆 bevestigd', 'gold') : chip('✖ afgewezen', 'bad')}<span class="mint">${ago(Date.now() - t.real.at)} geleden</span></div>
      </div>`; }).join('')}</div>` : '<div class="empty big">👀 Nog geen resultaten.</div>'}`;
}

function renderPaper() {
  const s = settings.paper;
  const pos = paper.positions;
  const sig = trader.signals.filter((t) => !pos.some((p) => p.mint === t.mint));
  const span = s.tp + s.sl;
  const at = (v) => Math.max(0, Math.min(100, ((v + s.sl) / span) * 100));
  const paused = trader.riskBlock();
  $('[data-bot="paper"] [data-body]').innerHTML = `
    ${paused ? `<div class="insight warn">⏸ Kopen gepauzeerd: ${esc(paused)}. Open posities worden wel gewoon beheerd.</div>` : ''}
    <div class="sectionlbl">Open posities · ${pos.length}/${s.maxPos}</div>
    ${pos.length ? `<div class="tgrid wide">${pos.map((p) => `
      <div class="tcard pcard ${p.pnlPct >= 0 ? 'ok' : 'bad'}">
        <div class="tc-head"><div class="click" data-mint="${esc(p.mint)}">${tokenCell(p.symbol, p.mint)}</div><div class="pnl ${p.pnlPct >= 0 ? 'pos' : 'neg'}">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%</div></div>
        <div class="range" title="Stop loss -${s.sl}% · Take profit +${s.tp}%">
          <div class="range-track"><i class="zero" style="left:${at(0)}%"></i><i class="peak" style="left:${at(p.peakPct)}%" title="piek"></i><i class="now ${p.pnlPct >= 0 ? 'up' : 'down'}" style="left:${at(p.pnlPct)}%"></i></div>
          <div class="range-lbl"><span>SL −${s.sl}%</span><span>0</span><span>TP +${s.tp}%</span></div>
        </div>
        <div class="tc-chips">${chip(`in ${sol(p.entrySol)}`)}${chip(`nu ${sol(p.lastValueSol)}`)}${chip(`piek ${p.peakPct >= 0 ? '+' : ''}${p.peakPct.toFixed(1)}%`)}${chip(`⏱ ${ago(Date.now() - p.entryTs)}`)}
          ${p.partialDone ? chip(`🟡 deel verkocht +${(p.realizedSol || 0).toFixed(3)}◎`, 'gold') : ''}
          ${s.beAct > 0 && p.peakPct >= s.beAct ? chip('🛡 break-even stop actief', 'good') : ''}
          ${p.sizeFactor && p.sizeFactor !== 1 ? chip(`${p.sizeFactor.toFixed(2)}× grootte`) : ''}
          ${p.m5 ? chip(`5m ${p.m5.buys}B/${p.m5.sells}S`, p.m5.sells > p.m5.buys * 1.5 ? 'bad' : '') : ''}</div>
        <div class="tc-foot"><a href="${dexUrl(p.mint)}" target="_blank" rel="noopener" class="mint">DexScreener ↗</a><button class="btn small" data-close="${esc(p.id)}">Verkoop</button></div>
      </div>`).join('')}</div>` : '<div class="empty big">📂 Geen open posities.</div>'}
    ${trader.waiting.size ? `<div class="sectionlbl">Wacht op terugval na pump · ${trader.waiting.size}</div>
    <div class="queue">${[...trader.waiting.values()].map((w) => `<span class="qchip click" data-mint="${esc(w.t.mint)}">${avatar(w.t.symbol, w.t.mint)}${esc(w.t.symbol)} <span class="mint">${w.high && w.last ? `${((w.last / w.high - 1) * 100).toFixed(0)}% van top` : ''} · nog ${ago(Math.max(0, w.since + s.dipWaitMin * 60000 - Date.now()))}</span></span>`).join('')}</div>` : ''}
    <div class="sectionlbl">Signalen (bevestigd, niet gekocht)</div>
    ${sig.length ? `<div class="queue">${sig.map((t) => `<span class="qchip">${avatar(t.symbol, t.mint)}<b class="click" data-mint="${esc(t.mint)}">${esc(t.symbol)}</b> <span class="mint">score ${t.rank}</span><button class="btn small primary" data-buy="${esc(t.mint)}">Buy ${s.sizeSol} ◎</button></span>`).join('')}</div>`
      : `<div class="mint">${s.autoTrade ? 'Auto-trade aan: bevestigde coins worden direct gekocht zolang de trader draait.' : 'Nog geen signalen.'}</div>`}`;
}

function renderHistory() {
  const h = paper.history.slice(0, 60);
  $('#history').innerHTML = h.length ? `
    <table class="nice"><thead><tr><th>Token</th><th>Gekocht</th><th class="r">In</th><th class="r">Uit</th><th class="r">P&L</th><th class="r">Duur</th><th>Reden</th></tr></thead><tbody>
    ${h.map((t) => `
      <tr class="click" data-mint="${esc(t.mint)}">
        <td>${tokenCell(t.symbol, t.mint)}</td><td>${new Date(t.entryTs).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td class="r">${sol(t.entrySol)}</td><td class="r">${sol(t.exitSol)}</td>
        <td class="r">${chip(`${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`, t.pnlSol >= 0 ? 'good' : 'bad')} <span class="mint">${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)}</span></td>
        <td class="r">${ago(t.exitTs - t.entryTs)}</td><td class="reason" title="${esc(t.reason)}">${esc(t.reason)}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty big">📜 Nog geen gesloten paper trades.</div>';
}

let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderKpis(); renderFlow(); renderProfiles(); renderNotifyBtn(); renderRemoteBadge();
    keepAwake(Object.values(bots).some((b) => b.running)); // screen stays on while bots run
    Object.keys(bots).forEach(renderBotHead);
    renderSniper(); renderSecurity(); renderReal(); renderPaper(); renderHistory();
    renderEquity();
    const an = $('#analyse');
    if (an.offsetParent !== null) renderAnalyse(an, tracker, paper.history, eng.learner);
    $('[data-cnt="analyse"]').textContent = Object.keys(tracker.records).length || '';
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
function checkList(checks) {
  const icon = { pass: '✓', warn: '!', fail: '✗' };
  return `<ul class="checks">${checks.map((c) => `<li class="${c.status}"><span class="ci">${icon[c.status] || '•'}</span><div><b>${esc(c.name)}</b><div class="mint">${esc(c.detail)}</div></div></li>`).join('')}</ul>`;
}
function showDetail(mint) {
  const t = tokens.get(mint) || { mint, ...(sniper.results.find((r) => r.mint === mint) || {}) };
  const rec = tracker.records[mint];
  const p = t.pair;
  const stageLabel = { 'security-queue': 'wacht op security', security: 'in security', 'watch-queue': 'naar real check', watching: 'in observatie', confirmed: 'bevestigd', traded: 'gekocht', rejected: 'afgekeurd' };
  const scores = [['Sniper', t.sniperScore ?? t.score], ['Security', t.security?.score], ['Real', t.real?.score], ['Totaal', t.rank]].filter(([, v]) => v != null);
  $('#detailBody').innerHTML = `
    <div class="dlg-head">${avatar(t.symbol || rec?.sym, mint, true)}<div><h3>${esc(t.symbol || rec?.sym || '?')} <span class="mint">${esc(t.name || '')}</span></h3>
      <div class="mint">${esc(mint)}</div>
      <div class="tc-chips">${chip(esc(stageLabel[t.stage] || t.stage || 'gescand'), t.stage === 'rejected' ? 'bad' : t.stage === 'traded' || t.stage === 'confirmed' ? 'gold' : 'accent')}${t.origin ? chip(esc(t.origin)) : ''}${p ? chip(esc(p.dexId)) : ''}</div></div></div>
    ${t.rejectReason ? `<div class="insight warn">⛔ ${esc(t.rejectReason)}</div>` : ''}
    ${scores.length ? `<div class="dlg-scores">${scores.map(([l, v]) => `<div>${ring(v)}<span>${l}</span></div>`).join('')}</div>` : ''}
    ${p ? `<div class="kpis compact">${kpiHtml([
      ['💵', 'Prijs', `$${esc(p.priceUsd)}`], ['💧', 'Liquiditeit', `$${fmt(p.liquidity?.usd || 0)}`], ['🏷', 'Market cap', `$${fmt(p.marketCap || p.fdv || 0)}`], ['📊', 'Volume 24u', `$${fmt(p.volume?.h24 || 0)}`],
    ])}</div>` : ''}
    ${rec ? `<div class="sectionlbl">Gemeten na eerste keer gezien</div><div class="tc-chips">${[[15, '15m'], [60, '1u'], [360, '6u']].map(([c, l]) => chip(`${l}: ${rec.cp[c] == null ? '—' : pct(rec.cp[c])}`)).join('')}${chip(`max ${pct(rec.max)}`)}${rec.rug ? chip('💀 rug', 'bad') : ''}</div>` : ''}
    <div class="links">
      <a class="btn small" href="${dexUrl(mint)}" target="_blank" rel="noopener">DexScreener ↗</a>
      <a class="btn small" href="https://rugcheck.xyz/tokens/${encodeURIComponent(mint)}" target="_blank" rel="noopener">RugCheck ↗</a>
      <a class="btn small" href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener">Solscan ↗</a>
      <a class="btn small" href="https://jup.ag/swap/SOL-${encodeURIComponent(mint)}" target="_blank" rel="noopener">Jupiter ↗</a>
    </div>
    ${t.security ? `<div class="sectionlbl">2 · Security check</div>${checkList(t.security.checks)}` : ''}
    ${t.real ? `<div class="sectionlbl">3 · Real check</div>${checkList(t.real.checks)}` : ''}
    ${!t.security && !tokens.has(mint) ? `<p><button class="btn primary" data-check="${esc(mint)}">🛡️ Security check uitvoeren</button></p>` : ''}`;
  $('#detail').showModal();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-mint],[data-close],[data-buy],[data-check],[data-toggle],[data-once],[data-settings],[data-clear-log],[data-goto],[data-filter],[data-profile],[data-apply-exit],[data-apply-filter],[data-train-model],[data-model-use],[data-learn-auto],[data-learn-run],[data-learn-revert]');
  if (!el) return;
  const card = el.closest('[data-bot],[data-mini]');
  if (el.hasAttribute('data-clear-log')) {
    $('[data-log]', el.closest('.card')).innerHTML = '';
  } else if (el.hasAttribute('data-toggle')) {
    run('toggle', { bot: card.dataset.bot || card.dataset.mini });
  } else if (el.hasAttribute('data-once')) {
    run('once', { bot: card.dataset.bot });
  } else if (el.hasAttribute('data-settings')) {
    const f = $('[data-form]', card); f.hidden = !f.hidden;
  } else if (el.dataset.close) {
    el.disabled = true;
    await run('close', { id: el.dataset.close });
  } else if (el.dataset.buy) {
    el.disabled = true;
    await run('buy', { mint: el.dataset.buy });
  } else if (el.dataset.check) {
    $('#detail').close();
    run('check', { mint: el.dataset.check });
  } else if (el.dataset.mint) {
    showDetail(el.dataset.mint);
  } else if (el.hasAttribute('data-learn-auto')) {
    run('setting', { bot: 'learn', key: 'auto', value: !settings.learn.auto });
  } else if (el.hasAttribute('data-learn-run')) {
    el.disabled = true;
    await run('learnRun');
  } else if (el.dataset.learnRevert) {
    if (confirm('Deze automatische aanpassing terugdraaien?')) run('learnRevert', { id: el.dataset.learnRevert });
  } else if (el.dataset.applyFilter) {
    const cfg = JSON.parse(el.dataset.applyFilter);
    run('settings', { bot: 'sniper', patch: cfg, msg: `Sniper-drempels uit filter-optimizer toegepast: score ≥ ${cfg.minScore} (jong ${cfg.youngMinScore}), liq ≥ $${cfg.minLiq}, vol ≥ $${cfg.minVolH1}, B/S ≥ ${cfg.minBuySell}` });
  } else if (el.hasAttribute('data-train-model')) {
    run('train', { manual: true });
  } else if (el.dataset.modelUse) {
    const use = el.dataset.modelUse === '1';
    run('settings', { bot: 'sniper', patch: { useModel: use }, msg: `Geleerde score ${use ? 'aan' : 'uit'} als sniper-filter` });
  } else if (el.dataset.applyExit) {
    const cfg = JSON.parse(el.dataset.applyExit);
    run('settings', { bot: 'paper', patch: cfg, msg: `Exit-instellingen uit optimizer toegepast: TP +${cfg.tp}%, SL −${cfg.sl}%, trailing ${cfg.trailAct ? `${cfg.trail}% na +${cfg.trailAct}%` : 'uit'}, deelverkoop ${cfg.partialTp ? `+${cfg.partialTp}%` : 'uit'}` });
  } else if (el.dataset.profile) {
    run('profile', { name: el.dataset.profile });
  } else if (el.dataset.filter) {
    sniperFilter = el.dataset.filter;
    render();
  } else if (el.dataset.goto) {
    location.hash = `#/${el.dataset.goto}`;
  }
});

$$('form.manual').forEach((form) => form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = form.elements.mint;
  const mint = input.value.trim();
  if (!mint) return;
  const r = await run('check', { mint });
  if (!r?.error) input.value = '';
}));

$('#notifyBtn').onclick = async () => {
  if (!remote.active) { await toggleNotify(); render(); return; }
  // On the Mac server: real push to the iPhone via the free ntfy app, also when the phone is locked.
  const topic = prompt('Pushmeldingen van je Mac naar je iPhone (gratis app "ntfy"):\n\n1. Installeer "ntfy" uit de App Store\n2. Tik daar op + en kies een eigen, moeilijk te raden naam, bijv. solbot-' + Math.random().toString(36).slice(2, 8) + '\n3. Vul precies dezelfde naam hier in\n\nLeeg laten = meldingen uit.', remote.ntfy || '');
  if (topic === null) return;
  const r = await run('ntfy', { topic });
  remote.ntfy = r?.result?.topic || '';
  render();
};
$('#startAll').onclick = () => run('startAll');
$('#stopAll').onclick = () => run('stopAll');
$('#resetPaper').onclick = () => { if (confirm('Paper account resetten? Alle posities en historie worden gewist.')) run('resetPaper'); };
$('#exportTracker').onclick = () => exportTracker(tracker);
$('#exportTrades').onclick = () => exportTrades(paper.history);
$('#resetTracker').onclick = () => { if (confirm('Alle metingen wissen?')) run('resetTracker'); };
$('#resetSettings').onclick = () => { if (confirm('Alle instellingen terugzetten naar standaard?')) run('resetSettings'); };
$('#exportBackup').onclick = async () => {
  try {
    const b = await exportBackup();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
    a.download = `solbot-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  } catch (err) { log('app', `Backup mislukt: ${err.message}`, 'err'); }
};
$('#importBackup').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const b = JSON.parse(await file.text());
    if (!confirm(`Backup van ${new Date(b.at).toLocaleString('nl-NL')} terugzetten? Huidige data${remote.active ? ' op de Mac' : ''} wordt vervangen.`)) return;
    await importBackup(b);
    log('app', 'Backup teruggezet, herstarten…', 'ok');
    setTimeout(() => location.reload(), remote.active ? 4000 : 300);
  } catch (err) { log('app', `Terugzetten mislukt: ${err.message}`, 'err'); }
  e.target.value = '';
};

on('bot', render);
on('sniper:results', render);
on('security:done', render);

// ---------- router: one page app, so the bots keep running across pages ----------
const ROUTES = { dashboard: 'Dashboard', sniper: 'Sniper', security: 'Security check', real: 'Real check', paper: 'Paper trader', analyse: 'Analyse' };
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
initPWA();
initFlow($('#flow'));
window.__solbotStarted = true;
document.getElementById('bootError').hidden = true;
buildForms();
route();
setInterval(render, 3000);
detectRemote().then((isRemote) => {
  if (isRemote) {
    // Dashboard served by the Mac: show the Mac's bots, don't run any here.
    document.documentElement.classList.add('remote');
    log('app', `🖥 Verbonden met ${remote.name}: de bots draaien 24/7 op de Mac.`, 'ok');
    startRemote(eng, () => { buildFormsIfIdle(); render(); });
    remoteCmd('serverInfo').then((r) => { remote.ntfy = r?.result?.ntfyTopic || ''; render(); }).catch(() => {});
    remoteCmd('dashboardUrl', { url: location.origin }).catch(() => {}); // lets ntfy notifications open this dashboard
  } else {
    eng.startLocal();
    log('app', 'SolBot geladen — PAPER MODE (geen echt geld). De bots draaien in deze browser.', 'ok');
  }
  render();
});

/** In remote mode settings can change on the Mac (or another device): refresh forms unless you are typing. */
let lastSettings = '';
function buildFormsIfIdle() {
  const now = JSON.stringify(settings);
  if (now === lastSettings || document.activeElement?.closest?.('[data-form]')) return;
  lastSettings = now;
  buildForms();
}
