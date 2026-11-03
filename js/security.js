import { Bot } from './bot.js?v=20261103192235';
import * as api from './api.js?v=20261103192235';
import { devBalance, pctOf } from './dev.js?v=20261103192235';
import { settings, upsertToken, tokens, emit, log } from './store.js?v=20261103192235';

const LAMPORTS = 1e9;

class RetryLater extends Error {}
const MAX_PARALLEL = 3;

export class SecurityBot extends Bot {
  constructor() {
    super('security', 'Security bot');
    this.queue = [];
    this.checked = []; // most recent first
    this.stats = { pass: 0, fail: 0 };
    this.active = 0;
  }

  intervalMs() { return 1000; }

  enqueue(t) {
    if (this.queue.some((x) => x.mint === t.mint)) return;
    t.queuedAt = t.queuedAt || Date.now();
    this.queue.push(t);
    this.changed();
  }

  /**
   * Runs up to MAX_PARALLEL audits at once (the API rate limiters still space the calls),
   * best sniper score first; candidates waiting longer than 15 min are dropped as stale.
   */
  async tick() {
    const now = Date.now();
    for (const t of this.queue.filter((x) => !x.attempts && now - x.queuedAt > 15 * 60000)) {
      this.queue = this.queue.filter((x) => x !== t);
      upsertToken(t.mint, { stage: 'rejected', rejectReason: 'te lang in wachtrij' });
      log(this.id, `⌛ ${t.symbol} overgeslagen: >15 min in de wachtrij`, 'warn');
    }
    const prio = (x) => (x.manual ? 1000 : x.sniperScore || 0); // manual checks go first
    this.queue.sort((a, b) => prio(b) - prio(a));
    while (this.active < MAX_PARALLEL && this.queue.length) {
      const t = this.queue.shift();
      this.active++;
      this.process(t)
        .catch((e) => log(this.id, `Fout bij ${t.symbol || t.mint.slice(0, 6)}: ${e.message}`, 'err'))
        .finally(() => { this.active--; this.changed(); });
    }
  }

  async process(t) {
    upsertToken(t.mint, { stage: 'security' });
    this.changed();
    log(this.id, `🔍 Check ${t.symbol || t.mint.slice(0, 6)}…`);
    let result;
    try {
      result = await this.audit(t.mint, t.attempts || 0, t);
    } catch (e) {
      if (!(e instanceof RetryLater)) throw e;
      t.attempts = (t.attempts || 0) + 1;
      if (t.attempts <= 3) {
        upsertToken(t.mint, { stage: 'security-queue' });
        this.queue.push(t);
        log(this.id, `⏳ ${t.symbol}: API druk (${e.message}), later opnieuw (${t.attempts}/3)`, 'warn');
      } else {
        upsertToken(t.mint, { stage: 'rejected', rejectReason: 'API niet bereikbaar' });
        log(this.id, `⛔ ${t.symbol}: overgeslagen, API niet bereikbaar`, 'err');
      }
      return;
    }
    const passed = result.checks.every((c) => c.status !== 'fail');
    const tok = upsertToken(t.mint, {
      security: result, decimals: result.decimals, devAtCheck: result.dev,
      dev: t.dev || result.dev?.dev,
      symbol: t.symbol || result.symbol, name: t.name || result.name,
      stage: passed ? 'watch-queue' : 'rejected',
      rejectReason: passed ? null : result.checks.filter((c) => c.status === 'fail').map((c) => c.name).join(', '),
    });
    this.checked.unshift(tok);
    this.checked = this.checked.slice(0, 60);
    if (passed) {
      this.stats.pass++;
      log(this.id, `✅ ${tok.symbol} veilig (score ${result.score}) → real check`, 'ok');
      emit('secured', tok);
    } else {
      this.stats.fail++;
      log(this.id, `⛔ ${tok.symbol} afgekeurd: ${tok.rejectReason}`, 'err');
    }
    emit('security:done', tok);
  }

  async audit(mint, attempts = 0, t = {}) {
    const s = settings.security;
    const checks = [];
    const add = (name, status, detail) => checks.push({ name, status, detail });

    // ---- Jupiter token audit (always; also the fallback when RugCheck is down) ----
    let j = null;
    try { j = await api.jupToken(mint); } catch { /* optional */ }

    // ---- RugCheck on-chain report ----
    let r = null;
    try { r = await api.rugReport(mint); }
    catch (e) {
      // Rate limit / timeout: try again later once, then fall back to Jupiter's audit.
      if (api.isTransient(e) && attempts < 1) throw new RetryLater(`RugCheck: ${e.message}`);
      if (!j) {
        if (api.isTransient(e)) throw new RetryLater(`RugCheck: ${e.message}`);
        add('RugCheck rapport', 'fail', `niet beschikbaar (${e.message}) en geen Jupiter audit`);
      } else {
        add('RugCheck rapport', 'warn', `niet beschikbaar (${e.message}): Jupiter audit gebruikt, LP-lock en insiders niet gecheckt`);
        this.jupiterFallback(j, add);
      }
    }
    if (j) this.jupiterExtras(j, add);

    let decimals = j?.decimals ?? 6, symbol = j?.symbol || '', name = j?.name || '';
    if (r) {
      decimals = r.token?.decimals ?? 6;
      symbol = r.tokenMeta?.symbol || '';
      name = r.tokenMeta?.name || '';

      add('Mint authority', r.mintAuthority ? 'fail' : 'pass',
        r.mintAuthority ? 'actief: er kunnen nieuwe tokens bijgemint worden' : 'ingetrokken');
      add('Freeze authority', r.freezeAuthority ? 'fail' : 'pass',
        r.freezeAuthority ? 'actief: jouw tokens kunnen bevroren worden' : 'ingetrokken');
      add('Rugged', r.rugged ? 'fail' : 'pass', r.rugged ? 'RugCheck markeert token als gerugd' : 'nee');

      const ext = r.token_extensions || {};
      const dangerExt = [];
      if (ext.permanentDelegate) dangerExt.push('permanent delegate');
      if (ext.transferHook && ext.transferHook.programId) dangerExt.push('transfer hook');
      if (ext.nonTransferable) dangerExt.push('non-transferable');
      if (ext.pausableConfig) dangerExt.push('pausable');
      if (ext.defaultAccountState && ext.defaultAccountState.state === 'frozen') dangerExt.push('default frozen');
      add('Token-2022 extensies', dangerExt.length ? 'fail' : 'pass', dangerExt.join(', ') || 'geen gevaarlijke');

      const feePct = r.transferFee?.pct || 0;
      add('Transfer fee / tax', feePct > s.maxTransferFee ? 'fail' : 'pass', `${feePct}%`);

      // LP locked/burned, weighted by pool size
      const markets = r.markets || [];
      if (markets.length) {
        let w = 0, sum = 0;
        for (const m of markets) {
          const size = (m.lp?.quoteUSD || 0) + (m.lp?.baseUSD || 0);
          w += size; sum += size * (m.lp?.lpLockedPct || 0);
        }
        const lp = w ? sum / w : 0;
        add('LP locked/burned', lp >= s.minLpLocked ? 'pass' : 'fail', `${lp.toFixed(1)}%`);
        // Locked (not burned) LP: when does the lock end? An unlock soon means the LP can be pulled.
        const unlocks = Object.values(r.lockers || {})
          .map((l) => Number(l.unlockDate || l.unlock_date || l.unlockAt || 0))
          .filter((x) => x > 0).map((x) => (x < 1e12 ? x * 1000 : x));
        if (unlocks.length) {
          const days = (Math.min(...unlocks) - Date.now()) / 864e5;
          add('LP lock loopt af', days < 1 ? 'fail' : days < s.lpUnlockDays ? 'warn' : 'pass',
            days < 0 ? 'lock is al verlopen' : `over ${days < 2 ? `${Math.round(days * 24)} uur` : `${Math.round(days)} dagen`}`);
        }
      } else {
        add('LP locked/burned', 'warn', 'geen AMM pool (bonding curve / onbekend)');
      }

      // Holder concentration excluding pools/lockers
      const skip = new Set(markets.flatMap((m) => [m.pubkey, m.liquidityA, m.liquidityB]));
      for (const [addr, k] of Object.entries(r.knownAccounts || {})) {
        if (k.type === 'AMM' || k.type === 'LOCKER') skip.add(addr);
      }
      const holders = (r.topHolders || []).filter((h) => !skip.has(h.owner) && !skip.has(h.address));
      const top10 = holders.slice(0, 10).reduce((a, h) => a + (h.pct || 0), 0);
      const maxOne = holders.reduce((a, h) => Math.max(a, h.pct || 0), 0);
      add('Top 10 holders', top10 > s.maxTop10 ? 'fail' : 'pass', `${top10.toFixed(1)}% van supply`);
      add('Grootste holder', maxOne > s.maxSingleHolder ? 'fail' : 'pass', `${maxOne.toFixed(1)}%`);

      const insiders = r.graphInsidersDetected || 0;
      add('Insider netwerk', insiders > s.maxInsiders ? 'fail' : insiders > 0 ? 'warn' : 'pass',
        `${insiders} gelinkte wallets`);

      const nh = r.totalHolders || 0;
      add('Aantal holders', nh >= s.minHolders ? 'pass' : 'warn', `${nh}`);

      const rs = r.score_normalised ?? 0;
      add('RugCheck risico-score', rs > s.maxRiskScore ? 'fail' : 'pass', `${rs} (lager = beter)`);

      for (const risk of r.risks || []) {
        // strictDanger off: RugCheck "danger" risks only warn; the hard checks above still fail.
        if (risk.level === 'danger') add(`Risico: ${risk.name}`, s.strictDanger ? 'fail' : 'warn', risk.description || risk.value || '');
        else if (risk.level === 'warn') add(`Risico: ${risk.name}`, 'warn', risk.description || risk.value || '');
      }
    }

    // ---- Dev (creator) wallet: how much does it still hold, how much did it already dump? ----
    const dev = t.dev || j?.dev || r?.creator;
    const supply = Number(j?.totalSupply) || (r?.token?.supply ? Number(r.token.supply) / 10 ** (r.token.decimals ?? 6) : 0);
    let devInfo = null;
    if (dev) {
      const bal = await devBalance(dev, mint, 0);
      if (bal != null) {
        const holdPct = pctOf(bal, supply);
        const soldPct = t.devInitial > 0 ? Math.max(0, (1 - bal / t.devInitial) * 100) : null;
        devInfo = { dev, bal, holdPct, soldPct, at: Date.now() };
        if (holdPct != null) {
          add('Dev bezit', holdPct > s.maxDevHold ? 'fail' : holdPct > s.maxDevHold / 2 ? 'warn' : 'pass',
            `${holdPct.toFixed(2)}% van supply${holdPct > s.maxDevHold ? ': kan op je dumpen' : ''}`);
        }
        if (soldPct != null) {
          const failSold = s.devSoldFail > 0 && soldPct >= s.devSoldFail;
          add('Dev verkocht', failSold ? 'fail' : soldPct >= 50 ? 'warn' : 'pass',
            `${soldPct.toFixed(0)}% van zijn launch-aankoop verkocht`);
        }
      }
      const mints = j?.audit?.devMints;
      if (mints != null) add('Dev geschiedenis', mints > s.maxDevMints ? 'fail' : mints > s.maxDevMints / 2 ? 'warn' : 'pass', `dev heeft ${mints} token(s) gemaakt${mints > s.maxDevMints ? ' (serie-launcher)' : ''}`);
    }

    // ---- Honeypot simulation via Jupiter: buy then sell ----
    const inLamports = Math.round(s.testSol * LAMPORTS);
    let roundTrip = null;
    try {
      const buy = await api.jupQuote(api.SOL_MINT, mint, inLamports, 1000);
      try {
        const sell = await api.jupQuote(mint, api.SOL_MINT, buy.outAmount, 1000);
        const back = Number(sell.outAmount);
        roundTrip = (1 - back / inLamports) * 100;
        add('Honeypot (verkoop-simulatie)', 'pass', `verkopen mogelijk via ${sell.routePlan?.[0]?.swapInfo?.label || 'Jupiter'}`);
        add('Round-trip verlies', roundTrip > s.maxRoundTrip ? 'fail' : 'pass',
          `${roundTrip.toFixed(2)}% bij ${s.testSol} SOL (tax + slippage)`);
      } catch (e) {
        if (api.isTransient(e)) throw new RetryLater(`Jupiter: ${e.message}`);
        add('Honeypot (verkoop-simulatie)', 'fail', `geen verkoop-route: ${e.message}`);
      }
    } catch (e) {
      if (e instanceof RetryLater) throw e;
      if (api.isTransient(e)) throw new RetryLater(`Jupiter: ${e.message}`);
      add('Koop-route', 'fail', `geen route via Jupiter: ${e.message}`);
    }

    const fails = checks.filter((c) => c.status === 'fail').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    const score = Math.max(0, 100 - fails * 25 - warns * 7);
    return { checks, score, roundTrip, decimals, symbol, name, at: Date.now(), dev: devInfo };
  }

  /** Core checks from Jupiter's token audit, used when RugCheck is unavailable. */
  jupiterFallback(j, add) {
    const s = settings.security;
    const a = j.audit || {};
    add('Mint authority', a.mintAuthorityDisabled ? 'pass' : 'fail',
      a.mintAuthorityDisabled ? 'ingetrokken (Jupiter)' : 'actief of onbekend: er kunnen tokens bijgemint worden');
    add('Freeze authority', a.freezeAuthorityDisabled ? 'pass' : 'fail',
      a.freezeAuthorityDisabled ? 'ingetrokken (Jupiter)' : 'actief of onbekend: tokens kunnen bevroren worden');
    if (a.topHoldersPercentage != null) {
      add('Top holders', a.topHoldersPercentage > s.maxTop10 ? 'fail' : 'pass', `${a.topHoldersPercentage.toFixed(1)}% van supply (Jupiter)`);
    }
    const nh = j.holderCount || 0;
    add('Aantal holders', nh >= s.minHolders ? 'pass' : 'warn', `${nh}`);
  }

  /** Extra signals Jupiter has that RugCheck doesn't: wash trading and "suspicious" flag. */
  jupiterExtras(j, add) {
    const s = settings.security;
    const a = j.audit || {};
    if (a.isSus) add('Jupiter: verdacht token', 'fail', 'Jupiter markeert dit token als verdacht');
    if (j.organicScore != null) {
      add('Organische handel', j.organicScore < s.minOrganic ? 'fail' : j.organicScore < s.minOrganic * 2 ? 'warn' : 'pass',
        `organic score ${j.organicScore.toFixed(0)}/100 (${j.organicScoreLabel || '?'}); laag = veel bot/wash trading`);
    }
  }

  /** Manually push a mint (from the UI) through the pipeline. */
  async addManual(mint) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('Ongeldig Solana adres');
    const t = tokens.get(mint) || upsertToken(mint, { stage: 'security-queue', manual: true });
    if (!t.pair) {
      try {
        const p = api.bestPairs(await api.dsPairsForTokens([mint])).get(mint);
        if (p) upsertToken(mint, { pair: p, symbol: p.baseToken.symbol, name: p.baseToken.name });
      } catch { /* pair info optional */ }
    }
    upsertToken(mint, { stage: 'security-queue', manual: true });
    this.enqueue(tokens.get(mint));
    log(this.id, `Handmatig toegevoegd: ${tokens.get(mint).symbol || mint}`);
  }
}
