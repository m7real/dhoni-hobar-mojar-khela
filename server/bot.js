'use strict';

/*
 * Bot opponents.
 *
 * The policy is the colour-group chasing strategy the engine tests settled on:
 * complete a group, then raise houses on it. Games where nobody builds
 * anything never produce a winner, because the START salary compounds until
 * rent can no longer bankrupt anybody — so building is what makes a game
 * actually resolve.
 */

const { getTile, groupMembers, groupOf } = require('./board');

function groupTilesOf(group) {
  return groupMembers(group);
}

const COLOR_GROUPS = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue'];

// How much cash to keep back rather than spend on houses.
const RESERVE = 120;

function ownedCountInGroup(game, player, group) {
  return groupTilesOf(group).filter(function (t) { return player.holdings.has(t.id); }).length;
}

function ownsFullGroup(game, player, group) {
  return groupTilesOf(group).every(function (t) { return player.holdings.has(t.id); });
}

// Should the bot buy this tile?
function wantsTile(game, player, tileId) {
  const tile = getTile(tileId);
  if (!tile) return false;
  if (game.ownerOf(tileId)) return false;
  if (player.cash < tile.price) return false;

  if (tile.type === 'rail' || tile.type === 'utility') {
    // Cheap and always useful, but not before the basics.
    return player.holdings.size >= 2 || tile.price <= player.cash / 3;
  }

  const group = groupOf(tileId);
  const groupSize = groupTilesOf(group).length;
  const owned = ownedCountInGroup(game, player, group);

  // Finishing a group is always worth it.
  if (owned === groupSize - 1) return true;
  // Half a group is promising.
  if (owned > 0) return true;
  // Opening a group: only when flush, and less often for three-tile groups.
  const flush = player.cash > tile.price * 4;
  if (!flush) return false;
  return groupSize === 2 ? Math.random() < 0.7 : Math.random() < 0.35;
}

// The single next thing the bot wants to do, or null.
function decide(game, player) {
  if (!player || player.bankrupt) return null;

  if (player.jail && player.getOutOfJail && player.cash > 200 && Math.random() < 0.6) {
    return { type: 'jailcard' };
  }

  if (game.phase === 'awaitBuy' && game.pending && game.pending.playerId === player.id) {
    return wantsTile(game, player, game.pending.tileId) ? { type: 'buy' } : { type: 'skip' };
  }

  if (game.phase === 'awaitCard' && game.pending && game.pending.playerId === player.id) {
    // Keep the jail card; it is worth more held than spent.
    return { type: 'useCard' };
  }

  if (game.phase === 'awaitEnd') {
    // Spend on houses first: that is what creates pressure.
    for (const id of player.holdings.keys()) {
      const tile = getTile(id);
      if (tile.type !== 'property' || !tile.houseCost) continue;
      if (!ownsFullGroup(game, player, groupOf(id))) continue;
      if (player.cash - tile.houseCost < RESERVE) continue;
      if (game.canBuild(player, id)) return { type: 'build', tileId: id };
    }

    // Then reopen a title worth having.
    for (const id of player.holdings.keys()) {
      const holding = player.holdings.get(id);
      if (holding.mortgaged) {
        const tile = getTile(id);
        const value = Math.ceil((Math.floor(tile.price / 2) * 11) / 10);
        if (player.cash - value > RESERVE) return { type: 'unmortgage', tileId: id };
      }
    }

    return { type: 'next' };
  }

  if (game.phase === 'awaitRoll') {
    return { type: 'roll' };
  }

  return null;
}

// Perform a decision through the same guarded engine methods the socket layer
// uses, so a bot cannot do anything a player could not.
function act(game, player, intent) {
  if (!intent) return { ok: false, msg: 'no decision' };
  switch (intent.type) {
    case 'roll': return game.actRoll(player.id);
    case 'buy': return game.actBuy(player.id, intent.tileId);
    case 'skip': return game.actSkip(player.id);
    case 'useCard': return game.actUseCard(player.id);
    case 'next': return game.actNext(player.id);
    case 'build': return game.actBuild(player.id, intent.tileId);
    case 'sell': return game.actSell(player.id, intent.tileId);
    case 'mortgage': return game.actMortgage(player.id, intent.tileId);
    case 'unmortgage': return game.actUnmortgage(player.id, intent.tileId);
    case 'jailcard': return game.actJailCard(player.id);
    default: return { ok: false, msg: 'unknown action ' + intent.type };
  }
}

const BOT_NAMES = ['বট রিয়া', 'বট তানভীর', 'বট সাফি', 'বট নুসরাত'];

function botName(index) {
  return BOT_NAMES[index % BOT_NAMES.length];
}

module.exports = { decide, act, wantsTile, botName, COLOR_GROUPS };