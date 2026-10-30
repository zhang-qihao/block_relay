'use strict';

const { createGame, enqueueGarbage, cancelGarbage } = require('./game');
const Rules = require('./public/rules');

function opponents(room, player) {
  if (!Rules.hostile(room.settings)) return [];
  return [...room.players.values()].filter(other => other.id !== player.id && other.game?.alive &&
    (room.settings.mode !== 'teams' || other.team !== player.team));
}
function height(game) {
  const top = game.board.findIndex(row => row.some(Boolean));
  return top < 0 ? 0 : 20 - top;
}
function choose(list, random) { return list[Math.min(list.length - 1, Math.floor(random() * list.length))]; }
function extreme(list, metric, maximum, random) {
  const value = (maximum ? Math.max : Math.min)(...list.map(metric));
  return choose(list.filter(player => metric(player) === value), random);
}
function nextOpponent(list, lastOrder) {
  return list.find(player => player.order > lastOrder) || list[0];
}
function routeAttack(room, player, amount, random = Math.random) {
  const targets = opponents(room, player);
  if (!amount || !targets.length || room.settings.mode === 'practice') return [];
  const mode = room.settings.attack;
  let target;
  if (mode === 'all') return targets.map(other => ({ player: other, lines: amount }));
  if (mode === 'split') {
    const allocation = new Map();
    for (let i = 0; i < amount; i++) {
      target = nextOpponent(targets, player.lastAttackOrder ?? -1);
      player.lastAttackOrder = target.order;
      allocation.set(target, (allocation.get(target) || 0) + 1);
    }
    return [...allocation].map(([other, lines]) => ({ player: other, lines }));
  }
  if (mode === 'manual') {
    target = targets.find(other => other.id === player.targetId);
    if (!target) { target = targets[0]; player.targetChangedAt = null; }
  }
  else if (mode === 'lowest') target = extreme(targets, other => other.game.lines, false, random);
  else if (mode === 'leader') target = extreme(targets, other => other.game.lines, true, random);
  else if (mode === 'emptiest') target = extreme(targets, other => height(other.game), false, random);
  else if (mode === 'highest') target = extreme(targets, other => height(other.game), true, random);
  else if (mode === 'round') {
    target = nextOpponent(targets, player.lastAttackOrder ?? -1);
    player.lastAttackOrder = target.order;
  } else if (mode === 'bounty') target = targets.find(other => other.id === room.bountyId) || choose(targets, random);
  else target = choose(targets, random);
  player.targetId = target.id;
  return [{ player: target, lines: amount }];
}
function startError(room) {
  const players = [...room.players.values()];
  const minimum = ['practice', 'dig', 'coop'].includes(room.settings.mode) ? 1 : 2;
  if (players.length < minimum) return `至少需要 ${minimum} 位玩家。`;
  if (players.some(player => !player.ready || !player.ws)) return '请等待所有玩家连接并准备。';
  if (room.settings.mode === 'teams') {
    const red = players.filter(player => player.team === 'red').length;
    if (!red || red * 2 !== players.length) return '红蓝两队人数必须相等，支持 1v1、2v2、3v3。';
  }
  return null;
}
function beginMatch(room, seed, now, countdownMs) {
  room.participants = [...room.players.values()];
  room.eliminationSequence = 0;
  room.outcome = null;
  room.status = 'countdown';
  room.startsAt = now + countdownMs;
  room.deadline = room.settings.mode === 'timed' ? room.startsAt + room.settings.duration * 1000 : null;
  room.nextEnvironmentAt = room.settings.mode === 'battle' ? room.startsAt + 30000 : null;
  room.bountyId = null;
  room.bountyOrder = -1;
  room.nextBountyAt = null;
  room.wave = 0;
  room.nextWaveAt = room.settings.mode === 'coop' ? room.startsAt + 20000 : null;
  room.coopEndsAt = null;
  for (const player of room.participants) {
    player.game = createGame(seed, room.settings);
    player.rank = null;
    player.eliminatedOrder = null;
    player.targetId = null;
    player.targetChangedAt = null;
    player.lastAttackOrder = -1;
  }
}
function recordEliminations(room) {
  const fallen = (room.participants || []).filter(player => !player.game.alive && player.eliminatedOrder == null);
  if (fallen.length) room.eliminationSequence++;
  for (const player of fallen) player.eliminatedOrder = room.eliminationSequence;
  for (const player of room.participants || []) {
    if (!player.game.alive) player.rank = 1 + room.participants.filter(other =>
      other.game.alive || other.eliminatedOrder > player.eliminatedOrder).length;
  }
  return fallen;
}
function rescue(room, player, amount) {
  const rescued = new Map();
  while (amount > 0) {
    const target = [...room.players.values()].filter(other => other.id !== player.id && other.game?.alive && other.game.pending > 0)
      .sort((a, b) => b.game.pending - a.game.pending || a.order - b.order)[0];
    if (!target) break;
    cancelGarbage(target.game, 1);
    player.game.helped++;
    rescued.set(target, (rescued.get(target) || 0) + 1);
    amount--;
  }
  return [...rescued].map(([target, lines]) => ({ targetId: target.id, name: target.name, lines }));
}
function scoreCompare(a, b) {
  return Number(b.game.alive) - Number(a.game.alive) || b.game.lines - a.game.lines || b.game.score - a.game.score;
}
function complete(room, reason, winners = [], winningTeam = null, byScore = false) {
  const players = room.participants.slice();
  const winnerIds = winners.map(player => player.id);
  const compare = byScore ? scoreCompare : (a, b) =>
    Number(winnerIds.includes(b.id)) - Number(winnerIds.includes(a.id)) ||
    Number(b.game.alive) - Number(a.game.alive) || (b.eliminatedOrder || 0) - (a.eliminatedOrder || 0);
  players.sort(compare);
  players.forEach((player, i) => {
    if (winningTeam) player.rank = winningTeam === 'coop' || player.team === winningTeam ? 1 : 2;
    else if (i && compare(players[i - 1], player) === 0) player.rank = players[i - 1].rank;
    else player.rank = i + 1;
  });
  const actualWinners = byScore ? players.filter(player => player.rank === 1) : winners;
  room.outcome = {
    reason, winnerIds: actualWinners.map(player => player.id), winningTeam,
    results: players.map(player => ({ id: player.id, name: player.name, team: player.team, rank: player.rank,
      lines: player.game.lines, score: player.game.score, dug: player.game.dug, cancelled: player.game.cancelled, purified: player.game.purified, helped: player.game.helped })),
  };
  room.status = 'finished';
  room.dirty = true;
}
function evaluateMatch(room, now) {
  if (room.status !== 'playing') return false;
  const alive = [...room.players.values()].filter(player => player.game.alive);
  const mode = room.settings.mode;
  if (mode === 'coop') {
    if (!alive.length) complete(room, '全员淘汰，守城失败');
    else if (room.coopEndsAt != null && now >= room.coopEndsAt) complete(room, '团队守城成功', room.participants, 'coop');
  } else if (mode === 'dig') {
    const finished = alive.filter(player => !player.game.board.some(row => row.includes('G')));
    if (finished.length) complete(room, '已挖净全部初始障碍', finished);
    else if (!alive.length) complete(room, '挑战结束，无人挖净障碍');
  } else if (mode === 'practice') {
    if (!alive.length) complete(room, '练习结束', [], null, true);
  } else if (mode === 'teams') {
    const teams = new Set(alive.map(player => player.team));
    if (teams.size <= 1) {
      const team = alive[0]?.team || null;
      complete(room, team ? `${team === 'red' ? '红' : '蓝'}队获胜` : '双方全部淘汰', room.participants.filter(player => player.team === team), team);
    }
  } else if (mode === 'timed' && now >= room.deadline) complete(room, '比赛时间到', [], null, true);
  else if (mode === 'sprint' && alive.some(player => player.game.lines >= room.settings.goal)) {
    complete(room, `完成 ${room.settings.goal} 行竞速`, alive.filter(player => player.game.lines >= room.settings.goal));
  } else if (alive.length <= 1) complete(room, alive.length ? '最后存活' : '全部淘汰', alive);
  return room.status === 'finished';
}
function rotateBounty(room, now) {
  const candidates = [...room.players.values()].filter(player => player.game?.alive);
  const target = nextOpponent(candidates, room.bountyOrder ?? -1);
  room.bountyId = target?.id || null;
  room.bountyOrder = target?.order ?? -1;
  room.nextBountyAt = now + 20000;
  room.dirty = true;
  return target;
}
function advanceMatch(room, now) {
  const notices = [];
  if (room.status === 'countdown' && now >= room.startsAt) {
    room.status = 'playing';
    room.dirty = true;
    notices.push('开始！用消行进攻，也可以抵消和净化障碍。');
  }
  if (room.status !== 'playing') return notices;
  if (room.settings.attack === 'bounty' && Rules.hostile(room.settings) &&
      (!room.players.get(room.bountyId)?.game.alive || now >= room.nextBountyAt)) {
    const target = rotateBounty(room, now);
    if (target) notices.push(`本轮悬赏目标：${target.name}，20 秒后轮换。`);
  }
  if (room.settings.mode === 'battle' && now >= room.nextEnvironmentAt) {
    const count = Math.floor((now - room.nextEnvironmentAt) / 30000) + 1;
    for (const player of room.players.values()) enqueueGarbage(player.game, count, now);
    room.nextEnvironmentAt += count * 30000;
    room.dirty = true;
    notices.push(`环境上涨：所有存活玩家收到 ${count} 行障碍。`);
  }
  if (room.settings.mode === 'coop' && room.nextWaveAt != null) {
    while (room.wave < room.settings.waves && now >= room.nextWaveAt) {
      room.dirty = true;
      room.wave++;
      const lines = Math.min(4, Math.ceil(room.wave / 2));
      for (const player of room.players.values()) enqueueGarbage(player.game, lines, now, { sourceName: `守城第 ${room.wave} 波` });
      notices.push(`第 ${room.wave}/${room.settings.waves} 波：每人 ${lines} 行，消行可以帮助队友。`);
      room.nextWaveAt += 20000;
      if (room.wave === room.settings.waves) { room.coopEndsAt = room.nextWaveAt; room.nextWaveAt = null; break; }
    }
  }
  return notices;
}

module.exports = { opponents, height, routeAttack, startError, beginMatch, recordEliminations, evaluateMatch, complete, advanceMatch, rotateBounty, rescue };
