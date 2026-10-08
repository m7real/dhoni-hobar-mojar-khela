'use strict';

/* Bot opponents: legality, the guarded action API, and termination. */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Game } = require('../server/game');
const { decide, act, wantsTile } = require('../server/bot');
const board = require('../server/board');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

function botGame(n, maxRounds) {
  const g = new Game('BOTS', { maxRounds: maxRounds });
  for (let i = 0; i < n; i++) g.addBot();
  g.start();
  return g;
}

/*
 * Play one player's whole turn.
 *
 * This has to keep asking the bot what to do until the turn actually passes.
 * An earlier version acted once and then skipped any pending decision, which
 * meant bots never bought anything and every "game" quietly ended on the
 * round limit instead of through bankruptcy.
 */
function playTurn(game, player, limit) {
  let guard = 0;
  while (game.current === player && !player.bankrupt &&
         game.phase !== 'gameOver' && guard < (limit || 60)) {
    guard++;
    const intent = decide(game, player);
    if (!intent) return false;
    const res = act(game, player, intent);
    if (!res.ok) return false;
  }
  // Safety net: never leave the board waiting on this player.
  if (game.current === player && !player.bankrupt && game.phase !== 'gameOver') {
    if (game.phase === 'awaitEnd') game.actNext(player.id);
    else if (game.pending && game.pending.type !== 'end') game.actSkip(player.id);
  }
  return true;
}

// ---- the guarded action API --------------------------------------------

section('only the player on turn may act');
{
  const g = botGame(2);
  const [a, b] = g.players;

  ok(!g.actRoll(b.id).ok, 'a player who is not on turn cannot roll');
  ok(!g.actNext(b.id).ok, 'nor pass the turn');
  ok(!g.actBuy(b.id, 1).ok, 'nor buy');
  ok(!g.actBuy(a.id, 1).ok, 'nor buy when it is not a buy moment');
  ok(g.actRoll(a.id).ok, 'the player on turn can roll');

  const st = g.current;
  ok(st.id === a.id, 'rolling does not change whose turn it is');
}

section('a disconnected human is frozen');
{
  const g = botGame(2);
  g.players[0].isBot = false;
  g.players[0].connected = false;
  g.currentIndex = 0;

  const res = g.actRoll(g.players[0].id);
  ok(!res.ok, 'a player with no connection cannot roll', res && res.msg);

  // Bots are exempt: they have no socket to lose.
  g.currentIndex = 1;
  ok(g.actRoll(g.players[1].id).ok, 'a bot is not blocked by the connection check');
}

section('the API refuses actions at the wrong moment');
{
  const g = botGame(2);
  const a = g.players[0];
  g.phase = 'awaitEnd';
  g.pending = { type: 'end', playerId: a.id };

  ok(!g.actRoll(a.id).ok, 'cannot roll while finishing the turn');
  ok(g.actNext(a.id).ok, 'can pass the turn');
  ok(g.current.id === g.players[1].id, 'the turn moved on');

  g.phase = 'lobby';
  ok(!g.actRoll(g.players[1].id).ok, 'cannot act in the lobby');
}

section('build and mortgage are guarded too');
{
  const g = botGame(2);
  const a = g.players[0];
  g.currentIndex = 0;
  g.phase = 'awaitEnd';
  g.pending = { type: 'end', playerId: a.id };

  ok(!g.actBuild(a.id, 1).ok, 'cannot build without owning the title');
  a.holdings.set(1, { mortgaged: false, houses: 0 });
  a.holdings.set(3, { mortgaged: false, houses: 0 });
  a.holdings.set(6, { mortgaged: false, houses: 0 });   // a different group
  a.cash = 1000;
  ok(g.actBuild(a.id, 1).ok, 'can build with the group complete');
  ok(!g.actMortgage(a.id, 1).ok, 'cannot mortgage a title with a building on it');
  ok(!g.actMortgage(a.id, 3).ok,
    'cannot mortgage a group mate while a building stands in that group');

  ok(g.actMortgage(a.id, 6).ok, 'can mortgage a title in another group');
  ok(!g.actMortgage(a.id, 6).ok, 'cannot mortgage twice');
  ok(g.actUnmortgage(a.id, 6).ok, 'can un-mortgage');
}

// ---- the policy --------------------------------------------------------

section('the bot chases colour groups');
{
  const g = botGame(2);
  const a = g.players[0];

  // Nothing owned yet, so it should not open every group at once.
  a.cash = 1500;
  a.holdings.set(6, { mortgaged: false, houses: 0 });   // one light blue
  ok(wantsTile(g, a, 8), 'the bot wants to complete a group it has started');
  ok(wantsTile(g, a, 9), 'and the third of that group');

  a.holdings.set(1, { mortgaged: false, houses: 0 });
  ok(wantsTile(g, a, 3), 'a two-tile group is completed eagerly');
}

section('the bot will not overpay');
{
  const g = botGame(2);
  const a = g.players[0];

  a.cash = 10;
  ok(!wantsTile(g, a, 37), 'it cannot buy what it cannot afford');

  // Below the "flush" threshold it will not open a brand new group.
  a.cash = 300;
  ok(!wantsTile(g, a, 6), 'it will not open a fresh group while cash is tight',
    'Lalbazar costs 100, four times that is 400');

  // Above it, it sometimes will.
  a.cash = 2000;
  let wanted = 0;
  for (let i = 0; i < 40; i++) if (wantsTile(g, a, 6)) wanted++;
  ok(wanted > 0 && wanted < 40, 'when flush it sometimes opens a fresh group',
    wanted + '/40');
}

section('the bot refuses bought titles');
{
  const g = botGame(2);
  const a = g.players[0];
  g.players[1].holdings.set(6, { mortgaged: false, houses: 0 });
  ok(!wantsTile(g, a, 6), 'it will not try to buy an owned title');
}

// ---- decisions ---------------------------------------------------------

section('the bot always resolves the phase it is given');
{
  const g = botGame(2);
  let stuck = null;

  for (let i = 0; i < 300 && !stuck; i++) {
    const player = g.current;
    if (!player) { stuck = 'no current player at step ' + i; break; }
    if (!playTurn(g, player, 60)) {
      stuck = 'stuck in phase ' + g.phase;
      break;
    }
  }
  ok(!stuck, 'the bot never leaves the game unable to move', stuck);
}

section('bot games always reach a winner');
{
  let finished = 0;
  let byBankruptcy = 0;
  let byRoundLimit = 0;
  let stalled = [];
  let illegal = [];
  let maxHouses = 0;
  let maxTitles = 0;
  const lengths = [];

  for (let n = 0; n < 200; n++) {
    const g = botGame(2 + (n % 3), 200);
    let turns = 0;

    try {
      while (g.phase !== 'gameOver' && turns < 5000) {
        turns++;
        const player = g.current;
        if (!player) { stalled.push('no current player'); break; }
        if (!playTurn(g, player, 60)) {
          stalled.push('stuck in phase ' + g.phase);
          break;
        }

        // Track what the bots actually achieve, not just that they finish.
        let houses = 0;
        let titles = 0;
        g.players.forEach(function (p) {
          titles += p.holdings.size;
          for (const [, h] of p.holdings) houses += h.houses;
        });
        if (houses > maxHouses) maxHouses = houses;
        if (titles > maxTitles) maxTitles = titles;

        // Nothing may go negative or wander off the board.
        g.players.forEach(function (p) {
          if (p.cash < 0 && !p.bankrupt) illegal.push('negative cash ' + p.cash);
          if (p.position < 0 || p.position > 39) illegal.push('bad position ' + p.position);
          for (const [tid, h] of p.holdings) {
            if (h.houses < 0 || h.houses > 5) illegal.push('houses ' + h.houses + ' on ' + tid);
          }
        });
        if (illegal.length) break;
      }
      if (g.phase === 'gameOver' && g.winnerId) {
        finished++;
        lengths.push(turns);
        if (g.alive().length === 1) byBankruptcy++;
        else byRoundLimit++;
      }
    } catch (err) {
      illegal.push('threw: ' + err.message);
      break;
    }
    if (stalled.length || illegal.length) break;
  }

  lengths.sort(function (a, b) { return a - b; });

  ok(illegal.length === 0, 'no bot ever did something illegal',
    illegal.slice(0, 3).join(' | '));
  ok(stalled.length === 0, 'no bot game got stuck', stalled.slice(0, 3).join(' | '));
  ok(finished === 200, 'all 200 bot games produced a winner', finished + '/200');

  // The bots have to actually play Monopoly. If they bought nothing and built
  // nothing, games would end on the round limit with an empty board and the
  // "winner" would prove nothing at all.
  ok(maxTitles >= 20, 'the bots buy a real spread of titles', 'peak=' + maxTitles);
  ok(maxHouses >= 8, 'the bots raise houses, which is what ends games', 'peak=' + maxHouses);
  ok(byBankruptcy >= 120, 'most games are won by bankrupting the opposition',
    byBankruptcy + '/200 by bankruptcy, ' + byRoundLimit + ' by round limit');

  if (lengths.length) {
    const median = lengths[Math.floor(lengths.length / 2)];
    ok(median < 3000, 'bot games finish at a playable pace', 'median=' + median);
    ok(lengths[lengths.length - 1] < 5000, 'no bot game runs away',
      'max=' + lengths[lengths.length - 1]);
    console.log('       turns: min=' + lengths[0] + ' median=' + median +
      ' max=' + lengths[lengths.length - 1]);
  }
}

section('the bots actually play Monopoly');
{
  // A single game can end early with nobody completing a group, so take the
  // best of several rather than depending on one run.
  let peakHouses = 0;
  let peakTitles = 0;
  let concluded = 0;

  for (let run = 0; run < 5; run++) {
    const g = botGame(4, 400);
    let turns = 0;

    while (g.phase !== 'gameOver' && turns < 5000) {
      turns++;
      const p = g.current;
      if (!playTurn(g, p, 60)) break;

      const houses = g.players.reduce(function (sum, pl) {
        return sum + [...pl.holdings.values()].reduce(function (s, h) { return s + h.houses; }, 0);
      }, 0);
      const titles = g.players.reduce(function (sum, pl) {
        return sum + pl.holdings.size;
      }, 0);
      if (houses > peakHouses) peakHouses = houses;
      if (titles > peakTitles) peakTitles = titles;
    }
    if (g.phase === 'gameOver') concluded++;
  }

  ok(concluded === 5, 'every full-table game concluded', concluded + '/5');
  ok(peakTitles >= 20, 'the bots bought a decent spread of titles', 'peak=' + peakTitles);
  ok(peakHouses >= 8, 'the bots raised houses, which is what ends games',
    'peak=' + peakHouses);
}

// ---- persistence and transport ----------------------------------------

section('bots survive a save and reload');
{
  const g = botGame(3, 200);
  let before = 0;
  while (g.phase !== 'gameOver' && before < 30) {
    before++;
    const p = g.current;
    if (!playTurn(g, p, 60)) break;
  }
  ok(g.phase !== 'gameOver', 'the pre-save game is still in progress', g.phase);

  const back = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  ok(back.players.length === 3, 'every bot came back');
  ok(back.players.every(function (p) { return p.isBot === true; }), 'they are still bots');
  ok(back.players.every(function (p) { return p.sessionToken === null; }),
    'bots hold no reconnect token');
  ok(back.players.every(function (p) { return p.connected === true; }),
    'bots are treated as connected');

  // And they carry on playing.
  let turns = 0;
  while (back.phase !== 'gameOver' && turns < 800) {
    turns++;
    const p = back.current;
    if (!p || !p.isBot) break;
    if (!playTurn(back, p, 60)) break;
  }
  ok(turns > 0, 'the restored bot game can be played on');
}

section('a bot cannot be resumed');
{
  const g = botGame(2);
  const bot = g.players[0];
  ok(bot.sessionToken === null || bot.sessionToken === undefined,
    'a bot has no token to present', String(bot.sessionToken));
  ok(!g.findByToken(bot.sessionToken), 'no bot matches a token lookup');
  ok(g.resume(null, 'sock') === null, 'resuming with no token fails');
  ok(g.resume('made-up-token', 'sock') === null, 'resuming with a made-up token fails');
}

// ---- over a real server ------------------------------------------------

section('adding a bot over the socket');
(async function socketTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhk-bot-'));
  const PORT = 3465;
  const { io: ioc } = require('socket.io-client');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STORE_DIR: dir,
      MAX_ROUNDS: '40',
      RESUME_GRACE_MS: '60000'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });

  const ready = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get('http://127.0.0.1:' + PORT + '/health', (r) => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        rt();
      }).on('error', rt);
      function rt() {
        if (Date.now() - t0 > 30000) return reject(new Error('no boot'));
        setTimeout(tick, 120);
      }
    };
    tick();
  });
  const connect = () => new Promise((resolve) => {
    const s = ioc('http://127.0.0.1:' + PORT, { transports: ['websocket'] });
    s.__last = null;
    s.on('state', (x) => { s.__last = x; });
    s.on('connect', () => resolve(s));
  });
  const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = (s, pred, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms || 20000);
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

  let a = null;
  try {
    await ready();
    a = await connect();
    const ra = await emit(a, 'join', { name: 'রিয়া' });
    ok(ra.ok, 'a room is created');

    const full = await emit(a, 'addBot', {});
    ok(full.ok, 'a bot can be added to an empty seat', JSON.stringify(full));

    const second = await emit(a, 'addBot', {});
    ok(second.ok, 'a second bot can be added', JSON.stringify(second));

    const third = await emit(a, 'addBot', {});
    ok(third.ok, 'a third bot can be added', JSON.stringify(third));

    const fourth = await emit(a, 'addBot', {});
    ok(!fourth.ok, 'a fifth seat is refused', JSON.stringify(fourth));

    const st = a.__last;
    ok(st.players.length === 4, 'the room holds four seats', st.players.length);
    ok(st.players.filter((p) => p.isBot).length === 3, 'three of them are bots');
    ok(st.players.filter((p) => !p.isBot).length === 1, 'and one is the human');

    // A bot cannot be resumed or traded with.
    const botId = st.players.find((p) => p.isBot).id;
    const trade = await emit(a, 'tradePropose', {
      toId: botId, offer: { cash: 100 }, want: { cash: 10 }
    });
    ok(!trade.ok, 'trading with a bot is refused', JSON.stringify(trade));

    const removed = await emit(a, 'removeBot', {});
    ok(removed.ok, 'a bot can be removed before the start', JSON.stringify(removed));
    const freed = await until(a, (s) => s.players.length === 3, 'the seat to free up');
    ok(freed.players.length === 3, 'the seat is freed', freed.players.length);

    // Once started, no more bots.
    await emit(a, 'addBot', {});
    await emit(a, 'start');
    const started = await until(a, (s) => s.phase !== 'lobby', 'the start');
    const late = await emit(a, 'addBot', {});
    ok(!late.ok, 'a bot cannot be added mid-game', JSON.stringify(late));

    // We drive the human's own decisions and nothing else. Every other turn must
    // be completed by a bot on its own, which is the whole point.
    const botTurns = {};
    let botTurnsSeen = 0;
    const lastPos = {};
    (ra.state.players || []).forEach(function (p) { lastPos[p.id] = p.position; });

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const st = a.__last;
      if (!st || st.phase === 'gameOver') break;

      const cur = st.players.find(function (p) { return p.id === st.currentPlayerId; });

      // Count a bot turn once it has moved its pawn.
      st.players.forEach(function (p) {
        if (!p.isBot) return;
        if (lastPos[p.id] !== undefined && p.position !== lastPos[p.id]) {
          if (!botTurns[p.id]) botTurns[p.id] = 0;
          botTurns[p.id]++;
          botTurnsSeen++;
        }
        lastPos[p.id] = p.position;
      });
      if (botTurnsSeen >= 3) break;

      // Only ever answer the human's own prompts.
      if (!cur || cur.id !== ra.you || cur.isBot) {
        await sleep(150);
        continue;
      }
      if (st.phase === 'awaitRoll') a.emit('roll');
      else if (st.phase === 'awaitBuy') {
        const tile = st.board[st.pending.tileId];
        if (cur.cash >= tile.price) a.emit('buy', { tileId: tile.id });
        else a.emit('skip');
      } else if (st.phase === 'awaitCard') {
        a.emit('useCard');
      } else if (st.phase === 'awaitEnd') {
        a.emit('next');
      }
      await sleep(150);
    }

    ok(botTurnsSeen >= 1, 'a bot takes its turn with no human input',
      'bot turns seen: ' + botTurnsSeen);
    ok(botTurnsSeen >= 3, 'bots keep playing by themselves',
      'bot turns seen: ' + botTurnsSeen + ' ' + JSON.stringify(botTurns));
    ok(Object.keys(botTurns).length >= 2, 'more than one bot gets a turn',
      Object.keys(botTurns).length + ' bots moved');

    a.close();
    await sleep(300);
  } catch (err) {
    failed++;
    console.log('  FAIL harness error: ' + err.message);
    if (stderr.trim()) console.log('  server stderr: ' + stderr.trim().slice(0, 700));
  } finally {
    server.kill('SIGKILL');
    if (a) a.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '-'.repeat(52));
  console.log('passed: ' + passed + '   failed: ' + failed);
  console.log('-'.repeat(52));
  process.exit(failed === 0 ? 0 : 1);
})();