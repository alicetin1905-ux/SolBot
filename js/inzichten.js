// Analyse page: turns tracker records into "do my filters work?" answers.
import { CHECKPOINTS, STAGES, WIN_PCT, RUG_PCT } from './metingen.js?v=20261102235128';
import { exchangeOf } from './flow.js?v=20261102235128';

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

export function renderAnalyse(el, tracker) {
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
