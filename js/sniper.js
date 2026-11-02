import { Bot } from './bot.js';
import * as api from './api.js';
import { settings, tokens, upsertToken, emit, log } from './store.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function scorePair(p, s) {
  const liq = p.liquidity?.usd || 0;
  const volH1 = p.volume?.h1 || 0;
  const buys = p.txns?.h1?.buys || 0;
  const sells = p.txns?.h1?.sells || 0;
  const bs = buys / Math.max(1, sells);
  const mom = p.priceChange?.h1 ?? 0;
  const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 999;
  const socials = (p.info?.websites?.length ? 1 : 0) + (p.info?.socials?.length || 0);

  const liqS = clamp(Math.log10(Math.max(1, liq) / s.minLiq) / Math.log10(50)) * 25;
  const volS = clamp(volH1 / Math.max(1, liq)) * 20;
  const bsS = clamp((bs - 0.8) / 1.2) * 20;
  let momS;
  if (mom < 0) momS = Math.max(0, 10 + mom / 2);
  else if (mom <= 300) momS = Math.min(15, 10 + mom / 10);
  else momS = 5; // parabolic: late entry, higher dump risk
  const ageS = clamp(1 - (ageH - 1) / Math.max(1, s.maxAgeH)) * 10;
  const txS = clamp((buys + sells) / 500) * 5;
  const socS = clamp(socials / 3) * 5;

  return {
    score: Math.round(liqS + volS + bsS + momS + ageS + txS + socS),
    liq, volH1, bs, mom, ageH, mcap: p.marketCap || p.fdv || 0,
  };
}

function filterReason(m, s) {
  if (m.liq < s.minLiq) return `liquiditeit < $${s.minLiq}`;
  if (m.volH1 < s.minVolH1) return `volume 1u < $${s.minVolH1}`;
  if (m.mcap < s.minMcap) return 'mcap te laag';
  if (m.mcap > s.maxMcap) return 'mcap te hoog';
  if (m.ageH > s.maxAgeH) return `ouder dan ${s.maxAgeH}u`;
  if (m.bs < s.minBuySell) return 'meer sells dan buys';
  return null;
}

export class SniperBot extends Bot {
  constructor() {
    super('sniper', 'Sniper bot');
    this.results = [];
    this.scans = 0;
  }

  intervalMs() { return settings.sniper.intervalSec * 1000; }

  async collectMints() {
    const s = settings.sniper;
    const sources = [
      ['profiles', api.dsLatestProfiles()],
      ['boosts', api.dsLatestBoosts()],
      ['top boosts', api.dsTopBoosts()],
    ];
    const mints = new Set();
    const results = await Promise.allSettled(sources.map((x) => x[1]));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        r.value.filter((x) => x.chainId === 'solana').forEach((x) => mints.add(x.tokenAddress));
      } else if (r.status === 'rejected') {
        log(this.id, `Bron ${sources[i][0]} faalde: ${r.reason?.message}`, 'warn');
      }
    });
    if (s.useGecko) {
      try { (await api.geckoNewPools()).forEach((m) => mints.add(m)); }
      catch (e) { log(this.id, `GeckoTerminal overgeslagen (${e.message})`, 'warn'); }
    }
    mints.delete(api.SOL_MINT);
    return [...mints];
  }

  async tick() {
    const s = settings.sniper;
    const mints = await this.collectMints();
    log(this.id, `Scan: ${mints.length} Solana tokens gevonden, pairs ophalen…`);
    const pairs = api.bestPairs(await api.dsPairsForTokens(mints));

    const results = [];
    let fresh = 0;
    for (const [mint, p] of pairs) {
      const m = scorePair(p, s);
      let reason = filterReason(m, s);
      if (!reason && m.score < s.minScore) reason = `score ${m.score} < ${s.minScore}`;
      results.push({ mint, symbol: p.baseToken.symbol, name: p.baseToken.name, ...m, url: p.url, pass: !reason, reason });

      if (!reason && !tokens.has(mint)) {
        fresh++;
        const t = upsertToken(mint, {
          symbol: p.baseToken.symbol, name: p.baseToken.name, pair: p,
          sniperScore: m.score, stage: 'security-queue',
        });
        log(this.id, `🎯 ${t.symbol} score ${m.score} · liq $${fmt(m.liq)} · B/S ${m.bs.toFixed(2)} → security`, 'ok');
        emit('candidate', t);
      }
    }
    results.sort((a, b) => b.score - a.score);
    this.results = results;
    this.scans++;
    log(this.id, `Scan klaar: ${results.filter((r) => r.pass).length}/${results.length} door filter, ${fresh} nieuw`);
    emit('sniper:results', results);
  }
}

export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
