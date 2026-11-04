// The bot engine: creates the 4 bots + tracker, wires the pipeline and exposes every
// user action as a named command. Used by the browser (local mode) and by the Mac
// server (24/7 mode), so both behave exactly the same.
import { settings, saveSettings, resetSettings, paper, tokens, on, log, PROFILES, applyProfile } from './store.js?v=20261104174655';
import { SniperBot } from './sniper.js?v=20261104174655';
import { SecurityBot } from './security.js?v=20261104174655';
import { RealCheckBot } from './realcheck.js?v=20261104174655';
import { PaperBot } from './paper.js?v=20261104174655';
import { TrackerBot } from './metingen.js?v=20261104174655';
import { train, setModel, getModel } from './model.js?v=20261104174655';
import { AutoLearner } from './autolearn.js?v=20261104174655';

const RUN_KEY = 'solbot.running.v1';
const BOT_IDS = ['sniper', 'security', 'real', 'paper'];

export function createEngine() {
  const sniper = new SniperBot();
  const security = new SecurityBot();
  const real = new RealCheckBot();
  const trader = new PaperBot();
  const bots = { sniper, security, real, paper: trader };
  const tracker = new TrackerBot(); // background: always on, not part of start/stop all
  const learner = new AutoLearner(tracker);

  const persistRunning = () => {
    try { localStorage.setItem(RUN_KEY, JSON.stringify(BOT_IDS.filter((k) => bots[k].running))); } catch { /* ignore */ }
  };

  function trainModel(manual = false) {
    const m = train(tracker.list());
    if (m.error) { if (manual) log('app', `🧠 ${m.error}`, 'warn'); return m; }
    setModel(m);
    log('app', `🧠 Model getraind op ${m.n} coins (${m.pos} winnaars) · betrouwbaarheid AUC ${m.auc == null ? '?' : m.auc.toFixed(2)}`, 'ok');
    return m;
  }

  /** Starts the real thing: pipeline wiring, tracker, model training, restore running bots. */
  function startLocal() {
    on('candidate', (t) => security.enqueue(t));
    on('secured', (t) => real.add(t));
    on('confirmed', (t) => trader.onConfirmed(t));
    tracker.start();
    setInterval(() => trainModel(false), 60 * 60000);
    setTimeout(() => { if (!getModel()) trainModel(false); }, 15000);
    // Automatisch leren: every hour (first round 3 min after start)
    setTimeout(() => learner.run(false), 3 * 60000);
    setInterval(() => learner.run(false), 60 * 60000);
    try { JSON.parse(localStorage.getItem(RUN_KEY) || '[]').forEach((k) => bots[k]?.start()); } catch { /* ignore */ }
  }

  // ---------- commands (every user action) ----------
  const setOne = (bot, key, value) => {
    if (!settings[bot] || !(key in settings[bot])) throw new Error(`onbekende instelling ${bot}.${key}`);
    settings[bot][key] = typeof settings[bot][key] === 'boolean' ? !!value : Number(value);
  };
  const commands = {
    toggle({ bot }) { const b = bots[bot]; b.running ? b.stop() : b.start(); persistRunning(); },
    once({ bot }) { bots[bot].runOnce(); },
    startAll() { BOT_IDS.forEach((k) => bots[k].start()); persistRunning(); },
    stopAll() { BOT_IDS.forEach((k) => bots[k].running && bots[k].stop()); persistRunning(); },
    setting({ bot, key, value }) {
      setOne(bot, key, value);
      saveSettings();
      if (bot === 'sniper' && /^use(Launches|Migrations)$/.test(key)) { sniper.closeSocket(); sniper.ensureSocket(); }
      log(bot, `Instelling ${key} = ${settings[bot][key]}`);
    },
    settings({ bot, patch, msg }) {
      for (const [k, v] of Object.entries(patch || {})) setOne(bot, k, v);
      saveSettings();
      if (msg) log(bot, msg, 'ok');
    },
    profile({ name }) {
      if (!PROFILES[name]) throw new Error('onbekend profiel');
      applyProfile(name);
      log('app', `Profiel ${PROFILES[name].label} actief`, 'ok');
      for (const b of BOT_IDS) log(b, `Profiel ${PROFILES[name].label} toegepast`, 'ok');
    },
    resetSettings() { resetSettings(); log('app', 'Instellingen hersteld', 'warn'); },
    async close({ id }) {
      const pos = paper.positions.find((p) => p.id === id);
      if (pos) await trader.sell(pos, 'Handmatig verkocht');
    },
    async buy({ mint }) {
      const t = tokens.get(mint) || trader.signals.find((x) => x.mint === mint);
      if (!t) throw new Error('signaal niet gevonden');
      try { await trader.buy(t); } catch (err) { log('paper', `Koop fout: ${err.message}`, 'err'); }
    },
    async check({ mint }) {
      await security.addManual(mint);
      if (!security.running) log('security', 'Tip: start de Security bot om de wachtrij te verwerken', 'warn');
    },
    resetPaper() { trader.reset(); },
    resetTracker() { tracker.reset(); },
    train({ manual = true } = {}) { const m = trainModel(manual); return m.error ? { error: m.error } : { n: m.n }; },
    learnRun() {
      trainModel(false);
      learner.run(true);
      log('app', '🧠 Leerronde uitgevoerd', 'ok');
    },
    learnRevert({ id }) { learner.revert(id); },
  };

  return { sniper, security, real, trader, tracker, learner, bots, commands, startLocal, trainModel };
}
