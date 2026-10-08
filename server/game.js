'use strict';

const crypto = require('crypto');

const {
  TILES, CHEST_CARDS, CHANCE_CARDS, START_CASH, GO_SALARY,
  JAIL_INDEX, JAIL_FINE, MAX_JAIL_TURNS, MAX_HOUSES,
  getTile, isOwnable, groupMembers, groupOf,
  mortgageValue, unmortgageValue, houseCostOf
} = require('./board');

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#457b9d'];
const TOKENS = ['pawn', 'car', 'ship', 'hat'];

// Classic Monopoly has no natural end: once every title is sold, the ৳200
// START salary keeps compounding until rent can no longer bankrupt anybody.
// So after this many full rounds the richest player by net worth wins.
const DEFAULT_MAX_ROUNDS = 200;

// How long a dropped player is given to come back before their seat is forfeit.
const RESUME_GRACE_MS = 60_000;

// How long a trade offer stays open.
const TRADE_TTL_MS = 45_000;

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextTileOfType(type, from) {
  for (let step = 1; step <= 40; step++) {
    if (getTile(from + step).type === type) return ((from + step) % 40 + 40) % 40;
  }
  return from;
}

class Game {
  constructor(code, options) {
    this.code = code;
    this.phase = 'lobby';           // lobby | awaitRoll | awaitBuy | awaitCard | awaitEnd | gameOver
    this.players = [];
    this.currentIndex = 0;
    this.dice = [0, 0];
    this.doublesInARow = 0;
    this.pending = null;           // { type, playerId, tileId? }
    this.winnerId = null;
    this.rounds = 0;
    this.maxRounds = (options && options.maxRounds) || DEFAULT_MAX_ROUNDS;
    this.trades = [];
    this.tradeSeq = 0;
    this.log = [];
    this.chestDeck = shuffle(CHEST_CARDS);
    this.chestUsed = [];
    this.chanceDeck = shuffle(CHANCE_CARDS);
    this.chanceUsed = [];
    this.logSeq = 0;
    this.version = 0;
  }

  get current() {
    return this.players[this.currentIndex] || null;
  }

  alive() {
    return this.players.filter((p) => !p.bankrupt);
  }

  say(bn, en) {
    this.log.push({ id: ++this.logSeq, bn, en, ts: Date.now() });
    if (this.log.length > 80) this.log.shift();
  }

  // ---- lobby -------------------------------------------------------------

  addPlayer(name, socketId) {
    if (this.players.length >= 4) return null;
    const idx = this.players.length;
    const player = {
      id: 'p' + (this.players.length + 1) + '_' + Math.random().toString(36).slice(2, 8),
      socketId,
      // A reconnect token, so a refresh or a dropped line does not cost the
      // player their seat. Bots have none.
      sessionToken: newToken(),
      connected: true,
      disconnectedAt: null,
      isBot: false,
      name: (name || '').substring(0, 18) || 'Player ' + (idx + 1),
      colorIndex: idx,
      color: COLORS[idx % COLORS.length],
      token: TOKENS[idx % TOKENS.length],
      cash: START_CASH,
      position: 0,
      jail: false,
      jailTurns: 0,
      getOutOfJail: false,
      holdings: new Map(),
      bankrupt: false
    };
    this.players.push(player);
    this.version++;
    return player;
  }

  start() {
    if (this.players.length < 2) return false;
    this.phase = 'awaitRoll';
    this.currentIndex = 0;
    this.doublesInARow = 0;
    this.rounds = 0;
    this.winnerId = null;
    this.version++;
    this.say(
      `খেলা শুরু! প্রথম চাল ${this.current.name}-এর।`,
      `Game starts! ${this.current.name} goes first.`
    );
    return true;
  }

  // A player who walks away mid-game hands their titles back to the bank and
// is out of the game. (There is no reconnect support, so a dropped socket is
// handled the same way — otherwise a zombie seat blocks the room forever.)
  surrender(player) {
    if (!player || player.bankrupt) return false;
    this.say(
      `${player.name} খেলা ছেড়ে দিলেন।`,
      `${player.name} left the game.`
    );
    this.trades.forEach((t) => {
      if (t.status === 'pending' && (t.fromId === player.id || t.toId === player.id)) {
        t.status = 'cancelled';
      }
    });
    player.holdings.clear();
    player.cash = 0;
    player.bankrupt = true;
    player.jail = false;
    player.getOutOfJail = false;
    this.trades.forEach((t) => {
      if (t.status === 'pending' && (t.fromId === player.id || t.toId === player.id)) {
        t.status = 'cancelled';
      }
    });
    if (this.current === player) this.rotateOffBankrupt();
    this.checkWin();
    this.version++;
    return true;
  }

  removePlayerById(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    const player = this.players[idx];
    if (this.phase === 'lobby') {
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => {
        p.colorIndex = i;
        p.color = COLORS[i % COLORS.length];
        p.token = TOKENS[i % TOKENS.length];
      });
      this.version++;
      return true;
    }
    return this.surrender(player);
  }

  findBySocket(socketId) {
    return this.players.find((p) => p.socketId === socketId) || null;
  }

  findByToken(sessionToken) {
    if (!sessionToken) return null;
    return this.players.find((p) => p.sessionToken && p.sessionToken === sessionToken) || null;
  }

  // Fill a seat with a bot. Bots have no socket and no reconnect token.
  addBot() {
    if (this.players.length >= 4) return null;
    const player = this.addPlayer('', null);
    if (!player) return null;
    player.isBot = true;
    player.connected = true;
    player.name = this.players.length <= 4
      ? ('বট ' + this.players.length)
      : 'বট';
    player.sessionToken = null;
    this.version++;
    return player;
  }

  // Re-attach a live socket to a player who had dropped out.
  resume(sessionToken, socketId) {
    const player = this.findByToken(sessionToken);
    if (!player || player.bankrupt) return null;
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    this.version++;
    this.say(
      `${player.name} আবার যুক্ত হলেন।`,
      `${player.name} reconnected.`
    );
    return player;
  }

  // Flag a player as gone. The socket layer decides when the grace period
  // runs out and calls surrender().
  markDisconnected(player) {
    if (!player || player.bankrupt) return false;
    player.connected = false;
    player.disconnectedAt = Date.now();
    player.socketId = null;
    this.version++;
    return true;
  }

  findById(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  ownerOf(tileId, ignoreId) {
    return this.players.find(
      (p) => !p.bankrupt && p.id !== ignoreId && p.holdings.has(tileId)
    ) || null;
  }

  // ---- money -------------------------------------------------------------

  netWorth(player) {
    let total = player.cash;
    for (const [tileId, holding] of player.holdings) {
      const tile = getTile(tileId);
      total += holding.mortgaged ? mortgageValue(tile) : (tile.price || 0);
      if (tile.houseCost && holding.houses > 0) {
        const unitValue = tile.houseCost / 2;
        total += holding.houses >= MAX_HOUSES
          ? unitValue * 4 + tile.houseCost
          : unitValue * holding.houses;
      }
    }
    return total;
  }

  credit(player, amount) {
    player.cash += amount;
    this.version++;
  }

  pay(player, amount, creditor, reason) {
    if (amount <= 0) return true;
    if (player.cash >= amount) {
      player.cash -= amount;
      if (creditor) creditor.cash += amount;
      this.version++;
      return true;
    }
    // Not enough cash on hand: the creditor's cash is the only rescue available.
    if (creditor && !creditor.bankrupt) {
      const fromCreditor = Math.min(creditor.cash, amount - player.cash);
      player.cash -= fromCreditor;
      creditor.cash -= fromCreditor;
    }
    this.say(
      `${player.name} টাকা দিতে পারলেন না (Tk ${amount} — ${reason})।`,
      `${player.name} could not pay Tk ${amount} (${reason}).`
    );
    this.bankrupt(player, creditor);
    return false;
  }

  checkWin() {
    if (this.winnerId) return;              // already announced
    const alive = this.alive();
    if (this.players.length < 2) return;
    if (alive.length === 1) {
      this.phase = 'gameOver';
      this.winnerId = alive[0].id;
      this.pending = null;
      this.say(`🏆 ${alive[0].name} খেলা জিতেছেন!`, `${alive[0].name} wins the game!`);
    }
  }

  // Called after the turn pointer moves. Ends the game on the round limit.
  afterRotate() {
    // Count a round when the pointer lands back on whoever goes first.
    // Keying it on index 0 would stop counting the moment player 0 busts,
    // leaving the round limit unable to fire and the game able to run on
    // for ever.
    const firstLive = this.players.findIndex((p) => !p.bankrupt);
    if (firstLive >= 0 && this.currentIndex === firstLive) this.rounds++;

    this.checkWin();
    if (this.phase === 'gameOver') return;
    if (this.rounds < this.maxRounds) return;

    const ranked = this.players
      .filter((p) => !p.bankrupt)
      .map((p) => ({ p, worth: this.netWorth(p) }))
      .sort((a, b) => b.worth - a.worth);
    if (!ranked.length) return;

    this.phase = 'gameOver';
    this.winnerId = ranked[0].p.id;
    this.pending = null;
    this.say(
      `🏁 ${this.maxRounds} রাউন্ড শেষ — সর্বাধিক সম্পদ (Tk ${ranked[0].worth}) নিয়ে ${ranked[0].p.name} জিতলেন।`,
      `Round limit of ${this.maxRounds} reached — ${ranked[0].p.name} wins with the highest net worth (Tk ${ranked[0].worth}).`
    );
    this.version++;
  }

  bankrupt(player, creditor) {
    if (player.bankrupt) return;
    player.bankrupt = true;
    player.jail = false;
    player.getOutOfJail = false;
    player.doublesInARow = 0;

    const creditorAlive = creditor && !creditor.bankrupt;

    for (const [tileId, holding] of player.holdings) {
      const tile = getTile(tileId);
      if (creditorAlive && tile.houseCost && holding.houses > 0) {
        creditor.cash += (tile.houseCost / 2) * holding.houses;
      }
      if (creditorAlive) {
        creditor.holdings.set(tileId, { mortgaged: holding.mortgaged, houses: 0 });
      } else {
        player.holdings.delete(tileId);
      }
    }

    if (creditorAlive) creditor.cash += Math.max(0, player.cash);
    player.cash = 0;
    player.holdings.clear();

    this.say(
      `💸 ${player.name} দেউলিয়া হয়ে খেলা থেকে বাদ পড়লেন।`,
      `${player.name} is bankrupt and out of the game.`
    );

    // Whoever was on turn must not stay on turn now that they are out.
    if (this.current === player) this.rotateOffBankrupt();

    this.checkWin();
    this.version++;
  }

  // Move the turn pointer past the current (bankrupt) player.
  rotateOffBankrupt() {
    this.checkWin();
    if (this.phase === 'gameOver') return;
    let i = this.currentIndex;
    let guard = 0;
    do {
      i = (i + 1) % this.players.length;
      guard++;
    } while (this.players[i].bankrupt && guard <= this.players.length);
    this.currentIndex = i;
    this.afterRotate();
    if (this.phase === 'gameOver') return;
    this.phase = 'awaitRoll';
    this.pending = null;
    this.doublesInARow = 0;
    this.version++;
  }

  // ---- turn rotation -----------------------------------------------------

  // Move the turn pointer past the (now bankrupt) current player.
  skipCurrent() {
    this.rotateOffBankrupt();
  }

  endTurn() {
    if (this.phase === 'gameOver') return;
    const player = this.current;
    if (player && !player.bankrupt) {
      this.currentIndex = (this.currentIndex + 1) % this.players.length;
    }
    let guard = 0;
    while (this.players[this.currentIndex].bankrupt && guard <= this.players.length) {
      this.currentIndex = (this.currentIndex + 1) % this.players.length;
      guard++;
    }
    this.afterRotate();
    if (this.phase === 'gameOver') return;
    this.phase = 'awaitRoll';
    this.pending = null;
    this.doublesInARow = 0;
    this.version++;
  }

  confirmEnd() {
    if (this.phase !== 'awaitEnd') return;
    this.endTurn();
  }

  // ---- rolling -----------------------------------------------------------

  roll() {
    const player = this.current;
    if (this.phase !== 'awaitRoll' || !player || player.bankrupt) return null;

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const sum = d1 + d2;
    const doubles = d1 === d2;
    this.dice = [d1, d2];

    const result = { dice: [d1, d2], doubles, moved: false, from: player.position };

    if (player.jail) {
      this.say(
        `${player.name} জেলে (${player.jailTurns}/${MAX_JAIL_TURNS}) — ডাইস ${d1}+${d2}`,
        `${player.name} is in jail (${player.jailTurns}/${MAX_JAIL_TURNS}) and rolled ${d1}+${d2}`
      );
      result.inJail = true;

      if (doubles) {
        player.jail = false;
        player.jailTurns = 0;
        this.say(
          `${player.name} জোড়া ডাইসে জেল থেকে ছাড়া পেলেন!`,
          `${player.name} rolled doubles and left jail!`
        );
        this.advance(player, sum, result);
        return result;
      }

      player.jailTurns++;
      if (player.jailTurns >= MAX_JAIL_TURNS) {
        if (this.pay(player, JAIL_FINE, null, 'jail fine')) {
          player.jail = false;
          player.jailTurns = 0;
          this.say(
            `${player.name} Tk ${JAIL_FINE} জরিমানা দিয়ে জেল থেকে ছাড়া পেলেন।`,
            `${player.name} paid Tk ${JAIL_FINE} and left jail.`
          );
          this.advance(player, sum, result);
          return result;
        }
        this.skipCurrent();
        return result;
      }

      this.doublesInARow = 0;
      this.phase = 'awaitEnd';
      this.pending = { type: 'end', playerId: player.id };
      this.version++;
      return result;
    }

    this.say(
      `${player.name} ডাইস ফেললেন ${d1} + ${d2} = ${sum}${doubles ? ' (জোড়া!)' : ''}`,
      `${player.name} rolled ${d1} + ${d2} = ${sum}${doubles ? ' (doubles!)' : ''}`
    );

    this.advance(player, sum, result);
    return result;
  }

  // Spend the "Get Out of Jail" card to leave jail without rolling.
  useJailCard() {
    const player = this.current;
    if (!player || player.bankrupt || !player.getOutOfJail) {
      return { ok: false, msg: 'আপনার কাছে জেল ছাড়ার কার্ড নেই।' };
    }
    if (this.phase !== 'awaitRoll' && this.phase !== 'awaitEnd') {
      return { ok: false, msg: 'এখন কার্ডটি ব্যবহার করা যাবে না।' };
    }
    player.getOutOfJail = false;
    const wasInJail = player.jail;
    player.jail = false;
    player.jailTurns = 0;
    this.say(
      `${player.name} জেল ছাড়ার কার্ড ব্যবহার করলেন${wasInJail ? ' এবং জেল থেকে বের হলেন' : ''}।`,
      `${player.name} used their Get Out of Jail card${wasInJail ? ' and left jail' : ''}.`
    );
    this.phase = 'awaitRoll';
    this.pending = null;
    this.version++;
    return { ok: true };
  }

  advance(player, steps, result) {
    for (let i = 0; i < steps; i++) {
      player.position = (player.position + 1) % 40;
      if (player.position === 0) {
        this.credit(player, GO_SALARY);
        this.say(
          `${player.name} শুরু পেরিয়ে Tk ${GO_SALARY} পেলেন।`,
          `${player.name} passed START and collected Tk ${GO_SALARY}.`
        );
      }
    }
    result.position = player.position;
    result.moved = true;

    this.landOn(player, result);

    if (this.phase === 'gameOver') return;

    // Waiting on the player's decision (buy / keep card): stop here.
    if (this.phase === 'awaitBuy' || this.phase === 'awaitCard') {
      this.version++;
      return;
    }

    // The player went bust mid-move: bankrupt() has already rotated the turn,
    // and if the turn is no longer theirs there is nothing left to decide.
    if (player.bankrupt || this.current !== player) {
      if (this.phase !== 'gameOver' && this.current === player) this.skipCurrent();
      return;
    }

    if (result.doubles) {
      this.doublesInARow++;
      if (this.doublesInARow >= 3) {
        this.doublesInARow = 0;
        this.sendToJail(player);
        this.say(
          `${player.name} তিনবার জোড়া ডাইস ফেললেন — সরাসরি জেলে!`,
          `${player.name} rolled three doubles in a row and is sent to jail!`
        );
        this.phase = 'awaitEnd';
        this.pending = { type: 'end', playerId: player.id };
      } else {
        this.say(
          `${player.name} আবার ডাইস ফেলতে পারেন।`,
          `${player.name} gets another roll.`
        );
        this.phase = 'awaitRoll';
        this.pending = null;
      }
    } else {
      this.doublesInARow = 0;
      this.phase = 'awaitEnd';
      this.pending = { type: 'end', playerId: player.id };
    }
    this.version++;
  }

  landOn(player, result) {
    const tile = getTile(player.position);
    result.landedOn = { id: tile.id, type: tile.type, name: tile.name, bn: tile.bn };

    if (isOwnable(tile)) {
      const owner = this.ownerOf(tile.id);
      if (owner) {
        if (owner.id === player.id) {
          // Your own property: no rent, nothing to buy.
          return;
        }
        const holding = owner.holdings.get(tile.id);
        if (!holding.mortgaged) {
          const amount = this.rentFor(owner, tile, this.dice[0] + this.dice[1]);
          this.say(
            `${player.name} → ${tile.bn}: ${owner.name} কে Tk ${amount} ভাড়া দিতে হবে।`,
            `${player.name} landed on ${tile.name}: owes Tk ${amount} rent to ${owner.name}.`
          );
          if (this.pay(player, amount, owner, 'rent on ' + tile.name)) {
            result.chargedRent = { amount, to: owner.name, tileId: tile.id };
          }
        } else {
          this.say(
            `${tile.bn} বন্ধ আছে, ভাড়া লাগবে না।`,
            `${tile.name} is mortgaged, so no rent is due.`
          );
        }
        return;
      }

      this.say(
        `${player.name} → ${tile.bn}: খালি জমি (Tk ${tile.price})।`,
        `${player.name} landed on the unowned ${tile.name} (Tk ${tile.price}).`
      );
      if (player.cash >= tile.price && this.phase !== 'gameOver') {
        this.phase = 'awaitBuy';
        this.pending = { type: 'buy', playerId: player.id, tileId: tile.id };
      }
      return;
    }

    switch (tile.type) {
      case 'go':
        this.credit(player, GO_SALARY);
        this.say(
          `${player.name} শুরুতে ফিরলেন, Tk ${GO_SALARY}।`,
          `${player.name} returned to START, +Tk ${GO_SALARY}.`
        );
        break;
      case 'tax':
        this.say(
          `${player.name}-কে ${tile.bn} Tk ${tile.amount} দিতে হবে।`,
          `${player.name} owes ${tile.name}: Tk ${tile.amount}.`
        );
        this.pay(player, tile.amount, null, 'income tax');
        break;
      case 'luxury':
        this.say(
          `${player.name}-কে ${tile.bn} Tk ${tile.amount} দিতে হবে।`,
          `${player.name} owes ${tile.name}: Tk ${tile.amount}.`
        );
        this.pay(player, tile.amount, null, 'luxury tax');
        break;
      case 'parking':
        this.say(
          `${player.name} ফ্রি পার্কিং-এ বিশ্রাম করছেন।`,
          `${player.name} is resting at Free Parking.`
        );
        break;
      case 'jail':
        this.say(
          `${player.name} জেল পর্যবেক্ষণ করছেন।`,
          `${player.name} is only visiting the jail.`
        );
        break;
      case 'gotojail':
        this.sendToJail(player);
        break;
      case 'chest':
      case 'chance':
        this.drawCard(player, tile, result);
        break;
      default:
        break;
    }
  }

  sendToJail(player) {
    player.position = JAIL_INDEX;
    player.jail = true;
    player.jailTurns = 0;
    this.say(
      `${player.name} জেলে গেলেন।`,
      `${player.name} was sent to jail.`
    );
    this.version++;
  }

  // ---- cards -------------------------------------------------------------

  drawCard(player, tile, result) {
    const isChance = tile.type === 'chance';
    const deckName = isChance ? 'chance' : 'chest';

    if ((isChance ? this.chanceDeck : this.chestDeck).length === 0) {
      this.chanceDeck = shuffle(CHANCE_CARDS);
      this.chanceUsed = [];
      this.chestDeck = shuffle(CHEST_CARDS);
      this.chestUsed = [];
      this.say('কার্ডের ডেক নতুন করে সাজানো হয়েছে।', 'The card decks have been reshuffled.');
    }

    const card = (isChance ? this.chanceDeck : this.chestDeck).shift();
    (isChance ? this.chanceUsed : this.chestUsed).push(card.id);

    const fill = (s) => s
      .replace('{salary}', GO_SALARY)
      .replace('{rent}', String(this.previewRent(card)));

    const shown = { ...card, deck: deckName, bn: fill(card.bn), en: fill(card.text) };
    result.card = shown;

    this.say(
      `${isChance ? 'সুযোগ' : 'ভাগ্য'} — ${player.name}: ${shown.bn}`,
      `${isChance ? 'Chance' : 'Bhagya'} — ${player.name}: ${shown.en}`
    );

    if (card.action === 'getout') {
      this.phase = 'awaitCard';
      this.pending = { type: 'card', playerId: player.id, card: shown, deck: deckName, tileId: tile.id };
      this.version++;
      return;
    }

    this.applyCard(player, card, result);
  }

  // What the rent would be for a "goto" card target, for text display.
  previewRent(card) {
    if (!card.to) return 0;
    const tile = getTile(card.to);
    if (!isOwnable(tile)) return 0;
    const owner = this.ownerOf(tile.id);
    if (!owner) return 0;
    const holding = owner.holdings.get(tile.id);
    if (holding && holding.mortgaged) return 0;
    const base = this.rentFor(owner, tile, 7);
    return card.doubleRent ? base * 2 : base;
  }

  useCard() {
    const p = this.pending;
    if (!p || p.type !== 'card') return;
    const player = this.findById(p.playerId);
    if (!player) return;
    player.getOutOfJail = true;
    this.say(
      `${player.name} জেল ছাড়ার কার্ড রাখলেন।`,
      `${player.name} kept the Get Out of Jail card.`
    );
    this.phase = 'awaitEnd';
    this.pending = { type: 'end', playerId: player.id };
    this.version++;
  }

  applyCard(player, card, result) {
    switch (card.action) {
      case 'credit':
        this.credit(player, card.amount);
        this.say(
          `${player.name} পেলেন Tk ${card.amount}।`,
          `${player.name} received Tk ${card.amount}.`
        );
        result.credit = card.amount;
        break;

      case 'debit':
        this.say(
          `${player.name} দিলেন Tk ${card.amount}।`,
          `${player.name} paid Tk ${card.amount}.`
        );
        this.pay(player, card.amount, null, card.en);
        break;

      case 'goto': {
        let passedGo = false;
        while (player.position !== card.to) {
          player.position = (player.position + 1) % 40;
          if (player.position === 0) {
            passedGo = true;
            this.credit(player, GO_SALARY);
          }
        }
        if (card.salary) this.credit(player, GO_SALARY);
        if (passedGo) {
          this.say(
            `${player.name} শুরু পেরিয়ে Tk ${GO_SALARY} পেলেন।`,
            `${player.name} passed START and collected Tk ${GO_SALARY}.`
          );
        }
        result.position = player.position;
        result.moved = true;
        if (card.jail) {
          this.sendToJail(player);
        } else {
          this.landOn(player, result);
        }
        break;
      }

      case 'back': {
        player.position = (player.position + 40 - card.amount) % 40;
        result.position = player.position;
        result.moved = true;
        const tile = getTile(player.position);
        result.landedOn = { id: tile.id, type: tile.type, name: tile.name, bn: tile.bn };
        this.say(
          `${player.name} ${card.amount} ঘর পিছনে → ${tile.bn}।`,
          `${player.name} moved ${card.amount} spaces back to ${tile.name}.`
        );
        if (isOwnable(tile)) {
          const owner = this.ownerOf(tile.id);
          if (owner && owner.id !== player.id) {
            const holding = owner.holdings.get(tile.id);
            if (!holding.mortgaged) {
              const amount = this.rentFor(owner, tile, this.dice[0] + this.dice[1] || 7);
              this.pay(player, amount, owner, 'rent on ' + tile.name);
            }
          }
        }
        break;
      }

      case 'nearestRail':
        this.landOnTile(player, nextTileOfType('rail', player.position), result, { doubleRent: true });
        break;

      case 'nearestUtility':
        this.landOnTile(player, nextTileOfType('utility', player.position), result, { diceRent: true });
        break;

      case 'repairs': {
        let houses = 0;
        let hotels = 0;
        for (const [tileId, holding] of player.holdings) {
          const t = getTile(tileId);
          if (!t.houseCost) continue;
          if (holding.houses >= MAX_HOUSES) {
            hotels++;
            houses += 4;
          } else {
            houses += holding.houses;
          }
        }
        const amount = houses * card.house + hotels * (card.hotel - card.house);
        this.say(
          `${player.name}: ${houses} নং বাড়ি, ${hotels} হোটেল → Tk ${amount}`,
          `${player.name}: ${houses} house(s) and ${hotels} hotel(s) → Tk ${amount}`
        );
        if (amount > 0) this.pay(player, amount, null, 'repairs');
        break;
      }

      case 'getout':
        break;

      default:
        break;
    }
    this.version++;
  }

  // Shared landing logic for the "nearest ..." Chance cards.
  landOnTile(player, target, result, flags) {
    player.position = target;
    result.position = target;
    result.moved = true;
    const tile = getTile(target);
    result.landedOn = { id: tile.id, type: tile.type, name: tile.name, bn: tile.bn };

    const owner = this.ownerOf(target);
    if (owner && owner.id === player.id) return;   // your own tile: nothing due
    if (!owner) {
      this.say(
        `${player.name} → ${tile.bn}: খালি জমি (Tk ${tile.price})।`,
        `${player.name} landed on the unowned ${tile.name} (Tk ${tile.price}).`
      );
      if (player.cash >= tile.price && this.phase !== 'gameOver') {
        this.phase = 'awaitBuy';
        this.pending = { type: 'buy', playerId: player.id, tileId: target };
      }
      return;
    }

    const holding = owner.holdings.get(target);
    if (holding && holding.mortgaged) {
      this.say(`${tile.bn} বন্ধ আছে, ভাড়া লাগবে না।`, `${tile.name} is mortgaged, so no rent is due.`);
      return;
    }

    let amount = this.rentFor(owner, tile, flags.diceRent ? (this.dice[0] + this.dice[1] || 7) : 0);
    if (flags.doubleRent) amount *= 2;
    this.say(
      `${player.name} → ${tile.bn}: ${owner.name} কে Tk ${amount}।`,
      `${player.name} landed on ${tile.name}: pays Tk ${amount} to ${owner.name}.`
    );
    if (this.pay(player, amount, owner, 'rent on ' + tile.name)) {
      result.chargedRent = { amount, to: owner.name, tileId: tile.id };
    }
  }

  rentFor(owner, tile, diceSum) {
    if (tile.type === 'rail') {
      const count = groupMembers('rail').filter((t) => owner.holdings.has(t.id)).length;
      return tile.rent[Math.max(0, Math.min(count - 1, 3))];
    }
    if (tile.type === 'utility') {
      const count = groupMembers('utility').filter((t) => owner.holdings.has(t.id)).length;
      const multiplier = count >= 2 ? tile.diceRent : tile.baseRent;
      return multiplier * (diceSum > 0 ? diceSum : 7);
    }
    const holding = owner.holdings.get(tile.id);
    const houses = holding ? holding.houses : 0;
    return houses > 0 ? tile.rent[Math.min(houses, MAX_HOUSES)] : tile.rent[0];
  }

  // ---- buying / mortgages / building ------------------------------------

  buy(tileId) {
    const p = this.pending;
    if (!p || p.type !== 'buy') return;
    const player = this.findById(p.playerId);
    const tile = getTile(tileId);
    if (!player) return;
    if (this.ownerOf(tileId)) return;

    if (player.cash < tile.price) {
      this.say(
        `${player.name} এর Tk যথেষ্ট নয়, ${tile.bn} কেনা হয়নি।`,
        `${player.name} cannot afford ${tile.name} and passes on it.`
      );
    } else {
      player.cash -= tile.price;
      player.holdings.set(tileId, { mortgaged: false, houses: 0 });
      this.say(
        `${player.name} ${tile.bn} কিনলেন (Tk ${tile.price})।`,
        `${player.name} bought ${tile.name} for Tk ${tile.price}.`
      );
    }
    this.finishAction(player.id);
  }

  skipAction() {
    const p = this.pending;
    if (!p) return;
    if (p.type === 'buy') {
      const player = this.findById(p.playerId);
      const tile = getTile(p.tileId);
      if (player) {
        this.say(
          `${player.name} ${tile.bn} কেনেনি।`,
          `${player.name} declined to buy ${tile.name}.`
        );
      }
    }
    this.finishAction(p.playerId);
  }

  finishAction(playerId) {
    this.checkWin();
    if (this.phase === 'gameOver') {
      this.pending = null;
      return;
    }
    this.phase = 'awaitEnd';
    this.pending = { type: 'end', playerId };
    this.version++;
  }

  ownsFullGroup(player, tileId) {
    return groupMembers(groupOf(tileId)).every((t) => player.holdings.has(t.id));
  }

  groupHasBuildings(player, tileId) {
    return groupMembers(groupOf(tileId)).some((t) => {
      const h = player.holdings.get(t.id);
      return h && h.houses > 0;
    });
  }

  houseCount(player, tileId) {
    const h = player.holdings.get(tileId);
    return h ? h.houses : 0;
  }

  canBuild(player, tileId) {
    const tile = getTile(tileId);
    if (tile.type !== 'property' || !tile.houseCost) return false;
    if (!player.holdings.has(tileId)) return false;
    if (!this.ownsFullGroup(player, tileId)) return false;
    const holding = player.holdings.get(tileId);
    if (holding.mortgaged) return false;
    if (holding.houses >= MAX_HOUSES) return false;
    // Even-build rule: never more than one storey ahead of the lowest in the group.
    const group = groupMembers(groupOf(tileId));
    const min = Math.min(...group.map((t) => this.houseCount(player, t.id)));
    return holding.houses < Math.min(MAX_HOUSES, min + 1);
  }

  canSellBuilding(player, tileId) {
    const tile = getTile(tileId);
    if (tile.type !== 'property' || !tile.houseCost) return false;
    const holding = player.holdings.get(tileId);
    if (!holding || holding.houses === 0) return false;
    // Even-sell rule: after the sale, no built property in the group may sit
    // more than one storey below the tallest one.
    const group = groupMembers(groupOf(tileId));
    const after = group.map((t) => this.houseCount(player, t.id));
    const idx = group.findIndex((t) => t.id === tileId);
    after[idx] -= 1;
    const max = Math.max(...after);
    return after.every((h) => h === 0 || h >= max - 1);
  }

  build(tileId) {
    const player = this.current;
    if (!player || player.bankrupt) return { ok: false, msg: 'এখন আপনার চাল নয়।' };
    if (!this.canBuild(player, tileId)) return { ok: false, msg: 'এখানে বাড়ি বানানো যাবে না।' };
    const tile = getTile(tileId);
    const cost = houseCostOf(tile);
    if (player.cash < cost) return { ok: false, msg: 'Tk যথেষ্ট নয়।' };
    player.cash -= cost;
    const holding = player.holdings.get(tileId);
    holding.houses++;
    const label = holding.houses >= MAX_HOUSES ? 'একটি হোটেল' : `${holding.houses} নং বাড়ি`;
    this.say(
      `${player.name} ${tile.bn}-এ ${label} বানালেন (Tk ${cost})।`,
      `${player.name} built ${label} on ${tile.name} for Tk ${cost}.`
    );
    this.version++;
    return { ok: true };
  }

  sellBuilding(tileId) {
    const player = this.current;
    if (!player || player.bankrupt) return { ok: false, msg: 'এখন আপনার চাল নয়।' };
    if (!this.canSellBuilding(player, tileId)) {
      return { ok: false, msg: 'এই গ্রুপে অন্য জমির বাড়ি আগে সরাতে হবে।' };
    }
    const tile = getTile(tileId);
    const holding = player.holdings.get(tileId);
    holding.houses--;
    const refund = Math.floor(tile.houseCost / 2);
    player.cash += refund;
    this.say(
      `${player.name} ${tile.bn}-এর একটি বাড়ি সরালেন (+Tk ${refund})।`,
      `${player.name} sold a building on ${tile.name} for Tk ${refund}.`
    );
    this.version++;
    return { ok: true };
  }

  mortgage(tileId) {
    const player = this.current;
    if (!player || player.bankrupt) return { ok: false, msg: 'এখন আপনার চাল নয়।' };
    const tile = getTile(tileId);
    if (!isOwnable(tile)) return { ok: false, msg: 'এটি কিনা যায় না।' };
    const holding = player.holdings.get(tileId);
    if (!holding) return { ok: false, msg: 'এটি আপনার জমি নয়।' };
    if (holding.mortgaged) return { ok: false, msg: 'এটি ইতিমধ্যে বন্ধ আছে।' };
    if (holding.houses > 0) return { ok: false, msg: 'আগে বাড়িটি সরান।' };
    if (this.groupHasBuildings(player, tileId)) return { ok: false, msg: 'গ্রুপের অন্য জমিতে বাড়ি আছে।' };
    holding.mortgaged = true;
    const value = mortgageValue(tile);
    player.cash += value;
    this.say(
      `${player.name} ${tile.bn} বন্ধ করলেন (+Tk ${value})।`,
      `${player.name} mortgaged ${tile.name} for Tk ${value}.`
    );
    this.version++;
    return { ok: true };
  }

  unmortgage(tileId) {
    const player = this.current;
    if (!player || player.bankrupt) return { ok: false, msg: 'এখন আপনার চাল নয়।' };
    const tile = getTile(tileId);
    const holding = player.holdings.get(tileId);
    if (!holding || !holding.mortgaged) return { ok: false, msg: 'এটি বন্ধ নয়।' };
    const value = unmortgageValue(tile);
    if (player.cash < value) return { ok: false, msg: 'Tk যথেষ্ট নয়।' };
    player.cash -= value;
    holding.mortgaged = false;
    this.say(
      `${player.name} ${tile.bn} আবার খুললেন (Tk ${value})।`,
      `${player.name} unmortgaged ${tile.name} for Tk ${value}.`
    );
    this.version++;
    return { ok: true };
  }

  // ---- turn ownership ----------------------------------------------------

  // Every action a player can take goes through here, so a bot and a socket
  // are held to exactly the same rules. Returns { ok, msg }.
  requireTurn(playerId) {
    if (this.phase === 'lobby') return { ok: false, msg: 'খেলা এখনো শুরু হয়নি।' };
    if (this.phase === 'gameOver') return { ok: false, msg: 'খেলা শেষ হয়ে গেছে।' };
    const player = this.findById(playerId);
    if (!player) return { ok: false, msg: 'খেলোয়াড় পাওয়া যায়নি।' };
    if (player.bankrupt) return { ok: false, msg: 'আপনি খেলা ছেড়ে দিয়েছেন।' };
    if (!player.isBot && player.connected === false) {
      return { ok: false, msg: 'সংযোগ না থাকায় এখনই চাল নেওয়া যাচ্ছে না।' };
    }
    if (this.current !== player) return { ok: false, msg: 'এখন আপনার চাল নয়।' };
    return { ok: true, player: player };
  }

  // Guarded wrappers, used by both the socket layer and the bot.
  actRoll(playerId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    if (this.phase !== 'awaitRoll') return { ok: false, msg: 'এখন ডাইস ফেলার সময় নয়।' };
    return { ok: true, result: this.roll() };
  }

  actBuy(playerId, tileId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    if (this.phase !== 'awaitBuy') return { ok: false, msg: 'এখন কেনার সময় নয়।' };
    if (!this.pending || this.pending.type !== 'buy' || this.pending.playerId !== playerId) {
      return { ok: false, msg: 'কেনার কোনো প্রস্তাব নেই।' };
    }
    this.buy(tileId != null ? tileId : this.pending.tileId);
    return { ok: true };
  }

  actSkip(playerId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    if (!this.pending || this.pending.type === 'end') {
      return { ok: false, msg: 'এখন কিছু করার নেই।' };
    }
    if (this.pending.playerId !== playerId) return { ok: false, msg: 'এটি আপনার সিদ্ধান্ত নয়।' };
    this.skipAction();
    return { ok: true };
  }

  actUseCard(playerId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    if (this.phase !== 'awaitCard') return { ok: false, msg: 'এখন কার্ড ব্যবহারের সময় নয়।' };
    this.useCard();
    return { ok: true };
  }

  actNext(playerId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    if (this.phase !== 'awaitEnd') return { ok: false, msg: 'এখন চাল শেষ করার সময় নয়।' };
    this.confirmEnd();
    return { ok: true };
  }

  actJailCard(playerId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    const res = this.useJailCard();
    return res.ok ? { ok: true } : { ok: false, msg: res.msg };
  }

  actBuild(playerId, tileId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    const res = this.build(tileId);
    return res.ok ? { ok: true } : { ok: false, msg: res.msg };
  }

  actSell(playerId, tileId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    const res = this.sellBuilding(tileId);
    return res.ok ? { ok: true } : { ok: false, msg: res.msg };
  }

  actMortgage(playerId, tileId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    const res = this.mortgage(tileId);
    return res.ok ? { ok: true } : { ok: false, msg: res.msg };
  }

  actUnmortgage(playerId, tileId) {
    const t = this.requireTurn(playerId);
    if (!t.ok) return t;
    const res = this.unmortgage(tileId);
    return res.ok ? { ok: true } : { ok: false, msg: res.msg };
  }

  // ---- persistence -------------------------------------------------------

  // Plain-data snapshot for saving to disk. `holdings` is a Map, which JSON
  // cannot encode, so it becomes an array of entries.
  toJSON() {
    return {
      v: 1,
      code: this.code,
      phase: this.phase,
      currentIndex: this.currentIndex,
      dice: this.dice,
      doublesInARow: this.doublesInARow,
      pending: this.pending,
      winnerId: this.winnerId,
      rounds: this.rounds,
      maxRounds: this.maxRounds,
      log: this.log,
      chestDeck: this.chestDeck,
      chestUsed: this.chestUsed,
      chanceDeck: this.chanceDeck,
      chanceUsed: this.chanceUsed,
      logSeq: this.logSeq,
      version: this.version,
      trades: (this.trades || []).map((t) => Object.assign({}, t)),
      tradeSeq: this.tradeSeq | 0,
      players: this.players.map((p) => ({
        id: p.id,
        socketId: null,                 // sockets never outlive the process
        sessionToken: p.sessionToken,
        connected: false,               // nobody is connected after a restart
        disconnectedAt: null,
        isBot: !!p.isBot,
        name: p.name,
        colorIndex: p.colorIndex,
        cash: p.cash,
        position: p.position,
        jail: p.jail,
        jailTurns: p.jailTurns,
        getOutOfJail: p.getOutOfJail,
        bankrupt: p.bankrupt,
        holdings: [...p.holdings.entries()].map(([tileId, h]) => [
          tileId,
          { mortgaged: !!h.mortgaged, houses: h.houses | 0 }
        ])
      }))
    };
  }

  // Rebuild a Game from a snapshot, keeping the prototype so the rules still
  // work afterwards. Never trusts the file: every field is re-shaped.
  static fromJSON(data) {
    if (!data || typeof data !== 'object') return null;
    if (!Array.isArray(data.players) || !data.players.length) return null;

    const g = new Game(String(data.code || '????').slice(0, 4));
    g.phase = typeof data.phase === 'string' ? data.phase : 'lobby';
    g.currentIndex = Number.isInteger(data.currentIndex) ? data.currentIndex : 0;
    g.dice = Array.isArray(data.dice) ? data.dice.slice(0, 2) : [0, 0];
    g.doublesInARow = data.doublesInARow | 0;
    g.pending = data.pending && typeof data.pending === 'object' ? data.pending : null;
    g.winnerId = data.winnerId || null;
    g.rounds = data.rounds | 0;
    g.maxRounds = Number.isInteger(data.maxRounds) && data.maxRounds > 0
      ? data.maxRounds
      : DEFAULT_MAX_ROUNDS;
    g.log = Array.isArray(data.log) ? data.log.slice(-80) : [];
    g.chestDeck = Array.isArray(data.chestDeck) ? data.chestDeck : shuffle(CHEST_CARDS);
    g.chestUsed = Array.isArray(data.chestUsed) ? data.chestUsed : [];
    g.chanceDeck = Array.isArray(data.chanceDeck) ? data.chanceDeck : shuffle(CHANCE_CARDS);
    g.chanceUsed = Array.isArray(data.chanceUsed) ? data.chanceUsed : [];
    g.logSeq = data.logSeq | 0;
    g.version = data.version | 0;
    g.trades = Array.isArray(data.trades) ? data.trades : [];
    g.tradeSeq = data.tradeSeq | 0;

    g.players = data.players.slice(0, 4).map((p, i) => {
      const idx = Number.isInteger(p.colorIndex) ? p.colorIndex : i;
      const holdings = new Map();
      if (Array.isArray(p.holdings)) {
        p.holdings.forEach((entry) => {
          if (!Array.isArray(entry) || entry.length < 2) return;
          const tileId = Number(entry[0]);
          // Validate the raw id: getTile() wraps out-of-range values, so a
          // corrupt 999 would otherwise hand the player tile 39.
          if (!Number.isInteger(tileId) || tileId < 0 || tileId > 39) return;
          const tile = getTile(tileId);
          if (!isOwnable(tile)) return;
          const h = entry[1] || {};
          holdings.set(tileId, {
            mortgaged: !!h.mortgaged,
            houses: Math.max(0, Math.min(MAX_HOUSES, h.houses | 0))
          });
        });
      }
      const position = Number(p.position);
      return {
        id: typeof p.id === 'string' && p.id ? p.id : 'p' + (i + 1) + '_restored',
        socketId: null,
        sessionToken: typeof p.sessionToken === 'string' && p.sessionToken
          ? p.sessionToken
          : (p.isBot ? null : newToken()),
        connected: p.isBot ? true : false,
        disconnectedAt: null,
        isBot: !!p.isBot,
        name: String(p.name || ('Player ' + (i + 1))).substring(0, 18),
        colorIndex: idx,
        color: COLORS[idx % COLORS.length],
        token: TOKENS[idx % TOKENS.length],
        cash: Number.isFinite(p.cash) ? Math.max(0, p.cash) : START_CASH,
        position: Number.isFinite(position) ? ((position % 40) + 40) % 40 : 0,
        jail: !!p.jail,
        jailTurns: Math.max(0, Math.min(MAX_JAIL_TURNS, p.jailTurns | 0)),
        getOutOfJail: !!p.getOutOfJail,
        bankrupt: !!p.bankrupt,
        holdings: holdings
      };
    });

    if (g.currentIndex >= g.players.length) g.currentIndex = 0;
    g.version = (g.version | 0) + 1;
    return g;
  }

  // ---- trading ------------------------------------------------------

  // Trades never consume a turn. They are proposed freely and accepted later,
  // so a slow reply can never stall the board.

  // Check a single side of an offer: does this player really hold it?
  _sideIsValid(player, side) {
    if (!side || typeof side !== 'object') return false;
    const cash = side.cash | 0;
    if (cash < 0 || cash > player.cash) return false;
    const tiles = Array.isArray(side.tiles) ? side.tiles : [];
    if (!tiles.length && cash === 0) return false;      // nothing offered

    const seen = new Set();
    for (const raw of tiles) {
      const tileId = Number(raw);
      if (!Number.isInteger(tileId) || tileId < 0 || tileId > 39) return false;
      if (seen.has(tileId)) return false;                 // no duplicates
      seen.add(tileId);
      if (!isOwnable(getTile(tileId))) return false;
      const holding = player.holdings.get(tileId);
      if (!holding) return false;                         // not theirs
      if (holding.houses > 0) return false;               // no built-up titles
    }
    return true;
  }

  _sideOf(side) {
    const tiles = (Array.isArray(side.tiles) ? side.tiles : [])
      .map((t) => Number(t))
      .filter((t) => Number.isInteger(t) && t >= 0 && t <= 39);
    return { cash: Math.max(0, side.cash | 0), tiles };
  }

  proposeTrade(fromId, toId, offer, want) {
    if (this.phase === 'lobby') return { ok: false, msg: 'খেলা শুরু হওয়ার আগে ট্রেড করা যায় না।' };
    if (this.phase === 'gameOver') return { ok: false, msg: 'খেলা শেষ হয়ে গেছে।' };
    if (fromId === toId) return { ok: false, msg: 'নিজের সাথে ট্রেড করা যায় না।' };

    const from = this.findById(fromId);
    const to = this.findById(toId);
    if (!from || from.bankrupt) return { ok: false, msg: 'খেলোয়াড় পাওয়া যায়নি।' };
    if (!to || to.bankrupt) return { ok: false, msg: 'প্রতিপক্ষকে ট্রেড করা যাবে না।' };
    if (to.isBot) return { ok: false, msg: 'বটের সাথে ট্রেড করা যায় না।' };
    if (to.connected === false) return { ok: false, msg: 'প্রতিপক্ষের সংযোগ নেই।' };

    if (!this._sideIsValid(from, offer)) {
      return { ok: false, msg: 'আপনার অফারটি সঠিক নয় (টাকা বা জমি আপনার নয়)।' };
    }
    if (!this._sideIsValid(to, want)) {
      return { ok: false, msg: 'যা চাইছেন তা প্রতিপক্ষের কাছে নেই।' };
    }

    // No duplicate offers to the same person already sitting there.
    const already = this.trades.some(
      (t) => t.status === 'pending' && t.fromId === fromId && t.toId === toId
    );
    if (already) return { ok: false, msg: 'এই খেলোয়াড়ের কাছে একটি অফার পেন্ডিং আছে।' };

    const mySide = this._sideOf(offer);
    const theirSide = this._sideOf(want);

    const trade = {
      id: 't' + (++this.tradeSeq),
      fromId,
      toId,
      fromName: from.name,
      toName: to.name,
      offer: mySide,
      want: theirSide,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + TRADE_TTL_MS
    };
    this.trades.push(trade);

    this.say(
      `${from.name} → ${to.name}: ট্রেডের প্রস্তাব দিয়েছেন।`,
      `${from.name} proposed a trade to ${to.name}.`
    );
    this.version++;
    return { ok: true, trade: trade };
  }

  // Drop offers that nobody answered.
  expireTrades() {
    const now = Date.now();
    let changed = false;
    this.trades = this.trades.filter((t) => {
      if (t.status !== 'pending' || t.expiresAt > now) return true;
      t.status = 'expired';
      changed = true;
      return false;
    });
    if (changed) this.version++;
    return changed;
  }

  declineTrade(tradeId, byId) {
    const trade = this.trades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== 'pending') return { ok: false, msg: 'ট্রেডটি পাওয়া যায়নি।' };
    if (trade.fromId !== byId && trade.toId !== byId) return { ok: false, msg: 'এটি আপনার ট্রেড নয়।' };
    trade.status = 'declined';
    this.say(
      `${trade.fromName} ও ${trade.toName} ট্রেডটি বাতিল করলেন।`,
      `${trade.fromName} and ${trade.toName} called off the trade.`
    );
    this.version++;
    return { ok: true };
  }

  acceptTrade(tradeId, byId) {
    const trade = this.trades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== 'pending') return { ok: false, msg: 'ট্রেডটি আর বৈধ নয়।' };
    if (trade.toId !== byId) return { ok: false, msg: 'শুধু যিনি ট্রেডটি পেয়েছেন তিনিই গ্রহণ করতে পারবেন।' };
    if (trade.expiresAt <= Date.now()) {
      trade.status = 'expired';
      return { ok: false, msg: 'ট্রেডের সময় শেষ হয়ে গেছে।' };
    }

    // Re-validate everything: since the offer was made, titles may have been
    // mortgaged, built on, or traded away. Never trust the stored proposal.
    const from = this.findById(trade.fromId);
    const to = this.findById(trade.toId);
    if (!from || !to || from.bankrupt || to.bankrupt) {
      trade.status = 'failed';
      return { ok: false, msg: 'প্রতিপক্ষ খেলা ছেড়ে দিয়েছেন।' };
    }
    if (!this._sideIsValid(from, trade.offer)) {
      trade.status = 'failed';
      return { ok: false, msg: 'প্রস্তাব দেওয়ার পর জমির অবস্থা বদলে গেছে।' };
    }
    if (!this._sideIsValid(to, trade.want)) {
      trade.status = 'failed';
      return { ok: false, msg: 'চাওয়া জমি আর নেই।' };
    }

    // Move the titles, carrying mortgage state across with them.
    const give = (fromP, toP, side) => {
      if (side.cash > 0) {
        fromP.cash -= side.cash;
        toP.cash += side.cash;
      }
      side.tiles.forEach((tileId) => {
        const holding = fromP.holdings.get(tileId);
        fromP.holdings.delete(tileId);
        toP.holdings.set(tileId, {
          mortgaged: holding ? holding.mortgaged : false,
          houses: 0
        });
      });
    };
    give(from, to, trade.offer);
    give(to, from, trade.want);

    trade.status = 'accepted';

    const describe = (p) => {
      const bits = [];
      if (p.cash > 0) bits.push('Tk ' + p.cash);
      if (p.tiles.length) bits.push(p.tiles.map((t) => getTile(t).bn).join(', '));
      return bits.join(' + ') || 'কিছু নয়';
    };
    this.say(
      `✅ ট্রেড হয়েছে — ${trade.fromName} দিলেন ${describe(trade.offer)}; ${trade.toName} দিলেন ${describe(trade.want)}।`,
      `Trade agreed: ${trade.fromName} gave ${describe(trade.offer)}; ${trade.toName} gave ${describe(trade.want)}.`
    );
    this.version++;
    return { ok: true };
  }

  cancelTradesBetween(aId, bId) {
    let changed = false;
    this.trades = this.trades.filter((t) => {
      if (t.status !== 'pending') return true;
      if (t.fromId !== aId && t.toId !== aId) return true;
      if (t.fromId !== bId && t.toId !== bId) return true;
      t.status = 'cancelled';
      changed = true;
      return false;
    });
    if (changed) this.version++;
    return changed;
  }

  // The client's view of open trade offers.
  tradeViewFor(playerId) {
    return this.trades
      .filter((t) => t.status === 'pending' && (t.fromId === playerId || t.toId === playerId))
      .map((t) => ({
        id: t.id,
        fromId: t.fromId,
        toId: t.toId,
        fromName: t.fromName,
        toName: t.toName,
        offer: t.offer,
        want: t.want,
        direction: t.toId === playerId ? 'incoming' : 'outgoing',
        expiresIn: Math.max(0, t.expiresAt - Date.now())
      }));
  }

  // ---- serialization -----------------------------------------------------

  serialize() {
    return {
      code: this.code,
      phase: this.phase,
      currentPlayerId: this.current && !this.current.bankrupt ? this.current.id : null,
      dice: this.dice,
      winnerId: this.winnerId,
      rounds: this.rounds,
      maxRounds: this.maxRounds,
      pending: this.pending,
      version: this.version,
      log: this.log,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        colorIndex: p.colorIndex,
        token: p.token,
        isBot: p.isBot,
        connected: p.connected,
        cash: p.cash,
        position: p.position,
        jail: p.jail,
        jailTurns: p.jailTurns,
        getOutOfJail: p.getOutOfJail,
        bankrupt: p.bankrupt,
        netWorth: this.netWorth(p),
        holdings: [...p.holdings.keys()]
          .sort((a, b) => a - b)
          .map((tileId) => {
            const h = p.holdings.get(tileId);
            return {
              tileId,
              mortgaged: h.mortgaged,
              houses: h.houses,
              canBuild: this.canBuild(p, tileId),
              canSell: this.canSellBuilding(p, tileId)
            };
          })
      })),
      board: TILES.map((t) => {
        const owner = this.ownerOf(t.id);
        const holding = owner ? owner.holdings.get(t.id) : null;
        return {
          id: t.id,
          type: t.type,
          name: t.name,
          bn: t.bn,
          group: t.group || null,
          price: t.price || 0,
          amount: t.amount || 0,
          rents: t.rent || null,
          baseRent: t.baseRent || null,
          diceRent: t.diceRent || null,
          houseCost: t.houseCost || 0,
          mortgageValue: isOwnable(t) ? mortgageValue(t) : 0,
          unmortgageValue: isOwnable(t) ? unmortgageValue(t) : 0,
          ownerId: owner ? owner.id : null,
          mortgaged: holding ? holding.mortgaged : false,
          houses: holding ? holding.houses : 0
        };
      })
    };
  }
}

module.exports = { Game, COLORS, TOKENS, RESUME_GRACE_MS, DEFAULT_MAX_ROUNDS };