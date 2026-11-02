import { Bot } from './bot.js';
import * as api from './api.js';
import { settings, upsertToken, tokens, emit, log } from './store.js';

const LAMPORTS = 1e9;

class RetryLater extends Error {}

export class SecurityBot extends Bot {
  constructor() {
    super('security', 'Security bot');
    this.queue = [];
    this.checked = []; // most recent first
    this.stats = { pass: 0, fail: 0 };
  }

  intervalMs() { return 2000; }

  enqueue(t) {
    if (this.queue.some((x) => x.mint === t.mint)) return;
    this.queue.push(t);
    this.changed();
  }

  async tick() {
    const t = this.queue.shift();
    if (!t) return;
    upsertToken(t.mint, { stage: 'security' });
    this.changed();
    log(this.id, `🔍 Check ${t.symbol || t.mint.slice(0, 6)}…`);
    let result;
    try {
      result = await this.audit(t.mint);
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
      security: result, decimals: result.decimals,
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

  async audit(mint) {
    const s = settings.security;
    const checks = [];
    const add = (name, status, detail) => checks.push({ name, status, detail });

    // ---- RugCheck on-chain report ----
    let r = null;
    try { r = await api.rugReport(mint); }
    catch (e) {
      if (api.isTransient(e)) throw new RetryLater(`RugCheck: ${e.message}`);
      add('RugCheck rapport', 'fail', `niet beschikbaar (${e.message})`);
    }

    let decimals = 6, symbol = '', name = '';
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
        if (risk.level === 'danger') add(`Risico: ${risk.name}`, 'fail', risk.description || risk.value || '');
        else if (risk.level === 'warn') add(`Risico: ${risk.name}`, 'warn', risk.description || risk.value || '');
      }
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
    return { checks, score, roundTrip, decimals, symbol, name, at: Date.now() };
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
    upsertToken(mint, { stage: 'security-queue' });
    this.enqueue(tokens.get(mint));
    log(this.id, `Handmatig toegevoegd: ${tokens.get(mint).symbol || mint}`);
  }
}
