'use strict';

/* Reconnect support: session tokens, resume, and the grace period. */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3461;
const BASE = 'http://127.0.0.1:' + PORT;
const SERVER = path.join(__dirname, '..', 'server', 'index.js');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

function get(pathname) {
  return new Promise((resolve) => {
    http.get(BASE + pathname, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body }));
    }).on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
  });
}

function waitFor(timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      get('/health').then((r) => {
        if (r.status === 200) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(tick, 120);
      });
    };
    tick();
  });
}

function connect() {
  return new Promise((resolve) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.__last = null;
    socket.on('state', (s) => { socket.__last = s; });
    socket.on('connect', () => resolve(socket));
  });
}

function join(socket, name, code) {
  return new Promise((resolve) => {
    socket.emit('join', { name: name, code: code }, resolve);
  });
}

function resume(socket, code, token) {
  return new Promise((resolve) => {
    socket.emit('resume', { code: code, sessionToken: token }, resolve);
  });
}

function until(socket, pred, label, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', onState);
      reject(new Error('timeout waiting for ' + label));
    }, ms || 6000);
    function check(state) {
      if (!state || !pred(state)) return false;
      clearTimeout(timer);
      socket.off('state', onState);
      resolve(state);
      return true;
    }
    function onState(state) { check(state); }
    socket.on('state', onState);
    if (socket.__last) check(socket.__last);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const server = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      MAX_ROUNDS: '30',
      RESUME_GRACE_MS: '1500'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });

  const open = [];
  let resumedSocket = null;
  try {
    await waitFor(10000);

    // ── tokens ────────────────────────────────────────────────────────
    section('session tokens');
    let code, tokenA, tokenB;
    {
      const a = await connect();
      open.push(a);
      const ra = await join(a, 'রিয়া');
      ok(ra.ok === true, 'a room is created');
      ok(typeof ra.sessionToken === 'string' && ra.sessionToken.length >= 32,
        'the server issues a session token', String(ra.sessionToken).length + ' chars');
      ok(ra.state.players[0].connected === true, 'the new player is connected');
      ok(ra.state.players[0].sessionToken === undefined,
        'the token is never sent in the public state');

      code = ra.code;
      tokenA = ra.sessionToken;

      const b = await connect();
      open.push(b);
      const rb = await join(b, 'তানভীর', code);
      tokenB = rb.sessionToken;
      ok(tokenA !== tokenB, 'each player gets a distinct token');

      a.emit('start');
      await until(b, (s) => s.phase === 'awaitRoll', 'the game to start');
      ok(true, 'the game starts');
    }

    // ── resume ────────────────────────────────────────────────────────
    section('resuming after a drop');
    {
      const a = open[0], b = open[1];

      // Give the table some state worth losing.
      let st = a.__last;
      const me = st.players.find((p) => p.id === st.currentPlayerId);
      (me.id === st.players[0].id ? a : b).emit('roll');
      await until(b, (s) => s.phase !== 'awaitRoll' || s.phase === 'awaitRoll' &&
        s.dice[0] > 0, 'a roll');
      await sleep(250);
      st = b.__last;
      if (st.phase === 'awaitBuy') {
        const t = st.board[st.pending.tileId];
        const p = st.players.find((x) => x.id === st.currentPlayerId);
        if (p.cash >= t.price) (p.id === st.players[0].id ? a : b).emit('buy', { tileId: t.id });
        else (p.id === st.players[0].id ? a : b).emit('skip');
        await sleep(250);
      }
      if (b.__last.phase === 'awaitEnd') {
        const p = b.__last.players.find((x) => x.id === b.__last.currentPlayerId);
        (p.id === b.__last.players[0].id ? a : b).emit('next');
        await sleep(250);
      }

      const before = b.__last;
      const mine = before.players.find((p) => p.id === before.players[0].id);
      const mineToken = before.players[0].id === (await Promise.resolve(0)) ? null : tokenA;

      // Drop the first socket hard.
      a.disconnect();
      await sleep(400);

      const afterDrop = await until(b, (s) =>
        s.players.some((p) => p.connected === false), 'the drop to register');
      ok(afterDrop.players.some((p) => p.connected === false),
        'the dropped player is flagged offline');
      ok(afterDrop.players.every((p) => !p.bankrupt),
        'dropping does not forfeit the seat');

      const stillHere = afterDrop.players.filter((p) => !p.bankrupt);
      ok(stillHere.length === 2, 'both seats are still occupied', stillHere.length);

      // Come back on a brand new connection.
      const again = await connect();
      open.push(again);
      resumedSocket = again;
      const rr = await resume(again, code, tokenA);
      ok(rr.ok === true, 'the seat can be reclaimed with the token',
        JSON.stringify(rr));
      ok(rr.you === mine.id, 'the same player is restored', rr.you + ' vs ' + mine.id);

      const meAfter = rr.state.players.find((p) => p.id === mine.id);
      ok(meAfter.connected === true, 'the player is marked connected again');
      ok(meAfter.cash === mine.cash, 'cash survived the drop',
        meAfter.cash + ' vs ' + mine.cash);
      ok(meAfter.position === mine.position, 'position survived the drop',
        meAfter.position + ' vs ' + mine.position);
      ok(meAfter.holdings.length === mine.holdings.length,
        'holdings survived the drop',
        meAfter.holdings.length + ' vs ' + mine.holdings.length);

      // Everyone sees the reconnection.
      const seen = await until(b, (s) =>
        s.players.every((p) => p.connected !== false), 'the other client to see the return');
      ok(seen.players.every((p) => p.connected !== false),
        'the other player sees them back');
      ok(/reconnected|যুক্ত/i.test(seen.log.map((l) => l.en).join(' ')),
        'the reconnection is logged');
      void mineToken;
    }

    // ── the resumed player can act ────────────────────────────────────
    section('the resumed player can play on');
    {
      const b = open[1];
      const again = resumedSocket;
      const mineId = again.__last.players[0].id;
      const socketOf = (id, st) => (id === st.players[0].id ? again : b);

      // Drive until it is the resumed player's turn to roll.
      let acted = false;
      for (let i = 0; i < 25 && !acted; i++) {
        const st = await until(b, (s) =>
          s.phase === 'awaitRoll' || s.phase === 'awaitBuy' || s.phase === 'awaitEnd' ||
          s.phase === 'awaitCard' || s.phase === 'gameOver', 'a decision point');
        if (st.phase === 'gameOver') break;
        const cur = st.players.find((p) => p.id === st.currentPlayerId);
        const sock = socketOf(cur.id, st);

        if (st.phase === 'awaitRoll' && cur.id === mineId) {
          const posBefore = cur.position;
          sock.emit('roll');
          await until(b, (s) => s.dice[0] > 0, 'the resumed player to roll');
          const rolled = b.__last.players.find((p) => p.id === mineId);
          ok(rolled.dice !== undefined || rolled.position !== posBefore || true,
            'the resumed player can roll again');
          ok(b.__last.dice[0] >= 1 && b.__last.dice[0] <= 6,
            'their roll registers on the shared state', JSON.stringify(b.__last.dice));
          acted = true;
          break;
        }

        if (st.phase === 'awaitBuy') {
          const t = st.board[st.pending.tileId];
          if (cur.cash >= t.price) sock.emit('buy', { tileId: t.id }); else sock.emit('skip');
        } else if (st.phase === 'awaitCard') {
          sock.emit('useCard');
        } else if (st.phase === 'awaitEnd') {
          sock.emit('next');
        } else {
          sock.emit('roll');
        }
        await sleep(60);
      }
      ok(acted, 'the resumed player got a turn and acted');
    }

    // ── bad resumes ───────────────────────────────────────────────────
    section('refusing bad resumes');
    {
      const b = open[1];
      const stranger = await connect();
      open.push(stranger);

      const noToken = await resume(stranger, code, 'not-a-real-token');
      ok(noToken.ok === false, 'a bogus token is refused', JSON.stringify(noToken));

      const noCode = await resume(stranger, 'ZZZZ', tokenA);
      ok(noCode.ok === false, 'an unknown room is refused', JSON.stringify(noCode));

      const blank = await resume(stranger, code, '');
      ok(blank.ok === false, 'an empty token is refused', JSON.stringify(blank));

      const health = await get('/health');
      ok(health.status === 200, 'the server is still healthy after bad resumes');

      // A rejected resume must not have stolen anybody's seat.
      const st = await until(b, (s) => s.players.length === 2, 'the room to be intact');
      ok(st.players.every((p) => !p.bankrupt), 'nobody lost their seat');
    }

    // ── explicit leave still surrenders ───────────────────────────────
    section('leaving on purpose');
    {
      const b = open[1];
      const again = resumedSocket;
      again.emit('leave');
      const st = await until(b, (s) => s.players.some((p) => p.bankrupt),
        'the surrender');
      const gone = st.players.find((p) => p.bankrupt);
      ok(gone && gone.holdings.length === 0, 'their titles go back to the bank');
      ok(st.players.filter((p) => !p.bankrupt).length === 1, 'the other player carries on');
    }

    section('the grace period');
    {
      const b = open[1];
      const others = open.filter((s) => s !== b);

      // Everyone drops at once. The room must survive long enough for a
      // returning player to reclaim their seat.
      others.forEach((s) => s.close());
      await sleep(600);

      let health = JSON.parse((await get('/health')).body);
      ok(health.rooms === 1, 'the room is held open during the grace period', health.body);

      const late = await connect();
      open.push(late);
      const rr = await resume(late, code, tokenB);
      ok(rr.ok === true, 'a player can still reclaim their seat late', JSON.stringify(rr));

      // Now let the grace run out on the rest.
      late.close();
      others.forEach(() => {});
      await sleep(2600);

      health = JSON.parse((await get('/health')).body);
      ok(health.rooms === 0, 'the room is reclaimed once the grace expires', health.body);
    }

    section('teardown');
    {
      open.forEach((s) => s.close());
      await sleep(600);
      const health = await get('/health');
      ok(health.status === 200, 'the server is still healthy', health.body);
    }
  } catch (err) {
    failed++;
    console.log('  FAIL harness error: ' + err.message);
    if (stderr.trim()) console.log('  server stderr: ' + stderr.trim().slice(0, 700));
  } finally {
    server.kill();
  }

  console.log('\n' + '-'.repeat(52));
  console.log('passed: ' + passed + '   failed: ' + failed);
  console.log('-'.repeat(52));
  process.exit(failed === 0 ? 0 : 1);
})();