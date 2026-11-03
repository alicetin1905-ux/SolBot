// Analyse page: turns tracker records into "do my filters work?" answers.
import { CHECKPOINTS, STAGES, WIN_PCT, RUG_PCT } from './metingen.js?v=20261103192235';
import { exchangeOf } from './flow.js?v=20261103192235';
import { exitKind } from './paper.js?v=20261103192235';
import { settings } from './store.js?v=20261103192235';
import { getModel, FEATURES, labeled, MIN_SAMPLES } from './model.js?v=20261103192235';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctCell = (v, d = 0) => (v == null ? '<span class="mint">—</span>' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`);
const rate = (v, cls) => (v == null ? '<span class="mint">—</span>'
  : `<span class="rate ${cls}"><span class="rate-bar"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></span><b>${Math.round(v)}%</b></span>`);
const MIN_N = 8;

/** Aggregates a group of records. Win/rug rates use coins measured for at least 15 min. */
export function agg(recs) {
  const base = recs.filter((r) => r.cp[15] != null);
  const c60 = recs.map((r) => r.cp[60]).filter((v) => v != null);
  return {
    n: recs.length,
    m: base.length,
    med15: median(base.map((r) => r.cp[15])),
    med60: median(c60),
    win: base.length ? (base.filter((r) => r.max >= WIN_PCT).length / base.length) * 100 : null,
    rug: base.length ? (base.filter((r) => r.rug).length / base.length) * 100 : null,
  };
}

function groupBy(recs, keyFn) {
  const m = new Map();
  for (const r of recs) for (const k of [].concat(keyFn(r))) {
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function table(title, rows, firstCol = 'Groep', sub = '') {
  if (!rows.length) return '';
  return `<article class="card"><header class="card-head"><div class="title"><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></header><div class="body">
  <table class="nice"><thead><tr><th>${firstCol}</th><th class="r">Coins</th><th class="r">Gemeten</th><th class="r">Mediaan 15m</th><th class="r">Mediaan 1u</th><th class="r">Winnaar</th><th class="r">Rug</th></tr></thead><tbody>
  ${rows.map(([label, a]) => `<tr><td>${label}</td><td class="r">${a.n}</td><td class="r">${a.m}</td><td class="r">${pctCell(a.med15, 1)}</td><td class="r">${pctCell(a.med60, 1)}</td><td class="r">${rate(a.win, 'pos')}</td><td class="r">${rate(a.rug, 'neg')}</td></tr>`).join('')}
  </tbody></table></div></article>`;
}

export function insights(recs) {
  const out = [];
  const byStage = groupBy(recs, (r) => r.stage);
  const a = (k) => agg(byStage.get(k) || []);
  const filt = a('filtered'), sec = a('security-fail'), real = a('real-fail');
  const good = agg([...(byStage.get('confirmed') || []), ...(byStage.get('traded') || [])]);
  const measured = recs.filter((r) => r.cp[15] != null).length;

  if (measured < MIN_N) {
    out.push(['info', `Nog te weinig metingen (${measured} coins met ≥15 min data). Laat de bots een paar uur draaien; vanaf ~50 coins worden de cijfers betrouwbaar.`]);
    return out;
  }
  if (sec.m >= MIN_N) {
    if (sec.rug >= 40) out.push(['ok', `Security werkt: ${Math.round(sec.rug)}% van de afgekeurde coins rugde daarna.`]);
    if (sec.win >= 25) out.push(['warn', `Security is misschien te streng: ${Math.round(sec.win)}% van de afgekeurde coins werd later winnaar (≥ +${WIN_PCT}%). Kijk welke afkeur-reden die winnaars had.`]);
  }
  if (good.m >= 5 && sec.m >= MIN_N) {
    if (good.rug < sec.rug) out.push(['ok', `Bevestigde coins rugden minder (${Math.round(good.rug)}%) dan afgekeurde (${Math.round(sec.rug)}%).`]);
    else out.push(['warn', `Bevestigde coins rugden niet minder vaak (${Math.round(good.rug)}%) dan afgekeurde (${Math.round(sec.rug)}%): de checks onderscheiden nog slecht.`]);
  }
  if (real.m >= 5 && real.win >= 30) out.push(['warn', `${Math.round(real.win)}% van de door real check afgewezen coins werd winnaar: real check is mogelijk te streng (minder rondes of lagere min. score).`]);
  if (filt.m >= MIN_N * 3 && filt.win >= 15) out.push(['info', `${Math.round(filt.win)}% van de door de sniper gefilterde coins werd toch winnaar. Kijk bij "Sniper filter-redenen" welke filter dat vooral was.`]);

  // Security reasons: which one predicts rugs well / blocks winners.
  const reasons = [...groupBy(byStage.get('security-fail') || [], (r) => r.fails).entries()]
    .map(([k, v]) => [k, agg(v)]).filter(([, x]) => x.m >= 5);
  const bestRug = reasons.sort((x, y) => y[1].rug - x[1].rug)[0];
  if (bestRug && bestRug[1].rug >= 50) out.push(['ok', `"${bestRug[0]}" is de sterkste rug-voorspeller (${Math.round(bestRug[1].rug)}% rugde).`]);
  const worst = reasons.sort((x, y) => y[1].win - x[1].win)[0];
  if (worst && worst[1].win >= 30) out.push(['warn', `"${worst[0]}" houdt veel winnaars tegen (${Math.round(worst[1].win)}% winnaar). Overweeg die drempel soepeler te zetten.`]);

  const ex = [...groupBy(recs, (r) => exchangeOf(r.dex).name).entries()].map(([k, v]) => [k, agg(v)]).filter(([, x]) => x.m >= MIN_N);
  if (ex.length > 1) {
    ex.sort((x, y) => (y[1].med60 ?? -999) - (x[1].med60 ?? -999));
    if (ex[0][1].med60 != null) out.push(['info', `Beste exchange tot nu toe: ${ex[0][0]} (mediaan 1u ${ex[0][1].med60 >= 0 ? '+' : ''}${ex[0][1].med60.toFixed(1)}%).`]);
  }
  if (!out.length) out.push(['info', 'Nog geen duidelijke patronen. Blijf meten.']);
  return out;
}

// ---------- trade analysis ----------
export function tradeAgg(trades) {
  const pnl = trades.map((t) => t.pnlPct);
  return {
    n: trades.length,
    win: trades.length ? (trades.filter((t) => t.pnlSol > 0).length / trades.length) * 100 : null,
    avg: trades.length ? pnl.reduce((a, b) => a + b, 0) / trades.length : null,
    sum: trades.reduce((a, t) => a + t.pnlSol, 0),
    best: trades.length ? Math.max(...pnl) : null,
    worst: trades.length ? Math.min(...pnl) : null,
  };
}

function tradeTable(title, rows, firstCol, sub = '') {
  if (!rows.length) return '';
  return `<article class="card"><header class="card-head"><div class="title"><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></header><div class="body">
  <table class="nice"><thead><tr><th>${firstCol}</th><th class="r">Trades</th><th class="r">Win rate</th><th class="r">Gem. P&L</th><th class="r">Totaal</th><th class="r">Beste</th><th class="r">Slechtste</th></tr></thead><tbody>
  ${rows.map(([label, a]) => `<tr><td>${label}</td><td class="r">${a.n}</td><td class="r">${rate(a.win, 'pos')}</td><td class="r">${pctCell(a.avg, 1)}</td>
    <td class="r"><span class="${a.sum >= 0 ? 'pos' : 'neg'}">${a.sum >= 0 ? '+' : ''}${a.sum.toFixed(3)} ◎</span></td><td class="r">${pctCell(a.best)}</td><td class="r">${pctCell(a.worst)}</td></tr>`).join('')}
  </tbody></table></div></article>`;
}

// ---------- exit optimizer ----------
/**
 * Replays one recorded price path (minutes, % vs. price at confirmation) with
 * the given exit rules. Conservative: stops fill at the sampled (worse) price,
 * take profits fill exactly at their level. Returns the trade result in %.
 */
export function simulate(path, cfg, costPct, partialFrac) {
  let frac = 1, realized = 0, peak = 0, partialDone = false;
  const done = (pct) => (realized + frac * (1 + pct / 100) - 1) * 100 - costPct;
  for (const [, pct] of path) {
    if (pct > peak) peak = pct;
    if (pct <= -cfg.sl) return done(pct);
    if (cfg.partialTp && !partialDone && pct >= cfg.partialTp) {
      realized += partialFrac * (1 + cfg.partialTp / 100);
      frac -= partialFrac;
      partialDone = true;
    }
    if (pct >= cfg.tp) return done(cfg.tp);
    if (cfg.trailAct && peak >= cfg.trailAct && pct <= peak - cfg.trail) return done(pct);
  }
  return done(path.length ? path[path.length - 1][1] : 0);
}

export function optimize(paths, costPct, partialFrac) {
  const grid = [];
  for (const tp of [40, 60, 100, 150, 250]) for (const sl of [10, 15, 20, 30]) for (const [trailAct, trail] of [[0, 0], [20, 10], [20, 15], [30, 20]]) {
    for (const partialTp of [0, 20, 35]) if (!partialTp || partialTp < tp) grid.push({ tp, sl, trailAct, trail, partialTp });
  }
  const evalCfg = (cfg) => {
    const r = paths.map((p) => simulate(p, cfg, costPct, partialFrac));
    return { cfg, avg: r.reduce((a, b) => a + b, 0) / r.length, win: (r.filter((x) => x > 0).length / r.length) * 100, med: median(r) };
  };
  return { results: grid.map(evalCfg).sort((a, b) => b.avg - a.avg), evalCfg };
}

let optCache = { key: null };
const cfgLabel = (c) => `TP +${c.tp}% · SL −${c.sl}% · ${c.trailAct ? `trailing ${c.trail}% na +${c.trailAct}%` : 'geen trailing'} · ${c.partialTp ? `deel bij +${c.partialTp}%` : 'geen deelverkoop'}`;

function optimizerCard(recs, history) {
  const paths = recs.filter((r) => r.path && r.path.length >= 10).map((r) => r.path);
  const head = `<article class="card"><header class="card-head"><div class="title"><h2>Exit-optimizer</h2>
    <p>Speelt het echte prijsverloop van elke bevestigde coin (elke 30s gemeten, tot 3u) opnieuw af met andere verkoop-instellingen. Instap = moment van bevestiging.</p></div></header><div class="body">`;
  if (paths.length < 5) {
    return `${head}<div class="empty big">🧪 Nog ${paths.length}/5 bevestigde coins met genoeg prijsdata. Laat de bots draaien; elke bevestigde coin wordt 3 uur gevolgd.</div></div></article>`;
  }
  const costs = history.map((t) => t.entryCost).filter((x) => x != null);
  const cost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 3;
  const s = settings.paper;
  const partialFrac = (s.partialSell || 50) / 100;
  // Recompute only when the data or the settings change (the page re-renders every few seconds).
  const curCfg = { tp: s.tp, sl: s.sl, trailAct: s.trailAct, trail: s.trail, partialTp: s.partialTp };
  const key = `${paths.length}:${paths.reduce((a, p) => a + p.length, 0)}:${cost.toFixed(2)}:${partialFrac}:${JSON.stringify(curCfg)}`;
  if (optCache.key !== key) {
    const { results, evalCfg } = optimize(paths, cost, partialFrac);
    optCache = { key, results, cur: evalCfg(curCfg) };
  }
  const { results, cur } = optCache;
  const row = (r, isCur) => `<tr${isCur ? ' class="cur"' : ''}><td>${isCur ? '<b>Huidige instellingen</b><br>' : ''}<span class="${isCur ? 'mint' : ''}">${cfgLabel(r.cfg)}</span></td>
    <td class="r">${pctCell(r.avg, 1)}</td><td class="r">${pctCell(r.med, 1)}</td><td class="r">${rate(r.win, 'pos')}</td>
    <td class="r">${isCur ? '' : `<button class="btn small primary" data-apply-exit='${esc(JSON.stringify(r.cfg))}'>Toepassen</button>`}</td></tr>`;
  return `${head}
    ${paths.length < 30 ? `<div class="insight warn">⚠️ Pas ${paths.length} coins: de beste instelling kan toeval zijn. Vanaf ~30 coins wordt dit betrouwbaarder.</div>` : ''}
    <table class="nice"><thead><tr><th>Instellingen</th><th class="r">Gem. per trade</th><th class="r">Mediaan</th><th class="r">Win rate</th><th></th></tr></thead><tbody>
      ${row(cur, true)}${results.slice(0, 5).map((r) => row(r, false)).join('')}
    </tbody></table>
    <p class="mint">${paths.length} coins · ${results.length} combinaties getest · kosten ${cost.toFixed(1)}% per trade meegerekend · break-even, dode-coin en verkoopdruk-exits niet gesimuleerd</p>
  </div></article>`;
}

// ---------- filter optimizer (sniper thresholds) ----------
/** Would a coin with these first-sight features pass the sniper filters `c`? */
export function passesFilters(r, c) {
  const f = r.f;
  if (!f) return false;
  const young = f.curve || r.origin !== 'lijst' || (f.age ?? 99) < 1;
  if (f.curve) { if (f.mc < c.curveMinMcap) return false; } else {
    if (f.liq < c.minLiq || f.mc < c.minMcap) return false;
  }
  if (f.vol < c.minVolH1 || f.bs < c.minBuySell) return false;
  return (f.score || 0) >= (young ? c.youngMinScore : c.minScore);
}

let filtCache = { key: null };
function filterOptimizerCard(recs) {
  const measured = recs.filter((r) => r.f && r.cp && r.cp[15] != null);
  const head = `<article class="card"><header class="card-head"><div class="title"><h2>Filter-optimizer (sniper)</h2>
    <p>Test ruim 5.700 combinaties van sniper-drempels op alle gemeten coins (ook de afgekeurde): welke instelling had de meeste winnaars en de minste rugs doorgelaten?</p></div></header><div class="body">`;
  if (measured.length < 30) {
    return `${head}<div class="empty big">🧪 Nog ${measured.length}/30 gemeten coins met kenmerken. Coins van vóór deze update tellen niet mee.</div></div></article>`;
  }
  const s = settings.sniper;
  const cur = { minScore: s.minScore, youngMinScore: s.youngMinScore, minLiq: s.minLiq, minVolH1: s.minVolH1, minBuySell: s.minBuySell, minMcap: s.minMcap, curveMinMcap: s.curveMinMcap };
  const key = `${measured.length}:${JSON.stringify(cur)}`;
  if (filtCache.key !== key) {
    const evalCfg = (c) => {
      const p = measured.filter((r) => passesFilters(r, c));
      const win = p.length ? (p.filter((r) => r.max >= WIN_PCT).length / p.length) * 100 : 0;
      const rug = p.length ? (p.filter((r) => r.rug).length / p.length) * 100 : 0;
      return { c, n: p.length, win, rug, edge: win - rug };
    };
    const minN = Math.max(8, Math.round(measured.length * 0.03));
    const res = [];
    for (const minScore of [35, 42, 50, 55, 60, 65]) for (const youngMinScore of [30, 35, 42, 50]) for (const minLiq of [3000, 5000, 7000, 10000, 15000])
      for (const minVolH1 of [500, 1500, 3000, 6000]) for (const minBuySell of [0.9, 1.0, 1.1, 1.3]) for (const [minMcap, curveMinMcap] of [[8000, 6000], [15000, 9000], [20000, 12000]]) {
        const r = evalCfg({ minScore, youngMinScore, minLiq, minVolH1, minBuySell, minMcap, curveMinMcap });
        if (r.n >= minN) res.push(r);
      }
    res.sort((a, b) => b.edge - a.edge || b.n - a.n);
    filtCache = { key, cur: evalCfg(cur), top: res.slice(0, 5) };
  }
  const { cur: c0, top } = filtCache;
  const k = (v) => `${Math.round(v / 100) / 10}K`;
  const label = (c) => `score ≥ ${c.minScore} (jong ${c.youngMinScore}) · liq ≥ ${k(c.minLiq)} · vol 1u ≥ ${k(c.minVolH1)} · B/S ≥ ${c.minBuySell} · mcap ≥ ${k(c.minMcap)} (curve ${k(c.curveMinMcap)})`;
  const row = (r, isCur) => `<tr${isCur ? ' class="cur"' : ''}><td>${isCur ? '<b>Huidige instellingen</b><br>' : ''}<span class="${isCur ? 'mint' : ''}">${label(r.c)}</span></td>
    <td class="r">${r.n}</td><td class="r">${rate(r.n ? r.win : null, 'pos')}</td><td class="r">${rate(r.n ? r.rug : null, 'neg')}</td><td class="r">${pctCell(r.n ? r.edge : null, 0)}</td>
    <td class="r">${isCur ? '' : `<button class="btn small primary" data-apply-filter='${esc(JSON.stringify(r.c))}'>Toepassen</button>`}</td></tr>`;
  return `${head}
    ${measured.length < 150 ? `<div class="insight warn">⚠️ Pas ${measured.length} gemeten coins: kies liever een instelling die veel coins doorlaat dan de allerhoogste voorsprong.</div>` : ''}
    <table class="nice"><thead><tr><th>Sniper-drempels (bedragen in $)</th><th class="r">Coins door</th><th class="r">Winnaar</th><th class="r">Rug</th><th class="r">Voorsprong</th><th></th></tr></thead><tbody>
    ${row(c0, true)}${top.map((r) => row(r, false)).join('')}</tbody></table>
    <p class="mint">Voorsprong = winnaar% − rug% van de doorgelaten coins · ${measured.length} gemeten coins · alleen combinaties die ≥ 3% van de coins doorlaten</p>
  </div></article>`;
}

// ---------- learned score ----------
function modelCard(recs) {
  const m = getModel();
  const data = labeled(recs);
  const pos = data.filter((d) => d.y).length;
  const s = settings.sniper;
  const quality = (a) => (a == null ? 'onbekend' : a >= 0.7 ? 'goed' : a >= 0.6 ? 'bruikbaar' : a >= 0.55 ? 'zwak' : 'niet beter dan toeval');
  let body;
  if (!m) {
    body = `<div class="empty big">🧠 Nog geen model. Nodig: ${MIN_SAMPLES} coins met ≥ 1 uur metingen, waarvan minstens 8 winnaars (nu ${data.length}, ${pos} winnaars).</div>`;
  } else {
    const imp = m.w.map((w, i) => [FEATURES[i][0], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const max = Math.max(...imp.map(([, w]) => Math.abs(w))) || 1;
    const kpi = (cls, icon, label, value, sub) => `<div class="kpi ${cls}"><span class="kpi-icon">${icon}</span><div class="kpi-txt"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div></div>`;
    body = `<div class="kpis compact">
        ${kpi('accent', '🧠', 'Getraind op', `${m.n} coins`, `${m.pos} winnaars (${Math.round(m.baseRate * 100)}%)`)}
        ${kpi(m.auc >= 0.6 ? 'good' : 'warn', '🎯', 'Betrouwbaarheid (AUC)', m.auc == null ? '—' : m.auc.toFixed(2), `${quality(m.auc)} · 0,5 = toeval`)}
        ${kpi('', '⏱', 'Getraind', new Date(m.trainedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }), new Date(m.trainedAt).toLocaleDateString('nl-NL'))}
        ${kpi(s.useModel ? 'good' : '', s.useModel ? '✅' : '⏸', 'In sniper', s.useModel ? 'aan' : 'uit', `min. kans ${s.minProb}%`)}
      </div>
      <div class="sectionlbl">Wat voorspelt een winnaar? (groen = meer kans, rood = minder)</div>
      <ul class="imp">${imp.map(([n, w]) => `<li><span>${esc(n)}</span><span class="imp-bar"><i class="${w >= 0 ? 'up' : 'down'}" style="width:${(Math.abs(w) / max) * 50}%;${w >= 0 ? 'left:50%' : 'right:50%'}"></i></span></li>`).join('')}</ul>`;
  }
  return `<article class="card"><header class="card-head"><div class="title"><h2>Geleerde score</h2>
    <p>Een model leert van jouw gemeten coins welke kenmerken samengaan met een winnaar (≥ +${WIN_PCT}%, geen rug). Traint automatisch elk uur.</p></div></header>
    <div class="controls"><button class="btn primary" data-train-model>🧠 Nu trainen</button>${m ? `<button class="btn" data-model-use="${s.useModel ? '0' : '1'}">${s.useModel ? '⏸ Niet gebruiken in sniper' : '▶ Gebruiken in sniper'}</button>` : ''}</div>
    <div class="body">${body}</div></article>`;
}

export function renderAnalyse(el, tracker, history = []) {
  const recs = tracker.list();
  const ins = insights(recs);
  const byStage = groupBy(recs, (r) => r.stage);
  const stageRows = Object.entries(STAGES).filter(([k]) => byStage.has(k)).map(([k, l]) => [l, agg(byStage.get(k))]);

  const secReasons = [...groupBy(byStage.get('security-fail') || [], (r) => r.fails).entries()]
    .map(([k, v]) => [esc(k), agg(v)]).sort((a, b) => b[1].n - a[1].n);
  const filtReasons = [...groupBy(byStage.get('filtered') || [], (r) => (r.reason || '').replace(/[<>]\s*\$?[\d.]+/, '').replace(/score \d+.*/, 'score te laag').trim()).entries()]
    .map(([k, v]) => [esc(k), agg(v)]).sort((a, b) => b[1].n - a[1].n);
  const exRows = [...groupBy(recs, (r) => exchangeOf(r.dex).name).entries()].map(([k, v]) => [esc(k), agg(v)]).sort((a, b) => b[1].n - a[1].n);
  const srcLabel = { lijst: '📋 Lijsten (DexScreener/Gecko)', launch: '🆕 Live launch', migratie: '🎓 Migratie' };
  const srcRows = [...groupBy(recs, (r) => r.origin || 'lijst').entries()].map(([k, v]) => [srcLabel[k] || esc(k), agg(v)]);
  const profLabel = { voorzichtig: '🛡️ Voorzichtig', normaal: '⚖️ Normaal', agressief: '🔥 Agressief', aangepast: '✏️ Aangepast' };
  const passed = (r) => r.stage !== 'filtered';
  const profRows = [...groupBy(recs, (r) => r.profile || 'aangepast').entries()].map(([k, v]) => {
    const a = agg(v.filter(passed)); // compare what each profile let through the sniper
    return [`${profLabel[k] || esc(k)} <span class="mint">(${v.length} gezien)</span>`, a];
  });
  const bucket = (s) => (s >= 70 ? '70+' : s >= 55 ? '55–69' : s >= 40 ? '40–54' : '< 40');
  const scoreGroups = groupBy(recs, (r) => bucket(r.score || 0));
  const scoreRows = ['70+', '55–69', '40–54', '< 40'].filter((k) => scoreGroups.has(k)).map((k) => [`Score ${k}`, agg(scoreGroups.get(k))]);

  const recent = [...recs].sort((a, b) => b.t0 - a.t0).slice(0, 60);
  const tg = (fn) => [...groupBy(history, fn).entries()].map(([k, v]) => [esc(k), tradeAgg(v)]).sort((a, b) => b[1].n - a[1].n);
  const rankBucket = (r) => (r == null ? 'onbekend' : r >= 80 ? 'Score 80+' : r >= 70 ? 'Score 70–79' : r >= 60 ? 'Score 60–69' : 'Score < 60');
  const tradeSection = history.length ? `
    ${tradeTable('Trades per verkoopreden', tg((t) => t.exitKind || exitKind(t.reason)), 'Verkoopreden', 'Waar komt de winst vandaan en waar lekt het weg?')}
    <div class="agrid">
      ${tradeTable('Trades per score', tg((t) => rankBucket(t.rank)), 'Totaalscore')}
      ${tradeTable('Trades per bron', tg((t) => t.origin || 'lijst'), 'Bron')}
      ${tradeTable('Trades per profiel', tg((t) => t.profile || 'onbekend'), 'Profiel')}
      ${tradeTable('Trades per exchange', tg((t) => exchangeOf(t.dex).name), 'Exchange')}
    </div>` : `<article class="card"><header class="card-head"><div class="title"><h2>Trade-analyse</h2></div></header><div class="body"><div class="empty big">📈 Nog geen gesloten paper trades.</div></div></article>`;
  const ago = (ms) => (ms < 3.6e6 ? `${Math.round(ms / 60000)}m` : `${(ms / 3.6e6).toFixed(1)}u`);

  el.innerHTML = `
    <article class="card"><header class="card-head"><div class="title"><h2>Inzichten</h2>
      <p>Winnaar = ooit ≥ +${WIN_PCT}% na eerste keer gezien · Rug = prijs ≤ ${RUG_PCT}% of liquiditeit −80% · metingen na ${CHECKPOINTS.map((c) => (c < 60 ? `${c}m` : `${c / 60}u`)).join(', ')}</p></div></header>
      <div class="body"><div class="insights">${ins.map(([k, t]) => `<div class="insight ${k}">${k === 'ok' ? '✅' : k === 'warn' ? '⚠️' : '💡'} ${esc(t)}</div>`).join('')}</div></div></article>
    ${table('Per uitkomst in de pipeline', stageRows, 'Uitkomst', 'Doen bevestigde coins het beter dan afgekeurde?')}
    ${table('Per profiel', profRows, 'Profiel', 'Coins die door de sniper kwamen, per actief profiel. Meer coins is pas beter als winnaar% hoog en rug% laag blijft')}
    ${table('Security afkeur-redenen', secReasons, 'Reden', 'Hoge rug% = goede check · hoge winnaar% = houdt winnaars tegen')}
    <div class="agrid">
      ${table('Sniper filter-redenen', filtReasons.slice(0, 10), 'Reden')}
      ${table('Per exchange', exRows, 'Exchange')}
      ${table('Per bron', srcRows, 'Bron')}
      ${table('Per sniper score', scoreRows, 'Score')}
    </div>
    ${tradeSection}
    ${optimizerCard(recs, history)}
    ${filterOptimizerCard(recs)}
    ${modelCard(recs)}
    <article class="card"><header class="card-head"><div class="title"><h2>Laatst gevolgde coins</h2><p>Klik voor details</p></div></header><div class="body">
    ${recent.length ? `<table class="nice"><thead><tr><th>Token</th><th>Bron</th><th>Uitkomst</th><th class="r">Gezien</th><th class="r">15m</th><th class="r">1u</th><th class="r">6u</th><th class="r">Max</th><th></th></tr></thead><tbody>
      ${recent.map((r) => `<tr class="click" data-mint="${esc(r.mint)}">
        <td class="sym">${esc(r.sym)}</td><td>${esc(r.origin)}</td><td>${esc(STAGES[r.stage] || r.stage)}</td>
        <td class="r">${ago(Date.now() - r.t0)}</td>
        <td class="r">${pctCell(r.cp[15])}</td><td class="r">${pctCell(r.cp[60])}</td><td class="r">${pctCell(r.cp[360])}</td>
        <td class="r">${r.last == null ? '—' : pctCell(r.max)}</td>
        <td>${r.rug ? '<span class="chip bad">💀 rug</span>' : r.max >= WIN_PCT ? '<span class="chip good">🏆 winnaar</span>' : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty big">🔬 Nog niets gevolgd. Start de Sniper; elke gescande coin wordt automatisch gevolgd.</div>'}
    </div></article>`;
}

// ---------- CSV export ----------
function download(name, rows) {
  const csv = rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function exportTracker(tracker) {
  const head = ['mint', 'symbol', 'dex', 'bron', 'eerst_gezien', 'prijs0', 'liq0', 'mcap0', 'sniper_score', 'security_score', 'real_score', 'uitkomst', 'reden', ...CHECKPOINTS.map((c) => `chg_${c}m`), 'max', 'min', 'rug'];
  download('solbot-metingen.csv', [head, ...tracker.list().map((r) => [
    r.mint, r.sym, r.dex, r.origin, new Date(r.t0).toISOString(), r.p0, r.liq0, r.mc0, r.score, r.sec, r.real,
    STAGES[r.stage] || r.stage, r.fails?.join(' | ') || r.reason, ...CHECKPOINTS.map((c) => r.cp[c]), r.max, r.min, r.rug,
  ])]);
}

export function exportTrades(history) {
  const head = ['mint', 'symbol', 'dex', 'bron', 'gekocht', 'verkocht', 'in_sol', 'uit_sol', 'pnl_sol', 'pnl_pct', 'piek_pct', 'reden'];
  download('solbot-trades.csv', [head, ...history.map((t) => [
    t.mint, t.symbol, t.dex, t.origin, new Date(t.entryTs).toISOString(), new Date(t.exitTs).toISOString(),
    t.entrySol, t.exitSol, t.pnlSol, t.pnlPct, t.peakPct, t.reason,
  ])]);
}
