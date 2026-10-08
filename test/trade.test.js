'use strict';

/* Trading: proposals, rejections, atomic acceptance, and conservation. */

const { Game } = require('../server/game');
const board = require('../server/board');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

function makeGame(n) {
  const g = new Game('TRDE');
  for (let i = 0; i < n; i++) g.addPlayer('P' + (i + 1), 'sock' + i);
  g.start();
  return g;
}

// Give a player a small, realistic spread of titles.
function seed(g, player, tiles) {
  tiles.forEach((id) => player.holdings.set(id, { mortgaged: false, houses: 0 }));
}

// ── a plain swap ────────────────────────────────────────────────────────────

section('a straightforward swap');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1, 3]);
  seed(g, b, [6]);
  a.cash = 500;
  b.cash = 500;

  const res = g.proposeTrade(a.id, b.id, { cash: 0, tiles: [1] }, { cash: 0, tiles: [6] });
  ok(res.ok, 'a proposal is accepted', JSON.stringify(res));
  ok(g.trades.length === 1, 'the trade is recorded');

  const id = res.trade.id;
  const acc = g.acceptTrade(id, b.id);
  ok(acc.ok, 'the recipient can accept', JSON.stringify(acc));

  ok(a.holdings.has(6) && !a.holdings.has(1), 'the giver received what was asked for');
  ok(b.holdings.has(1) && !b.holdings.has(6), 'the titles moved across');
  // A gave one and got one; B gave one and got one. Total is unchanged.
  ok(a.holdings.size === 2 && b.holdings.size === 1, 'the total number of titles is unchanged',
    a.holdings.size + '/' + b.holdings.size);
}

section('trading cash');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);
  a.cash = 500;
  b.cash = 200;

  const res = g.proposeTrade(a.id, b.id, { cash: 100, tiles: [1] }, { cash: 0, tiles: [] });
  ok(!res.ok, 'an offer with nothing wanted is refused', JSON.stringify(res));

  const good = g.proposeTrade(a.id, b.id, { cash: 100, tiles: [1] }, { cash: 50, tiles: [6] });
  ok(good.ok, 'a cash-for-title trade is accepted', JSON.stringify(good));
  ok(g.acceptTrade(good.trade.id, b.id).ok, 'it can be accepted');

  ok(a.cash === 450, 'the payer is out 100', a.cash);
  ok(b.cash === 250, 'the payee is up 100', b.cash);
  ok(a.holdings.has(6), 'the title arrived');
  ok(b.holdings.has(1), 'the title left');
}

// ── rejections ──────────────────────────────────────────────────────────────

section('invalid proposals are refused');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1, 3]);
  seed(g, b, [6]);
  a.cash = 500;
  b.cash = 500;

  const cases = [
    ['trading with yourself', () => g.proposeTrade(a.id, a.id, { tiles: [1] }, { tiles: [6] })],
    ['an unknown player', () => g.proposeTrade(a.id, 'nope', { tiles: [1] }, { tiles: [6] })],
    ['offering a title you do not own', () => g.proposeTrade(a.id, b.id, { tiles: [16] }, { tiles: [6] })],
    ['asking for a title they do not own', () => g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [16] })],
    ['offering a non-purchasable tile', () => g.proposeTrade(a.id, b.id, { tiles: [0] }, { tiles: [6] })],
    ['offering a negative amount', () => g.proposeTrade(a.id, b.id, { cash: -50, tiles: [1] }, { tiles: [6] })],
    ['offering more cash than you have', () => g.proposeTrade(a.id, b.id, { cash: 99999, tiles: [1] }, { tiles: [6] })],
    ['asking for more cash than they have', () => g.proposeTrade(a.id, b.id, { tiles: [1] }, { cash: 99999, tiles: [6] })],
    ['an entirely empty offer', () => g.proposeTrade(a.id, b.id, {}, {})],
    ['a duplicate title in one side', () => g.proposeTrade(a.id, b.id, { tiles: [1, 1] }, { tiles: [6] })],
    ['a duplicate of theirs', () => g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6, 6] })]
  ];

  cases.forEach((pair) => {
    const res = pair[1]();
    ok(!res.ok, pair[0] + ' is refused', res && res.msg);
  });

  ok(g.trades.length === 0, 'no invalid proposal was recorded', g.trades.length);
}

section('titles with buildings cannot be traded');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  a.holdings.set(1, { mortgaged: false, houses: 3 });
  a.holdings.set(3, { mortgaged: false, houses: 0 });
  seed(g, b, [6]);
  a.cash = 500;
  b.cash = 500;

  const built = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  ok(!built.ok, 'a developed title cannot be offered', built && built.msg);

  const mate = g.proposeTrade(a.id, b.id, { tiles: [3] }, { tiles: [6] });
  ok(mate.ok, 'the undeveloped mate of the same group still can', JSON.stringify(mate));
}

section('a mortgaged title keeps its status through a trade');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  a.holdings.set(1, { mortgaged: true, houses: 0 });
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  ok(res.ok, 'a mortgaged title can be traded', JSON.stringify(res));
  g.acceptTrade(res.trade.id, b.id);
  ok(b.holdings.get(1).mortgaged === true, 'it arrives still mortgaged');
}

section('only the recipient may accept');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  const wrong = g.acceptTrade(res.trade.id, a.id);
  ok(!wrong.ok, 'the proposer cannot accept their own offer', wrong && wrong.msg);

  const stranger = makeGame(3);
  const other = stranger.acceptTrade('t1', stranger.players[2].id);
  ok(!other.ok, 'an unknown trade id is refused');
}

section('dealing with withdrawn players');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  b.bankrupt = true;
  ok(!g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] }).ok,
    'a bankrupt player cannot be traded with');

  const g2 = makeGame(2);
  const [a2, b2] = g2.players;
  seed(g2, a2, [1]);
  seed(g2, b2, [6]);
  b2.connected = false;
  ok(!g2.proposeTrade(a2.id, b2.id, { tiles: [1] }, { tiles: [6] }).ok,
    'a disconnected player cannot be traded with');

  const g3 = makeGame(2);
  const [a3, b3] = g3.players;
  seed(g3, a3, [1]);
  seed(g3, b3, [6]);
  b3.isBot = true;
  ok(!g3.proposeTrade(a3.id, b3.id, { tiles: [1] }, { tiles: [6] }).ok,
    'a bot cannot be traded with');
}

section('one open offer per pair');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1, 3]);
  seed(g, b, [6]);

  ok(g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] }).ok, 'the first proposal goes through');
  ok(!g.proposeTrade(a.id, b.id, { tiles: [3] }, { tiles: [6] }).ok,
    'a second proposal to the same player is refused while one is open');

  g.trades[0].status = 'declined';
  ok(g.proposeTrade(a.id, b.id, { tiles: [3] }, { tiles: [6] }).ok,
    'a new proposal is allowed once the first is resolved');
}

section('declining and expiry');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  const dec = g.declineTrade(res.trade.id, a.id);
  ok(dec.ok, 'the proposer can call it off', JSON.stringify(dec));
  ok(!g.acceptTrade(res.trade.id, b.id).ok, 'a declined trade cannot be accepted');
  ok(a.holdings.has(1) && b.holdings.has(6), 'nothing moved');

  const g2 = makeGame(2);
  const [a2, b2] = g2.players;
  seed(g2, a2, [1]);
  seed(g2, b2, [6]);
  const res2 = g2.proposeTrade(a2.id, b2.id, { tiles: [1] }, { tiles: [6] });
  res2.trade.expiresAt = Date.now() - 1;      // pretend the clock ran out
  ok(!g2.acceptTrade(res2.trade.id, b2.id).ok, 'an expired trade cannot be accepted');

  const g3 = makeGame(2);
  const [a3, b3] = g3.players;
  seed(g3, a3, [1]);
  seed(g3, b3, [6]);
  const res3 = g3.proposeTrade(a3.id, b3.id, { tiles: [1] }, { tiles: [6] });
  res3.trade.expiresAt = Date.now() - 1;
  const changed = g3.expireTrades();
  ok(changed, 'the sweeper notices expired offers');
  ok(g3.trades.filter(function (t) { return t.status === 'pending'; }).length === 0,
    'the expired offer is no longer pending');
}

// ── the state can change between offer and acceptance ───────────────────────

section('the world moves between offer and acceptance');
{
  // The offered title gets sold before the recipient replies.
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  a.holdings.delete(1);                      // no longer theirs

  const acc = g.acceptTrade(res.trade.id, b.id);
  ok(!acc.ok, 'acceptance fails once the offered title is gone', acc && acc.msg);
  ok(b.holdings.has(6), 'no title was taken on a failed trade');
  ok(!b.holdings.has(1), 'nothing was transferred');
}

{
  // The wanted title gets built on before the reply.
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  b.holdings.set(6, { mortgaged: false, houses: 2 });   // now developed

  const acc = g.acceptTrade(res.trade.id, b.id);
  ok(!acc.ok, 'a developed title cannot be accepted in', acc && acc.msg);
  ok(a.holdings.has(1), 'the offerer kept their title');
}

{
  // The offerer runs short of cash.
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);
  a.cash = 100;
  b.cash = 500;

  const res = g.proposeTrade(a.id, b.id, { cash: 100, tiles: [1] }, { tiles: [6] });
  a.cash = 0;

  const acc = g.acceptTrade(res.trade.id, b.id);
  ok(!acc.ok, 'a trade fails if the cash is no longer there', acc && acc.msg);
  ok(b.cash === 500, 'no cash moved', b.cash);
  ok(a.holdings.has(1), 'no title moved');
}

{
  // The offerer is bought out mid-negotiation.
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  g.bankrupt(a, b);

  const acc = g.acceptTrade(res.trade.id, b.id);
  ok(!acc.ok, 'a trade with a bankrupt player fails', acc && acc.msg);
}

{
  // Leaving mid-negotiation cancels the offer.
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);

  const res = g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  g.surrender(a);
  ok(g.trades[0].status === 'cancelled', 'the open offer is cancelled');
  ok(!g.acceptTrade(res.trade.id, b.id).ok, 'it cannot be accepted afterwards');
}

// ── trades never hold up the turn ───────────────────────────────────────────

section('trading does not consume a turn');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);
  g.currentIndex = 0;
  g.phase = 'awaitRoll';

  const phaseBefore = g.phase;
  const turnBefore = g.currentIndex;
  g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });
  ok(g.phase === phaseBefore, 'the phase is untouched by proposing', g.phase);
  ok(g.currentIndex === turnBefore, 'the turn pointer is untouched');

  g.acceptTrade(g.trades[0].id, b.id);
  ok(g.phase === phaseBefore, 'the phase is untouched by accepting', g.phase);
  ok(g.currentIndex === turnBefore, 'the turn pointer still points at the same player');
}

section('trading is refused before the game starts');
{
  const g = new Game('TRDE');
  g.addPlayer('A', 's1');
  g.addPlayer('B', 's2');
  g.players[0].holdings.set(1, { mortgaged: false, houses: 0 });
  g.players[1].holdings.set(6, { mortgaged: false, houses: 0 });

  const res = g.proposeTrade(g.players[0].id, g.players[1].id, { tiles: [1] }, { tiles: [6] });
  ok(!res.ok, 'no trading in the lobby', res && res.msg);
}

// ── the client's view ───────────────────────────────────────────────────────

section('trade views are directed');
{
  const g = makeGame(2);
  const [a, b] = g.players;
  seed(g, a, [1]);
  seed(g, b, [6]);
  g.proposeTrade(a.id, b.id, { tiles: [1] }, { tiles: [6] });

  const forA = g.tradeViewFor(a.id);
  const forB = g.tradeViewFor(b.id);
  ok(forA.length === 1 && forA[0].direction === 'outgoing', 'the proposer sees an outgoing offer',
    JSON.stringify(forA));
  ok(forB.length === 1 && forB[0].direction === 'incoming', 'the recipient sees an incoming offer',
    JSON.stringify(forB));
  ok(typeof forB[0].expiresIn === 'number' && forB[0].expiresIn > 0, 'the countdown is included');

  g.declineTrade(g.trades[0].id, a.id);
  ok(g.tradeViewFor(b.id).length === 0, 'a resolved trade disappears from both views');
}

// ── conservation under fuzz ─────────────────────────────────────────────────

section('cash and titles are conserved under fuzz');
{
  let problems = [];
  let tradesDone = 0;

  for (let n = 0; n < 120; n++) {
    const g = makeGame(2 + (n % 3));
    const players = g.players;

    // Every board tile must be owned by exactly one player, or none.
    const ownerOfTile = (id) => {
      const owners = players.filter(function (p) { return p.holdings.has(id); });
      return owners.length > 1 ? owners.map(function (p) { return p.name; }).join('+') : null;
    };

    let turns = 0;
    try {
      while (g.phase !== 'gameOver' && turns < 600) {
        turns++;
        const me = g.current;

        if (g.phase === 'awaitRoll') {
          g.roll();
        } else if (g.phase === 'awaitBuy') {
          const t = board.getTile(g.pending.tileId);
          if (me.cash >= t.price) g.buy(g.pending.tileId);
          else g.skipAction();
        } else if (g.phase === 'awaitCard') {
          g.useCard();
        } else if (g.phase === 'awaitEnd') {
          // Interleave random trades with the normal turn.
          const partners = players.filter(function (p) {
            return p.id !== me.id && !p.bankrupt && !p.isBot;
          });
          if (partners.length && Math.random() < 0.6) {
            const other = partners[Math.floor(Math.random() * partners.length)];
            const mine = [...me.holdings.keys()].filter(function (id) {
              return me.holdings.get(id).houses === 0;
            });
            const theirs = [...other.holdings.keys()].filter(function (id) {
              return other.holdings.get(id).houses === 0;
            });
            if (mine.length && theirs.length) {
              const offer = { cash: Math.floor(me.cash * 0.25), tiles: [mine[0]] };
              const want = { cash: Math.floor(other.cash * 0.25), tiles: [theirs[0]] };
              const before = {
                mine: me.holdings.size,
                theirs: other.holdings.size,
                myCash: me.cash,
                theirCash: other.cash
              };

              const res = g.proposeTrade(me.id, other.id, offer, want);
              if (res.ok) {
                // Half the time the other player walks away.
                const accepted = Math.random() < 0.6;
                const outcome = accepted
                  ? g.acceptTrade(res.trade.id, other.id)
                  : g.declineTrade(res.trade.id, other.id);
                tradesDone++;

                if (accepted && outcome.ok) {
                  // Cash is conserved, and the total title count is unchanged.
                  const cashAfter = me.cash + other.cash;
                  const cashBefore = before.myCash + before.theirCash;
                  if (cashAfter !== cashBefore) {
                    problems.push('cash ' + cashBefore + ' -> ' + cashAfter);
                  }
                  const tilesAfter = me.holdings.size + other.holdings.size;
                  const tilesBefore = before.mine + before.theirs;
                  if (tilesAfter !== tilesBefore) {
                    problems.push('titles ' + tilesBefore + ' -> ' + tilesAfter);
                  }
                  if (!me.holdings.has(theirs[0]) || !other.holdings.has(mine[0])) {
                    problems.push('titles did not swap');
                  }
                }
                g.expireTrades();
              }
            }
          }
          g.confirmEnd();
        } else {
          break;
        }

        // No title may ever be held by two people at once.
        for (let id = 0; id < 40; id++) {
          const dup = ownerOfTile(id);
          if (dup) problems.push('tile ' + id + ' held by ' + dup);
        }
        players.forEach(function (p) {
          if (!Number.isFinite(p.cash)) problems.push('NaN cash for ' + p.name);
          if (p.cash < 0 && !p.bankrupt) problems.push('negative cash ' + p.cash);
        });
        if (problems.length) break;
      }
    } catch (err) {
      problems.push('threw: ' + err.message);
      break;
    }
  }

  ok(tradesDone > 50, 'the fuzz actually traded', String(tradesDone));
  ok(problems.length === 0,
    'no title was ever duplicated and no cash appeared or vanished',
    problems.slice(0, 4).join(' | '));
}

console.log('\n' + '-'.repeat(52));
console.log('passed: ' + passed + '   failed: ' + failed);
console.log('-'.repeat(52));
process.exit(failed === 0 ? 0 : 1);