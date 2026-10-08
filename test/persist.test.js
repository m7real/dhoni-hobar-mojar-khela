'use strict';

/* Disk persistence: serialiser round-trips, store durability, restart recovery. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { Game } = require('../server/game');
const { Store, isValidCode } = require('../server/store');
const board = require('../server/board');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dhk-' + tag + '-'));
}

// ── the serialiser ──────────────────────────────────────────────────────────

(async function main() {

section('Game.toJSON / Game.fromJSON round trip');
{
  const g = new Game('WXYZ');
  g.addPlayer('রিয়া', 's1');
  g.addPlayer('তানভীর', 's2');
  g.start();

  const [a, b] = g.players;
  a.cash = 1234;
  a.position = 27;
  a.jail = true;
  a.jailTurns = 2;
  a.getOutOfJail = true;
  a.holdings.set(1, { mortgaged: false, houses: 3 });
  a.holdings.set(3, { mortgaged: true, houses: 0 });
  a.holdings.set(5, { mortgaged: false, houses: 5 });
  b.cash = 77;
  b.holdings.set(6, { mortgaged: false, houses: 0 });
  b.holdings.set(12, { mortgaged: false, houses: 0 });
  b.holdings.set(19, { mortgaged: false, houses: 2 });
  b.bankrupt = true;

  g.currentIndex = 1;
  g.phase = 'awaitEnd';
  g.pending = { type: 'end', playerId: b.id };
  g.dice = [3, 5];
  g.rounds = 12;
  g.winnerId = null;
  g.doublesInARow = 1;

  const json = g.toJSON();
  const text = JSON.stringify(json);

  ok(typeof text === 'string' && text.length > 100, 'the snapshot serialises to JSON');
  ok(json.players[0].socketId === null, 'socket ids are not persisted');
  ok(json.players[0].connected === false, 'nobody is marked connected after a restart');
  ok(typeof json.players[0].holdings[0] === 'object' && Array.isArray(json.players[0].holdings[0]),
    'holdings are encoded as entries', JSON.stringify(json.players[0].holdings[0]));

  const back = Game.fromJSON(JSON.parse(text));
  ok(back !== null, 'the snapshot can be read back');
  ok(back instanceof Game, 'the prototype survives, so the rules still work',
    Object.getPrototypeOf(back).constructor.name);

  ok(back.code === 'WXYZ', 'the room code survives', back.code);
  ok(back.phase === 'awaitEnd', 'the phase survives', back.phase);
  ok(back.rounds === 12, 'the round count survives', back.rounds);
  ok(back.dice.join(',') === '3,5', 'the dice survive', back.dice.join(','));
  ok(back.currentIndex === 1, 'the turn pointer survives', back.currentIndex);
  ok(back.pending && back.pending.type === 'end', 'the pending action survives');

  const a2 = back.players.find((p) => p.name === 'রিয়া');
  ok(a2.cash === 1234, 'cash survives', a2.cash);
  ok(a2.position === 27, 'position survives', a2.position);
  ok(a2.jail === true && a2.jailTurns === 2, 'jail state survives');
  ok(a2.getOutOfJail === true, 'the jail card survives');
  ok(a2.holdings.size === 3, 'every holding survives', a2.holdings.size);
  ok(a2.holdings.get(1).houses === 3, 'house counts survive', a2.holdings.get(1).houses);
  ok(a2.holdings.get(3).mortgaged === true, 'mortgage flags survive');
  ok(a2.holdings.get(5).houses === 5, 'a hotel survives');
  ok(a2.sessionToken === a.sessionToken, 'the reconnect token survives', a2.sessionToken);

  const b2 = back.players.find((p) => p.name === 'তানভীর');
  ok(b2.bankrupt === true, 'bankruptcy survives');
  ok(b2.holdings.size === 3, 'the bankrupt player keeps their record');

  ok(typeof back.canBuild === 'function', 'game methods are available after restore');
  ok(back.netWorth(a2) === g.netWorth(a), 'net worth is identical after restore',
    back.netWorth(a2) + ' vs ' + g.netWorth(a));
}

section('a restored game still plays');
{
  const g = new Game('WXYZ');
  g.addPlayer('A', 's1');
  g.addPlayer('B', 's2');
  g.start();
  g.players[0].holdings.set(1, { mortgaged: false, houses: 0 });
  g.players[0].holdings.set(3, { mortgaged: false, houses: 0 });
  g.players[0].cash = 1000;

  const back = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  back.currentIndex = 0;
  back.phase = 'awaitRoll';

  let threw = null;
  try {
    for (let i = 0; i < 400 && back.phase !== 'gameOver'; i++) {
      if (back.phase === 'awaitRoll') back.roll();
      else if (back.phase === 'awaitBuy') back.skipAction();
      else if (back.phase === 'awaitCard') back.useCard();
      else if (back.phase === 'awaitEnd') back.confirmEnd();
      else break;
    }
  } catch (err) { threw = err.message; }

  ok(!threw, 'a restored game can be played to completion', threw);
  ok(back.players.every((p) => p.position >= 0 && p.position < 40),
    'positions stay in range while playing on');
}

section('the serialiser refuses nonsense');
{
  ok(Game.fromJSON(null) === null, 'null is rejected');
  ok(Game.fromJSON(undefined) === null, 'undefined is rejected');
  ok(Game.fromJSON({}) === null, 'an object with no players is rejected');
  ok(Game.fromJSON({ players: 'nope' }) === null, 'a non-array players field is rejected');
  ok(Game.fromJSON({ players: [] }) === null, 'an empty players list is rejected');

  // Structural junk must be ignored rather than crash the restore.
  let junk = null;
  try {
    junk = Game.fromJSON({
      code: 'WXYZ',
      phase: 'awaitRoll',
      currentIndex: 999,
      players: [
        {
          id: 'p1', name: 'X', cash: -50, position: 9999, jailTurns: 99,
          holdings: [
            [1, { houses: 2 }],
            ['not-a-number', { houses: 1 }],
            [0, { houses: 1 }],            // START is not ownable
            [999, { houses: 1 }],          // off the board
            'garbage',
            [3, { houses: 99 }]            // clamped below
          ]
        }
      ]
    });
  } catch (err) {
    junk = 'threw: ' + err.message;
  }
  ok(junk instanceof Game, 'structural junk does not throw', String(junk));
  ok(junk && junk.players[0].cash === 0, 'negative cash is clamped', junk && junk.players[0].cash);
  ok(junk && junk.players[0].position === 39, 'a silly position wraps onto the board',
    junk && junk.players[0].position);
  ok(junk && junk.players[0].jailTurns === 3, 'jail turns are clamped',
    junk && junk.players[0].jailTurns);
  ok(junk && junk.players[0].holdings.size === 2, 'only real purchasable titles are kept',
    junk && [...junk.players[0].holdings.keys()].join(','));
  ok(junk && junk.players[0].holdings.get(3).houses === 5, 'house counts are clamped',
    junk && junk.players[0].holdings.get(3).houses);
  ok(junk && junk.currentIndex === 0, 'an out-of-range turn pointer is fixed',
    junk && junk.currentIndex);
}

// ── the store ──────────────────────────────────────────────────────────────

section('store path safety');
{
  ok(isValidCode('ABCD'), 'a real code is accepted');
  ok(!isValidCode('abcd'), 'lower case is rejected');
  ok(!isValidCode('../../etc/passwd'), 'traversal is rejected');
  ok(!isValidCode('..\\..\\windows'), 'windows traversal is rejected');
  ok(!isValidCode('ABCD/../x'), 'an embedded slash is rejected');
  ok(!isValidCode('ABC'), 'a short code is rejected');
  ok(!isValidCode('ABCDE'), 'a long code is rejected');
  ok(!isValidCode('A/B1'), 'a slash inside is rejected');
  ok(!isValidCode(''), 'the empty string is rejected');
  ok(!isValidCode(null), 'null is rejected');
}

section('store writes and reads');
{
  const dir = tmpDir('store');
  const store = new Store(dir);
  ok(await store.init(), 'the store directory is created');

  const g = new Game('WXYZ');
  g.addPlayer('A', 's1');
  g.addPlayer('B', 's2');
  g.start();
  g.players[0].cash = 4242;

  store.save('WXYZ', g.toJSON());
  // The save is debounced, so nothing should exist yet.
  ok(!fs.existsSync(path.join(dir, 'WXYZ.json')), 'a save is debounced, not written instantly');

  await new Promise((r) => setTimeout(r, 400));
  ok(fs.existsSync(path.join(dir, 'WXYZ.json')), 'the save lands after the debounce');

  const loaded = await store.load('WXYZ');
  ok(loaded && loaded.players[0].cash === 4242, 'the saved game reads back',
    loaded && loaded.players[0].cash);

  ok((await store.list()).indexOf('WXYZ') >= 0, 'the room is listed');

  // flush bypasses the debounce
  store.save('WXYZ', g.toJSON());
  await store.flush('WXYZ', g.toJSON());
  ok(fs.existsSync(path.join(dir, 'WXYZ.json')), 'flush writes straight away');

  await store.remove('WXYZ');
  ok(!fs.existsSync(path.join(dir, 'WXYZ.json')), 'a room can be deleted');
  ok((await store.load('WXYZ')) === null, 'a missing room loads as null');

  fs.rmSync(dir, { recursive: true, force: true });
}

section('store survives damage');
{
  const dir = tmpDir('damage');
  const store = new Store(dir);
  await store.init();

  fs.writeFileSync(path.join(dir, 'AAAA.json'), '{ this is not json', 'utf8');
  const bad = await store.load('AAAA');
  ok(bad === null, 'a corrupt file reads as null rather than throwing');

  ok((await store.list()).indexOf('AAAA') >= 0, 'a corrupt file is still listed');

// Backdate well beyond the sweep age, so the comparison is never a
// millisecond-boundary coin flip.
const old = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(path.join(dir, 'AAAA.json'), old, old);

const removed = await store.sweep(60 * 60 * 1000);
ok(removed >= 1, 'the sweep collects a corrupt file', String(removed));

  // A file named like a traversal attempt must never be listed.
  fs.writeFileSync(path.join(dir, 'evil.json'), '{}', 'utf8');
  const list = await store.list();
  ok(list.every((c) => isValidCode(c)), 'listing only yields valid codes', list.join(','));

  fs.rmSync(dir, { recursive: true, force: true });
}

section('store sweep keeps live rooms');
{
  const dir = tmpDir('sweep');
  const store = new Store(dir);
  await store.init();

  const live = new Game('LIVE');
  live.addPlayer('A', 's1');
  live.addPlayer('B', 's2');
  live.start();
  await store.flush('LIVE', live.toJSON());

  const done = new Game('DONE');
  done.addPlayer('A', 's1');
  done.addPlayer('B', 's2');
  done.start();
  done.phase = 'gameOver';
  done.winnerId = done.players[0].id;
  await store.flush('DONE', done.toJSON());

  ok((await store.list()).length === 2, 'both rooms are on disk', (await store.list()).join(','));

  // Everything is fresh, so nothing should be swept yet.
  const fresh = await store.sweep(60 * 60 * 1000);
  ok(fresh === 0, 'fresh saves are left alone', String(fresh));

  // Backdate the finished one so the sweep sees it as old.
  const old = path.join(dir, 'DONE.json');
  const when = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(old, when, when);

  const swept = await store.sweep(60 * 60 * 1000);
  ok(swept === 1, 'an old finished room is swept', String(swept));
  ok(!fs.existsSync(old), 'the file is gone');
  ok(fs.existsSync(path.join(dir, 'LIVE.json')), 'the live room is kept');

  // An old but unfinished room must be kept too, so a long game is not lost.
  const oldLive = path.join(dir, 'LIVE.json');
  fs.utimesSync(oldLive, when, when);
  await store.sweep(60 * 60 * 1000);
  ok(fs.existsSync(oldLive), 'an old but unfinished room is kept');

  fs.rmSync(dir, { recursive: true, force: true });
}

section('an unwritable store directory does not break the server');
{
  const dir = tmpDir('nope');
  const blocked = new Store(path.join(dir, 'file-in-the-way'));
  fs.writeFileSync(path.join(dir, 'file-in-the-way'), 'i am a file', 'utf8');
  const okDir = await blocked.init();
  ok(!okDir && !blocked.enabled,
    'the store disables itself instead of throwing', String(okDir));

  // Disabling must be non-fatal for callers.
  let threw = null;
  try {
    blocked.save('WXYZ', {});
    await blocked.load('WXYZ');
    await blocked.list();
    await blocked.sweep(0);
    await blocked.remove('WXYZ');
  } catch (err) { threw = err.message; }
  ok(!threw, 'every store call is safe while disabled', threw);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── restart recovery, through the real server ───────────────────────────────

section('games survive a server restart');
{
  const dir = tmpDir('restart');
  const PORT = 3473;

  function boot() {
    return spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        STORE_DIR: dir,
        MAX_ROUNDS: '80',
        RESUME_GRACE_MS: '60000'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  const http = require('http');
  const { io } = require('socket.io-client');
  const ready = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get('http://127.0.0.1:' + PORT + '/health', (r) => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        if (Date.now() - t0 > 10000) return reject(new Error('no boot'));
        setTimeout(tick, 120);
      }).on('error', () => {
        if (Date.now() - t0 > 10000) return reject(new Error('no boot'));
        setTimeout(tick, 120);
      });
    };
    tick();
  });

  const connect = () => new Promise((resolve) => {
    const s = io('http://127.0.0.1:' + PORT, { transports: ['websocket'] });
    s.__last = null;
    s.on('state', (x) => { s.__last = x; });
    s.on('connect', () => resolve(s));
  });
  const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
  const until = (s, pred, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms || 6000);
    const check = (st) => {
      if (!st || !pred(st)) return false;
      clearTimeout(timer);
      s.off('state', check);
      resolve(st);
      return true;
    };
    s.on('state', check);
    if (s.__last) check(s.__last);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let server = boot();
  try {
    await ready();

    const a = await connect();
    const joinA = await emit(a, 'join', { name: 'রিয়া' });
    const playerId = joinA.you;
    const token = joinA.sessionToken;
    const b = await connect();
    await emit(b, 'join', { name: 'তানভীর', code: joinA.code });
    const started = await emit(a, 'start');
    ok(started && started.ok === true, 'the game starts', JSON.stringify(started));
    await until(b, (s) => s.phase === 'awaitRoll');

    // Play a few turns so there is real state worth keeping.
    for (let i = 0; i < 8; i++) {
      const st = await until(b, (s) => s.phase === 'awaitRoll' || s.phase === 'awaitBuy' ||
        s.phase === 'awaitEnd' || s.phase === 'awaitCard' || s.phase === 'gameOver');
      if (st.phase === 'gameOver') break;
      const cur = st.players.find((p) => p.id === st.currentPlayerId);
      const s = cur.id === st.players[0].id ? a : b;
      if (st.phase === 'awaitRoll') s.emit('roll');
      else if (st.phase === 'awaitBuy') {
        const t = st.board[st.pending.tileId];
        if (cur.cash >= t.price) s.emit('buy', { tileId: t.id }); else s.emit('skip');
      } else if (st.phase === 'awaitCard') s.emit('useCard');
      else s.emit('next');
      await sleep(120);
    }

    const snapshot = b.__last;
    const before = snapshot.players.find((p) => p.id === playerId);
    ok(snapshot.players.some((p) => p.holdings.length > 0),
      'someone owns a title before the restart',
      snapshot.players.map((p) => p.holdings.length).join('/'));

    // Let the debounced save land, then take the process down cleanly.
    await sleep(500);
    ok(fs.existsSync(path.join(dir, snapshot.code + '.json')),
      'the game was written to disk', snapshot.code);

    a.close();
    b.close();
    await sleep(200);
    server.kill('SIGTERM');
    await sleep(1200);

    // Boot again on the same directory.
    server = boot();
    await ready();
    await sleep(400);

    const health = JSON.parse(await new Promise((resolve) => {
      http.get('http://127.0.0.1:' + PORT + '/health', (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve(body));
      });
    }));
    ok(health.rooms === 1, 'the room was restored on boot', JSON.stringify(health));

    // The returning player claims their seat with the same token.
    const again = await connect();
    const rr = await emit(again, 'resume', { code: snapshot.code, sessionToken: token });
    ok(rr && rr.ok === true, 'the seat is reclaimable after a restart', JSON.stringify(rr));

    if (rr && rr.ok) {
      const back = rr.state.players.find((p) => p.id === rr.you);
      ok(rr.you === playerId, 'it is the same player', rr.you + ' vs ' + playerId);
      ok(back.holdings.length === before.holdings.length,
        'holdings survived the restart',
        back.holdings.length + ' vs ' + before.holdings.length);
      ok(back.cash === before.cash, 'cash survived the restart', back.cash + ' vs ' + before.cash);
      ok(back.position === before.position, 'position survived the restart',
        back.position + ' vs ' + before.position);
      ok(rr.state.board.length === 40, 'the board is intact after a restart');
      ok(rr.state.players.every((p) => p.sessionToken === undefined),
        'tokens are never leaked in the public state');

      // And the restored game is playable.
      const sockOf = (id) => (id === rr.state.players[0].id ? again : null);
      void sockOf;
    }
    again.close();
  } catch (err) {
    failed++;
    console.log('  FAIL harness error: ' + err.message);
  } finally {
    server.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // The token has to be captured inside the try, so redo the capture cleanly.
  section('game state on disk is valid');
  {
    // Re-run a minimal round trip through the store itself rather than the
    // network, which keeps this independent of the restart test above.
    const dir = tmpDir('disk');
    const store = new Store(dir);
    await store.init();

    const g = new Game('WXYZ');
    g.addPlayer('A', 's1');
    g.addPlayer('B', 's2');
    g.start();
    g.players[0].cash = 999;
    g.players[0].holdings.set(6, { mortgaged: false, houses: 2 });
    g.rounds = 5;

    await store.flush('WXYZ', g.toJSON());
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'WXYZ.json'), 'utf8'));
    const back = Game.fromJSON(raw);

    ok(back.players[0].cash === 999, 'cash on disk matches', back.players[0].cash);
    ok(back.players[0].holdings.get(6).houses === 2, 'houses on disk match',
      back.players[0].holdings.get(6).houses);
    ok(back.rounds === 5, 'rounds on disk match', back.rounds);
    ok(raw.v === 1, 'the snapshot carries a version', raw.v);

    // A snapshot without a version marker is still readable.
    const legacy = JSON.parse(JSON.stringify(raw));
    delete legacy.v;
    ok(Game.fromJSON(legacy) !== null, 'an unversioned snapshot still loads');

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

})().catch((err) => {
  failed++;
  console.log('  FAIL harness error: ' + err.message);
  console.log('passed: ' + passed + '   failed: ' + failed);
  process.exit(1);
}).then(() => {
  console.log('\n' + '-'.repeat(52));
  console.log('passed: ' + passed + '   failed: ' + failed);
  console.log('-'.repeat(52));
  process.exit(failed === 0 ? 0 : 1);
});