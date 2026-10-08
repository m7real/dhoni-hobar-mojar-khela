/* audio.js — every sound is synthesised, so there are no asset files to ship. */
(function (global) {
  'use strict';

  var KEY = 'dhk:muted';

  function Audio() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.supported = typeof global.AudioContext === 'function' ||
      typeof global.webkitAudioContext === 'function';
    this.unlocked = false;

    try {
      this.muted = global.localStorage.getItem(KEY) === '1';
    } catch (_) { this.muted = false; }
  }

  // Browsers only allow audio after a gesture, so this is called from a click.
  Audio.prototype.unlock = function () {
    if (this.unlocked || !this.supported) return;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.unlocked = true;
    } catch (_) {
      this.supported = false;
    }
  };

  Audio.prototype.isMuted = function () { return this.muted; };

  Audio.prototype.setMuted = function (m) {
    this.muted = !!m;
    try { global.localStorage.setItem(KEY, m ? '1' : '0'); } catch (_) { /* ignore */ }
    if (this.master) this.master.gain.value = m ? 0 : 0.32;
  };

  Audio.prototype.toggle = function () {
    this.setMuted(!this.muted);
    return this.muted;
  };

  // ---- primitives ---------------------------------------------------------

  function env(node, ctx, at, attack, hold, release, peak) {
    var g = node.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(0.0001, at);
    g.exponentialRampToValueAtTime(peak, at + attack);
    g.setValueAtTime(peak, at + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  }

  // One shaped tone.
  Audio.prototype.tone = function (freq, opts) {
    if (!this.ready()) return;
    opts = opts || {};
    var ctx = this.ctx;
    var at = ctx.currentTime + (opts.delay || 0);
    var dur = opts.duration || 0.16;

    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (opts.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(opts.slideTo, at + dur);
    }
    env(gain, ctx, at, opts.attack || 0.01, (dur - (opts.attack || 0.01) - (opts.release || 0.08)) || 0.02,
      opts.release || 0.08, opts.peak || 0.5);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  };

  // A filtered noise burst, for dice and impacts.
  Audio.prototype.noise = function (opts) {
    if (!this.ready()) return;
    opts = opts || {};
    var ctx = this.ctx;
    var at = ctx.currentTime + (opts.delay || 0);
    var dur = opts.duration || 0.1;

    var frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    var src = ctx.createBufferSource();
    src.buffer = buffer;

    var filter = ctx.createBiquadFilter();
    filter.type = opts.filter || 'bandpass';
    filter.frequency.value = opts.freq || 1200;
    filter.Q.value = opts.q || 1.2;

    var gain = ctx.createGain();
    env(gain, ctx, at, 0.004, dur * 0.3, dur * 0.6, opts.peak || 0.3);

    src.connect(filter).connect(gain).connect(this.master);
    src.start(at);
  };

  Audio.prototype.ready = function () {
    if (!this.supported || this.muted) return false;
    if (!this.ctx) this.unlock();
    return !!this.ctx && !this.muted;
  };

  // ---- the game's voices --------------------------------------------------

  // Dice tumbling: a scatter of knocks that settle.
  Audio.prototype.dice = function () {
    if (!this.ready()) return;
    for (var i = 0; i < 7; i++) {
      this.noise({
        delay: i * 0.055 + Math.random() * 0.02,
        duration: 0.07,
        freq: 700 + Math.random() * 900,
        peak: 0.22 - i * 0.02
      });
    }
    this.tone(180, { delay: 0.36, duration: 0.1, type: 'triangle', slideTo: 120, peak: 0.25 });
  };

  Audio.prototype.buy = function () {
    if (!this.ready()) return;
    [523.25, 659.25, 783.99].forEach(function (f, i) {
      this.tone(f, { delay: i * 0.07, duration: 0.2, type: 'triangle', peak: 0.28 });
    }, this);
  };

  Audio.prototype.rent = function () {
    if (!this.ready()) return;
    this.tone(392, { duration: 0.14, type: 'sine', peak: 0.3 });
    this.tone(261.63, { delay: 0.09, duration: 0.22, type: 'sine', peak: 0.3 });
  };

  Audio.prototype.build = function () {
    if (!this.ready()) return;
    this.noise({ duration: 0.09, freq: 500, filter: 'lowpass', peak: 0.3 });
    this.tone(659.25, { delay: 0.05, duration: 0.14, type: 'square', peak: 0.14 });
  };

  Audio.prototype.card = function () {
    if (!this.ready()) return;
    this.noise({ duration: 0.14, freq: 2600, q: 0.6, peak: 0.18 });
    this.tone(880, { delay: 0.05, duration: 0.12, type: 'sine', peak: 0.2 });
  };

  Audio.prototype.jail = function () {
    if (!this.ready()) return;
    [220, 174.61, 138.59].forEach(function (f, i) {
      this.tone(f, { delay: i * 0.13, duration: 0.28, type: 'sawtooth', peak: 0.16 });
    }, this);
  };

  Audio.prototype.bankrupt = function () {
    if (!this.ready()) return;
    [440, 349.23, 261.63, 196].forEach(function (f, i) {
      this.tone(f, { delay: i * 0.16, duration: 0.4, type: 'sawtooth', peak: 0.2 });
    }, this);
  };

  Audio.prototype.trade = function () {
    if (!this.ready()) return;
    this.tone(587.33, { duration: 0.12, type: 'triangle', peak: 0.24 });
    this.tone(880, { delay: 0.1, duration: 0.18, type: 'triangle', peak: 0.24 });
  };

  Audio.prototype.win = function () {
    if (!this.ready()) return;
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      this.tone(f, { delay: i * 0.13, duration: 0.5, type: 'triangle', peak: 0.3 });
    }, this);
    this.noise({ delay: 0.52, duration: 0.4, freq: 4000, q: 0.4, peak: 0.12 });
  };

  Audio.prototype.click = function () {
    if (!this.ready()) return;
    this.noise({ duration: 0.035, freq: 2600, q: 1.6, peak: 0.12 });
  };

  // Map a server event onto a voice.
  Audio.prototype.forEvent = function (kind, detail) {
    switch (kind) {
      case 'roll': this.dice(); break;
      case 'buy': this.buy(); break;
      case 'rent': this.rent(); break;
      case 'build': this.build(); break;
      case 'card': this.card(); break;
      case 'jail': this.jail(); break;
      case 'bankrupt': this.bankrupt(); break;
      case 'trade': this.trade(); break;
      case 'win': this.win(); break;
      case 'click': this.click(); break;
      default: break;
    }
    void detail;
  };

  global.GameAudio = new Audio();
})(window);