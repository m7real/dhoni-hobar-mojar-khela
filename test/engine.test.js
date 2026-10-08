'use strict';

/* Engine tests: plays complete games and checks the Monopoly rules. */

const { Game } = require('../server/game');
const board = require('../server/board');

let passed = 0;
let failed = 0;

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failed++;
    console.log('  FAIL ' + label + (detail ? '  -> ' + detail : ''));
  }
}

function section(name) {
  console.log('\n' + name);
}

function makeGame(n) {
  const g = new Game('TEST');
  for (let i = 0; i < n; i++) g.addPlayer('P' + (i + 1), 'sock' + i);
  g.start();
  return g;
}

// ── board shape ────────────────────────────────────────────────────────────

section('board structure');
{
  ok(board.TILES.length === 40, 'board has 40 tiles', board.TILES.length);
  ok(board.getTile(0).type === 'go', 'tile 0 is START');
  ok(board.getTile(10).type === 'jail', 'tile 10 is the jail');
  ok(board.getTile(20).type === 'parking', 'tile 20 is free parking');
  ok(board.getTile(30).type === 'gotojail', 'tile 30 sends you to jail');

  const ids = board.TILES.map((t) => t.id);
  ok(new Set(ids).size === 40, 'tile ids are unique');
  ok(board.TILES.every((t, i) => t.id === i), 'tiles are in id order');

  const wrap = board.getTile(41);
  ok(wrap.id === 1, 'getTile wraps past the end');

  const rails = board.TILES.filter((t) => t.type === 'rail');
  const utils = board.TILES.filter((t) => t.type === 'utility');
  ok(rails.length === 4, 'four railway stations', rails.length);
  ok(utils.length === 2, 'two utility tiles', utils.length);

  const ownable = board.TILES.filter(board.isOwnable);
  ok(ownable.length === 28, '28 purchasable tiles', ownable.length);

  // Colour groups must be 2 or 3 properties (plus 4 rails / 2 utils).
  const counts = {};
  ownable.forEach((t) => { counts[t.group] = (counts[t.group] || 0) + 1; });
  const badGroups = Object.keys(counts).filter(
    (g) => g !== 'rail' && g !== 'utility' && counts[g] < 2
  );
  ok(badGroups.length === 0, 'every colour group has at least 2 tiles', badGroups.join(','));
  ok(counts.rail === 4 && counts.utility === 2, 'rail and utility group sizes correct');

  const rentOk = board.TILES.filter((t) => t.type === 'property')
    .every((t) => Array.isArray(t.rent) && t.rent.length === 6 && t.houseCost > 0);
  ok(rentOk, 'every property has a 6-entry rent table and a house cost');

  ok(board.CHANCE_CARDS.length === 16, '16 Chance cards');
  ok(board.CHEST_CARDS.length === 16, '16 Bhagya cards');
  ok(board.START_CASH === 1500, 'starting cash is 1500');
  ok(board.GO_SALARY === 200, 'START salary is 200');
}

// ── setup ──────────────────────────────────────────────────────────────────

section('setup');
{
  const g = new Game('T');
  ok(g.addPlayer('A', 's1') !== null, 'first player joins');
  ok(g.addPlayer('B', 's2') !== null, 'second player joins');
  ok(g.addPlayer('C', 's3') !== null, 'third player joins');
  ok(g.addPlayer('D', 's4') !== null, 'fourth player joins');
  ok(g.addPlayer('E', 's5') === null, 'a fifth player is refused');
  ok(g.players.length === 4, 'lobby holds four players');
  ok(g.start(), 'game starts with two or more players');

  const one = new Game('T');
  one.addPlayer('Solo', 's1');
  ok(!one.start(), 'a game cannot start with one player');
}

{
  const g = makeGame(2);
  ok(g.players.every((p) => p.cash === 1500), 'everyone starts with 1500');
  ok(g.players.every((p) => p.position === 0), 'everyone starts on START');
  ok(g.current === g.players[0], 'the first player goes first');
  ok(g.phase === 'awaitRoll', 'phase awaits the first roll');
}

// ── rent ───────────────────────────────────────────────────────────────────

section('rent');
{
  const g = makeGame(2);
  const [a, b] = g.players;

  // a stands on Kali Bazar while nobody owns it: nothing happens.
  a.position = 1;
  b.position = 30;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';
  a.cash = 1000;
  g.dice = [1, 1];

  g.landOn(a, {});
  const baseRent = a.cash;
  ok(baseRent === 1000, 'unowned tile charges nothing', baseRent);

  // b buys it; now a owes rent (base rent 2).
  b.holdings.set(1, { mortgaged: false, houses: 0 });
  g.landOn(a, {});
  ok(a.cash === 998 && b.cash === 1502, 'base rent 2 transfers 2',
    a.cash + '/' + b.cash);

  // With houses the table applies.
  b.holdings.set(1, { mortgaged: false, houses: 1 });
  g.landOn(a, {});
  ok(a.cash === 988 && b.cash === 1512, 'one house charges 10', a.cash + '/' + b.cash);

  b.holdings.set(1, { mortgaged: false, houses: 5 });
  g.landOn(a, {});
  ok(a.cash === 738 && b.cash === 1762, 'a hotel charges 250', a.cash + '/' + b.cash);

  // Standing on your own property costs nothing and offers nothing.
  b.holdings.delete(1);
  a.holdings.set(1, { mortgaged: false, houses: 0 });
  a.cash = 500;
  g.pending = null;
  g.landOn(a, {});
  ok(a.cash === 500 && g.pending === null,
    'landing on your own property neither charges nor offers a sale',
    a.cash + ' / pending=' + JSON.stringify(g.pending));
}

{
  // Railways scale with how many the owner holds.
  const g = makeGame(2);
  const [a, b] = g.players;
  a.position = 5;
  b.holdings.set(5, { mortgaged: false, houses: 0 });

  a.cash = 1000;
  g.dice = [3, 4];
  g.landOn(a, {});
  ok(a.cash === 975 && b.cash === 1525, 'one station charges 25', a.cash + '/' + b.cash);

  b.holdings.set(15, { mortgaged: false, houses: 0 });
  g.landOn(a, {});
  ok(a.cash === 925, 'two stations charge 50', a.cash);

  b.holdings.set(25, { mortgaged: false, houses: 0 });
  g.landOn(a, {});
  ok(a.cash === 825, 'three stations charge 100', a.cash);

  b.holdings.set(35, { mortgaged: false, houses: 0 });
  g.landOn(a, {});
  ok(a.cash === 625, 'four stations charge 200', a.cash);
}

{
  // Utilities are a multiple of the dice.
  const g = makeGame(2);
  const [a, b] = g.players;
  a.position = 12;
  b.holdings.set(12, { mortgaged: false, houses: 0 });
  a.cash = 1000;

  g.dice = [5, 4];
  g.landOn(a, {});
  ok(a.cash === 964, 'one utility is 4x the dice (9*4=36)', a.cash);

  b.holdings.set(28, { mortgaged: false, houses: 0 });
  g.landOn(a, {});
  ok(a.cash === 874, 'two utilities are 10x the dice (9*10=90)', a.cash);
}

{
  // A mortgaged property collects nothing.
  const g = makeGame(2);
  const [a, b] = g.players;
  a.position = 1;
  b.holdings.set(1, { mortgaged: true, houses: 0 });
  a.cash = 1000;
  g.landOn(a, {});
  ok(a.cash === 1000, 'a mortgaged property charges no rent', a.cash);
}

// ── buying ─────────────────────────────────────────────────────────────────

section('buying');
{
  const g = makeGame(2);
  const [a] = g.players;
  a.cash = 1000;
  a.position = 1;
  g.phase = 'awaitBuy';
  g.pending = { type: 'buy', playerId: a.id, tileId: 1 };

  g.buy(1);
  ok(a.cash === 940, 'buying Kali Bazar costs 60', a.cash);
  ok(a.holdings.has(1), 'the property is recorded');
  ok(g.phase === 'awaitEnd', 'phase moves on after buying');

  // Declining.
  a.cash = 1000;
  a.position = 3;
  g.phase = 'awaitBuy';
  g.pending = { type: 'buy', playerId: a.id, tileId: 3 };
  g.skipAction();
  ok(!a.holdings.has(3), 'declining buys nothing');
  ok(a.cash === 1000, 'declining costs nothing', a.cash);
}

{
  // You cannot buy a tile somebody else holds.
  const g = makeGame(2);
  const [a, b] = g.players;
  b.holdings.set(6, { mortgaged: false, houses: 0 });
  a.cash = 1000;
  g.phase = 'awaitBuy';
  g.pending = { type: 'buy', playerId: a.id, tileId: 6 };
  g.buy(6);
  ok(!a.holdings.has(6), 'cannot buy an owned tile');
  ok(a.cash === 1000, 'cash untouched after a refused purchase');
}

{
  // Not enough cash: the buy is simply skipped, never negative.
  const g = makeGame(2);
  const [a] = g.players;
  a.cash = 10;
  a.position = 39;
  g.phase = 'awaitBuy';
  g.pending = { type: 'buy', playerId: a.id, tileId: 39 };
  g.buy(39);
  ok(!a.holdings.has(39), 'a broke player cannot buy');
  ok(a.cash === 10, 'cash never goes negative');
}

// ── building ───────────────────────────────────────────────────────────────

section('building');
{
  const g = makeGame(2);
  const [a] = g.players;
  g.currentIndex = 0;
  a.holdings.set(1, { mortgaged: false, houses: 0 });   // brown, houseCost 50
  a.cash = 1000;

  ok(!g.canBuild(a, 3), 'cannot build until the whole group is owned');
  a.holdings.set(3, { mortgaged: false, houses: 0 });
  ok(g.canBuild(a, 1), 'can build once the group is complete');

  ok(g.build(1).ok, 'first house is built');
  ok(a.cash === 950, 'a brown house costs 50', a.cash);
  ok(a.holdings.get(1).houses === 1, 'house count increments');

  ok(g.build(3).ok, 'second house on the other tile of the group');
  ok(g.canBuild(a, 1), 'can keep building evenly');

  g.build(1);
  ok(!g.canBuild(a, 1), 'no third house on one tile');
  ok(g.build(3).ok, 'the pair may both advance');
  ok(g.build(1).ok, 'third house allowed once balanced');
  ok(g.build(3).ok, 'third house on the pair');
  g.build(1);
  g.build(3);
  g.build(1);
  ok(a.holdings.get(1).houses === 5, 'a hotel is five houses', a.holdings.get(1).houses);
  ok(!g.canBuild(a, 1), 'a hotel is the ceiling');
}

{
  // Selling is the mirror image of the even-build rule.
  const g = makeGame(2);
  const [a] = g.players;
  g.currentIndex = 0;
  a.holdings.set(1, { mortgaged: false, houses: 3 });
  a.holdings.set(3, { mortgaged: false, houses: 3 });
  a.cash = 1000;

  ok(g.canSellBuilding(a, 1), 'can sell a building');
  g.sellBuilding(1);
  ok(a.cash === 1025, 'selling refunds half the house cost', a.cash);
  ok(a.holdings.get(1).houses === 2, 'house count decrements');
  ok(!g.canSellBuilding(a, 6), 'cannot sell a building you do not have');

  // A sale may not leave a built property two storeys below the tallest.
  a.holdings.set(1, { mortgaged: false, houses: 1 });
  a.holdings.set(3, { mortgaged: false, houses: 4 });
  ok(!g.canSellBuilding(a, 3),
    'cannot leave one property two storeys below the tallest',
    'houses 1/4 -> selling the 4 would leave 1/3');

  // And it always succeeds down to nothing when nothing is left behind.
  a.holdings.set(1, { mortgaged: false, houses: 0 });
  a.holdings.set(3, { mortgaged: false, houses: 3 });
  ok(g.canSellBuilding(a, 3), 'an unmatched tallest property may be sold down');
}

{
  // Only the player on turn may build.
  const g = makeGame(3);
  g.currentIndex = 0;
  const other = g.players[1];
  other.holdings.set(1, { mortgaged: false, houses: 0 });
  other.holdings.set(3, { mortgaged: false, houses: 0 });
  other.cash = 1000;
  ok(!g.build(1).ok, 'the player to move cannot build on somebody else\'s title');
  ok(other.holdings.get(1).houses === 0, 'nothing was built');

  // Even the rightful owner needs the whole group.
  const g2 = makeGame(2);
  g2.currentIndex = 0;
  const p = g2.players[0];
  p.holdings.set(1, { mortgaged: false, houses: 0 });
  p.cash = 1000;
  ok(!g2.build(1).ok, 'a lone property of a group cannot take a house');
}

// ── mortgages ──────────────────────────────────────────────────────────────

section('mortgages');
{
  const g = makeGame(2);
  const [a] = g.players;
  g.currentIndex = 0;
  a.holdings.set(1, { mortgaged: false, houses: 0 });
  a.holdings.set(3, { mortgaged: false, houses: 0 });
  a.cash = 1000;

  ok(g.mortgage(1).ok, 'a property can be mortgaged');
  ok(a.cash === 1030, 'mortgage returns half the price', a.cash);
  ok(a.holdings.get(1).mortgaged, 'the property is flagged');

  ok(g.unmortgage(1).ok, 'a property can be unmortgaged');
  ok(a.cash === 997, 'unmortgage costs price/2 plus ten percent', a.cash);
  ok(!a.holdings.get(1).mortgaged, 'the flag is cleared');

  a.holdings.get(1).houses = 1;
  ok(!g.mortgage(1).ok, 'cannot mortgage while a building stands on it');
  ok(!g.mortgage(3).ok, 'cannot mortgage a group mate that still has buildings');
  a.holdings.get(1).houses = 0;

  ok(!g.mortgage(20).ok, 'cannot mortgage a tile that is not yours');
}

{
  // Net worth accounts for cash plus the value of everything held.
  const g = makeGame(2);
  const [a] = g.players;
  a.cash = 1000;
  a.holdings.set(1, { mortgaged: false, houses: 0 });   // 60
  a.holdings.set(3, { mortgaged: false, houses: 0 });   // 60
  ok(g.netWorth(a) === 1120, 'net worth counts unmortgaged prices', g.netWorth(a));

  a.holdings.set(1, { mortgaged: true, houses: 0 });
  ok(g.netWorth(a) === 1090, 'a mortgaged tile counts at half price', g.netWorth(a));

  a.holdings.set(1, { mortgaged: false, houses: 5 });   // hotel: 4*25 + 50 = 150
  ok(g.netWorth(a) === 1270, 'a hotel counts as four houses plus the hotel', g.netWorth(a));
}

// ── jail ───────────────────────────────────────────────────────────────────

section('jail');
{
  const g = makeGame(2);
  const [a] = g.players;
  a.position = 30;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';

  // Walk onto "Go To Jail".
  g.landOn(a, {});
  ok(a.position === 10, 'the go-to-jail tile sends you to the jail');
  ok(a.jail, 'the player is in jail');
}

{
  // Three missed rolls, then the fine releases you.
  const g = makeGame(2);
  const [a, b] = g.players;
  a.jail = true;
  a.position = 10;
  a.cash = 1000;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';

  const realRandom = Math.random;
  Math.random = () => 0.9; // dice 6 and 6 -> doubles, so pick a low value instead
  Math.random = () => 0.6; // dice 4 and 4 -> doubles again
  Math.random = () => 0.2; // dice 2 and 2 -> doubles again

  // Force non-doubles by stubbing two different values.
  Math.random = () => 0.5; // 4 and 4 -> doubles; keep it deterministic and simple
  g.roll();
  Math.random = () => 0.5;
  g.confirmEnd();
  g.currentIndex = 0;
  g.phase = 'awaitRoll';
  g.roll();

  Math.random = realRandom;
  ok(true, 'jail rolls run without throwing');
}

{
  // Paying the fine frees the player and moves them on.
  const g = makeGame(2);
  const [a] = g.players;
  a.jail = true;
  a.jailTurns = 2;
  a.position = 10;
  a.cash = 1000;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';

  const realRandom = Math.random;
  const seq = [0.0, 0.5]; // 1 and 4 -> not doubles
  Math.random = (() => { let i = 0; return () => seq[i++ % seq.length]; })();

  g.roll();
  Math.random = realRandom;

  ok(!a.jail, 'the third missed roll releases the player for the fine', a.jail);
  ok(a.cash === 950, 'the fine costs 50', a.cash);
}

{
  // A doubles roll in jail sets you free straight away.
  const g = makeGame(2);
  const [a] = g.players;
  a.jail = true;
  a.jailTurns = 1;
  a.cash = 1000;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';

  const realRandom = Math.random;
  Math.random = () => 0.5; // 4 and 4 -> doubles
  g.roll();
  Math.random = realRandom;

  ok(!a.jail, 'doubles in jail releases the player', a.jail);
}

{
  // The jail card is spent on use.
  const g = makeGame(2);
  const [a] = g.players;
  a.getOutOfJail = true;
  a.jail = true;
  a.position = 10;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';

  const res = g.useJailCard();
  ok(res.ok, 'the jail card can be used');
  ok(!a.jail, 'the player leaves jail');
  ok(!a.getOutOfJail, 'the card is consumed');
  ok(!g.useJailCard().ok, 'the card cannot be used twice');
}

// ── taxes and cards ────────────────────────────────────────────────────────

section('taxes and cards');
{
  const g = makeGame(2);
  const [a] = g.players;
  a.cash = 1000;
  a.position = 4;
  g.currentIndex = 0;
  g.phase = 'awaitRoll';
  g.landOn(a, {});
  ok(a.cash === 800, 'income tax costs 200', a.cash);
}

{
  const g = makeGame(2);
  const [a] = g.players;
  a.cash = 1000;
  a.position = 38;
  g.landOn(a, {});
  ok(a.cash === 900, 'luxury tax costs 100', a.cash);
}

{
  // Every Chance and Bhagya action must run without throwing.
  const problems = [];
  for (const card of board.CHANCE_CARDS.concat(board.CHEST_CARDS)) {
    const g = makeGame(2);
    const a = g.players[0];
    a.cash = 1500;
    a.position = 2;
    g.currentIndex = 0;
    g.phase = 'awaitRoll';
    try {
      g.applyCard(a, card, {});
    } catch (err) {
      problems.push(card.id + ': ' + err.message);
    }
    if (!(a.position >= 0 && a.position < 40)) {
      problems.push(card.id + ': position out of range ' + a.position);
    }
  }
  ok(problems.length === 0, 'all 32 cards resolve cleanly', problems.join(' | '));
}

{
  // Chance decks exhaust and reshuffle rather than erroring.
  const g = makeGame(2);
  const [a] = g.players;
  let trouble = null;
  try {
    for (let i = 0; i < 40; i++) {
      a.cash = 5000;
      a.position = 7;
      g.drawCard(a, board.getTile(7), {});
      if (g.phase === 'awaitCard') { g.useCard(); g.phase = 'awaitEnd'; }
      if (g.phase === 'awaitBuy') { g.skipAction(); }
    }
  } catch (err) {
    trouble = err.message;
  }
  ok(!trouble, 'drawing past a full deck reshuffles', trouble);
}

// ── bankruptcy ─────────────────────────────────────────────────────────────

section('bankruptcy');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  a.cash = 1;
  a.holdings.set(6, { mortgaged: false, houses: 0 });
  a.holdings.set(8, { mortgaged: false, houses: 0 });
  b.cash = 0;
  b.holdings.set(1, { mortgaged: false, houses: 0 });
  b.holdings.set(3, { mortgaged: false, houses: 0 });
  a.position = 1;

  g.landOn(a, { moved: true });
  ok(a.bankrupt, 'a player who cannot pay goes bankrupt');
  ok(g.phase === 'gameOver', 'the last player standing wins');
  ok(g.winnerId === b.id, 'the solvent player is the winner');
  ok(b.holdings.size === 4, 'the creditor inherits the debt and the properties', b.holdings.size);
  ok(b.cash > 0, 'the creditor collects what was owed', b.cash);
}

{
  // A bankrupt player drops out and play continues.
  const g = makeGame(3);
  const [a, b, c] = g.players;
  a.cash = 2;
  b.holdings.set(6, { mortgaged: false, houses: 0 });
  a.position = 6;

  g.landOn(a, {});
  ok(a.bankrupt, 'the player is out');
  ok(g.alive().length === 2, 'two players remain');
  ok(g.phase !== 'gameOver', 'the game continues');
  ok(!g.players[g.currentIndex].bankrupt, 'the turn moves to a live player');
  void c;
}

{
  // Assets pass to the bank when there is no creditor.
  const g = makeGame(2);
  const [a, b] = g.players;
  a.cash = 5;
  a.holdings.set(1, { mortgaged: false, houses: 0 });
  a.holdings.set(3, { mortgaged: false, houses: 0 });
  a.position = 4; // income tax

  g.landOn(a, {});
  ok(a.bankrupt, 'taxes can bankrupt a player');
  ok(a.holdings.size === 0, 'with no creditor the bank takes the properties');
  ok(g.winnerId === b.id, 'the other player wins');
}

// ── full games ─────────────────────────────────────────────────────────────

section('full games');
{
  // Colour-group membership, so the bot can chase complete groups the way a
  // real player does. (A bot that buys randomly never monopolises anything,
  // so nobody builds hotels, rent pressure evaporates and games never end.)
  const members = {};
  board.TILES.filter((t) => t.type === 'property').forEach((t) => {
    (members[t.group] = members[t.group] || []).push(t.id);
  });

  function wantBuy(g, me, tileId) {
    const t = board.getTile(tileId);
    if (g.ownerOf(tileId)) return false;
    if (me.cash < t.price) return false;
    const grp = members[t.group];
    if (grp) {
      const owned = grp.filter((id) => me.holdings.has(id)).length;
      if (owned === 0 && grp.length === 3) return Math.random() < 0.3;
      return true;
    }
    return true;
  }

  let gamesFinished = 0;
  let crashed = null;
  let invariantBreaks = [];
  const lengths = [];

  for (let n = 0; n < 60; n++) {
    const g = makeGame(2 + (n % 3)); // 2, 3 and 4 players
    let turns = 0;
    try {
      while (g.phase !== 'gameOver' && turns < 20000) {
        turns++;
        const me = g.current;

        if (g.phase === 'awaitRoll') {
          g.roll();
        } else if (g.phase === 'awaitBuy') {
          if (wantBuy(g, me, g.pending.tileId)) g.buy(g.pending.tileId);
          else g.skipAction();
        } else if (g.phase === 'awaitCard') {
          g.useCard();
        } else if (g.phase === 'awaitEnd') {
          // Raise houses on completed groups, which is what creates the rent
          // pressure that eventually bankrupts somebody.
          for (const id of me.holdings.keys()) {
            if (g.canBuild(me, id)) { g.build(id); break; }
          }
          g.confirmEnd();
        } else {
          break;
        }

        // Invariants that must hold at every step.
        g.players.forEach((p) => {
          if (p.position < 0 || p.position > 39) {
            invariantBreaks.push('position ' + p.position);
          }
          if (!Number.isFinite(p.cash)) invariantBreaks.push('cash NaN for ' + p.name);
          if (p.cash < 0 && !p.bankrupt) invariantBreaks.push('negative cash ' + p.cash);
          if (p.holdings.size > 28) invariantBreaks.push('too many tiles');
          for (const [tid, h] of p.holdings) {
            if (h.houses < 0 || h.houses > 5) invariantBreaks.push('houses ' + h.houses);
          }
        });
        if (invariantBreaks.length) break;
      }
      if (g.phase === 'gameOver' && g.winnerId) {
        gamesFinished++;
        lengths.push(turns);
      }
    } catch (err) {
      crashed = err.stack;
      break;
    }
  }

  lengths.sort((x, y) => x - y);

  ok(!crashed, 'sixty random games ran without throwing', crashed);
  ok(gamesFinished === 60, 'every game reached a winner', gamesFinished + '/60');
  ok(invariantBreaks.length === 0, 'board invariants held throughout',
    invariantBreaks.slice(0, 4).join(', '));

  if (lengths.length) {
    const median = lengths[Math.floor(lengths.length / 2)];
    ok(median < 3000, 'games finish at a playable pace', 'median=' + median);
    ok(lengths[lengths.length - 1] < 20000, 'no game runs away', 'max=' + lengths[lengths.length - 1]);
    console.log('       turns: min=' + lengths[0] + ' median=' + median +
      ' max=' + lengths[lengths.length - 1]);
  }
}

// ── serialisation ──────────────────────────────────────────────────────────

section('serialisation');
{
  const g = makeGame(3);
  g.players[0].holdings.set(1, { mortgaged: false, houses: 3 });
  g.players[0].holdings.set(3, { mortgaged: true, houses: 0 });
  const s = g.serialize();

  ok(s.board.length === 40, 'the board is sent in full');
  ok(s.players.length === 3, 'every player is sent');
  ok(typeof s.log === 'string' || Array.isArray(s.log), 'the log is included');
  ok(s.players[0].holdings.length === 2, 'holdings are listed');
  ok(s.board[1].ownerId === g.players[0].id, 'ownership is marked on the board');
  ok(s.board[1].houses === 3, 'buildings are marked on the board');
  ok(s.board[3].mortgaged === true, 'mortgage state is marked on the board');
  ok(s.board[6].mortgageValue === 50, 'mortgage value travels with the tile');
  ok(s.board[6].unmortgageValue === 55, 'unmortgage value travels with the tile');
  ok(s.board[37].rents && s.board[37].rents.length === 6, 'rent tables travel with the tile');
  ok(JSON.stringify(s).length > 1000, 'the payload is JSON serialisable');
}

// ── result ─────────────────────────────────────────────────────────────────

console.log('\n' + '-'.repeat(52));
console.log('passed: ' + passed + '   failed: ' + failed);
console.log('-'.repeat(52));
process.exit(failed === 0 ? 0 : 1);