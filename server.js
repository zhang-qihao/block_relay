'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomInt } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { act, tickGame, snapshotGame, enqueueGarbage } = require('./game');
const Rules = require('./public/rules');
const Match = require('./match');
const Bomb = require('./bomb');
const Bot = require('./bot');
const { createLeaderboard } = require('./leaderboard');

const MAX_PLAYERS = 6;
const RECONNECT_MS = 30_000;
const ACTIONS = new Set(['left', 'right', 'down', 'rotate', 'rotateBack', 'drop', 'hold', 'cleanse']);
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/rules.js': ['rules.js', 'text/javascript; charset=utf-8'],
  '/effects.js': ['effects.js', 'text/javascript; charset=utf-8'],
  '/audio.js': ['audio.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.png': ['favicon.png', 'image/png'],
  '/mascot.png': ['mascot.png', 'image/png'],
  '/bomb.svg': ['bomb.svg', 'image/svg+xml'],
};

function lanAddresses(port) {
  return Object.values(os.networkInterfaces()).flat()
    .filter(item => item && item.family === 'IPv4' && !item.internal)
    .map(item => `http://${item.address}:${port}`);
}

function createApp({ countdownMs = 5000, leaderboard = createLeaderboard() } = {}) {
  const rooms = new Map();
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    if (pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ addresses: lanAddresses(server.address().port), maxPlayers: MAX_PLAYERS }));
      return;
    }
    const file = Object.hasOwn(FILES, pathname) ? FILES[pathname] : null;
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(path.join(__dirname, 'public', file[0]), (error, data) => {
      res.writeHead(error ? 500 : 200, { 'Content-Type': file[1] });
      res.end(error ? 'Unable to load page' : data);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    // A LAN webpage should not be remotely controlled by unrelated websites.
    try {
      if (req.url !== '/ws' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
        socket.destroy(); return;
      }
    } catch { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  function send(ws, data) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
  function sendLeaderboard(ws, force = false, snapshot = leaderboard.snapshot()) {
    if (ws.player) return;
    const signature = JSON.stringify(snapshot);
    if (!force && ws.leaderboardSignature === signature) return;
    ws.leaderboardSignature = signature;
    send(ws, { type: 'leaderboardList', ...snapshot });
  }
  function updateLeaderboard() {
    const snapshot = leaderboard.snapshot();
    for (const ws of wss.clients) sendLeaderboard(ws, false, snapshot);
  }
  function recordScore(player) {
    if (player.game && !player.bot) leaderboard.record(player.name, player.game.score, player.room.settings.mode);
  }
  function directory() {
    const priority = { lobby: 0, countdown: 1, playing: 2, finished: 3 };
    return [...rooms.values()].map(room => {
      const online = [...room.players.values()].filter(player => player.ws || player.bot).length;
      return { code: room.code, hostName: room.players.get(room.hostId)?.name || '房主',
        mode: room.settings.mode, presetId: room.presetId, players: room.players.size,
        online, maxPlayers: MAX_PLAYERS, status: room.status,
        joinable: room.status === 'lobby' && room.players.size < MAX_PLAYERS && online > 0 };
    }).sort((a, b) => priority[a.status] - priority[b.status] || a.code.localeCompare(b.code));
  }
  function sendDirectory(ws, list = directory(), force = false) {
    if (ws.player) return;
    const signature = JSON.stringify(list);
    if (!force && ws.directorySignature === signature) return;
    ws.directorySignature = signature;
    send(ws, { type: 'roomList', rooms: list });
  }
  function updateDirectory() {
    const list = directory();
    for (const ws of wss.clients) sendDirectory(ws, list);
  }
  function fail(ws, message) {
    send(ws, { type: 'error', message });
    if (!ws.player) sendDirectory(ws, directory(), true);
  }
  function event(room, text, kind = 'info') {
    room.events.push({ id: ++room.eventId, text, kind });
    room.events = room.events.slice(-8);
  }
  function broadcast(room) {
    if (['countdown', 'playing'].includes(room.status)) Match.refreshManualTargets(room);
    const now = Date.now();
    room.effects = room.effects.filter(effect => now - effect.at < 5000).slice(-48);
    room.interactions = room.interactions.filter(effect => now - effect.at < 2500).slice(-20);
    const message = {
      type: 'state', room: {
        code: room.code, hostId: room.hostId, status: room.status,
        startsAt: room.startsAt, events: room.events, serverNow: now,
        roundId: room.roundId, effects: room.effects, interactions: room.interactions, bomb: Bomb.snapshot(room),
        settings: room.settings, presetId: room.presetId, wave: room.wave, nextWaveAt: room.nextWaveAt, coopEndsAt: room.coopEndsAt,
        deadline: room.deadline, nextEnvironmentAt: room.nextEnvironmentAt,
        bountyId: room.bountyId, nextBountyAt: room.nextBountyAt, outcome: room.outcome,
        players: [...room.players.values()].map(player => ({
          id: player.id, name: player.name, connected: Boolean(player.ws || player.bot), bot: player.bot || null,
          ready: player.ready, targetId: player.targetId, rank: player.rank, team: player.team,
          targetChangedAt: player.targetChangedAt,
          game: player.game ? snapshotGame(player.game) : null,
        })),
      },
    };
    for (const player of room.players.values()) send(player.ws, message);
    room.dirty = false;
  }
  function finishIfNeeded(room, now = Date.now()) {
    if (room.status === 'playing') {
      const explosion = Bomb.advance(room, now);
      if (explosion) {
        room.effects.push({ ...explosion, id: ++room.effectId });
        event(room, `${explosion.targetName} 的炸弹爆炸，立即增加 1 行！`, 'hit');
        recordScore(room.players.get(explosion.targetId));
      }
      recordEliminations(room);
    }
    if (Match.evaluateMatch(room, now)) {
      for (const player of room.participants) recordScore(player);
      event(room, room.outcome.reason, 'win');
    }
  }
  function recordEliminations(room) {
    for (const player of Match.recordEliminations(room)) {
      event(room, `${player.name} 的棋盘已满，继续观战。`, 'out');
      room.dirty = true;
    }
  }
  function applyResult(room, player, result, now) {
    if (player.bot && result.locked && player.botState) {
      player.botState.actions = [];
      player.botState.pieceReadyAt = now + Bot.levels[player.bot].pieceDelay;
      player.botState.choice = randomInt(10000) / 10000;
    }
    Bomb.credit(room, player, result.cleared);
    if (result.locked || !player.game?.alive) recordScore(player);
    if (result.changed) room.dirty = true;
    if (result.cancelled) event(room, `${player.name} 抵消 ${result.cancelled} 行待接收障碍。`, 'defense');
    if (result.purified) event(room, `${player.name} 净化 ${result.purified} 行障碍。`, 'defense');
    if (room.settings.mode === 'coop' && result.attack) {
      const rescued = Match.rescue(room, player, result.attack);
      if (rescued.length) {
        room.effects.push({ id: ++room.effectId, kind: 'rescue', at: now, sourceId: player.id, sourceName: player.name, targets: rescued });
        event(room, `${player.name} 救援：${rescued.map(item => `${item.name} 抵消 ${item.lines} 行`).join('、')}`, 'defense');
      }
    }
    const allocation = result.attack ? Match.routeAttack(room, player, result.attack) : [];
    for (const item of allocation) {
      enqueueGarbage(item.player.game, item.lines, now, { sourceId: player.id, sourceName: player.name });
      player.game.sent += item.lines;
    }
    if (result.cleared) {
      room.effects.push({ id: ++room.effectId, kind: 'clear', at: now, sourceId: player.id, sourceName: player.name,
        rows: result.clearedRows, cancelled: result.cancelled || 0,
        targets: allocation.map(item => ({ targetId: item.player.id, lines: item.lines })) });
    }
    if (result.incoming) {
      room.effects.push({ id: ++room.effectId, kind: 'hit', at: now, targetId: player.id,
        lines: result.incoming, sources: result.hits });
      event(room, `${player.name} 实际受击 +${result.incoming} 行，来自${result.hits.map(hit => `${hit.sourceName} ${hit.lines} 行`).join('、')}`, 'hit');
    }
    if (allocation.length) event(room, `${player.name} 消 ${result.cleared} 行 → ${allocation.map(item => `${item.player.name} +${item.lines}`).join('、')}`, 'attack');
  }
  function invalidateReady(room) {
    for (const player of room.players.values()) player.ready = Boolean(player.bot);
  }
  function clearMatch(room) {
    room.bomb = null;
    room.status = 'lobby';
    room.startsAt = null;
    room.deadline = null;
    room.nextEnvironmentAt = null;
    room.bountyId = null;
    room.nextBountyAt = null;
    room.outcome = null;
    room.participants = [];
    room.effects = [];
    room.interactions = [];
    room.wave = 0;
    room.nextWaveAt = null;
    room.coopEndsAt = null;
    for (const player of room.players.values()) {
      player.game = null;
      player.ready = Boolean(player.bot) || player.id === room.hostId;
      player.botState = null;
      player.rank = null;
      player.targetId = null;
      player.targetChangedAt = null;
    }
  }
  function removePlayer(room, player) {
    recordScore(player);
    if (room.status === 'playing' || room.status === 'countdown') {
      if (player.game?.alive) player.game.alive = false;
      recordEliminations(room);
    }
    room.players.delete(player.id);
    sessions.delete(player.token);
    if (room.hostId === player.id) {
      const humans = [...room.players.values()].filter(other => !other.bot);
      room.hostId = humans.find(other => other.ws)?.id || humans[0]?.id;
    }
    if (![...room.players.values()].some(other => !other.bot)) { rooms.delete(room.code); updateDirectory(); return; }
    event(room, `${player.name} 离开了房间。`);
    if (room.status === 'countdown') clearMatch(room);
    finishIfNeeded(room);
    room.dirty = true;
    broadcast(room);
  }
  function nameOf(value) {
    return Rules.normalizeName(value) || '方块玩家';
  }

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.player = null;
    ws.windowStart = Date.now();
    ws.messageCount = 0;
    const helloTimeout = setTimeout(() => { if (!ws.player) ws.close(1008, 'Join timeout'); }, 60_000);
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { type: 'hello' });
    sendDirectory(ws, directory(), true);
    sendLeaderboard(ws, true);
    ws.on('message', raw => {
      const now = Date.now();
      let data;
      try { data = JSON.parse(raw.toString()); } catch { fail(ws, '消息格式错误。'); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.type !== 'spectatorTap') {
        if (now - ws.windowStart > 1000) { ws.windowStart = now; ws.messageCount = 0; }
        if (++ws.messageCount > 70) {
          if (data.type === 'chat') send(ws, { type: 'chatError', code: ws.player?.room.code, message: '发送太快，请稍后再试。' });
          return;
        }
      }
      if (data.type === 'leaderboard') {
        sendLeaderboard(ws, true);
        return;
      }
      if (data.type === 'rooms') {
        sendDirectory(ws, directory(), true);
        return;
      }
      if (data.type === 'resume') {
        if (ws.player) return;
        const session = sessions.get(data.token);
        if (!session || !rooms.has(session.room.code) || (session.player.disconnectedAt && now - session.player.disconnectedAt > RECONNECT_MS)) {
          send(ws, { type: 'resumeFailed' }); return;
        }
        const { room, player } = session;
        if (player.ws) { fail(ws, '这个玩家已在另一个连接中。'); send(ws, { type: 'resumeFailed' }); return; }
        player.ws = ws;
        player.disconnectedAt = null;
        ws.player = player;
        clearTimeout(helloTimeout);
        send(ws, { type: 'joined', id: player.id, token: player.token });
        event(room, `${player.name} 重新连接。`);
        broadcast(room);
        send(ws, { type: 'chatHistory', code: room.code, messages: room.chat });
        return;
      }
      if (data.type === 'create' || data.type === 'join') {
        if (ws.player) { fail(ws, '请先离开当前房间。'); return; }
        let room;
        if (data.type === 'create') {
          if (rooms.size >= 100) { fail(ws, '房间已满，请稍后再试。'); return; }
          let code;
          do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); } while (rooms.has(code));
          room = { code, hostId: null, status: 'lobby', players: new Map(), startsAt: null,
            events: [], eventId: 0, dirty: false, settings: { ...Rules.presets.friends.settings }, presetId: 'friends', wave: 0, nextWaveAt: null, coopEndsAt: null,
            participants: [], nextOrder: 0, deadline: null, nextEnvironmentAt: null,
            bountyId: null, nextBountyAt: null, outcome: null, roundId: 0, effects: [], effectId: 0, interactions: [], interactionId: 0, chat: [], chatId: 0 };
          rooms.set(code, room);
        } else {
          room = rooms.get(typeof data.code === 'string' ? data.code.trim().toUpperCase() : '');
          if (!room) { fail(ws, '没有找到这个房间，请检查房间码。'); return; }
          if (room.status !== 'lobby') { fail(ws, '该房间正在对战，请等待下一轮。'); return; }
          if (room.players.size >= MAX_PLAYERS) { fail(ws, '房间已满，最多 6 人。'); return; }
        }
        const player = {
          id: randomBytes(8).toString('hex'), token: randomBytes(24).toString('hex'),
          name: nameOf(data.name), ws, ready: data.type === 'create',
          targetId: null, game: null, rank: null, disconnectedAt: null, room,
          order: room.nextOrder++,
          team: [...room.players.values()].filter(other => other.team === 'red').length <=
            [...room.players.values()].filter(other => other.team === 'blue').length ? 'red' : 'blue',
        };
        ws.player = player;
        clearTimeout(helloTimeout);
        room.players.set(player.id, player);
        if (!room.hostId) room.hostId = player.id;
        sessions.set(player.token, { room, player });
        send(ws, { type: 'joined', id: player.id, token: player.token });
        event(room, `${player.name} 加入房间。`);
        broadcast(room);
        send(ws, { type: 'chatHistory', code: room.code, messages: room.chat });
        return;
      }
      const player = ws.player;
      if (!player || player.ws !== ws) {
        if (data.type === 'chat') send(ws, { type: 'chatError', message: '请先加入房间再聊天。' });
        return;
      }
      const room = player.room;
      if (data.type === 'chat') {
        const reject = message => send(ws, { type: 'chatError', code: room.code, message });
        if (typeof data.text !== 'string') { reject('请输入文字消息。'); return; }
        const text = data.text.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').trim();
        if (!text || Array.from(text).length > 200) { reject('消息需为 1–200 个字符。'); return; }
        if (player.lastChatAt != null && now - player.lastChatAt < 500) { reject('发送太快，请稍后再试。'); return; }
        player.lastChatAt = now;
        const message = { id: ++room.chatId, sourceId: player.id, name: player.name, text, at: now };
        room.chat.push(message);
        room.chat = room.chat.slice(-100);
        for (const member of room.players.values()) send(member.ws, { type: 'chatMessage', code: room.code, message });
        return;
      }
      // Resolve time-based endings before accepting any late input.
      finishIfNeeded(room, now);
      if (data.type === 'preset') {
        if (room.status !== 'lobby' || player.id !== room.hostId) { fail(ws, '只有房主能在大厅选择玩法。'); return; }
        if (typeof data.id !== 'string' || !Object.hasOwn(Rules.presets, data.id)) { fail(ws, '推荐玩法无效。'); return; }
        const settings = Rules.normalize({ ...Rules.presets[data.id].settings });
        if (JSON.stringify(settings) !== JSON.stringify(room.settings)) {
          room.settings = settings;
          invalidateReady(room);
          event(room, '房主更换玩法，请重新准备。');
        }
        room.presetId = data.id;
        broadcast(room);
      } else if (data.type === 'settings') {
        if (room.status !== 'lobby' || player.id !== room.hostId) { fail(ws, '只有房主能在大厅修改规则。'); return; }
        const settings = Rules.validate(room.settings, data.settings);
        if (!settings) { fail(ws, '规则设置无效。'); return; }
        if (JSON.stringify(settings) !== JSON.stringify(room.settings)) {
          room.settings = settings;
          if (Object.hasOwn(data.settings, 'mode') && Rules.presets[room.presetId]?.settings.mode !== settings.mode) room.presetId = 'custom';
          invalidateReady(room);
          event(room, '房主修改了规则，请所有玩家重新准备。');
        }
        broadcast(room);
      } else if (data.type === 'team') {
        if (room.status !== 'lobby' || room.settings.mode !== 'teams' || !['red', 'blue'].includes(data.team)) { fail(ws, '只能在团队大厅选择红队或蓝队。'); return; }
        if (player.team !== data.team) {
          player.team = data.team;
          invalidateReady(room);
          event(room, `${player.name} 加入${player.team === 'red' ? '红' : '蓝'}队，请重新准备。`);
        }
        broadcast(room);
      } else if (data.type === 'addBot') {
        if (room.hostId !== player.id || room.status !== 'lobby') { fail(ws, '只有房主能在准备房间添加机器人。'); return; }
        if (room.players.size >= MAX_PLAYERS) { fail(ws, '房间已满，最多 6 人（含机器人）。'); return; }
        if (typeof data.level !== 'string' || !Object.hasOwn(Bot.levels, data.level)) { fail(ws, '机器人难度无效。'); return; }
        const order = room.nextOrder++;
        const robot = { id: randomBytes(8).toString('hex'), name: `${Bot.levels[data.level].label}机器人${order + 1}`,
          bot: data.level, ws: null, ready: true, targetId: null, game: null, rank: null, disconnectedAt: null, room, order,
          team: [...room.players.values()].filter(other => other.team === 'red').length <=
            [...room.players.values()].filter(other => other.team === 'blue').length ? 'red' : 'blue' };
        room.players.set(robot.id, robot);
        event(room, `${robot.name} 加入房间。`);
        broadcast(room);
      } else if (data.type === 'kick') {
        if (room.hostId !== player.id) { fail(ws, '只有房主可以移出玩家。'); return; }
        const target = room.players.get(data.id);
        if (!target || target.id === player.id) { fail(ws, '请选择房间内的其他玩家。'); return; }
        const targetSocket = target.ws;
        if (targetSocket) targetSocket.player = null;
        removePlayer(room, target);
        send(targetSocket, { type: 'kicked', message: '你已被房主移出房间。' });
        if (targetSocket) { sendLeaderboard(targetSocket, true); sendDirectory(targetSocket, directory(), true); }
      } else if (data.type === 'leave') {
        ws.player = null;
        removePlayer(room, player);
        send(ws, { type: 'left' });
        sendLeaderboard(ws, true);
        sendDirectory(ws, directory(), true);
      } else if (data.type === 'ready' && room.status === 'lobby') {
        player.ready = Boolean(data.ready);
        broadcast(room);
      } else if (data.type === 'start' && room.status === 'lobby') {
        if (room.hostId !== player.id) { fail(ws, '只有房主可以开始对局。'); return; }
        const error = Match.startError(room);
        if (error) { fail(ws, error); return; }
        Match.beginMatch(room, randomInt(0x7fffffff), now, countdownMs);
        room.roundId++;
        room.effects = [];
        room.interactions = [];
        event(room, `即将开始：${Rules.modes[room.settings.mode][0]} / ${!Rules.hostile(room.settings) ? '无玩家攻击' : Rules.attacks[room.settings.attack][0]}`);
        broadcast(room);
      } else if (data.type === 'spectatorTap') {
        const reject = text => send(ws, { type: 'tapError', message: text });
        if (room.status !== 'playing' || !player.game || player.game.alive) { reject('只有本轮淘汰的观众可以敲棋盘。'); return; }
        const target = room.players.get(data.targetId);
        if (!target?.game?.alive || target.id === player.id) { reject('请选择仍在场玩家的棋盘。'); return; }
        if (typeof data.effect !== 'string' || !Object.hasOwn(Rules.spectatorEffects, data.effect) ||
            !Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < 0 || data.x > 1 || data.y < 0 || data.y > 1) {
          reject('互动类型或点击位置无效。'); return;
        }
        const interaction = { id: ++room.interactionId, at: now, sourceId: player.id, sourceName: player.name,
          targetId: target.id, effect: data.effect, x: data.x, y: data.y };
        // Deliver every accepted click immediately, independently of snapshot history.
        for (const member of room.players.values()) send(member.ws, {
          type: 'spectatorInteraction', code: room.code, roundId: room.roundId, interaction,
        });
      } else if (data.type === 'passBomb') {
        const target = Bomb.pass(room, player, now);
        if (!target) { fail(ws, '持有炸弹并累计消除 1 行后才能传递。'); return; }
        event(room, `${player.name} 把炸弹传给了 ${target.name}。`, 'attack');
        broadcast(room);
      } else if (data.type === 'action' && room.status === 'playing' && ACTIONS.has(data.action)) {
        applyResult(room, player, act(player.game, data.action, now), now);
        recordEliminations(room);
        finishIfNeeded(room, now);
      } else if (data.type === 'target' && room.status === 'playing' && player.game.alive) {
        if (room.settings.mode === 'practice' || room.settings.attack !== 'manual') { fail(ws, '当前规则自动分配目标，不能手动选择。'); return; }
        const target = Match.opponents(room, player).find(other => other.id === data.id);
        if (!target) { fail(ws, '请选择仍在场的对手，不能攻击自己或队友。'); return; }
        const previousValid = Match.opponents(room, player).some(other => other.id === player.targetId);
        if (target.id !== player.targetId && room.settings.cooldown && previousValid &&
            player.targetChangedAt != null && now - player.targetChangedAt < 3000) { fail(ws, '切换目标有 3 秒冷却。'); return; }
        if (target.id !== player.targetId) {
          player.targetId = target.id;
          player.targetChangedAt = now;
          room.dirty = true;
        }
      } else if (data.type === 'endPractice' && room.status === 'playing' && room.settings.mode === 'practice') {
        if (player.id !== room.hostId) { fail(ws, '只有房主可以结束练习。'); return; }
        Match.complete(room, '房主结束练习', [], null, true);
        for (const member of room.participants) recordScore(member);
        event(room, '练习已结束。', 'win');
      } else if (data.type === 'rematch' && room.status === 'finished') {
        if (room.hostId !== player.id) { fail(ws, '等待房主返回大厅。'); return; }
        clearMatch(room);
        event(room, '已回到大厅，准备下一轮。');
        broadcast(room);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(helloTimeout);
      const player = ws.player;
      if (!player || player.ws !== ws) return;
      recordScore(player);
      player.ws = null;
      player.disconnectedAt = Date.now();
      event(player.room, `${player.name} 掉线，30 秒内可重连。`, 'offline');
      broadcast(player.room);
    });
  });

  function botSignature(game) {
    return JSON.stringify([game.board, game.active, game.hold, game.holdUsed, game.pending, game.cleanseQueued]);
  }
  function tickBot(room, player, now, budget) {
    if (!player.bot || !player.game?.alive || room.status !== 'playing') return;
    const config = Bot.levels[player.bot];
    const state = player.botState ||= { nextAt: now + config.interval, pieceReadyAt: now + config.pieceDelay,
      choice: randomInt(10000) / 10000, actions: [], signature: null };
    if (now < state.nextAt) return;
    const bomb = Bomb.snapshot(room);
    if (Bot.reactionReady(state, 'passReadyAt', bomb?.holderId === player.id && bomb.cleared >= 1, now, config.reactionDelay)) {
      state.nextAt = now + Bot.levels[player.bot].interval;
      const target = Bomb.pass(room, player, now);
      if (target) event(room, `${player.name} 把炸弹传给了 ${target.name}。`, 'attack');
      return;
    }
    const game = player.game;
    const needsCleanse = room.settings.cleanse && game.energy >= 6 && !game.cleanseQueued &&
      (game.pending >= 2 || game.board.slice(0, 8).some(row => row.some(Boolean)));
    if (Bot.reactionReady(state, 'cleanseReadyAt', needsCleanse, now, config.reactionDelay)) {
      state.nextAt = now + Bot.levels[player.bot].interval;
      applyResult(room, player, act(game, 'cleanse', now), now);
      state.actions = [];
      return;
    }
    const signature = botSignature(game);
    if (!state.actions.length || signature !== state.signature) {
      if (!budget.remaining) return;
      budget.remaining--;
      state.actions = Bot.plan(snapshotGame(game), room.settings, player.bot, state.choice);
    }
    state.nextAt = now + Bot.levels[player.bot].interval;
    if ((!state.actions.length || state.actions[0] === 'drop') && now < state.pieceReadyAt) {
      state.signature = signature;
      return;
    }
    const action = state.actions.shift() || 'drop';
    if (ACTIONS.has(action)) {
      const result = act(game, action, now);
      applyResult(room, player, result, now);
      if (result.locked || !result.changed) state.actions = [];
    }
    state.signature = botSignature(game);
    finishIfNeeded(room, now);
  }

  let previousTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(100, now - previousTick);
    previousTick = now;
    const botBudget = { remaining: 1 };
    for (const room of rooms.values()) {
      for (const player of [...room.players.values()]) {
        if (player.disconnectedAt && now - player.disconnectedAt > RECONNECT_MS) removePlayer(room, player);
      }
      if (!rooms.has(room.code)) continue;
      for (const notice of Match.advanceMatch(room, now)) event(room, notice);
      if (room.status === 'playing') {
        finishIfNeeded(room, now);
        if (room.status === 'playing') {
          const results = [...room.players.values()].map(player => ({ player, result: tickGame(player.game, elapsed, now) }));
          for (const { player, result } of results) applyResult(room, player, result, now);
          recordEliminations(room);
          finishIfNeeded(room, now);
          if ([...room.players.values()].some(player => !player.bot && player.ws)) {
            const robots = [...room.players.values()].filter(player => player.bot)
              .sort((a, b) => (a.botState?.nextAt ?? 0) - (b.botState?.nextAt ?? 0));
            for (const player of robots) tickBot(room, player, now, botBudget);
          }
        }
      }
      if (room.dirty) broadcast(room);
    }
    updateDirectory();
    updateLeaderboard();
  }, 50);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else { ws.isAlive = false; ws.ping(); }
    }
  }, 15_000);

  async function close() {
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const room of rooms.values()) for (const player of room.players.values()) recordScore(player);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
    if (!await leaderboard.flush()) throw new Error('排行榜保存失败，部分成绩可能未写入磁盘。');
  }
  return { server, rooms, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp({ leaderboard: createLeaderboard({ file: path.join(__dirname, 'data', 'leaderboard.json') }) });
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  });
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`\n  Block Relay · 联机俄罗斯方块\n  本机访问：http://localhost:${port}`);
    for (const address of lanAddresses(port)) console.log(`  局域网访问：${address}`);
    console.log('\n  同一局域网的玩家打开上述地址，再输入相同房间码。\n');
  });
  app.server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; app.close().catch(error => console.error(error)); });
}

module.exports = { createApp };
