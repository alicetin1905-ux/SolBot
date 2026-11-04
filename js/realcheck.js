import { Bot } from './bot.js?v=20261104184641';
import * as api from './api.js?v=20261104184641';
import { devBalance } from './dev.js?v=20261104184641';
import { settings, upsertToken, emit, log } from './store.js?v=20261104184641';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

/**
 * Real check: watches tokens that passed security for several rounds and
 * confirms that the momentum is real (liquidity stays, buyers keep coming,
 * DexScreener price agrees with Jupiter's executable price, still sellable).
 */
export class RealCheckBot extends Bot {
  constructor() {
    super('real', 'Real check bot');
    this.watch = []; // entries being observed
    this.done = [];  // finished entries, most recent first
  }

  intervalMs() { return 5000; }

  add(t) {
    if (this.watch.some((w) => w.mint === t.mint)) return;
    this.watch.push({
      mint: t.mint, symbol: t.symbol, snaps: [], startedAt: Date.now(), next: 0,
      dev: t.dev, devStart: t.devAtCheck?.bal, devHoldPct: t.devAtCheck?.holdPct,
    });
    upsertToken(t.mint, { stage: 'watching' });
    log(this.id, `👀 ${t.symbol} op watchlist (${settings.real.rounds} rondes)`);
    this.changed();
  }

  async tick() {
    const s = settings.real;
    const due = this.watch.filter((w) => Date.now() >= w.next);
    if (!due.length) return;

    const mints = due.map((w) => w.mint);
    const [pairs, prices] = await Promise.all([
      api.dsPairsForTokens(mints).then(api.bestPairs),
      api.jupPrices(mints).catch(() => ({})),
    ]);

    for (const w of due) {
      const p = pairs.get(w.mint);
      const jp = prices[w.mint]?.usdPrice;
      if (p) {
        upsertToken(w.mint, { pair: p });
        w.snaps.push({
          ts: Date.now(),
          price: Number(p.priceUsd) || 0,
          jup: jp || null,
          liq: p.liquidity?.usd || 0,
          volM5: p.volume?.m5 || 0,
          volH1: p.volume?.h1 || 0,
          bsM5: (p.txns?.m5?.buys || 0) / Math.max(1, p.txns?.m5?.sells || 0),
          bsH1: (p.txns?.h1?.buys || 0) / Math.max(1, p.txns?.h1?.sells || 0),
        });
      } else {
        w.missing = (w.missing || 0) + 1;
      }
      w.next = Date.now() + s.intervalSec * 1000;
      if (w.snaps.length >= s.rounds || (w.missing || 0) >= 3) await this.finish(w);
    }
    this.changed();
  }

  async finish(w) {
    const s = settings.real;
    this.watch = this.watch.filter((x) => x !== w);
    const checks = [];
    const add = (name, status, detail) => checks.push({ name, status, detail });
    const sn = w.snaps;

    if (sn.length < 2) {
      add('Data', 'fail', 'pair verdwenen / geen data meer');
      return this.conclude(w, checks, 0);
    }
    const first = sn[0], last = sn[sn.length - 1];

    const liqDrop = first.liq ? ((first.liq - last.liq) / first.liq) * 100 : 100;
    add('Liquiditeit stabiel', liqDrop > s.maxLiqDrop ? 'fail' : 'pass',
      `${liqDrop > 0 ? '-' : '+'}${Math.abs(liqDrop).toFixed(1)}% tijdens observatie`);

    const chg = first.price ? (last.price / first.price - 1) * 100 : -100;
    add('Prijs trend', chg < s.minPriceChange ? 'fail' : 'pass', `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`);

    const avgBs = sn.reduce((a, x) => a + (x.bsM5 + x.bsH1) / 2, 0) / sn.length;
    add('Koopdruk (buys/sells)', avgBs < s.minBuySell ? 'fail' : 'pass', avgBs.toFixed(2));

    const devs = sn.filter((x) => x.jup && x.price).map((x) => Math.abs(x.price - x.jup) / x.jup * 100);
    const dev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
    if (dev === null) add('Prijs DexScreener vs Jupiter', 'warn', 'geen Jupiter prijs');
    else add('Prijs DexScreener vs Jupiter', dev > s.maxPriceDev ? 'fail' : 'pass', `${dev.toFixed(2)}% verschil`);

    const active = sn.filter((x) => x.volM5 > 0).length / sn.length;
    add('Activiteit (5m volume)', active < 0.5 ? 'fail' : active < 1 ? 'warn' : 'pass',
      `${Math.round(active * 100)}% van rondes actief`);

    const volTrend = first.volH1 ? last.volH1 / first.volH1 : 1;
    add('Volume trend 1u', volTrend < 0.6 ? 'warn' : 'pass', `${((volTrend - 1) * 100).toFixed(0)}%`);

    // Did the dev sell while we were watching? (only meaningful if the dev held a real bag)
    if (w.dev && w.devStart > 0 && (w.devHoldPct ?? 0) >= 0.5) {
      const bal = await devBalance(w.dev, w.mint, 0);
      if (bal != null) {
        const sold = Math.max(0, (1 - bal / w.devStart) * 100);
        add('Dev blijft zitten', sold >= 20 ? 'fail' : sold > 0 ? 'warn' : 'pass',
          sold > 0 ? `dev verkocht ${sold.toFixed(0)}% tijdens observatie` : 'dev heeft niets verkocht');
      }
    }

    // Re-verify sellability right before handing over to the trader.
    try {
      const inL = Math.round(0.05 * 1e9);
      const buy = await api.jupQuote(api.SOL_MINT, w.mint, inL, 1000);
      const sell = await api.jupQuote(w.mint, api.SOL_MINT, buy.outAmount, 1000);
      const rt = (1 - Number(sell.outAmount) / inL) * 100;
      add('Nog steeds verkoopbaar', rt > settings.security.maxRoundTrip ? 'fail' : 'pass', `round-trip ${rt.toFixed(2)}%`);
    } catch (e) {
      if (api.isTransient(e)) add('Nog steeds verkoopbaar', 'warn', `kon niet checken (${e.message})`);
      else add('Nog steeds verkoopbaar', 'fail', `verkoop-route weg: ${e.message}`);
    }

    const score = Math.round(
      clamp((chg + 10) / 30) * 25 +
      clamp(1 - liqDrop / Math.max(1, s.maxLiqDrop)) * 20 +
      clamp((avgBs - 0.8) / 1.2) * 25 +
      (dev === null ? 7 : clamp(1 - dev / Math.max(0.1, s.maxPriceDev)) * 15) +
      active * 15,
    );
    return this.conclude(w, checks, score);
  }

  conclude(w, checks, score) {
    const s = settings.real;
    const failed = checks.filter((c) => c.status === 'fail');
    const ok = !failed.length && score >= s.minScore;
    const reason = failed.length ? failed.map((c) => c.name).join(', ') : ok ? null : `score ${score} < ${s.minScore}`;
    const tok = upsertToken(w.mint, {
      real: { checks, score, snaps: w.snaps, at: Date.now() },
      stage: ok ? 'confirmed' : 'rejected',
      rejectReason: reason,
    });
    tok.rank = Math.round(0.3 * (tok.sniperScore ?? 50) + 0.3 * (tok.security?.score ?? 50) + 0.4 * score);
    this.done.unshift(tok);
    this.done = this.done.slice(0, 60);
    if (ok) {
      log(this.id, `🏆 ${tok.symbol} bevestigd! real score ${score}, totaal ${tok.rank} → paper trader`, 'ok');
      emit('confirmed', tok);
    } else {
      log(this.id, `✖ ${tok.symbol} niet bevestigd: ${reason}`, 'err');
    }
    emit('real:done', tok);
    this.changed();
  }
}
