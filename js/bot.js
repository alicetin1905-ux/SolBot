import { emit, log } from './store.js?v=20261102235128';

/** Base class: a bot runs `tick()` on an interval while it is started. */
export class Bot {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.lastRun = 0;
    this.lastError = null;
  }

  intervalMs() { return 30000; }

  start() {
    if (this.running) return;
    this.running = true;
    log(this.id, `${this.name} gestart`, 'ok');
    this.changed();
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    log(this.id, `${this.name} gestopt`, 'warn');
    this.changed();
  }

  async loop() {
    if (!this.running) return;
    if (!this.busy) {
      this.busy = true;
      this.changed();
      try {
        await this.tick();
        this.lastError = null;
      } catch (e) {
        this.lastError = e.message || String(e);
        log(this.id, `Fout: ${this.lastError}`, 'err');
      } finally {
        this.busy = false;
        this.lastRun = Date.now();
        this.changed();
      }
    }
    if (this.running) this.timer = setTimeout(() => this.loop(), this.intervalMs());
  }

  /** Runs one cycle right away (also when stopped). */
  async runOnce() {
    if (this.busy) return;
    this.busy = true;
    this.changed();
    try { await this.tick(); } catch (e) { log(this.id, `Fout: ${e.message}`, 'err'); }
    finally { this.busy = false; this.lastRun = Date.now(); this.changed(); }
  }

  changed() { emit('bot', this); }
  async tick() {}
}
