#!/usr/bin/env node
// SolBot launcher (started by launchd). Runs the server and restarts it when it stops.
// Safety net for remote updates: if a freshly installed version crashes 3× within a minute
// of starting, the previous version (~/SolBot-backup) is put back automatically.
// Keep this file small and stable: it is the part that must keep working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = `${ROOT}-backup`;
const DATA = process.env.SOLBOT_DATA || path.join(os.homedir(), 'SolBot-data');
const UPDATE_FILE = path.join(DATA, 'update.json');

const say = (msg) => console.log(`[${new Date().toLocaleString('nl-NL')}] [launcher] ${msg}`);
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

let child = null;
function start() {
  const t0 = Date.now();
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'solbot-server.mjs')], { stdio: 'inherit', env: { ...process.env, SOLBOT_LAUNCHER: '1' }, cwd: ROOT });
  child.on('exit', (code, signal) => {
    child = null;
    const upd = readJSON(UPDATE_FILE);
    if (upd && code !== 0 && Date.now() - t0 < 60000) {
      upd.fails = (upd.fails || 0) + 1;
      fs.writeFileSync(UPDATE_FILE, JSON.stringify(upd));
      say(`⚠️ Nieuwe versie ${upd.to} startte niet goed (${upd.fails}/3)`);
      if (upd.fails >= 3 && fs.existsSync(path.join(BACKUP, 'server', 'solbot-server.mjs'))) {
        try {
          fs.rmSync(`${ROOT}-mislukt`, { recursive: true, force: true });
          fs.renameSync(ROOT, `${ROOT}-mislukt`);
          fs.renameSync(BACKUP, ROOT);
          fs.writeFileSync(UPDATE_FILE.replace('update.json', 'update-rollback.json'), JSON.stringify({ ...upd, rolledBackAt: Date.now() }));
          fs.rmSync(UPDATE_FILE, { force: true });
          say(`↩️ Teruggezet naar de vorige versie ${upd.from}`);
        } catch (e) { say(`Terugzetten mislukt: ${e.message}`); }
      }
    }
    if (signal === 'SIGTERM' && stopping) return;
    setTimeout(start, code === 0 ? 1000 : 3000);
  });
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) { child.once('exit', () => process.exit(0)); child.kill('SIGTERM'); } else process.exit(0);
  });
}
start();
