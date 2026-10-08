'use strict';

/* End-to-end socket test: drives a real game over the network layer. */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3457;
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

function waitFor(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      get('/health').then((r) => {
        if (r.status === 200) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}

function join(name, code) {
  return new Promise((resolve) => {
    const socket = io(BASE, { transports: ['websocket'] });
    // Remember the newest state so waiters can match conditions that are
    // already true, rather than only waiting for the next broadcast.
    socket.on('state', (s) => { socket.__last = s; });
    socket.on('connect', () => {
      socket.emit('join', { name: name, code: code }, (res) => {
        resolve({ socket: socket, res: res });
      });
    });
  });
}

// Resolve once `pred(state)` is true, or reject on timeout.
function until(socket, pred, label, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', onState);
      reject(new Error('timeout waiting for ' + label));
    }, ms || 20000);

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

(async function main() {
  const server = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      MAX_ROUNDS: '60',
      RESUME_GRACE_MS: '1200'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });

  try {
    await waitFor(server, 30000);

    // ── static assets ──────────────────────────────────────────────────
    section('static assets');
    {
      const home = await get('/');
      ok(home.status === 200, 'serves the game page');
      ok(/Dhoni Hobar Mojar Khela/.test(home.body), 'the page names the game');
      ok(/socket\.io/.test(home.body), 'the page loads the socket client');

      const three = await get('/vendor/three.min.js');
      ok(three.status === 200 && three.body.length > 100000, 'serves three.js locally',
        three.status + '/' + (three.body || '').length);

      for (const f of ['/css/style.css', '/js/scene.js', '/js/ui.js', '/js/main.js']) {
        const r = await get(f);
        ok(r.status === 200 && r.body.length > 100, 'serves ' + f, r.status);
      }

      const health = await get('/health');
      ok(health.status === 200 && JSON.parse(health.body).ok === true, 'health endpoint answers');
    }

    // ── lobby ─────────────────────────────────────────────────────────
    section('lobby');
    let a, b;
    {
      a = await join('রিয়া');
      ok(a.res.ok === true, 'first player creates a room');
      ok(/^[A-Z0-9]{4}$/.test(a.res.code), 'a four character code is issued', a.res.code);
      ok(a.res.state.phase === 'lobby', 'a new room starts in the lobby');
      ok(a.res.state.players.length === 1, 'the room holds one player');

      b = await join('তানভীর', a.res.code);
      ok(b.res.ok === true, 'second player joins by code');
      ok(b.res.state.players.length === 2, 'the room holds two players');

      const third = await join('সাফি', a.res.code);
      const fourth = await join('নুসরাত', a.res.code);
      ok(third.res.ok && fourth.res.ok, 'a third and fourth player join');
      const fifth = await join('too many', a.res.code);
      ok(fifth.res.ok === false, 'a fifth player is refused', JSON.stringify(fifth.res));
      fifth.socket.close();
      third.socket.close();
      fourth.socket.close();
    }

    // ── starting ──────────────────────────────────────────────────────
    section('starting the game');
    {
      const s = await until(a.socket, (st) => st.players.length === 2, 'both players present');
      ok(s.players.every((p) => p.cash === 1500), 'both start with 1500');

      a.socket.emit('start');
      const started = await until(a.socket, (st) => st.phase !== 'lobby', 'game start');
      ok(started.phase === 'awaitRoll', 'the game moves to the first roll', started.phase);
      ok(started.currentPlayerId === started.players[0].id, 'the first player is on turn');

      // Both clients must see the same thing.
      const mirror = await until(b.socket, (st) => st.phase === 'awaitRoll', 'mirror state');
      ok(mirror.currentPlayerId === started.currentPlayerId,
        'both clients agree whose turn it is');
    }

    // ── turn discipline ───────────────────────────────────────────────
    section('turn discipline');
    {
      const socketOf = (st, playerId) =>
        (playerId === st.players[0].id ? a.socket : b.socket);

      const start0 = await until(b.socket, (st) => st.phase === 'awaitRoll', 'a roll to be due');
      const cur = start0.players.find((p) => p.id === start0.currentPlayerId);
      const curSock = socketOf(start0, cur.id);
      const other = start0.players.find((p) => p.id !== cur.id);
      const otherSock = socketOf(start0, other.id);

      curSock.emit('roll');
      let after = await until(
        b.socket,
        (st) => st.phase === 'awaitEnd' || st.phase === 'awaitBuy' || st.phase === 'gameOver',
        'the roll to resolve'
      );
      ok(after.dice[0] >= 1 && after.dice[0] <= 6 && after.dice[1] >= 1 && after.dice[1] <= 6,
        'two six-sided dice are reported', JSON.stringify(after.dice));

      if (after.phase === 'awaitBuy') {
        const t = after.board[after.pending.tileId];
        const me = after.players.find((p) => p.id === after.currentPlayerId);
        if (me.cash >= t.price) socketOf(after, me.id).emit('buy', { tileId: t.id });
        else socketOf(after, me.id).emit('skip');
        after = await until(b.socket, (st) => st.phase === 'awaitEnd' || st.phase === 'gameOver',
          'the decision to settle');
      }
      ok(after.phase === 'awaitEnd', 'the turn settles in awaitEnd', after.phase);

      // The player who is not on turn must not be able to roll.
      const offBefore = after.players.find((p) => p.id !== after.currentPlayerId);
      const onTurnId = after.currentPlayerId;
      const cashBefore = JSON.stringify(after.players.map((p) => [p.position, p.cash]));
      const offPlayerId = offBefore.id;
      const offSock = socketOf(after, offPlayerId);

      offSock.emit('roll');
      await new Promise((r) => setTimeout(r, 400));
      const still = await until(a.socket, () => true, 'a state after the bogus roll');
      const offNow = still.players.find((p) => p.id === offPlayerId);
      ok(offNow.position === offBefore.position,
        'rolling out of turn does not move you',
        offBefore.position + ' -> ' + offNow.position);
      ok(still.currentPlayerId === onTurnId, 'the turn did not change hands');
      void cashBefore;

      // Passing the turn is the only way to hand over.
      socketOf(still, onTurnId).emit('next');
      const handed = await until(a.socket, (st) => st.currentPlayerId !== onTurnId || st.phase === 'gameOver',
        'the turn to change hands');
      ok(handed.currentPlayerId !== onTurnId || handed.phase === 'gameOver',
        'the turn hands over cleanly');
    }

    // Play one decision point, whoever is on turn. Doubles return the player to
// awaitRoll for another go, so this must be a loop rather than a fixed script.
function step(st, socketOf) {
  if (st.phase === 'gameOver' || st.phase === 'lobby') return null;
  const me = st.players.find((p) => p.id === st.currentPlayerId);
  if (!me) return null;
  const sock = socketOf(me.id);
  if (st.phase === 'awaitRoll') { sock.emit('roll'); return 'roll'; }
  if (st.phase === 'awaitBuy') {
    const tile = st.board[st.pending.tileId];
    if (me.cash >= tile.price) { sock.emit('buy', { tileId: tile.id }); return 'buy'; }
    sock.emit('skip');
    return 'skip';
  }
  if (st.phase === 'awaitCard') { sock.emit('useCard'); return 'card'; }
  if (st.phase === 'awaitEnd') { sock.emit('next'); return 'next'; }
  return null;
}

const anyPhase = (s) =>
  s.phase === 'gameOver' || s.phase === 'awaitRoll' || s.phase === 'awaitBuy' ||
  s.phase === 'awaitEnd' || s.phase === 'awaitCard';

const socketOf = (st, playerId) => (playerId === st.players[0].id ? a.socket : b.socket);

    // ── buying ────────────────────────────────────────────────────────
    section('buying over the socket');
    {
      let bought = null;
      for (let i = 0; i < 150 && !bought; i++) {
        const st = await until(a.socket, anyPhase, 'a decision point');
        if (st.phase === 'gameOver') break;
        const me = st.players.find((p) => p.id === st.currentPlayerId);
        const sock = socketOf(st, me.id);

        if (st.phase !== 'awaitBuy') {
          step(st, (id) => (id === st.players[0].id ? a.socket : b.socket));
          await new Promise((r) => setTimeout(r, 40));
          continue;
        }

        const tile = st.board[st.pending.tileId];
        if (me.cash < tile.price) {
          sock.emit('skip');
          await until(a.socket,
            (s) => !(s.phase === 'awaitBuy' && s.pending.tileId === tile.id), 'the decline');
          continue;
        }

        const cashBefore = me.cash;
        sock.emit('buy', { tileId: tile.id });
        const after = await until(a.socket,
          (s) => s.players.find((p) => p.id === me.id).cash !== cashBefore,
          'the purchase to register');
        const meAfter = after.players.find((p) => p.id === me.id);

        ok(meAfter.cash === cashBefore - tile.price, 'buying deducts the price',
          cashBefore + ' - ' + tile.price + ' != ' + meAfter.cash);
        ok(meAfter.holdings.some((h) => h.tileId === tile.id),
          "the title shows up in the buyer's holdings");
        ok(after.board[tile.id].ownerId === me.id, 'the board shows the new owner');
        bought = tile;
      }
      ok(bought !== null, 'a property purchase completed over the socket',
        bought ? bought.name : 'none');
    }

    // ── the game reaches a conclusion ─────────────────────────────────
    section('game reaches a conclusion');
    {
      let finished = null;
      for (let i = 0; i < 500 && !finished; i++) {
        const st = await until(a.socket, anyPhase, 'a decision point').catch(() => null);
        if (!st) continue;
        if (st.phase === 'gameOver') { finished = st; break; }
        step(st, (id) => (id === st.players[0].id ? a.socket : b.socket));
        await new Promise((r) => setTimeout(r, 40));
      }
      ok(finished !== null, 'the game finished');
      ok(finished && finished.winnerId !== null, 'a winner was declared');
      ok(finished && finished.rounds <= 60, 'the round limit ended it if bankruptcy did not',
        finished && finished.rounds);

      const winner = finished && finished.players.find((p) => p.id === finished.winnerId);
      ok(winner && !winner.bankrupt, 'the winner is a solvent player');

      const mirror = await until(b.socket, (s) => s.phase === 'gameOver', 'the other client agrees');
      ok(mirror.winnerId === finished.winnerId, 'both clients agree on the winner');
    }

    // ── rematch and leaving ───────────────────────────────────────────
    section('rematch and leaving');
    {
      a.socket.emit('rematch');
      const again = await until(a.socket, (s) => s.phase !== 'gameOver', 'the rematch');
      ok(again.players.every((p) => p.cash === 1500 && p.position === 0 && p.holdings.length === 0),
        'a rematch resets everyone');
      ok(again.rounds === 0, 'the round counter resets', again.rounds);

      a.socket.emit('leave');
      const left = await until(b.socket,
        (s) => s.players.some((p) => p.bankrupt), 'the leaver to be marked out');
      const stillIn = left.players.filter((p) => !p.bankrupt);
      ok(stillIn.length === 1, 'leaving takes the player out of the game', stillIn.length);
      const gone = left.players.find((p) => p.bankrupt);
      ok(gone && gone.holdings.length === 0,
        'their titles go back to the bank', gone && gone.holdings.length);
      ok(left.players.find((p) => p.id === stillIn[0].id).bankrupt === false,
        'the other player carries on');
    }

    section('teardown');
    {
      a.socket.close();
      b.socket.close();
      await new Promise((r) => setTimeout(r, 600));

      // A room is held open briefly so a dropped player can come back.
      const held = await get('/health');
      ok(JSON.parse(held.body).rooms >= 0, 'the server answers after everybody leaves');

      await new Promise((r) => setTimeout(r, 1600));
      const health = await get('/health');
      ok(health.status === 200 && JSON.parse(health.body).rooms === 0,
        'rooms are reclaimed once the grace period lapses', health.body);
    }
  } catch (err) {
    failed++;
    console.log('  FAIL harness error: ' + err.message);
    if (serverErr.trim()) console.log('  server stderr: ' + serverErr.trim().slice(0, 800));
  } finally {
    server.kill();
  }

  console.log('\n' + '-'.repeat(52));
  console.log('passed: ' + passed + '   failed: ' + failed);
  console.log('-'.repeat(52));
  process.exit(failed === 0 ? 0 : 1);
})();