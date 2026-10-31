'use strict';

const { randomInt } = require('node:crypto');
const { explodeGarbage } = require('./game');
const random = () => randomInt(0x1000000) / 0x1000000;

function alive(room) {
  return [...room.players.values()].filter(player => player.game?.alive).sort((a, b) => a.order - b.order);
}
function next(room, order) {
  const players = alive(room);
  return players.find(player => player.order > order) || players[0];
}
function create(room, player, now, rng) {
  room.bomb = { holderId: player.id, holderOrder: player.order, cleared: 0,
    bornAt: now, explodesAt: now + 10000 + Math.floor(rng() * 8001),
    nextBlinkAt: now + 1400, litUntil: 0, lit: false };
  room.dirty = true;
}
function advance(room, now, rng = random) {
  if (!room.settings.hotPotato || room.status !== 'playing') return null;
  const players = alive(room);
  if (players.length < 2) { if (room.bomb) room.dirty = true; room.bomb = null; return null; }
  if (!room.bomb) create(room, players[Math.floor(rng() * players.length)], now, rng);
  const bomb = room.bomb;
  let holder = room.players.get(bomb.holderId);
  if (!holder?.game?.alive) {
    holder = next(room, bomb.holderOrder);
    bomb.holderId = holder.id;
    bomb.holderOrder = holder.order;
    bomb.cleared = 0;
    room.dirty = true;
  }
  if (now >= bomb.explodesAt) {
    explodeGarbage(holder.game, 1);
    const effect = { kind: 'bomb', at: now, targetId: holder.id, targetName: holder.name, lines: 1 };
    room.bomb = null;
    const survivors = alive(room);
    if (survivors.length >= 2) {
      const candidates = survivors.filter(player => player.id !== holder.id);
      create(room, candidates[Math.floor(rng() * candidates.length)], now, rng);
    }
    room.dirty = true;
    return effect;
  }
  if (bomb.lit && now >= bomb.litUntil) { bomb.lit = false; room.dirty = true; }
  if (now >= bomb.nextBlinkAt) {
    const progress = Math.min(1, Math.max(0, (now - bomb.bornAt) / (bomb.explodesAt - bomb.bornAt)));
    const interval = Math.round(1400 - progress * 1000);
    bomb.lit = true;
    bomb.litUntil = now + Math.round(interval * .4);
    bomb.nextBlinkAt = now + interval;
    room.dirty = true;
  }
  return null;
}
function credit(room, player, lines) {
  if (room.bomb?.holderId === player.id && lines > 0) room.bomb.cleared = Math.min(1, room.bomb.cleared + lines);
}
function pass(room, player, now) {
  const bomb = room.bomb;
  if (room.status !== 'playing' || !room.settings.hotPotato || !player.game?.alive ||
      !bomb || bomb.holderId !== player.id || now >= bomb.explodesAt || bomb.cleared < 1) return null;
  const target = next(room, player.order);
  if (!target || target.id === player.id) return null;
  bomb.holderId = target.id;
  bomb.holderOrder = target.order;
  bomb.cleared = 0;
  room.dirty = true;
  return target;
}
function snapshot(room) {
  if (room.status !== 'playing' || !room.bomb) return null;
  const { holderId, cleared, lit } = room.bomb;
  return { holderId, cleared, lit };
}
module.exports = { advance, credit, pass, snapshot };
