#!/usr/bin/env node
// SolBot server for the Mac: runs the 4 bots 24/7 (same code as the web app), serves the
// dashboard and a small API so the iPhone/Mac dashboards show live data and send commands.
//
//   node server/solbot-server.mjs            (normally started by launchd, see install-mac.sh)
//
// Data lives in ~/SolBot-data (or $SOLBOT_DATA): storage.json (settings, paper account,
// measurements, model), config.json (port, access code, optional ntfy topic), server.log.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.SOLBOT_DATA || path.join(os.homedir(), 'SolBot-data');
fs.mkdirSync(DATA, { recursive: true });

if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket === 'undefined') {
  console.error(`SolBot heeft Node.js 22 of nieuwer nodig (nu ${process.version}). Installeer de LTS-versie via https://nodejs.org`);
  process.exit(1);
}

// ---------- config ----------
const CONFIG_FILE = path.join(DATA, 'config.json');
const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); };
const newCode = () => crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase().padEnd(6, '7');
const config = { port: 8787, key: newCode(), ntfyTopic: '', ...readJSON(CONFIG_FILE, {}) };
if (process.env.PORT) config.port = Number(process.env.PORT);
writeJSON(CONFIG_FILE, config);

// ---------- localStorage for the bot modules, saved to storage.json ----------
const STORE_FILE = path.join(DATA, 'storage.json');
const store = readJSON(STORE_FILE, {});
let flushTimer = null;
const flush = () => { clearTimeout(flushTimer); flushTimer = null; writeJSON(STORE_FILE, store); };
const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 2000); };
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); scheduleFlush(); },
  removeItem: (k) => { delete store[k]; scheduleFlush(); },
  key: (i) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; scheduleFlush(); },
};

const ts = () => new Date().toLocaleString('nl-NL');
const say = (msg) => console.log(`[${ts()}] ${msg}`);
process.on('unhandledRejection', (e) => say(`⚠️ ${e?.message || e}`));
process.on('uncaughtException', (e) => say(`⚠️ ${e?.stack || e}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); say('SolBot server gestopt'); process.exit(0); });

// ---------- bots ----------
// Same module URLs (incl. ?v=…) as the bots use internally, so we share one store/event bus.
const VQ = (fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8').match(/\?v=\d+/) || [''])[0];
const mod = (f) => import(pathToFileURL(path.join(ROOT, 'js', f)).href + VQ);
const { createEngine } = await mod('engine.js');
const { createEventLog, buildState, buildSlow } = await mod('sync.js');
const { on } = await mod('store.js');

const eventLog = createEventLog();
const eng = createEngine();
on('log', ({ bot, msg, level }) => { if (level === 'ok' || level === 'err') say(`[${bot}] ${msg}`); });

// optional push notifications to the iPhone via the free ntfy app (https://ntfy.sh)
async function ntfy(title, body, tags) {
  if (!config.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
      method: 'POST', body, headers: { Title: encodeURIComponent(title), Tags: tags, 'X-Title-Encoding': 'url' },
    });
  } catch { /* ignore */ }
}
on('paper:buy', (p) => ntfy(`Gekocht: ${p.symbol}`, `${p.entrySol.toFixed(3)} SOL · score ${p.rank ?? '?'}`, 'green_circle'));
on('paper:partial', (p) => ntfy(`Deel verkocht: ${p.symbol}`, `+${p.pnlPct.toFixed(1)}% · ${p.soldSol.toFixed(3)} SOL veiliggesteld`, 'yellow_circle'));
on('paper:sell', (t) => ntfy(`Verkocht: ${t.symbol} ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`, `${t.reason} · ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL`,
  t.reason.startsWith('Dev verkoopt') ? 'rotating_light' : t.pnlSol >= 0 ? 'moneybag' : 'small_red_triangle_down'));

const firstRun = !('solbot.running.v1' in store);
eng.startLocal();
if (firstRun) eng.commands.startAll(); // on the Mac the point is 24/7: start everything the first time

// server-only commands
const serverCommands = {
  ntfy({ topic }) {
    config.ntfyTopic = String(topic || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    writeJSON(CONFIG_FILE, config);
    say(config.ntfyTopic ? `📱 Push via ntfy aan (topic ${config.ntfyTopic})` : '📱 Push via ntfy uit');
    if (config.ntfyTopic) ntfy('SolBot push staat aan', 'Je krijgt een melding bij elke koop en verkoop.', 'robot');
    return { topic: config.ntfyTopic };
  },
  serverInfo() { return { name: hostName(), port: config.port, ntfyTopic: config.ntfyTopic, dataDir: DATA, node: process.version }; },
};

// ---------- http ----------
const hostName = () => os.hostname().replace(/\.local$/, '');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

function send(req, res, status, body, type = 'application/json') {
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { 'content-type': type, 'cache-control': 'no-store' };
  if (data.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    data = zlib.gzipSync(data);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(data);
}

const readBody = (req, limit = 60e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('te groot')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');
  if (route === 'hello') return send(req, res, 200, { solbot: true, name: hostName() });
  if (req.headers['x-solbot-key'] !== config.key) return send(req, res, 401, { error: 'toegangscode nodig' });

  if (route === 'state' && req.method === 'GET') {
    const have = Object.fromEntries((url.searchParams.get('h') || '').split(',').filter(Boolean).map((x) => x.split(':')));
    return send(req, res, 200, buildState(eng, eventLog, Number(url.searchParams.get('since')) || 0, have));
  }
  if (route === 'slow' && req.method === 'GET') return send(req, res, 200, buildSlow(eng, Object.fromEntries(url.searchParams)));
  if (route === 'cmd' && req.method === 'POST') {
    const { name, args } = await readBody(req);
    const fn = eng.commands[name] || serverCommands[name];
    if (!fn) return send(req, res, 400, { error: `onbekende opdracht ${name}` });
    const result = await fn(args || {});
    flush();
    return send(req, res, 200, { ok: true, result: result ?? null });
  }
  if (route === 'export' && req.method === 'GET') {
    flush();
    const data = Object.fromEntries(Object.entries(store).filter(([k]) => k.startsWith('solbot.')));
    return send(req, res, 200, { solbotBackup: 1, at: Date.now(), data });
  }
  if (route === 'import' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b?.solbotBackup || !b.data) return send(req, res, 400, { error: 'geen SolBot-backup' });
    for (const [k, v] of Object.entries(b.data)) if (k.startsWith('solbot.') && k !== 'solbot.remoteKey') store[k] = String(v);
    flush();
    say('♻️ Backup teruggezet, server herstart…');
    send(req, res, 200, { ok: true, restarting: true });
    setTimeout(() => process.exit(0), 500); // launchd starts the server again with the restored data
    return undefined;
  }
  return send(req, res, 404, { error: 'onbekend' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || rel.includes('/.') || rel.startsWith('/server/')) return send(req, res, 404, 'not found', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(req, res, 404, 'not found', 'text/plain');
    send(req, res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(req, res, 500, { error: e.message });
  }
});

// If the port is taken (e.g. by another bot or app), use the next free one and remember it,
// so the address stays the same after restarts.
let tries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && tries < 20) {
    say(`⚠️ Poort ${config.port} is al in gebruik door een ander programma, probeer ${config.port + 1}…`);
    tries++;
    config.port++;
    setTimeout(() => server.listen(config.port, '0.0.0.0'), 200);
  } else {
    say(`❌ Server kon niet starten: ${e.message}`);
    flush();
    process.exit(1);
  }
});
server.on('listening', () => writeJSON(CONFIG_FILE, config));
server.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  say('──────────────────────────────────────────────');
  say(`🤖 SolBot server draait (Node ${process.version}) — bots draaien 24/7`);
  say(`   Op deze Mac:     http://localhost:${config.port}`);
  say(`   Thuis (iPhone):  http://${hostName()}.local:${config.port}${ips.length ? `   of   http://${ips[0]}:${config.port}` : ''}`);
  say(`   Toegangscode:    ${config.key}`);
  say(`   Data:            ${DATA}`);
  say('──────────────────────────────────────────────');
});
