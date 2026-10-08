'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Game, RESUME_GRACE_MS } = require('./game');
const { decide: botDecide, act: botAct, botName } = require('./bot');
const { Store } = require('./store');

/*
 * Where the game may be served from.
 *
 * Set ALLOWED_ORIGIN to your own domain in production, comma separated. Left
 * unset it allows any origin, which is what you want while playing on a
 * laptop but not once it is on the internet.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const originAllowed = (origin) => {
  if (!ALLOWED_ORIGINS.length) return true;         // unrestricted
  if (!origin) return true;                         // same-origin, curl, health checks
  return ALLOWED_ORIGINS.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed === origin) return true;
    // Allow www. against a bare domain and the reverse.
    return origin.replace(/^https?:\/\//, '').replace(/^www\./, '') ===
      allowed.replace(/^https?:\/\//, '').replace(/^www\./, '');
  });
};

const corsOptions = {
  origin: (origin, callback) => {
    if (originAllowed(origin)) return callback(null, true);
    return callback(new Error('origin not allowed: ' + origin));
  },
  methods: ['GET', 'POST']
};

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: corsOptions });

const IS_PROD = process.env.NODE_ENV === 'production';
const quiet = IS_PROD && process.env.VERBOSE_LOGS !== '1';
const log = (...args) => { if (!quiet) console.log(...args); };

// ---- static files ---------------------------------------------------------

// Baseline hardening. The game loads only its own assets, so a strict
// policy costs nothing.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..', 'client', 'public');
app.use(express.static(PUBLIC_DIR, {
  maxAge: IS_PROD ? '1h' : 0,
  etag: true
}));

// Serve Three.js locally so the game works without a CDN.
app.get('/vendor/three.min.js', (req, res) => {
  res.sendFile(require.resolve('three/build/three.min.js'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// ---- rooms ----------------------------------------------------------------

// Classic Monopoly can run forever once every title is sold, because the
// START salary keeps compounding. Games therefore end on this round limit,
// with the richest player by net worth taking it.
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS) || undefined;

// How long a dropped player is given to reclaim their seat.
const GRACE_MS = Number(process.env.RESUME_GRACE_MS) || RESUME_GRACE_MS;

const rooms = new Map();

// Where games are saved. On Render this points at the mounted disk, so games
// survive a restart or a deploy.
const STORE_DIR = process.env.STORE_DIR || path.join(__dirname, '..', 'data', 'rooms');
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;
const store = new Store(STORE_DIR);

// Players currently given a chance to reconnect, keyed by player id.
const graceTimers = new Map();

function clearGrace(playerId) {
  const t = graceTimers.get(playerId);
  if (t) {
    clearTimeout(t);
    graceTimers.delete(playerId);
  }
}

function startGrace(game, player, ms) {
  clearGrace(player.id);
  const timer = setTimeout(() => {
    graceTimers.delete(player.id);
    // They may have come back while the timer was pending.
    const still = game.findById(player.id);
    if (!still || still.connected || still.bankrupt) return;
    if (!rooms.has(game.code)) return;
    game.surrender(still);
    pushState(game);
    cleanupRoom(game);
  }, ms);
  if (timer.unref) timer.unref();
  graceTimers.set(player.id, timer);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoom(game) {
  const inPlay = game.players.filter((p) => !p.bankrupt).length;
  return {
    code: game.code,
    phase: game.phase,
    playerCount: inPlay,
    canStart: inPlay >= 2 && game.phase === 'lobby'
  };
}

// The client's view of one room, with anything private to the player removed.
function stateFor(game, playerId) {
  const state = game.serialize();
  state.trades = playerId ? game.tradeViewFor(playerId) : [];
  return state;
}

function pushState(game) {
  // Each socket gets its own view, since trade offers are directed.
  game.players.forEach((p) => {
    if (!p.connected || !p.socketId) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('state', stateFor(game, p.id));
  });
  persist(game);
  nudgeBots(game);
}

function persist(game) {
  if (!store.enabled) return;
  try {
    store.save(game.code, game.toJSON());
  } catch (err) {
    store.lastError = err.message;
  }
}

function pushRooms() {
  const list = [...rooms.values()]
    .filter((g) => g.phase === 'lobby')
    .map(publicRoom);
  io.emit('rooms', list);
}

function cleanupRoom(game) {
    // Drop the room once nobody is still in it, otherwise a stale seat would
    // keep the code reserved for ever.
    const anyInPlay = game.players.some((p) => !p.bankrupt);
    if (!anyInPlay) {
      rooms.delete(game.code);
      clearBotTimer(game.code);
      game.players.forEach((p) => clearGrace(p.id));
      pushRooms();
      // Keep the save around briefly so the final score is still recoverable,
      // then let the sweep collect it.
      store.save(game.code, game.toJSON());
    }
  }

function toast(game, bn, en) {
  io.to(game.code).emit('toast', { bn, en });
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

// ---- socket handlers ------------------------------------------------------

io.on('connection', (socket) => {
  socket.data.gameCode = null;
  socket.data.playerId = null;

  // Re-attach to a seat after a refresh or a dropped connection.
  socket.on('resume', (data = {}, ack) => {
    const code = String(data.code || '').toUpperCase().trim();
    const game = code ? rooms.get(code) : null;

    if (!game) {
      if (typeof ack === 'function') ack({ ok: false, error: 'খেলাটি আর নেই।' });
      return;
    }

    const player = game.resume(data.sessionToken, socket.id);
    if (!player) {
      if (typeof ack === 'function') ack({ ok: false, error: 'সেটটি আর নেই।' });
      return;
    }

    clearGrace(player.id);
    socket.data.gameCode = game.code;
    socket.data.playerId = player.id;
    socket.join(game.code);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        code: game.code,
        you: player.id,
        sessionToken: player.sessionToken,
        state: stateFor(game, player.id)
      });
    }

    pushState(game);
  });

  socket.on('join', (data = {}, ack) => {
    const name = (data.name || '').trim().substring(0, 18);
    if (!name) {
      if (typeof ack === 'function') ack({ ok: false, error: 'নাম দিন।' });
      return;
    }

    let game = null;
    let isNew = false;

    if (data.code) {
      game = rooms.get(String(data.code).toUpperCase().trim());
      if (!game) {
        if (typeof ack === 'function') ack({ ok: false, error: 'রুম পাওয়া যায়নি।' });
        return;
      }
      if (game.phase === 'gameOver') {
        if (typeof ack === 'function') ack({ ok: false, error: 'খেলা শেষ, নতুন রুম খুলুন।' });
        return;
      }
      if (game.players.length >= 4) {
        if (typeof ack === 'function') ack({ ok: false, error: 'রুম ভর্তি।' });
        return;
      }
    } else {
      game = new Game(newCode(), { maxRounds: MAX_ROUNDS });
      rooms.set(game.code, game);
      isNew = true;
    }

    const player = game.addPlayer(name, socket.id);
    if (!player) {
      if (typeof ack === 'function') ack({ ok: false, error: 'রুম ভর্তি।' });
      return;
    }

    socket.data.gameCode = game.code;
    socket.data.playerId = player.id;
    socket.join(game.code);

    game.say(
      `${player.name} খেলায় যোগ দিলেন।`,
      `${player.name} joined the game.`
    );

    if (typeof ack === 'function') {
      ack({
        ok: true,
        code: game.code,
        you: player.id,
        sessionToken: player.sessionToken,
        isNew,
        state: stateFor(game, player.id)
      });
    }

    pushState(game);
    pushRooms();
  });

  socket.on('leave', () => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return;
    const player = game.findById(socket.data.playerId);
    if (player) clearGrace(player.id);
    if (player && game.phase !== 'lobby') {
      game.surrender(player);
    } else if (player) {
      game.removePlayerById(player.id);
      game.say(`${player.name} বেরিয়ে গেলেন।`, `${player.name} left.`);
    }
    socket.leave(game.code);
    socket.data.gameCode = null;
    socket.data.playerId = null;
    pushState(game);
    cleanupRoom(game);
    pushRooms();
  });

socket.on('start', (data, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const game = rooms.get(socket.data.gameCode);
    if (!game) return respond({ ok: false, error: 'খেলায় নেই।' });
    const me = game.findBySocket(socket.id);
    if (!me) return respond({ ok: false, error: 'খেলোয়াড় পাওয়া যায়নি।' });
    if (game.players[0] && game.players[0].id !== me.id) {
      const err = 'শুধু প্রথম খেলোয়াড় খেলা শুরু করতে পারবেন।';
      respond({ ok: false, error: err });
      socket.emit('toast', { bn: err, en: 'Only the first player can start.' });
      return;
    }
    if (!game.start()) {
      const err = 'কমপক্ষে ২ জন খেলোয়াড় দরকার।';
      respond({ ok: false, error: err });
      socket.emit('toast', { bn: err, en: 'Need at least 2 players.' });
      return;
    }
    respond({ ok: true });
    pushState(game);
  });

  // One guarded entry point for every player action, so a socket cannot do
  // anything the engine has not sanctioned. A bad request must never take
  // the process down.
  function perform(game, playerId, action, data, socket) {
    let res;
    try {
      res = action(game, playerId, data);
    } catch (err) {
      console.error('[action] ' + err.message);
      res = { ok: false, msg: 'কিছু একটা ভুল হয়েছে।' };
    }
    if (!res.ok) {
      if (socket) socket.emit('toast', { bn: res.msg, en: res.msg });
      return res;
    }
    pushState(game);
    return res;
  }

  function ctx(socket, ack) {
    const game = rooms.get(socket.data.gameCode);
    const me = game ? game.findById(socket.data.playerId) : null;
    if (!game || !me) {
      reply(ack, { ok: false, error: 'খেলায় নেই।' });
      return null;
    }
    return { game, me };
  }

  socket.on('roll', (data, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    const res = c.game.actRoll(c.me.id);
    if (!res.ok) {
      reply(ack, { ok: false, error: res.msg });
      socket.emit('toast', { bn: res.msg, en: res.msg });
      return;
    }
    announceRoll(c.game, c.me.id, res.result);
    reply(ack, { ok: true });
    pushState(c.game);
  });

  socket.on('buy', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id, d) => g.actBuy(id, d.tileId), data, socket));
  });

  socket.on('skip', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id) => g.actSkip(id), null, socket));
  });

  socket.on('useCard', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id) => g.actUseCard(id), null, socket));
  });

  socket.on('next', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id) => g.actNext(id), null, socket));
  });

  socket.on('build', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id, d) => g.actBuild(id, d.tileId), data, socket));
  });

  socket.on('sell', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id, d) => g.actSell(id, d.tileId), data, socket));
  });

  socket.on('mortgage', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id, d) => g.actMortgage(id, d.tileId), data, socket));
  });

  socket.on('unmortgage', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id, d) => g.actUnmortgage(id, d.tileId), data, socket));
  });

  socket.on('jailcard', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    reply(ack, perform(c.game, c.me.id, (g, id) => g.actJailCard(id), null, socket));
  });

  // Fill an empty seat with a bot.
  socket.on('addBot', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;

    if (c.game.phase !== 'lobby') {
      const err = 'বট যোগ করা যায় শুধু খেলা শুরুর আগে।';
      reply(ack, { ok: false, error: err });
      socket.emit('toast', { bn: err, en: 'Bots can only be added before the start.' });
      return;
    }

    const bot = c.game.addBot();
    if (!bot) {
      const err = 'আরও বট যোগ করার জায়গা নেই।';
      reply(ack, { ok: false, error: err });
      socket.emit('toast', { bn: err, en: 'No room for another bot.' });
      return;
    }

    bot.name = botName((data && data.name) || (c.game.players.length - 1));
    c.game.say(`${bot.name} যোগ দিলেন।`, `${bot.name} joined.`);
    reply(ack, { ok: true, botId: bot.id });
    pushState(c.game);
    pushRooms();
  });

  socket.on('removeBot', (data = {}, ack) => {
    const c = ctx(socket, ack);
    if (!c) return;
    if (c.game.phase !== 'lobby') {
      reply(ack, { ok: false, error: 'খেলা শুরু হওয়ার আগেই সরানো যাবে।' });
      return;
    }
    const bot = data.botId
      ? c.game.findById(data.botId)
      : c.game.players.filter(function (p) { return p.isBot; }).pop();
    if (!bot || !bot.isBot) return reply(ack, { ok: false, error: 'বট পাওয়া যায়নি।' });
    c.game.removePlayerById(bot.id);
    reply(ack, { ok: true });
    pushState(c.game);
    pushRooms();
  });

  socket.on('chat', (data = {}) => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return;
    const me = game.findBySocket(socket.id);
    if (!me) return;
    const text = String(data.text || '').trim().substring(0, 160);
    if (!text) return;
    io.to(game.code).emit('chat', {
      playerId: me.id,
      name: me.name,
      color: me.color,
      text,
      ts: Date.now()
    });
  });

  socket.on('rematch', () => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return;
    if (game.phase !== 'gameOver') return;
    game.players.forEach((p) => {
      p.cash = 1500;
      p.position = 0;
      p.jail = false;
      p.jailTurns = 0;
      p.getOutOfJail = false;
      p.holdings.clear();
      p.bankrupt = false;
    });
    game.phase = 'awaitRoll';
    game.currentIndex = 0;
    game.doublesInARow = 0;
    game.pending = null;
    game.winnerId = null;
    game.rounds = 0;
    game.chanceDeck = require('./board').CHANCE_CARDS.slice();
    game.chestDeck = require('./board').CHEST_CARDS.slice();
    game.log = [];
    game.version++;
    game.say('নতুন খেলা শুরু!', 'Rematch started!');
    pushState(game);
  });

  // ── trading ────────────────────────────────────────────────────────────

  // Trades are accepted out of turn on purpose: they must never be able to
  // hold the board up waiting for somebody to reply.
  socket.on('tradePropose', (data = {}, ack) => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return reply(ack, { ok: false, error: 'খেলায় নেই।' });
    const me = game.findById(socket.data.playerId);
    if (!me) return reply(ack, { ok: false, error: 'খেলোয়াড় পাওয়া যায়নি।' });

    const res = game.proposeTrade(me.id, data.toId, data.offer || {}, data.want || {});
    if (!res.ok) {
      reply(ack, { ok: false, error: res.msg });
      toast(game, res.msg, res.msg);
    } else {
      reply(ack, { ok: true, tradeId: res.trade.id });
    }
    pushState(game);
  });

  socket.on('tradeAccept', (data = {}, ack) => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return reply(ack, { ok: false, error: 'খেলায় নেই।' });
    const me = game.findById(socket.data.playerId);
    if (!me) return reply(ack, { ok: false, error: 'খেলোয়াড় পাওয়া যায়নি।' });

    const res = game.acceptTrade(data.tradeId, me.id);
    if (!res.ok) {
      reply(ack, { ok: false, error: res.msg });
      toast(game, res.msg, res.msg);
    } else {
      reply(ack, { ok: true });
    }
    pushState(game);
  });

  socket.on('tradeDecline', (data = {}, ack) => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return reply(ack, { ok: false, error: 'খেলায় নেই।' });
    const me = game.findById(socket.data.playerId);
    if (!me) return reply(ack, { ok: false, error: 'খেলোয়াড় পাওয়া যায়নি।' });

    const res = game.declineTrade(data.tradeId, me.id);
    reply(ack, res.ok ? { ok: true } : { ok: false, error: res.msg });
    pushState(game);
  });

  socket.on('disconnect', () => {
    const game = rooms.get(socket.data.gameCode);
    if (!game) return;

    const player = game.findById(socket.data.playerId);
    if (!player) return;

    if (game.phase === 'lobby') {
      game.removePlayerById(player.id);
      pushRooms();
    } else {
      // Give them a chance to come back before the seat is forfeit.
      game.markDisconnected(player);
      startGrace(game, player, GRACE_MS);
    }
    pushState(game);
  });
});

// ---- boot ---------------------------------------------------------------

async function restoreRooms() {
  if (!store.enabled) return 0;
  const codes = await store.list();
  let restored = 0;

  for (const code of codes) {
    const data = await store.load(code);
    if (!data) continue;
    const game = Game.fromJSON(data);
    if (!game) continue;

    // A finished room has nothing to play, but keep the save for the scoreboard.
    if (game.phase === 'gameOver') continue;

    // If everyone had already left before the restart, the game is over.
    const anyoneLeft = game.players.some((p) => !p.bankrupt);
    if (!anyoneLeft) continue;

    rooms.set(game.code, game);
    game.players.forEach((p) => {
      if (!p.bankrupt) startGrace(game, p, GRACE_MS);
    });
    restored++;
    log(`[store] restored room ${game.code} (${game.players.filter((p) => !p.bankrupt).length} player(s), round ${game.rounds})`);
  }
  return restored;
}

// Announce a roll so clients can animate dice and tokens. Lives at module
// scope because the bot scheduler needs it too.
function announceRoll(game, playerId, result) {
  if (!result) return;
  const player = game.findById(playerId);
  io.to(game.code).emit('fx', {
    type: 'roll',
    playerId: playerId,
    dice: result.dice,
    doubles: result.doubles,
    from: result.from,
    to: result.moved ? result.position : (player ? player.position : 0),
    landedOn: result.landedOn || null,
    card: result.card || null,
    chargedRent: result.chargedRent || null,
    credit: result.credit || null
  });
}

// Drop stale trade offers and nudge clients so their countdowns tick.
  function tickTrades() {
    rooms.forEach((game) => {
      const changed = game.expireTrades();
      const hasOffers = game.trades.some((t) => t.status === 'pending');
      if (changed) {
        pushState(game);
      } else if (hasOffers) {
        // No state change, but clients count down locally from expiresAt.
        io.to(game.code).emit('tradeTick');
      }
    });
  }

// ---- bots ------------------------------------------------------------------

// How long a bot waits before acting. The random part keeps a bot game from
// feeling mechanical, and the minimum gives people time to read the board.
const BOT_DELAY_MIN_MS = 650;
const BOT_DELAY_MAX_MS = 1500;

const botTimers = new Map();          // roomCode -> timeout

function clearBotTimer(code) {
  const t = botTimers.get(code);
  if (t) {
    clearTimeout(t);
    botTimers.delete(code);
  }
}

function scheduleBot(game) {
  clearBotTimer(game.code);
  if (game.phase === 'gameOver' || game.phase === 'lobby') return;

  const player = game.current;
  if (!player || !player.isBot || player.bankrupt) return;

  const delay = BOT_DELAY_MIN_MS +
    Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS);
  const timer = setTimeout(() => {
    botTimers.delete(game.code);
    // Autonomous code must never be able to take the process down.
    try {
      runBot(game, player.id);
    } catch (err) {
      console.error('[bot] turn failed: ' + (err && err.stack ? err.stack : err));
    }
    // Whatever happened, make sure the board is not left hanging on a bot.
    try {
      pushState(game);
      scheduleBot(game);
    } catch (err) {
      console.error('[bot] could not reschedule: ' + (err && err.stack ? err.stack : err));
    }
  }, delay);
  if (timer.unref) timer.unref();
  botTimers.set(game.code, timer);
}

// One bot turn.
function runBot(game, playerId) {
  const live = rooms.get(game.code);
  if (!live) return;

  // Re-check: the world may have moved on while the bot was thinking.
  const still = live.current;
  if (!still || still.id !== playerId || !still.isBot || still.bankrupt) return;

  const intent = botDecide(live, still);
  if (!intent) return;

  const res = botAct(live, still, intent);
  if (!res.ok) {
    // A refused decision must never leave the turn hanging.
    if (intent.type === 'buy' || intent.type === 'useCard') {
      botAct(live, still, { type: 'skip' });
    } else if (intent.type !== 'next' && intent.type !== 'roll') {
      botAct(live, still, { type: 'next' });
    }
  } else if (intent.type === 'roll' && res.result) {
    announceRoll(live, still.id, res.result);
  }
}

function nudgeBots(game) {
  // A bot always needs to be waiting, whatever changed the state.
  if (botTimers.has(game.code)) return;
  scheduleBot(game);
}

async function shutdown(signal) {
  console.log('\n' + signal + ' — saving games…');
  try {
    await store.flushAll((code) => {
      const game = rooms.get(code);
      return game ? game.toJSON() : null;
    });
  } catch (err) {
    console.warn('[store] shutdown flush failed: ' + err.message);
  }
  graceTimers.forEach((t) => clearTimeout(t));
  graceTimers.clear();
  botTimers.forEach((t) => clearTimeout(t));
  botTimers.clear();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

const PORT = process.env.PORT || 3000;

(async function start() {
  const ready = await store.init();
  if (ready) {
    const restored = await restoreRooms();
    if (restored) log('[store] ' + restored + ' room(s) restored from ' + STORE_DIR);
    await store.sweep(SWEEP_AFTER_MS).catch(() => {});
    // Re-check hourly rather than only at boot, so a long-lived process tidies up.
    const sweepTimer = setInterval(() => store.sweep(SWEEP_AFTER_MS).catch(() => {}), 3600_000);
    if (sweepTimer.unref) sweepTimer.unref();

    const tradeTimer = setInterval(tickTrades, 1000);
    if (tradeTimer.unref) tradeTimer.unref();
  }

  httpServer.listen(PORT, () => {
    log(`Dhoni Hobar Mojar Khela server on http://localhost:${PORT}`);
    if (ALLOWED_ORIGINS.length) {
      log('[cors] limited to: ' + ALLOWED_ORIGINS.join(', '));
    }
    if (!store.enabled) console.warn('[store] saving disabled — games are lost on restart');
  });
})();

module.exports = { app, io, rooms, store };