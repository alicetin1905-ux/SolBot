import { Bot } from './bot.js?v=20261104174655';
import * as api from './api.js?v=20261104174655';
import { getModel, predict } from './model.js?v=20261104174655';
import { settings, tokens, upsertToken, emit, log } from './store.js?v=20261104174655';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

/** Bonding-curve pairs (pump.fun before migration etc.) report $0 liquidity on DexScreener. */
const isCurve = (p) => !(p.liquidity?.usd > 0);

export function scorePair(p, s) {
  const curve = isCurve(p);
  const mcap = p.marketCap || p.fdv || 0;
  // For bonding curves, ~20% of market cap is a fair proxy for the SOL sitting in the curve.
  const liq = curve ? mcap * 0.2 : p.liquidity.usd;
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
    liq, volH1, bs, mom, ageH, mcap, curve, price: Number(p.priceUsd) || 0,
  };
}

function filterReason(m, s) {
  // Bonding-curve coins have their own (lower) market-cap floor instead of the liquidity + mcap floors.
  if (m.curve) {
    if (m.mcap < s.curveMinMcap) return `bonding curve mcap < $${s.curveMinMcap}`;
  } else {
    if (m.liq < s.minLiq) return `liquiditeit < $${s.minLiq}`;
    if (m.mcap < s.minMcap) return 'mcap te laag';
  }
  if (m.volH1 < s.minVolH1) return `volume 1u < $${s.minVolH1}`;
  if (m.mcap > s.maxMcap) return 'mcap te hoog';
  if (m.ageH > s.maxAgeH) return `ouder dan ${s.maxAgeH}u`;
  if (m.bs < s.minBuySell) return 'meer sells dan buys';
  return null;
}

/**
 * Two sources:
 *  - lists (DexScreener profiles/boosts, GeckoTerminal new pools) every `intervalSec`
 *  - live launches & migrations via the PumpPortal websocket, evaluated once
 *    they are `launchMinAgeMin` old and re-evaluated every minute until `launchMaxAgeMin`.
 */
export class SniperBot extends Bot {
  constructor() {
    super('sniper', 'Sniper bot');
    this.resultMap = new Map();
    this.results = [];
    this.scans = 0;
    this.nextListScan = 0;
    this.launches = new Map();
    this.ws = null;
    this.wsRetry = 0;
    this.live = { status: 'uit', creates: 0, migrations: 0, lastMsg: 0 };
    this.sources = {}; // coins per list source in the last scan
  }

  intervalMs() { return 10000; }

  start() { super.start(); this.ensureSocket(); }
  stop() { super.stop(); this.closeSocket(); }
  runOnce() { this.nextListScan = 0; return super.runOnce(); }

  // ---------- PumpPortal live feed ----------
  ensureSocket() {
    const s = settings.sniper;
    const want = this.running && (s.useLaunches || s.useMigrations);
    if (!want) { this.closeSocket(); return; }
    if (this.ws) return;
    this.live.status = 'verbinden';
    let ws;
    try { ws = new WebSocket(PUMPPORTAL_WS); } catch (e) { this.live.status = 'fout'; return; }
    this.ws = ws;
    ws.onopen = () => {
      this.wsRetry = 0;
      this.live.status = 'verbonden';
      if (s.useLaunches) ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      if (s.useMigrations) ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      log(this.id, '📡 Live feed verbonden (nieuwe launches + migraties)', 'ok');
      this.changed();
    };
    ws.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d?.mint || !d.txType) return;
      this.onLaunch(d);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.live.status = this.running ? 'opnieuw verbinden' : 'uit';
      this.changed();
      if (this.running) {
        const wait = Math.min(30000, 2000 * 2 ** this.wsRetry++);
        setTimeout(() => this.ensureSocket(), wait);
      }
    };
    ws.onerror = () => { this.live.status = 'fout'; };
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    this.live.status = 'uit';
  }

  onLaunch(d) {
    const s = settings.sniper;
    const now = Date.now();
    this.live.lastMsg = now;
    if (d.txType === 'create') {
      if (!s.useLaunches || this.launches.has(d.mint) || tokens.has(d.mint)) return;
      this.live.creates++;
      this.launches.set(d.mint, {
        mint: d.mint, symbol: d.symbol, name: d.name, kind: 'launch', createdAt: now,
        nextEval: now + s.launchMinAgeMin * 60000,
        dev: d.traderPublicKey, devInitial: Number(d.initialBuy) || 0, // dev wallet + tokens it bought at launch
      });
      emit('sniper:launch', { mint: d.mint, symbol: d.symbol, kind: 'launch' });
    } else if (d.txType === 'migrate') {
      if (!s.useMigrations || tokens.has(d.mint)) return;
      this.live.migrations++;
      const prev = this.launches.get(d.mint);
      // Give DexScreener ~1 min to index the new pool.
      this.launches.set(d.mint, { ...prev, mint: d.mint, kind: 'migratie', createdAt: now, nextEval: now + 60000 });
      emit('sniper:launch', { mint: d.mint, symbol: prev?.symbol, kind: 'migratie' });
      log(this.id, `🎓 Migratie naar PumpSwap: ${prev?.symbol || d.mint.slice(0, 6)}`);
    }
    // keep memory bounded
    if (this.launches.size > 3000) {
      const oldest = [...this.launches.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, 500);
      oldest.forEach((l) => this.launches.delete(l.mint));
    }
  }

  // ---------- list sources ----------
  async collectMints() {
    const s = settings.sniper;
    const mints = new Set();
    const count = (name, list) => {
      this.sources[name] = list.length;
      list.forEach((m) => mints.add(m));
    };
    const ds = [
      ['DexScreener profielen', api.dsLatestProfiles()],
      ['DexScreener boosts', api.dsLatestBoosts()],
      ['DexScreener top boosts', api.dsTopBoosts()],
      ['Community takeovers', api.dsTakeovers()],
    ];
    const results = await Promise.allSettled(ds.map((x) => x[1]));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        count(ds[i][0], r.value.filter((x) => x.chainId === 'solana').map((x) => x.tokenAddress));
      } else if (r.status === 'rejected') {
        log(this.id, `Bron ${ds[i][0]} faalde: ${r.reason?.message}`, 'warn');
      }
    });
    if (s.useGecko) {
      // GeckoTerminal covers every DEX/launchpad (Raydium LaunchLab, Meteora, Orca…), not only Pump.fun.
      const gecko = [['Gecko nieuwe pools', () => api.geckoNewPools(1)], ['Gecko nieuwe pools p2', () => api.geckoNewPools(2)], ['Gecko trending', () => api.geckoTrending()]];
      for (const [name, fn] of gecko) {
        try { count(name, await fn()); }
        catch (e) { log(this.id, `${name} overgeslagen (${e.message})`, 'warn'); }
      }
    }
    mints.delete(api.SOL_MINT);
    return [...mints];
  }

  async tick() {
    const s = settings.sniper;
    const now = Date.now();
    this.ensureSocket();

    const origin = new Map();
    let listScan = false;
    if (now >= this.nextListScan) {
      this.nextListScan = now + s.intervalSec * 1000;
      listScan = true;
      for (const m of await this.collectMints()) origin.set(m, 'lijst');
    }
    for (const L of this.launches.values()) {
      if (now - L.createdAt > s.launchMaxAgeMin * 60000) { this.launches.delete(L.mint); continue; }
      if (now >= L.nextEval && !origin.has(L.mint)) {
        origin.set(L.mint, L.kind);
        L.nextEval = now + 60000;
      }
    }
    if (!origin.size) { this.prune(); return; }

    const mints = [...origin.keys()].slice(0, 300);
    if (listScan) log(this.id, `Scan: ${mints.length} tokens (lijsten + ${mints.filter((m) => origin.get(m) !== 'lijst').length} live), pairs ophalen…`);
    const pairs = api.bestPairs(await api.dsPairsForTokens(mints));

    const batch = [];
    let fresh = 0;
    for (const [mint, p] of pairs) {
      const m = scorePair(p, s);
      let reason = filterReason(m, s);
      // Keep the first real source: a launch that later shows up in a list is still a launch.
      const prevSrc = this.resultMap.get(mint)?.origin || tokens.get(mint)?.origin;
      const src = prevSrc && prevSrc !== 'lijst' ? prevSrc : (origin.get(mint) || 'lijst');
      // Young coins (fresh launches, migrations, bonding curves) get their own score floor:
      // the score rewards liquidity and history, which a coin of minutes old cannot have yet.
      const young = m.curve || src !== 'lijst' || m.ageH < 1;
      const floor = young ? s.youngMinScore : s.minScore;
      if (!reason && m.score < floor) reason = `score ${m.score} < ${floor}${young ? ' (jong)' : ''}`;
      // Learned score (optional): chance of a clean winner according to the trained model.
      const prob = predict(getModel(), { liq: m.liq, vol: m.volH1, bs: m.bs, mom: m.mom, age: m.ageH, mc: m.mcap, curve: m.curve, score: m.score, origin: src });
      if (!reason && s.useModel && prob != null && prob * 100 < s.minProb) reason = `model: kans ${(prob * 100).toFixed(0)}% < ${s.minProb}%`;
      const r = {
        mint, symbol: p.baseToken.symbol, name: p.baseToken.name, ...m, url: p.url, dex: p.dexId,
        origin: src, pass: !reason, reason, seenAt: now, prob,
      };
      batch.push(r);
      this.resultMap.set(mint, r);

      if (!reason && !tokens.has(mint)) {
        fresh++;
        const L = this.launches.get(mint);
        this.launches.delete(mint);
        const t = upsertToken(mint, {
          symbol: p.baseToken.symbol, name: p.baseToken.name, pair: p,
          sniperScore: m.score, stage: 'security-queue', origin: src,
          ...(L?.dev ? { dev: L.dev, devInitial: L.devInitial } : {}),
          features: { liq: m.liq, vol: m.volH1, bs: m.bs, mom: m.mom, age: m.ageH, mc: m.mcap, curve: m.curve, score: m.score },
        });
        const tag = src === 'launch' ? '🆕 ' : src === 'migratie' ? '🎓 ' : '';
        log(this.id, `🎯 ${tag}${t.symbol} score ${m.score} · ${m.curve ? 'curve mcap' : 'liq'} $${fmt(m.curve ? m.mcap : m.liq)} · B/S ${m.bs.toFixed(2)} → security`, 'ok');
        emit('candidate', t);
      }
    }
    this.prune();
    if (listScan) {
      this.scans++;
      log(this.id, `Scan klaar: ${batch.filter((r) => r.pass).length}/${batch.length} door filter, ${fresh} nieuw`);
    }
    emit('sniper:results', batch);
  }

  /** Keeps the visible result list fresh: drops coins not seen for 20 minutes. */
  prune() {
    const cutoff = Date.now() - 20 * 60000;
    for (const [m, r] of this.resultMap) if (r.seenAt < cutoff) this.resultMap.delete(m);
    this.results = [...this.resultMap.values()].sort((a, b) => b.score - a.score).slice(0, 400);
  }
}

export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
