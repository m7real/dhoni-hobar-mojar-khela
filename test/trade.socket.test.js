'use strict';

/* Trading over the socket: offers reach both players, acceptance applies once. */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3463;
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

function emit(s, ev, data) {
  return new Promise((r) => s.emit(ev, data, r));
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
      MAX_ROUNDS: '60',
      RESUME_GRACE_MS: '60000'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });

  const open = [];
  try {
    await waitFor(10000);

    // Build a room and buy one title each so there is something to trade.
    let code, idA, idB;
    {
      const a = await connect(); open.push(a);
      const ra = await emit(a, 'join', { name: 'রিয়া' });
      code = ra.code; idA = ra.you;
      const b = await connect(); open.push(b);
      const rb = await emit(b, 'join', { name: 'তানভীর', code: code });
      idB = rb.you;

      await emit(a, 'start');
      await until(b, (s) => s.phase === 'awaitRoll');

      // Roll until each player has bought something.
      let gotA = false, gotB = false;
      for (let i = 0; i < 60 && !(gotA && gotB); i++) {
        const st = await until(a, (s) =>
          s.phase === 'awaitRoll' || s.phase === 'awaitBuy' || s.phase === 'awaitEnd' ||
          s.phase === 'awaitCard' || s.phase === 'gameOver', 'a decision point');
        if (st.phase === 'gameOver') break;

        const me = st.players.find((p) => p.id === st.currentPlayerId);
        const sock = me.id === idA ? a : b;

        if (st.phase === 'awaitRoll') {
          sock.emit('roll');
          await sleep(60);
          continue;
        }
        if (st.phase === 'awaitBuy') {
          const tile = st.board[st.pending.tileId];
          if (me.cash >= tile.price) {
            sock.emit('buy', { tileId: tile.id });
            const after = await until(a, (s) =>
              s.players.find((p) => p.id === me.id).holdings.length > 0, 'a purchase');
            if (me.id === idA) gotA = true; else gotB = true;
            void after;
          } else {
            sock.emit('skip');
          }
          await sleep(60);
          continue;
        }
        if (st.phase === 'awaitCard') { sock.emit('useCard'); await sleep(60); continue; }
        sock.emit('next');
        await sleep(60);
      }
      ok(gotA && gotB, 'both players own a title to trade',
        'A=' + gotA + ' B=' + gotB);
    }

    section('the offer reaches both players');
    {
      const a = open[0], b = open[1];
      const st = a.__last;
      const tileA = st.players.find((p) => p.id === idA).holdings[0];
      const tileB = st.players.find((p) => p.id === idB).holdings[0];
      ok(tileA && tileB, 'found a title for each side', JSON.stringify({ tileA, tileB }));

      const res = await emit(a, 'tradePropose', {
        toId: idB,
        offer: { cash: 0, tiles: [tileA.tileId] },
        want: { cash: 0, tiles: [tileB.tileId] }
      });
      ok(res.ok, 'the proposal is accepted', JSON.stringify(res));

      const forA = await until(a, (s) => (s.trades || []).some((t) => t.direction === 'outgoing'),
        'the proposer to see the offer');
      ok(forA.trades.length === 1, 'the proposer sees one open trade', forA.trades.length);
      ok(forA.trades[0].direction === 'outgoing', 'it is marked outgoing');

      const forB = await until(b, (s) => (s.trades || []).some((t) => t.direction === 'incoming'),
        'the recipient to see the offer');
      ok(forB.trades.length === 1, 'the recipient sees one open trade', forB.trades.length);
      ok(forB.trades[0].direction === 'incoming', 'it is marked incoming');
      ok(forB.trades[0].fromName === 'রিয়া', 'the sender is named', forB.trades[0].fromName);

      // Neither player leaks the other's offers.
      ok(forA.trades.every((t) => t.fromId === idA || t.toId === idA), 'the proposer only sees their own');

      section('acceptance moves the titles exactly once');
      {
        const cashBefore = {
          a: forA.players.find((p) => p.id === idA).cash,
          b: forA.players.find((p) => p.id === idB).cash
        };
        const wrong = await emit(a, 'tradeAccept', { tradeId: forA.trades[0].id });
        ok(!wrong.ok, 'the proposer cannot accept their own offer', JSON.stringify(wrong));

        const good = await emit(b, 'tradeAccept', { tradeId: forB.trades[0].id });
        ok(good.ok, 'the recipient can accept', JSON.stringify(good));

        const after = await until(a, (s) =>
          s.players.find((p) => p.id === idA).holdings.some((h) => h.tileId === tileB.tileId),
          'the swap to land');

        const aNow = after.players.find((p) => p.id === idA);
        const bNow = after.players.find((p) => p.id === idB);
        ok(!aNow.holdings.some((h) => h.tileId === tileA.tileId), 'the giver no longer holds the title');
        ok(bNow.holdings.some((h) => h.tileId === tileA.tileId), 'the recipient holds it now');
        ok(aNow.cash === cashBefore.a && bNow.cash === cashBefore.b,
          'no cash changed in a title-for-title swap',
          aNow.cash + '/' + bNow.cash);
        ok((after.trades || []).length === 0, 'the offer closes once accepted',
          JSON.stringify(after.trades));

        // Accepting twice must not apply it again.
        const twice = await emit(b, 'tradeAccept', { tradeId: forB.trades[0].id });
        ok(!twice.ok, 'the same trade cannot be accepted twice', JSON.stringify(twice));
      }

      section('bad proposals are refused over the wire');
      {
        const st2 = a.__last;
        const nope = await emit(a, 'tradePropose', {
          toId: idB, offer: { tiles: [39] }, want: { tiles: [1] }
        });
        ok(!nope.ok, 'offering a title you do not own is refused', JSON.stringify(nope));

        const selfTrade = await emit(a, 'tradePropose', {
          toId: idA, offer: { tiles: [1] }, want: { tiles: [6] }
        });
        ok(!selfTrade.ok, 'trading with yourself is refused', JSON.stringify(selfTrade));

        const unknown = await emit(a, 'tradePropose', {
          toId: 'nobody', offer: { tiles: [1] }, want: { tiles: [6] }
        });
        ok(!unknown.ok, 'an unknown partner is refused', JSON.stringify(unknown));

        const empty = await emit(a, 'tradePropose', { toId: idB, offer: {}, want: {} });
        ok(!empty.ok, 'an empty offer is refused', JSON.stringify(empty));
        void st2;
      }

      section('declining over the wire');
      {
        const st = a.__last;
        const mine = st.players.find((p) => p.id === idA).holdings[0];
        const theirs = st.players.find((p) => p.id === idB).holdings[0];

        const res = await emit(a, 'tradePropose', {
          toId: idB, offer: { tiles: [mine.tileId] }, want: { tiles: [theirs.tileId] }
        });
        ok(res.ok, 'a fresh proposal goes through', JSON.stringify(res));

        const dec = await emit(a, 'tradeDecline', { tradeId: res.tradeId });
        ok(dec.ok, 'the proposer can withdraw it', JSON.stringify(dec));

        const gone = await until(b, (s) => (s.trades || []).length === 0,
          'the offer to disappear');
        ok((gone.trades || []).length === 0, 'both sides stop showing it');
      }
    }

    section('teardown');
    {
      open.forEach((s) => s.close());
      await sleep(500);
      const health = await get('/health');
      ok(health.status === 200, 'the server is healthy', health.body);
    }
  } catch (err) {
    failed++;
    console.log('  FAIL harness error: ' + err.message);
    if (stderr.trim()) console.log('  server stderr: ' + stderr.trim().slice(0, 700));
  } finally {
    server.kill('SIGKILL');
  }

  console.log('\n' + '-'.repeat(52));
  console.log('passed: ' + passed + '   failed: ' + failed);
  console.log('-'.repeat(52));
  process.exit(failed === 0 ? 0 : 1);
})();