// Public, CORS-enabled data sources. No API keys required.
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DS = 'https://api.dexscreener.com';
const RUG = 'https://api.rugcheck.xyz/v1';
const JUP = 'https://lite-api.jup.ag';
const GECKO = 'https://api.geckoterminal.com/api/v2';

// Simple per-host rate limiter: guarantees a minimum gap between calls.
function limiter(minGapMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (fn) => {
    const run = chain.then(async () => {
      const wait = Math.max(0, last + minGapMs - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}

const limits = {
  ds: limiter(250),      // DexScreener: ~300 req/min on pair endpoints
  dsMeta: limiter(1100), // DexScreener profile/boost endpoints: 60 req/min
  rug: limiter(4200),    // RugCheck: ~15 req/min
  jup: limiter(1100),    // Jupiter lite API
  gecko: limiter(2500),  // GeckoTerminal: ~30 req/min
};

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

/** Errors worth retrying later (rate limit, timeouts, server hiccups). */
export const isTransient = (e) => e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500);

async function getJSON(url, timeout = 15000, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await getOnce(url, timeout);
    } catch (e) {
      if (i >= tries || !(isTransient(e) || e instanceof TypeError)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** (i - 1)));
    }
  }
}

async function getOnce(url, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
      throw new ApiError(String(msg), res.status);
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('timeout', 0);
    if (e instanceof TypeError) throw new ApiError(`netwerk: ${e.message}`, 0);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------- DexScreener ----------
export const dsLatestProfiles = () => limits.dsMeta(() => getJSON(`${DS}/token-profiles/latest/v1`));
export const dsLatestBoosts = () => limits.dsMeta(() => getJSON(`${DS}/token-boosts/latest/v1`));
export const dsTopBoosts = () => limits.dsMeta(() => getJSON(`${DS}/token-boosts/top/v1`));

/** Returns all pairs for the given token mints (batched by 30). */
export async function dsPairsForTokens(mints) {
  const out = [];
  const uniq = [...new Set(mints)];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    const res = await limits.ds(() => getJSON(`${DS}/tokens/v1/solana/${chunk.join(',')}`));
    if (Array.isArray(res)) out.push(...res);
  }
  return out;
}

/** Picks the most liquid Solana pair per mint where the mint is the base token. */
export function bestPairs(pairs) {
  const map = new Map();
  for (const p of pairs) {
    if (p.chainId !== 'solana' || !p.baseToken) continue;
    const mint = p.baseToken.address;
    const cur = map.get(mint);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) map.set(mint, p);
  }
  return map;
}

// ---------- GeckoTerminal (new pools; optional, often rate-limited) ----------
export async function geckoNewPools() {
  const res = await limits.gecko(() => getJSON(`${GECKO}/networks/solana/new_pools?page=1`));
  const mints = [];
  for (const pool of res?.data || []) {
    const id = pool?.relationships?.base_token?.data?.id || '';
    if (id.startsWith('solana_')) mints.push(id.slice(7));
  }
  return mints;
}

// ---------- RugCheck ----------
export const rugReport = (mint) => limits.rug(() => getJSON(`${RUG}/tokens/${mint}/report`, 25000));

// ---------- Jupiter ----------
export function jupQuote(inputMint, outputMint, amountRaw, slippageBps = 500) {
  const q = new URLSearchParams({
    inputMint, outputMint, amount: String(amountRaw), slippageBps: String(slippageBps),
  });
  return limits.jup(() => getJSON(`${JUP}/swap/v1/quote?${q}`));
}

export async function jupPrices(mints) {
  const out = {};
  const uniq = [...new Set(mints)];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const res = await limits.jup(() => getJSON(`${JUP}/price/v3?ids=${chunk.join(',')}`));
    Object.assign(out, res || {});
  }
  return out;
}
