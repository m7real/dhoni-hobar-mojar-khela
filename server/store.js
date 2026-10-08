'use strict';

/*
 * Disk store for in-progress games.
 *
 * Writes are atomic (temp file + rename) and debounced, because a single turn
 * can push several state changes in a fraction of a second and there is no
 * point doing all that I/O twice.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CODE_RE = /^[A-Z0-9]{4}$/;
const SAVE_DEBOUNCE_MS = 250;
const MAX_LOG_LINES = 80;

function isValidCode(code) {
  // The code becomes a path segment, so it must never be able to escape the
  // store directory.
  return typeof code === 'string' && CODE_RE.test(code);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.enabled = true;
    this.timers = new Map();
    this.writing = new Set();
    this.lastError = null;
  }

  async init() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
    } catch (err) {
      this.enabled = false;
      this.lastError = 'cannot create store directory: ' + err.message;
      console.warn('[store] ' + this.lastError + ' — running without saving');
      return false;
    }
    return true;
  }

  fileFor(code) {
    return path.join(this.dir, code + '.json');
  }

  // Debounced save. Safe to call on every state change.
  save(code, snapshot) {
    if (!this.enabled || !isValidCode(code)) return;
    const existing = this.timers.get(code);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(code);
      this._write(code, snapshot).catch((err) => {
        this.lastError = err.message;
        console.warn('[store] failed to save ' + code + ': ' + err.message);
      });
    }, SAVE_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    this.timers.set(code, timer);
  }

  // Write immediately, bypassing the debounce. Used on shutdown.
  async flush(code, snapshot) {
    if (!this.enabled || !isValidCode(code)) return;
    const timer = this.timers.get(code);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(code);
    }
    await this._write(code, snapshot);
  }

  async _write(code, snapshot) {
    if (!this.enabled || !isValidCode(code)) return;
    if (this.writing.has(code)) return;      // never interleave writes per room
    this.writing.add(code);

    const target = this.fileFor(code);
    const tmp = target + '.' + process.pid + '.tmp';
    try {
      const json = JSON.stringify(snapshot);
      await fsp.writeFile(tmp, json, 'utf8');
      await fsp.rename(tmp, target);        // atomic on POSIX and Windows
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    } finally {
      this.writing.delete(code);
    }
  }

  async load(code) {
    if (!this.enabled || !isValidCode(code)) return null;
    try {
      const raw = await fsp.readFile(this.fileFor(code), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // A corrupt file must not stop the server booting.
      console.warn('[store] ignoring unreadable save for ' + code + ': ' + err.message);
      return null;
    }
  }

  async remove(code) {
    if (!this.enabled || !isValidCode(code)) return;
    const timer = this.timers.get(code);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(code);
    }
    try {
      await fsp.unlink(this.fileFor(code));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[store] could not delete ' + code + ': ' + err.message);
      }
    }
  }

  async list() {
    if (!this.enabled) return [];
    try {
      const names = await fsp.readdir(this.dir);
      return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
        .filter(isValidCode);
    } catch (err) {
      return [];
    }
  }

  // Forget saves for rooms that finished long ago, so the disk does not grow
  // without bound. Anything still live or recent is left alone.
  // A maxAgeMs of zero or less means "sweep everything eligible".
  async sweep(maxAgeMs) {
    const codes = await this.list();
    const sweepAll = !(maxAgeMs > 0);
    const cutoff = Date.now() - (maxAgeMs > 0 ? maxAgeMs : 0);
    let removed = 0;

    for (const code of codes) {
      try {
        if (!sweepAll) {
          const stat = await fsp.stat(this.fileFor(code));
          if (stat.mtimeMs >= cutoff) continue;
        }
        const data = await this.load(code);
        const finished = !data || data.phase === 'gameOver';
        if (finished) {
          await this.remove(code);
          removed++;
        }
      } catch (err) {
        /* best effort */
      }
    }
    if (removed) console.log('[store] swept ' + removed + ' finished room(s)');
    return removed;
  }

  // Make sure nothing is lost on the way out.
  async flushAll(getSnapshot) {
    const codes = await this.list();
    for (const code of codes) {
      const timer = this.timers.get(code);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(code);
      }
      try {
        const snapshot = getSnapshot(code);
        if (snapshot) await this._write(code, snapshot);
      } catch (err) {
        /* best effort during shutdown */
      }
    }
  }
}

module.exports = { Store, isValidCode, SAVE_DEBOUNCE_MS, MAX_LOG_LINES };