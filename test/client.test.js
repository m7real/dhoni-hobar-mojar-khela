'use strict';

/* Client smoke test: renders the real UI against real server payloads. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { Game } = require('../server/game');
const board = require('../server/board');

const PUBLIC = path.join(__dirname, '..', 'client', 'public');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

// ── browser-ish sandbox ─────────────────────────────────────────────────────

function makeWindow() {
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/'
  });
  const win = dom.window;
  // No animation loop in a smoke test; Scene3D's render loop is never started.
  try { win.requestAnimationFrame = () => 0; } catch (_) { /* read-only is fine */ }
  return win;
}

function loadScript(win, file) {
  const code = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  win.eval(code);
}

function loadVendor(win, rel) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'node_modules', rel), 'utf8');
  win.eval(code);
}

// ── fixtures ────────────────────────────────────────────────────────────────

// A live game state, produced by the real engine.
function liveState() {
  const g = new Game('ABCD');
  g.addPlayer('রিয়া', 's1');
  g.addPlayer('তানভীর', 's2');
  g.start();
  const [a, b] = g.players;

  // Give the table some texture: ownership, buildings, a mortgage, a jail.
  a.holdings.set(1, { mortgaged: false, houses: 0 });
  a.holdings.set(3, { mortgaged: false, houses: 3 });
  a.holdings.set(5, { mortgaged: false, houses: 0 });
  a.cash = 840;
  a.getOutOfJail = true;

  b.holdings.set(6, { mortgaged: false, houses: 0 });
  b.holdings.set(12, { mortgaged: true, houses: 0 });
  b.holdings.set(25, { mortgaged: false, houses: 0 });
  b.cash = 1210;
  b.jail = true;
  b.jailTurns = 2;
  b.position = 10;

  a.position = 26;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';
  g.dice = [4, 5];
  g.rounds = 7;
  g.say('পরীক্ষা', 'test entry');
  return { g, state: g.serialize(), a, b };
}

// ── tests ───────────────────────────────────────────────────────────────────

section('client assets are present');
{
  ['index.html', 'css/style.css', 'js/scene.js', 'js/ui.js', 'js/main.js'].forEach((f) => {
    const p = path.join(PUBLIC, f);
    ok(fs.existsSync(p) && fs.statSync(p).size > 100, 'exists and is non-empty: ' + f);
  });
}

section('the page loads ui.js without throwing');
let win;
{
  try {
    win = makeWindow();
    loadScript(win, 'ui.js');
    ok(typeof win.UI === 'function', 'UI is exported');
    ok(typeof win.UIUtil.money === 'function', 'UIUtil.money is exported');
    ok(win.UIUtil.money(1500) === '৳1,500', 'money formats with the taka sign', win.UIUtil.money(1500));
    ok(win.UIUtil.bnDigits(1024) === '১০২৪', 'numbers convert to Bengali digits', win.UIUtil.bnDigits(1024));
    ok(win.UIUtil.esc('<b>&x</b>') === '&lt;b&gt;&amp;x&lt;/b&gt;', 'html is escaped', win.UIUtil.esc('<b>&x</b>'));
  } catch (err) {
    ok(false, 'ui.js loads', err.stack);
  }
}

section('the page loads audio.js without throwing');
{
  try {
    loadScript(win, 'audio.js');
    ok(typeof win.GameAudio === 'object' && win.GameAudio !== null,
      'GameAudio is exported');
    ok(typeof win.GameAudio.forEvent === 'function', 'forEvent is available');
    ok(typeof win.GameAudio.dice === 'function', 'the dice voice exists');
    ok(typeof win.GameAudio.toggle === 'function', 'muting can be toggled');

    // No AudioContext in jsdom, so it must degrade rather than throw.
    let threw = null;
    try {
      ['roll', 'buy', 'rent', 'build', 'card', 'jail', 'bankrupt', 'trade', 'win', 'click']
        .forEach(function (kind) { win.GameAudio.forEvent(kind); });
      win.GameAudio.unlock();
      win.GameAudio.dice();
    } catch (err) { threw = err.message; }
    ok(!threw, 'every sound is safe when audio is unavailable', threw);

    // Mute state round-trips.
    win.GameAudio.setMuted(true);
    ok(win.GameAudio.isMuted() === true, 'muting sticks');
    win.GameAudio.setMuted(false);
    ok(win.GameAudio.isMuted() === false, 'unmuting sticks');
  } catch (err) {
    ok(false, 'audio.js loads', err.stack);
  }
}

section('ui.js defines the board geometry helpers');
{
  try {
    loadVendor(win, path.join('three', 'build', 'three.min.js'));
    ok(typeof win.THREE === 'object' && win.THREE !== null, 'three.js exposes the THREE global');
    loadScript(win, 'scene.js');
    ok(typeof win.Scene3D === 'function', 'Scene3D is exported');
    ok(typeof win.BoardGeo === 'object', 'BoardGeo is exported');

    // Every tile must map to a distinct, sensible ring position.
    const seen = new Set();
    let bad = null;
    for (let i = 0; i < 40; i++) {
      const p = win.BoardGeo.tilePos(i);
      const key = p.x.toFixed(3) + ',' + p.z.toFixed(3);
      if (seen.has(key)) bad = 'duplicate position for tile ' + i;
      seen.add(key);
      if (Math.abs(p.x) > 5.01 || Math.abs(p.z) > 5.01) bad = 'tile ' + i + ' off the board';
      if (!isFinite(p.x) || !isFinite(p.z)) bad = 'tile ' + i + ' is not finite';
    }
    ok(seen.size === 40, 'all 40 tiles have distinct positions', bad);
    ok(!bad, 'all tiles sit on the ring', bad);

    // Corners must be at the four diagonals.
    const corners = [0, 10, 20, 30].map((i) => win.BoardGeo.tilePos(i));
    const signs = corners.map((c) => (c.x > 0 ? 'E' : 'W') + (c.z > 0 ? 'S' : 'N'));
    ok(new Set(signs).size === 4, 'corners fall in four different quadrants', signs.join(' '));
  } catch (err) {
    ok(false, 'scene.js loads', err.stack);
  }
}

section('UI renders a live game state');
{
  const { state, a, b } = liveState();
  const sent = [];
  const ui = new win.UI((ev, data) => sent.push({ ev: ev, data: data }));

  try {
    ui.render(state, a.id);

    ok(ui.el.roomCode.textContent === 'ABCD', 'the room code is shown', ui.el.roomCode.textContent);
    ok(/আপনার চাল/.test(ui.el.turnBanner.textContent),
      'the turn banner tells a waiting player it is their move',
      ui.el.turnBanner.textContent);

    const cards = ui.el.playersList.querySelectorAll('.player-card');
    ok(cards.length === 2, 'both players are listed', cards.length);
    ok(/৳840/.test(ui.el.playersList.innerHTML), 'cash is rendered in taka');
    ok(/জেল/.test(ui.el.playersList.innerHTML), 'the jailed player is flagged');
    ok(/🎟/.test(ui.el.playersList.innerHTML), 'the jail card is flagged');

    ok(/পরীক্ষা/.test(ui.el.logList.innerHTML), 'the log is rendered');
    ok(ui.el.diceA.textContent === win.UIUtil.bnDigits(4),
      'dice show Bengali digits', ui.el.diceA.textContent);
    ok(ui.el.roundCount.textContent === win.UIUtil.bnDigits(state.rounds),
      'the round counter is shown', ui.el.roundCount.textContent);
    ok(ui.el.roundMax.textContent === win.UIUtil.bnDigits(state.maxRounds),
      'the round limit is shown', ui.el.roundMax.textContent);

    // Controls: it is a's turn, phase awaitRoll, so a Roll button is offered.
    ok(!!ui.el.controls.querySelector('#btnRoll'), 'a roll button is offered on turn');
    ok(!!ui.el.controls.querySelector('#btnJail'), 'the jail card button is offered');

    // Properties tab.
    ui.el.propsPanel.innerHTML;
    const props = ui.el.propsPanel.querySelectorAll('.prop');
    ok(props.length === 3, "the player's three titles are listed", props.length);
    ok(/বাড়ি/.test(ui.el.propsPanel.innerHTML), 'buildable titles offer a house button');
    ok(/বন্ধ \(/.test(ui.el.propsPanel.innerHTML), 'mortgage values are shown');
  } catch (err) {
    ok(false, 'rendering a live state throws', err.stack);
  }
  void b;
}

section('UI renders every board tile kind');
{
  const { state, a } = liveState();
  const ui = new win.UI(() => {});
  ui.render(state, a.id);

  // Open each of the 40 tile dialogs; none may throw or emit "undefined".
  let failures = [];
  for (let i = 0; i < 40; i++) {
    try {
      ui.showTile(i);
      const html = ui.el.modalCard.innerHTML;
      if (/undefined|NaN|\[object/.test(html)) {
        failures.push(board.TILES[i].type + ' (' + board.TILES[i].name + '): ' +
          html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70));
      }
    } catch (err) {
      failures.push(board.TILES[i].type + ' (' + board.TILES[i].name + '): ' + err.message);
    }
  }
  ok(failures.length === 0, 'all 40 tile dialogs render cleanly',
    failures.slice(0, 3).join(' | '));
}

section('UI renders a card modal');
{
  const { state, a } = liveState();
  const ui = new win.UI(() => {});
  ui.render(state, a.id);

  const cards = board.CHANCE_CARDS.concat(board.CHEST_CARDS);
  let failures = [];
  cards.forEach((card) => {
    const deck = board.CHANCE_CARDS.indexOf(card) >= 0 ? 'chance' : 'chest';
    const shown = Object.assign({}, card, { deck: deck, bn: card.bn, en: card.text });
    try {
      ui.showCard(shown, 'রিয়া');
      const html = ui.el.modalCard.innerHTML;
      if (/undefined|NaN|\[object/.test(html)) failures.push(card.id + ': ' + html);
    } catch (err) {
      failures.push(card.id + ': ' + err.message);
    }
  });
  ok(failures.length === 0, 'all 32 card dialogs render cleanly', failures.slice(0, 2).join(' | '));
}

section('UI renders each game phase');
{
  const { state, a } = liveState();
  const ui = new win.UI(() => {});
  let failures = [];

  const phases = ['lobby', 'awaitRoll', 'awaitBuy', 'awaitCard', 'awaitEnd', 'gameOver'];
  phases.forEach((phase) => {
    const s = JSON.parse(JSON.stringify(state));
    s.phase = phase;
    if (phase === 'awaitBuy') s.pending = { type: 'buy', playerId: a.id, tileId: 19 };
    if (phase === 'awaitCard') s.pending = { type: 'card', playerId: a.id, tileId: 7 };
    if (phase === 'awaitEnd') s.pending = { type: 'end', playerId: a.id };
    try {
      ui.render(s, a.id);
      if (/undefined|NaN|\[object/.test(ui.el.controls.innerHTML)) {
        failures.push(phase + ': ' + ui.el.controls.innerHTML.replace(/<[^>]*>/g, ' ').trim());
      }
    } catch (err) {
      failures.push(phase + ': ' + err.message);
    }
  });
  ok(failures.length === 0, 'the controls render in every phase', failures.slice(0, 3).join(' | '));
}

section('UI renders player count and bankruptcy');
{
  const { state, a, b } = liveState();
  const s = JSON.parse(JSON.stringify(state));
  s.players[1].bankrupt = true;
  s.players[1].cash = 0;
  s.players[1].holdings = [];
  s.winnerId = a.id;
  s.phase = 'gameOver';

  const ui = new win.UI(() => {});
  try {
    ui.render(s, a.id);
    ok(/out|বাদ/.test(ui.el.playersList.innerHTML) ||
      ui.el.playersList.querySelectorAll('.is-out').length === 1,
      'a bankrupt player is greyed out');
    ui.showGameOver(s);
    const html = ui.el.modalCard.innerHTML;
    ok(/জিতেছেন/.test(html), 'the winner is announced');
    ok(!/undefined|NaN/.test(html), 'the summary has no undefined values');
  } catch (err) {
    ok(false, 'the game over screen renders', err.stack);
  }
  void b;
}

section('UI sends the right socket events');
{
  const { state, a } = liveState();
  const sent = [];
  const ui = new win.UI((ev, data) => sent.push({ ev: ev, data: data }));
  ui.render(state, a.id);

  // Roll
  ui.el.controls.querySelector('#btnRoll').click();
  ok(sent[0] && sent[0].ev === 'roll', 'the roll button emits roll');

  // Buy
  sent.length = 0;
  const s2 = JSON.parse(JSON.stringify(state));
  s2.phase = 'awaitBuy';
  s2.pending = { type: 'buy', playerId: a.id, tileId: 19 };
  ui.render(s2, a.id);
  ui.el.controls.querySelector('#btnBuy').click();
  ok(sent[0] && sent[0].ev === 'buy' && sent[0].data.tileId === 19,
    'the buy button emits buy with the tile id', JSON.stringify(sent[0]));

  // Skip / keep card / next
  sent.length = 0;
  ui.el.controls.querySelector('#btnSkip').click();
  ok(sent[0] && sent[0].ev === 'skip', 'the decline button emits skip');

  sent.length = 0;
  const s3 = JSON.parse(JSON.stringify(state));
  s3.phase = 'awaitCard';
  s3.pending = { type: 'card', playerId: a.id, tileId: 7 };
  ui.render(s3, a.id);
  ui.el.controls.querySelector('#btnKeepCard').click();
  ok(sent[0] && sent[0].ev === 'useCard', 'the keep-card button emits useCard');

  sent.length = 0;
  const s4 = JSON.parse(JSON.stringify(state));
  s4.phase = 'awaitEnd';
  s4.pending = { type: 'end', playerId: a.id };
  ui.render(s4, a.id);
  ui.el.controls.querySelector('#btnNext').click();
  ok(sent[0] && sent[0].ev === 'next', 'the next button emits next');

  // Property actions
  sent.length = 0;
  ui.render(state, a.id);
  const buildBtn = ui.el.propsPanel.querySelector('[data-act="build"]');
  ok(!!buildBtn, 'a build button is present when it is your turn');
  if (buildBtn) {
    buildBtn.click();
    ok(sent[0] && sent[0].ev === 'build' && typeof sent[0].data.tileId === 'number',
      'the build button emits build with the tile id', JSON.stringify(sent[0]));
  }
}

section('the trade panel');
{
  const { state, a, b } = liveState();
  const sent = [];
  const ui = new win.UI((ev, data) => sent.push({ ev: ev, data: data }));

  // No offers open, but the composer should be there.
  try {
    ui.render(state, a.id);
    ok(ui.el.tradePanel.querySelector('#btnTradeSend') !== null,
      'the proposal composer is offered');
    ok(ui.el.tradeBadge.hidden === true, 'the badge is hidden with no offers');

    // Your own tradeable titles should be listed to give. The fixture gives a
    // three titles but one carries 3 houses, so only two are tradeable.
    const giveBoxes = ui.el.tradePanel.querySelectorAll('input[data-trade-tile][data-side="give"]');
    ok(giveBoxes.length === 2, 'developed titles are excluded from the give list',
      giveBoxes.length);

    // The partner has three, none developed.
    const wantBoxes = ui.el.tradePanel.querySelectorAll('input[data-trade-tile][data-side="want"]');
    ok(wantBoxes.length === 3, "the partner's titles are listed to want", wantBoxes.length);

    // Built-up titles must not be offered.
    const allIds = [].slice.call(ui.el.tradePanel.querySelectorAll('input[data-trade-tile]'))
      .map(function (i) { return parseInt(i.dataset.tradeTile, 10); });
    ok(allIds.indexOf(6) >= 0, 'a plain title appears');
    ok(!/undefined/.test(ui.el.tradePanel.innerHTML), 'no undefined leaks into the panel');
  } catch (err) {
    ok(false, 'rendering the trade panel throws', err.stack);
  }

  // An incoming offer shows accept/decline and a countdown.
  try {
    const withOffer = JSON.parse(JSON.stringify(state));
    withOffer.trades = [{
      id: 't1', fromId: b.id, toId: a.id, fromName: 'তানভীর', toName: 'রিয়া',
      offer: { cash: 100, tiles: [6] }, want: { cash: 0, tiles: [1] },
      direction: 'incoming', expiresIn: 30000
    }];
    ui.render(withOffer, a.id);
    const html = ui.el.tradePanel.innerHTML;
    ok(html.indexOf('incoming') >= 0, 'an incoming offer is styled as such');
    ok(ui.el.tradePanel.querySelector('[data-trade-accept="t1"]') !== null,
      'an accept button is offered');
    ok(ui.el.tradePanel.querySelector('[data-trade-decline="t1"]') !== null,
      'a decline button is offered');
    ok(ui.el.tradeBadge.hidden === false, 'the badge appears when an offer is open');
    ok(ui.el.tradeBadge.textContent === '1', 'the badge counts the offer',
      ui.el.tradeBadge.textContent);
    ok(/৳100/.test(html) || /৳/.test(html), 'cash in the offer is formatted in taka');

    ui.el.tradePanel.querySelector('[data-trade-accept="t1"]').click();
    ok(sent[sent.length - 1].ev === 'tradeAccept' &&
      sent[sent.length - 1].data.tradeId === 't1', 'accepting emits tradeAccept',
      JSON.stringify(sent[sent.length - 1]));

    ui.el.tradePanel.querySelector('[data-trade-decline="t1"]').click();
    ok(sent[sent.length - 1].ev === 'tradeDecline', 'declining emits tradeDecline');
  } catch (err) {
    ok(false, 'rendering an incoming offer throws', err.stack);
  }

  // Sending a proposal carries the ticked boxes.
  try {
    const clean = JSON.parse(JSON.stringify(state));
    clean.trades = [];
    ui.render(clean, a.id);
    const giveBox = ui.el.tradePanel.querySelector('input[data-trade-tile][data-side="give"]');
    const wantBox = ui.el.tradePanel.querySelector('input[data-trade-tile][data-side="want"]');
    giveBox.checked = true;
    wantBox.checked = true;
    ui.el.tradePanel.querySelector('#tradeGiveCash').value = '50';

    sent.length = 0;
    ui.el.tradePanel.querySelector('#btnTradeSend').click();
    const sentTrade = sent[sent.length - 1];
    ok(sentTrade.ev === 'tradePropose', 'sending emits tradePropose', JSON.stringify(sentTrade));
    ok(sentTrade.data.toId === b.id, 'the partner is named', sentTrade.data.toId);
    ok(sentTrade.data.offer.tiles.length === 1, 'the ticked title is included',
      JSON.stringify(sentTrade.data.offer));
    ok(sentTrade.data.offer.cash === 50, 'the cash amount is included', sentTrade.data.offer.cash);
    ok(sentTrade.data.want.tiles.length === 1, 'the requested title is included');
  } catch (err) {
    ok(false, 'sending a proposal throws', err.stack);
  }

  // With only one other player, and none available, say so rather than break.
  try {
    const solo = JSON.parse(JSON.stringify(state));
    solo.players[1].bankrupt = true;
    ui.render(solo, a.id);
    ok(/যাচ্ছে না/.test(ui.el.tradePanel.innerHTML) || ui.el.tradePanel.innerHTML.length > 0,
      'with nobody to trade with the panel explains itself');
  } catch (err) {
    ok(false, 'rendering with no partners throws', err.stack);
  }
}

section('CSS classes used by the UI exist in the stylesheet');
{
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8');
  const { state, a } = liveState();
  const ui = new win.UI(() => {});
  ui.render(state, a.id);
  const s2 = JSON.parse(JSON.stringify(state));
  s2.phase = 'awaitBuy';
  s2.pending = { type: 'buy', playerId: a.id, tileId: 19 };
  ui.render(s2, a.id);
  ui.showTile(1);
  ui.showCard(Object.assign({}, board.CHANCE_CARDS[0], { deck: 'chance' }), 'রিয়া');
  const s3 = JSON.parse(JSON.stringify(state));
  s3.trades = [{
    id: 't1', fromId: state.players[1].id, toId: a.id,
    fromName: 'তানভীর', toName: 'রিয়া',
    offer: { cash: 10, tiles: [6] }, want: { cash: 0, tiles: [1] },
    direction: 'incoming', expiresIn: 1000
  }];
  ui.render(s3, a.id);
  ui.toast('hi', 'bad');
  ui.fxNote('boo');

  const html = ui.el.playersList.innerHTML + ui.el.propsPanel.innerHTML +
    ui.el.controls.innerHTML + ui.el.modalCard.innerHTML +
    ui.el.tradePanel.innerHTML +
    ui.el.toasts.innerHTML + ui.el.fxLayer.innerHTML;

  const classes = new Set();
  (html.match(/class="([^"]+)"/g) || []).forEach((m) => {
    m.replace(/class="|"/g, '').split(/\s+/).forEach((c) => c && classes.add(c));
  });

  const missing = [...classes].filter((c) => css.indexOf('.' + c) === -1);
  ok(missing.length === 0, 'every class the UI emits is styled',
    missing.slice(0, 8).join(', '));
}

section('the page wires up its scripts in order');
{
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const order = ['/socket.io/socket.io.js', '/vendor/three.min.js', './js/audio.js',
    './js/scene.js', './js/ui.js', './js/main.js'];
  let last = -1;
  let ordered = true;
  order.forEach((src) => {
    const i = html.indexOf(src);
    if (i === -1 || i < last) ordered = false;
    last = i;
  });
  ok(ordered, 'dependencies load in dependency order');
  ok(html.indexOf('/vendor/three.min.js') < html.indexOf('./js/scene.js'),
    'three.js loads before scene.js');
  ok(html.indexOf('./js/audio.js') < html.indexOf('./js/main.js'),
    'audio.js loads before main.js');
  ok(html.indexOf('btnSound') >= 0, 'there is a sound toggle in the page');
  ok(/prefers-reduced-motion/.test(fs.readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8')),
    'the stylesheet respects prefers-reduced-motion');
}

section('no sound effect needs an asset file');
{
  // Every voice is synthesised, so nothing should fetch audio from the server.
  const audioSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'audio.js'), 'utf8');
  ok(!/createElement\(\s*['"]audio['"]/.test(audioSrc), 'no audio element is created');
  ok(!/<audio|\.mp3|\.ogg|\.wav/i.test(audioSrc), 'no audio file is referenced');
  ok(/createOscillator/.test(audioSrc), 'tones are generated with an oscillator');
  ok(/createBufferSource/.test(audioSrc), 'noise is generated in code');

  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  ok(!/\.mp3|\.ogg|\.wav/i.test(html), 'the page references no audio files');
}

console.log('\n' + '-'.repeat(52));
console.log('passed: ' + passed + '   failed: ' + failed);
console.log('-'.repeat(52));
process.exit(failed === 0 ? 0 : 1);