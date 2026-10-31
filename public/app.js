'use strict';

const $ = id => document.getElementById(id);
const Rules = window.BlockRules;
const audio = window.BlockAudio.create();
function renderSound() {
  text('soundButton', audio.isEnabled() ? '音效开' : '已静音');
  $('soundButton').setAttribute('aria-pressed', String(audio.isEnabled()));
}
window.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
window.addEventListener('pointerup', () => audio.unlock(), { passive: true });
window.addEventListener('touchend', () => audio.unlock(), { passive: true });
window.addEventListener('keydown', () => audio.unlock());
let serverOffset = 0;
function serverNow() { return Date.now() + serverOffset; }
function isManual() { return state.room && Rules.hostile(state.room.settings) && state.room.settings.attack === 'manual'; }
function validOpponents() {
  const self = me();
  if (!state.room || !Rules.hostile(state.room.settings)) return [];
  return state.room?.players.filter(player => player.id !== state.id && player.game?.alive &&
    (state.room.settings.mode !== 'teams' || player.team !== self?.team)) || [];
}
const COLORS = {
  I: '#53d9e5', J: '#6b8bfa', L: '#f7a75f', O: '#eed36d',
  S: '#77d5ad', T: '#b394ef', Z: '#ed8198', G: '#69788e',
};
const SHAPES = {
  I: [[1, 1, 1, 1]], J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]], O: [[1, 1], [1, 1]],
  S: [[0, 1, 1], [1, 1, 0]], T: [[0, 1, 0], [1, 1, 1]],
  Z: [[1, 1, 0], [0, 1, 1]],
};
const state = { ws: null, room: null, id: null, connected: false, lastEvent: 0 };
let publicRooms = [];
let directoryLoaded = false;
let leaderboardEntries = [];
let leaderboardLoaded = false;
let leaderboardStorage = 'memory';
function renderLeaderboard() {
  if (state.room) return;
  $('refreshLeaderboardButton').disabled = !state.connected;
  const entries = leaderboardEntries.filter(entry => entry.mode === $('leaderboardModeSelect').value);
  const podium = entries.slice(0, 3);
  $('leaderboardPodium').replaceChildren(...Array.from({ length: 3 }, (_, index) => {
    const entry = podium[index];
    const place = element('li', `podium-place podium-place-${index + 1}${entry ? '' : ' podium-empty'}`);
    place.append(element('span', 'podium-rank', `第 ${index + 1} 名`),
      element('strong', 'podium-name', entry?.name || '等你上榜'),
      element('span', 'podium-score', entry ? entry.score.toLocaleString() : '—'),
      element('small', 'podium-mode', entry ? Rules.modes[entry.mode]?.[0] || '游戏纪录' : '尚无纪录'));
    return place;
  }));
  text('leaderboardStatus', !state.connected ? '连接中断，重连后更新榜单。' : !leaderboardLoaded ? '正在获取最高分…' :
    leaderboardStorage === 'error' ? '榜单存储异常，成绩可能尚未保存，请联系房主检查服务日志。' :
    !entries.length ? '' :
    leaderboardStorage === 'memory' ? '当前为临时榜单，重启后不保留。' : '');
}
let chatCode = null;
let chatItems = [];
let pendingChat = null;
let chatUnread = 0;
let chatCollapsed = window.innerWidth <= 1250;
let chatHeightRoom = null;
function alignChatHeight() {
  if (!state.room || state.room.status !== 'lobby' || window.innerWidth <= 1250) return;
  const height = $('waitingPanel').getBoundingClientRect().height;
  if (height > 0) $('chatPanel').style.setProperty('--chat-height', `${Math.ceil(height)}px`);
}
function closeRoomFinder() {
  if ($('roomFinder').open) $('roomFinder').close();
}
function openRoomFinder() {
  text('roomFinderError', '');
  renderDirectory();
  if (!$('roomFinder').open) $('roomFinder').showModal();
  $('roomSearchInput').focus();
  send({ type: 'rooms' });
}
function chatControls() {
  const enabled = state.connected && Boolean(state.room);
  $('chatInput').disabled = !enabled;
  $('chatSend').disabled = !enabled || Boolean(pendingChat);
  if (!state.connected && state.room) text('chatStatus', '连接中断，重连后可继续发送');
}
function clearChat() {
  chatCode = null;
  chatItems = [];
  pendingChat = null;
  chatUnread = 0;
  $('chatInput').value = '';
  $('chatMessages').replaceChildren();
  text('chatUnread', '');
  show($('chatLatest'), false);
  chatControls();
}
function scrollChatLatest() {
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  chatUnread = 0;
  text('chatUnread', '');
  show($('chatLatest'), false);
}
function receiveChat(messages, history = false) {
  const list = $('chatMessages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
  if (history) { chatItems = []; list.replaceChildren(); }
  for (const item of messages) {
    if (chatItems.some(existing => existing.id === item.id)) continue;
    chatItems.push(item);
    if (!history && item.sourceId !== state.id) audio.play('message');
    const row = element('div', `chat-message${item.sourceId === state.id ? ' is-own' : ''}`);
    const meta = element('div', 'chat-meta');
    meta.append(element('strong', 'chat-name', item.name + (item.sourceId === state.id ? '（你）' : '')),
      element('span', 'chat-time', new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    row.append(meta, element('p', 'chat-text', item.text));
    list.append(row);
    if (!history && (chatCollapsed || !atBottom)) chatUnread++;
    if (pendingChat && item.sourceId === state.id) {
      if ($('chatInput').value === pendingChat) $('chatInput').value = '';
      pendingChat = null;
      text('chatStatus', '记录跟随房间，再开保留');
    }
  }
  while (chatItems.length > 100) { chatItems.shift(); list.children[0]?.remove(); }
  if (!chatItems.length) list.replaceChildren(element('p', 'chat-empty', '还没有消息，和朋友打个招呼吧。'));
  else for (const node of [...list.children]) if (node.className === 'chat-empty') node.remove();
  if (history || (!chatCollapsed && atBottom)) scrollChatLatest();
  else if (chatUnread) {
    text('chatUnread', `${chatUnread} 条新消息`);
    show($('chatLatest'), true);
  }
  chatControls();
}
function submitChat() {
  if (!state.connected || !state.room || pendingChat) return;
  const value = $('chatInput').value;
  if (!value.trim() || Array.from(value.trim()).length > 200) { text('chatStatus', '请输入 1–200 个字符'); return; }
  pendingChat = value;
  if (!send({ type: 'chat', text: value })) pendingChat = null;
  else text('chatStatus', '正在发送…');
  chatControls();
}
function renderDirectory() {
  if (state.room) return;
  const query = $('roomSearchInput').value.trim().toLocaleLowerCase();
  const rooms = publicRooms.filter(room => `${room.code} ${room.hostName}`.toLocaleLowerCase().includes(query));
  text('roomDirectoryCount', directoryLoaded ? `${publicRooms.length} 个房间 · 状态实时同步` : '正在获取房间…');
  $('refreshRoomsButton').disabled = !state.connected;
  const statusNames = { lobby: '等待中', countdown: '即将开始', playing: '对战中', finished: '已结束' };
  $('roomDirectoryList').replaceChildren(...rooms.map(room => {
    const row = element('div', 'directory-row');
    const info = element('div', 'directory-info');
    info.append(element('strong', 'directory-code', room.code), element('span', 'directory-host', `房主：${room.hostName}`));
    const details = element('div', 'directory-details');
    details.append(element('span', '', Rules.presets[room.presetId]?.name || Rules.modes[room.mode]?.[0] || '自定义'),
      element('span', '', `${room.players}/${room.maxPlayers} 人 · ${statusNames[room.status] || '未知状态'}${room.online < room.players ? ` · ${room.online} 在线` : ''}`));
    const button = element('button', 'button button-secondary directory-join',
      room.status === 'lobby' && room.players >= room.maxPlayers ? '已满员' : !room.online ? '暂时离线' : room.joinable ? '加入' : statusNames[room.status] || '暂不可加入');
    button.type = 'button';
    button.disabled = !state.connected || !room.joinable;
    button.setAttribute('aria-label', `加入 ${room.code}，房主 ${room.hostName}`);
    button.addEventListener('click', () => {
      $('roomInput').value = room.code;
      join('join');
    });
    row.append(info, details, button);
    return row;
  }));
  text('roomDirectoryMessage', !state.connected ? '连接中断，重连后自动更新房间。' : !directoryLoaded ? '正在获取房间…' :
    !publicRooms.length ? '还没有房间，创建一个邀请朋友吧。' : !rooms.length ? '没有匹配的房间，试试房间码或房主昵称。' : '对战中的房间暂不接受中途加入。');
}
const monitors = new Map();
let countdownAnimation = null;
let countdownKey = null;
let incomingAttacks = [];
let reserveKey = null;
let reservePending = null;
let reserveCancelled = 0;
let reserveTimer;
function reserveRow() {
  const row = element('div', 'reserve-row');
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', '一行障碍');
  row.append(...Array.from({ length: 10 }, () => element('span', 'reserve-cell')));
  return row;
}
function resetReserve() {
  clearTimeout(reserveTimer);
  reserveKey = null;
  reservePending = null;
  reserveCancelled = 0;
  $('cancelledRows').replaceChildren();
  show($('cancelledReserve'), false);
}
function renderReserve(game) {
  const key = `${state.room.code}:${state.room.roundId}`;
  const baseline = reserveKey !== key;
  if (baseline) {
    resetReserve();
    reserveKey = key;
    reserveCancelled = game.cancelled;
  }
  if (reservePending !== game.pending) {
    reservePending = game.pending;
    text('attackValue', game.pending ? '待入盘' : '空');
    $('attackQueue').replaceChildren(...(game.pending
      ? Array.from({ length: game.pending }, reserveRow)
      : [element('span', 'reserve-empty', '没有待接收障碍')]));
  }
  const cancelled = Math.max(0, game.cancelled - reserveCancelled);
  reserveCancelled = game.cancelled;
  if (!baseline && cancelled) {
    clearTimeout(reserveTimer);
    $('cancelledRows').replaceChildren(...Array.from({ length: cancelled }, reserveRow));
    show($('cancelledReserve'), true);
    reserveTimer = setTimeout(() => {
      show($('cancelledReserve'), false);
      $('cancelledRows').replaceChildren();
    }, 1400);
  }
}
function clearIncoming() {
  incomingAttacks = [];
  show($('incomingNotice'), false);
}
function receiveAttack(attack) {
  const landed = attack.phase === 'hit';
  incomingAttacks.unshift(attack);
  incomingAttacks = incomingAttacks.slice(0, 4);
  $('incomingNotice').replaceChildren(...incomingAttacks.map(item =>
    element('p', '', `${item.phase === 'hit' ? '已入盘' : '来袭'} · ${item.sourceName} → 你：+${item.lines} 行`)));
  show($('incomingNotice'), true);
  const frame = $('mainBoard').parentElement;
  frame.animate?.([
    { boxShadow: '0 0 0 4px #ff6488, 0 0 52px #ff6488aa' },
    { boxShadow: '0 0 0 1px #ed8198, 0 0 0 transparent' },
  ], { duration: landed ? 1200 : 700, easing: 'ease-out' });
  const sourceCard = monitors.get(attack.sourceId);
  sourceCard?.animate?.([
    { outline: '3px solid #ed8198' }, { outline: '0px solid transparent' },
  ], { duration: 1600, easing: 'ease-out' });

}
function receiveHit(hit) {
  audio.play('hit', hit.lines);
  receiveAttack({ phase: 'hit', sourceId: hit.sources[0]?.sourceId,
    sourceName: hit.sources.map(source => `${source.sourceName}（${source.lines}行）`).join('、'), lines: hit.lines });
}
const battleEffects = window.BlockEffects.create({
  canvas: $('battleEffects'),
  onIncoming: receiveAttack,
  onHit: receiveHit,
  onBomb: effect => {
    audio.play('bomb');
    text('eventTicker', `${effect.targetName || '玩家'} 的炸弹爆炸 · +${effect.lines} 行`);
    $('eventTicker').dataset.kind = 'hit';
  },
  onClear: effect => audio.play('clear', effect.rows.length),
  resolve(id) {
    const player = state.room?.players.find(item => item.id === id);
    if (!player) return null;
    return { element: id === state.id ? $('mainBoard') : monitors.get(id)?.querySelector('canvas'),
      clip: id === state.id ? null : $('playerMonitors'), name: player.name };
  },
});
let reconnectTimer;
let retryDelay = 1000;
const heldInputs = new Map();
let gesture = null;
let inputMode = saved('block-relay-input') === 'gesture' ? 'gesture' : 'buttons';
function renderInputMode() {
  const enabled = inputMode === 'gesture';
  document.body.classList.toggle('gesture-mode', enabled);
  text('inputModeButton', enabled ? '切换按键' : '切换手势');
  $('inputModeButton').setAttribute('aria-pressed', String(enabled));
  text('inputModeHint', enabled ? '点按旋转 · 横拖移动 · 下拖软降' : '按住方向连续移动，可同时旋转');
}

function saved(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* The game also works with browser storage disabled. */ }
  return null;
}

function show(element, visible) { element.classList.toggle('is-hidden', !visible); }
function text(id, value) { $(id).textContent = value; }
function send(data) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(data));
  return true;
}
function message(value) {
  text(state.room ? 'roomMessage' : 'lobbyMessage', value);
  if (state.room && state.room.status !== 'lobby') text('eventTicker', value);
}
function me() { return state.room?.players.find(player => player.id === state.id); }
function canSpectatorTap() { return state.connected && state.room?.status === 'playing' && Boolean(me()?.game) && !me().game.alive; }
let spectatorEffect = 'glass';
function spectatorTap(targetId, x, y) {
  if (!canSpectatorTap()) return;
  if (send({ type: 'spectatorTap', targetId, effect: spectatorEffect, x, y })) {
    text('spectatorHint', `已送出${Rules.spectatorEffects[spectatorEffect][0]}，不影响对局。`);
  }
}
function activeGame() { return state.connected && state.room?.status === 'playing' && me()?.game?.alive; }
function action(value) { if (activeGame()) send({ type: 'action', action: value }); }

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('open', () => {
    state.connected = true;
    directoryLoaded = false;
    leaderboardLoaded = false;
    renderDirectory();
    renderLeaderboard();
    retryDelay = 1000;
    text('connectionLabel', '房间服务已连接 · 同一 Wi-Fi 即可开玩');
    document.body.classList.add('is-connected');
    $('createButton').disabled = false;
    $('joinButton').disabled = false;
    const token = saved('block-relay-token');
    if (token) send({ type: 'resume', token });
    else if (state.room) resetRoom();
  });
  ws.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'leaderboardList') {
      leaderboardEntries = data.entries;
      leaderboardStorage = data.storage;
      leaderboardLoaded = true;
      renderLeaderboard();
    } else if (data.type === 'roomList') {
      publicRooms = data.rooms;
      directoryLoaded = true;
      renderDirectory();
    } else if (data.type === 'joined') {
      closeRoomFinder();
      state.id = data.id;
      saved('block-relay-token', data.token);
      message('');
    } else if (data.type === 'state') {
      if (state.room?.code !== data.room.code) state.lastEvent = 0;
      state.room = data.room;
      serverOffset = data.room.serverNow - Date.now();
      render();
    } else if (data.type === 'chatHistory') {
      if (state.room?.code === data.code) {
        chatCode = data.code;
        pendingChat = null;
        receiveChat(data.messages, true);
      }
    } else if (data.type === 'chatMessage') {
      if (state.room?.code === data.code) receiveChat([data.message]);
    } else if (data.type === 'kicked') {
      saved('block-relay-token', null);
      resetRoom();
      message(data.message);
    } else if (data.type === 'chatError') {
      if (!data.code || state.room?.code === data.code) {
        pendingChat = null;
        text('chatStatus', data.message);
        chatControls();
      }
    } else if (data.type === 'spectatorInteraction') {
      if (state.room?.code === data.code && state.room.roundId === data.roundId && state.room.status === 'playing') {
        battleEffects.interact(data.interaction);
      }
    } else if (data.type === 'tapError') {
      text('spectatorHint', data.message);
    } else if (data.type === 'error') {
      if ($('roomFinder').open) text('roomFinderError', data.message);
      if ($('ruleOptionsDialog').open) { text('ruleOptionsMessage', data.message); renderRuleOptions(); }
      message(data.message);
    } else if (data.type === 'resumeFailed' || data.type === 'left') {
      saved('block-relay-token', null);
      resetRoom();
      if (data.type === 'resumeFailed') message('重连已超时，请重新加入房间。');
    }
  });
  ws.addEventListener('close', () => {
    state.connected = false;
    $('addBotButton').disabled = true;
    updateKickButtons();
    renderRuleOptions();
    renderBomb();
    pendingChat = null;
    chatControls();
    renderDirectory();
    renderLeaderboard();
    resetReserve();
    battleEffects.clear(true);
    stopRepeat();
    document.body.classList.remove('is-connected');
    $('createButton').disabled = true;
    $('joinButton').disabled = true;
    text('connectionLabel', '连接中断，正在重试…');
    if (state.room) {
      text('eventTicker', '连接中断，正在重连。游戏仍会继续，请尽快恢复网络。');
      renderOverlay();
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 5000);
  });
  ws.addEventListener('error', () => {});
}

let waitingViewportActive = false;
function syncWaitingViewport() {
  const view = $('roomView');
  if (!waitingViewportActive || window.innerWidth > 760) {
    view.style.removeProperty('--room-viewport-height');
    view.style.removeProperty('--room-viewport-top');
    return;
  }
  const viewport = window.visualViewport;
  // Pinch zoom must not resize the layout beneath the user's magnified view.
  if (viewport && Math.abs(viewport.scale - 1) > .01) return;
  const height = viewport?.height || window.innerHeight;
  if (height > 0) view.style.setProperty('--room-viewport-height', `${height}px`);
  view.style.setProperty('--room-viewport-top', `${Math.max(0, viewport?.offsetTop || 0)}px`);
}
function setWaitingViewport(active) {
  if (active === waitingViewportActive) return;
  waitingViewportActive = active;
  if (active && window.innerWidth <= 760) {
    document.activeElement?.blur?.();
    window.scrollTo?.(0, 0);
  }
  syncWaitingViewport();
}

function resetRoom() {
  resetReserve();
  clearIncoming();
  countdownAnimation?.cancel();
  countdownAnimation = null;
  countdownKey = null;
  show($('countdownModal'), false);
  battleEffects.clear(true);
  stopRepeat();
  state.room = null;
  closeRuleOptions();
  renderBomb();
  chatHeightRoom = null;
  closeRoomFinder();
  clearChat();
  document.body.classList.remove('controls-visible');
  document.body.classList.remove('match-visible');
  document.body.classList.remove('waiting-visible');
  setWaitingViewport(false);
  state.id = null;
  state.lastEvent = 0;
  monitors.clear();
  $('playerMonitors').replaceChildren();
  show($('lobbyView'), true);
  show($('roomView'), false);
  show($('finishOverlay'), false);
  renderDirectory();
  renderLeaderboard();
  send({ type: 'rooms' });
  send({ type: 'leaderboard' });
  message('');
}

function join(type) {
  const name = Rules.normalizeName($('nameInput').value) || '方块玩家';
  $('nameInput').value = name;
  saved('block-relay-name', name);
  const code = $('roomInput').value.trim().toUpperCase();
  if (type === 'join' && code.length !== 4) { message('请输入四位房间码。'); return; }
  if (!send({ type, name, code })) message('尚未连接服务，请稍等。');
}

function render() {
  const room = state.room;
  const self = me();
  if (!room || !self) return;
  if (chatHeightRoom !== room.code) {
    chatHeightRoom = room.code;
    $('chatPanel').style.removeProperty('--chat-height');
  }
  if (chatCode !== room.code) { clearChat(); chatCode = room.code; receiveChat([], true); }
  chatControls();
  const controlVisible = ['countdown', 'playing'].includes(room.status) && Boolean(self.game?.alive);
  document.body.classList.toggle('controls-visible', controlVisible);
  document.body.classList.toggle('match-visible', room.status !== 'lobby');
  if (!activeGame()) stopRepeat();
  show($('lobbyView'), false);
  show($('roomView'), true);
  const waiting = room.status === 'lobby';
  document.body.classList.toggle('waiting-visible', waiting);
  setWaitingViewport(waiting);
  if (!waiting) closeRuleOptions();
  show($('waitingPanel'), waiting);
  show($('gamePanel'), !waiting);
  show($('finishOverlay'), room.status === 'finished');
  text('roomCodeLabel', room.code);
  text('roomCodeLarge', room.code);
  text('playerCountLabel', `${room.players.length} / 6 位玩家`);
  text('readyCountLabel', `${room.players.filter(player => player.ready && player.connected).length} 已准备`);
  if (waiting) {
    renderBomb();
    resetReserve();
    clearIncoming();
    show($('countdownModal'), false);
    countdownAnimation?.cancel();
    countdownAnimation = null;
    countdownKey = null;
    renderWaiting(self);
  } else renderGame(self);
  const latest = room.events.at(-1);
  if (latest && latest.id > state.lastEvent) {
    state.lastEvent = latest.id;
    text('eventTicker', latest.text);
    $('eventTicker').dataset.kind = latest.kind;
  }
  if (room.status === 'finished') renderFinish(self);
  battleEffects.sync(room, state.id, serverNow());
  alignChatHeight();
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function setupSettings() {
  for (const [id, [name, icon]] of Object.entries(Rules.spectatorEffects)) {
    const button = element('button', '', `${icon} ${name}`);
    button.type = 'button';
    button.dataset.effect = id;
    button.setAttribute('aria-pressed', String(id === spectatorEffect));
    button.addEventListener('click', () => {
      spectatorEffect = id;
      for (const item of $('spectatorEffectButtons').children) item.setAttribute('aria-pressed', String(item.dataset.effect === id));
      text('spectatorHint', `已选择${name}，点击仍在场玩家的棋盘。`);
    });
    $('spectatorEffectButtons').append(button);
  }
  $('presetSelect').replaceChildren(...Object.entries(Rules.presets).map(([id, preset]) => {
    const option = element('option', '', preset.name);
    option.value = id;
    return option;
  }));
  $('presetSelect').addEventListener('change', event => send({ type: 'preset', id: event.target.value }));
  $('attackSelect').replaceChildren(...Object.entries(Rules.attacks).map(([value, [name]]) => {
    const option = element('option', '', name);
    option.value = value;
    return option;
  }));
  $('attackSelect').addEventListener('change', event => send({ type: 'settings', settings: { attack: event.target.value } }));
  function changeOption(key, value) {
    const room = state.room;
    if (!state.connected || room?.status !== 'lobby' || room.hostId !== state.id) { renderRuleOptions(); return; }
    text('ruleOptionsMessage', '');
    send({ type: 'settings', settings: { [key]: value } });
  }
  for (const key of Object.keys(ruleNumbers)) {
    $(key + 'Select').addEventListener('change', event => changeOption(key, Number(event.target.value)));
  }
  for (const [key, [name, description]] of Object.entries(Rules.toggles)) {
    const label = element('label', 'rule-toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.option = key;
    input.addEventListener('change', () => changeOption(key, input.checked));
    const copy = element('span', '');
    copy.append(element('strong', '', name), element('small', '', description));
    label.append(input, copy);
    $('ruleToggles').append(label);
  }
}
const ruleNumbers = { duration: ['timed', '比赛时长', value => `${value / 60} 分钟`], goal: ['sprint', '目标消行', value => `${value} 行`], digRows: ['dig', '初始障碍', value => `${value} 行`], waves: ['coop', '目标波数', value => `${value} 波`] };
function ruleApplies(key, settings) {
  if (key === 'randomGarbage' || key === 'hotPotato') return true;
  if (settings.mode === 'sprint') return ['packetHole', 'counter', 'buffer', 'digBonus', 'cleanse'].includes(key);
  if (settings.mode === 'dig') return false;
  if (settings.mode === 'practice') return key === 'cleanse';
  if (settings.mode === 'coop' && ['cooldown', 'combo', 'digBonus'].includes(key)) return false;
  return key !== 'cooldown' || settings.attack === 'manual';
}
function closeRuleOptions() {
  if ($('ruleOptionsDialog').open) $('ruleOptionsDialog').close();
}
function renderRuleOptions() {
  const room = state.room;
  if (!room || room.status !== 'lobby') { closeRuleOptions(); return; }
  const settings = room.settings;
  const editable = state.connected && room.hostId === state.id;
  const tags = [];
  text('ruleOptionsHint', !state.connected ? '连接中断，重连后可继续选配。' : editable ? '修改即时生效，所有玩家需要重新准备。更换玩法恢复默认配置。' : '房主设置 · 只读');
  for (const [key, [mode, name, format]] of Object.entries(ruleNumbers)) {
    const visible = settings.mode === mode;
    show($(key + 'Field'), visible);
    $(key + 'Select').value = settings[key];
    $(key + 'Select').disabled = !editable || !visible;
    if (visible) tags.push(`${name}：${format(settings[key])}`);
  }
  for (const input of $('ruleToggles').children) {
    const checkbox = input.children[0];
    const key = checkbox.dataset.option;
    const visible = ruleApplies(key, settings);
    const fixed = key === 'counter' && settings.mode === 'coop';
    show(input, visible);
    checkbox.checked = settings[key];
    checkbox.disabled = !editable || !visible || fixed;
    if (visible) tags.push(`${Rules.toggles[key][0]}：${settings[key] ? '开' : '关'}${fixed ? '（固定）' : ''}`);
  }
  $('ruleTags').replaceChildren(...tags.map(value => {
    const tag = element('span', 'rule-tag', value);
    tag.setAttribute('role', 'listitem');
    return tag;
  }));
}
function renderSettings(self) {
  const settings = state.room.settings;
  const host = self.id === state.room.hostId;
  const hostile = Rules.hostile(settings);
  const coop = settings.mode === 'coop';
  const [goal] = Rules.summary(settings);
  $('presetSelect').value = Object.hasOwn(Rules.presets, state.room.presetId) ? state.room.presetId :
    Object.keys(Rules.presets).find(id => Rules.presets[id].settings.mode === settings.mode) || '';
  $('presetSelect').disabled = !host;
  text('presetGoal', goal);
  text('settingsPermission', host ? '你是房主，可修改' : '房主设置 · 只读');
  text('attackDescription', coop ? '所有人都是队友，余量自动救援。' : !hostile ? '本局不发送攻击。' : Rules.attacks[settings.attack][1]);
  show($('attackSelect').parentElement, hostile);
  show($('teamField'), settings.mode === 'teams');
  $('teamSelect').value = self.team;
  $('attackSelect').value = settings.attack;
  $('attackSelect').disabled = !host || !hostile || !state.connected;
  renderRuleOptions();
}

function kickButton(player) {
  const button = element('button', 'text-button kick-button', '踢出');
  button.type = 'button';
  button.setAttribute('aria-label', `踢出 ${player.name}`);
  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (!state.connected || state.room?.hostId !== state.id || player.id === state.id) return;
    if (window.confirm(`确定将「${player.name}」踢出房间？`)) send({ type: 'kick', id: player.id });
  });
  return button;
}
function updateKickButtons() {
  const host = state.room?.hostId === state.id;
  for (const button of document.querySelectorAll('.kick-button')) {
    show(button, Boolean(host));
    button.disabled = !state.connected;
  }
}

function renderWaiting(self) {
  const room = state.room;
  show($('botControls'), room.hostId === self.id);
  $('addBotButton').disabled = !state.connected || room.players.length >= 6;
  const nodes = room.players.map((player, index) => {
    const row = element('div', 'roster-row');
    const avatar = element('span', 'player-avatar', player.name.slice(0, 1));
    avatar.dataset.color = index % 6;
    const details = element('div', 'roster-details');
    const nameRow = element('div', 'player-name-row');
    nameRow.append(element('strong', '', player.name + (player.id === self.id ? '（你）' : '')));
    if (room.hostId === self.id && player.id !== self.id) {
      const kick = kickButton(player);
      kick.disabled = !state.connected;
      nameRow.append(kick);
    }
    details.append(nameRow);
    details.append(element('span', '', (player.bot ? '机器人 · 自动准备' : player.id === room.hostId ? '房主' : '挑战者') +
      (room.settings.mode === 'teams' ? ` / ${player.team === 'red' ? '红队' : '蓝队'}` : '')));
    const status = element('span', `ready-tag ${player.ready && player.connected ? 'is-ready' : ''}`,
      !player.connected ? '等待重连' : player.ready ? '已准备' : '未准备');
    row.append(avatar, details, status);
    return row;
  });
  for (let i = room.players.length; i < 2; i++) nodes.push(element('div', 'roster-empty', '＋ 等待朋友加入'));
  $('waitingRoster').replaceChildren(...nodes);
  text('readyButton', self.ready ? '取消准备' : '我准备好了');
  const host = self.id === room.hostId;
  show($('startButton'), host);
  const minimum = ['practice', 'dig', 'coop'].includes(room.settings.mode) ? 1 : 2;
  const red = room.players.filter(player => player.team === 'red').length;
  const uneven = room.settings.mode === 'teams' && (!red || red * 2 !== room.players.length);
  $('startButton').disabled = room.players.length < minimum || uneven || room.players.some(player => !player.ready || !player.connected);
  text('roomMessage', uneven ? '红蓝两队人数必须相等。换队后所有人需要重新准备。' :
    host ? `至少 ${minimum} 人，所有人准备后即可开始。修改规则后需要重新准备。` : '确认规则并准备，等待房主开始。');
  renderSettings(self);
}

function drawCell(ctx, x, y, color, size, ghost = false) {
  const gap = size > 20 ? 1.5 : 0.8;
  const px = x * size + gap;
  const py = y * size + gap;
  const width = size - gap * 2;
  if (ghost) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, width - 1, width - 1);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(px, py, width, width);
  ctx.fillStyle = 'rgba(255,255,255,.24)';
  ctx.fillRect(px, py, width, Math.max(1, size * 0.09));
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(px, py + width - Math.max(1, size * 0.1), width, Math.max(1, size * 0.1));
}

function fits(board, piece, y) {
  return piece.matrix.every((row, dy) => row.every((cell, dx) => !cell ||
    (piece.x + dx >= 0 && piece.x + dx < 10 && y + dy < 20 && (y + dy < 0 || !board[y + dy][piece.x + dx]))));
}

function drawBoard(canvas, game, main = false) {
  const size = main ? 30 : 9;
  const width = size * 10;
  const height = size * 20;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#0b1427';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#172239';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = 1; x < 10; x++) { ctx.moveTo(x * size, 0); ctx.lineTo(x * size, height); }
  for (let y = 1; y < 20; y++) { ctx.moveTo(0, y * size); ctx.lineTo(width, y * size); }
  ctx.stroke();
  if (!game) return;
  game.board.forEach((row, y) => row.forEach((cell, x) => { if (cell) drawCell(ctx, x, y, COLORS[cell], size); }));
  if (!game.alive) return;
  const piece = game.active;
  if (main) {
    let y = piece.y;
    while (fits(game.board, piece, y + 1)) y++;
    piece.matrix.forEach((row, dy) => row.forEach((cell, dx) => {
      if (cell && y + dy >= 0) drawCell(ctx, piece.x + dx, y + dy, COLORS[piece.type], size, true);
    }));
  }
  piece.matrix.forEach((row, dy) => row.forEach((cell, dx) => {
    if (cell && piece.y + dy >= 0) drawCell(ctx, piece.x + dx, piece.y + dy, COLORS[piece.type], size);
  }));
}

function renderPiece(id, type) {
  const container = $(id);
  if (container.dataset.type === (type || 'none')) return;
  container.dataset.type = type || 'none';
  if (!type) { container.replaceChildren(element('span', 'preview-empty', '—')); return; }
  const canvas = document.createElement('canvas');
  const matrix = SHAPES[type];
  canvas.width = matrix[0].length * 25;
  canvas.height = matrix.length * 25;
  const ctx = canvas.getContext('2d');
  matrix.forEach((row, y) => row.forEach((cell, x) => { if (cell) drawCell(ctx, x, y, COLORS[type], 25); }));
  container.replaceChildren(canvas);
}

function decorateBomb(badge) {
  const art = element('img', 'bomb-art');
  art.src = '/bomb.svg';
  art.alt = '';
  art.width = 96;
  art.height = 108;
  badge.append(art, element('span', 'bomb-sparks'), element('span', 'bomb-caption'));
  return badge;
}

let bombTickLit = false;
let bombTickHolder = null;
function renderBomb() {
  const bomb = state.room?.bomb;
  const enabled = state.room?.settings.hotPotato && state.room.status === 'playing';
  const own = enabled && bomb?.holderId === state.id;
  const holder = state.room?.players.find(player => player.id === bomb?.holderId);
  document.body.classList.toggle('bomb-visible', Boolean(enabled));
  show($('bombPanel'), enabled);
  show($('mainBombBadge'), Boolean(own));
  const lit = Boolean(state.connected && bomb?.lit);
  if (own && lit && !bombTickLit && bombTickHolder === state.id) audio.play('bombTick');
  bombTickLit = Boolean(own && lit);
  bombTickHolder = own && state.connected ? state.id : null;
  $('mainBombBadge').classList.toggle('is-lit', Boolean(own && lit));
  $('mainBombBadge').querySelector('.bomb-caption').textContent = own ? `[${bomb.cleared >= 1 ? 1 : 0}/1]按B传递！` : '';
  $('mainBoard').parentElement.classList.toggle('has-bomb', Boolean(own));
  $('mainBoard').parentElement.classList.toggle('bomb-lit', Boolean(own && lit));
  $('bombPanel').classList.toggle('is-holder', Boolean(own));
  text('bombHolderLabel', own ? '炸弹在你手里' : holder ? `炸弹在 ${holder.name} 手里` : '等待炸弹');
  text('bombProgress', own ? bomb.cleared >= 1 ? '可以传递！按 B 或点右侧按钮' : '再消 1 行可传递 · 按 B 或点按钮' : '观察右侧炸弹标记，闪烁越急通常越危险');
  $('passBombButton').disabled = !state.connected || !own || !me()?.game?.alive || bomb.cleared < 1;
  for (const [id, node] of monitors) {
    const carrying = enabled && bomb?.holderId === id;
    node.classList.toggle('has-bomb', Boolean(carrying));
    const badge = node.querySelector('.bomb-badge');
    show(badge, Boolean(carrying));
    badge.classList.toggle('is-lit', Boolean(carrying && lit));
    badge.querySelector('.bomb-caption').textContent = carrying ? bomb.cleared >= 1 ? '可传递' : '消 1 行可传' : '';
    node.classList.toggle('bomb-lit', Boolean(carrying && lit));
    const canvas = node.querySelector('canvas');
    canvas.classList.toggle('has-bomb', Boolean(carrying));
    canvas.classList.toggle('bomb-lit', Boolean(carrying && lit));
  }
}
function passBomb() {
  if (!$('passBombButton').disabled) send({ type: 'passBomb' });
}

function renderGame(self) {
  const room = state.room;
  const game = self.game;
  if (!game) return;
  text('scoreValue', game.score.toLocaleString());
  text('levelValue', String(game.level).padStart(2, '0'));
  text('linesValue', String(game.lines).padStart(2, '0'));
  text('nextPieceName', game.next[0]);
  renderPiece('nextPreview', game.next[0]);
  renderPiece('holdPreview', game.hold);
  $('holdPreview').classList.toggle('is-used', game.holdUsed);
  renderReserve(game);
  const targets = validOpponents();
  const target = targets.find(player => player.id === self.targetId) || (isManual() ? Rules.previousOpponent(room.players, self.id, room.settings) : null);
  text('targetName', room.settings.mode === 'coop' ? '自动救援队友' : !Rules.hostile(room.settings) ? '无攻击' : isManual() ? target?.name || '暂无目标' : Rules.attacks[room.settings.attack][0]);
  text('energyValue', room.settings.cleanse ? `${game.energy} / 12` : '已关闭');
  text('cleanseButton', !room.settings.cleanse ? '净化已关闭' : `${game.cleanseQueued ? '已预约' : '净化'} ${game.energy}/6`);
  $('cleanseButton').disabled = !activeGame() || !room.settings.cleanse || game.energy < 6 || game.cleanseQueued;
  text('defenseStats', `挖掘 ${game.dug} · 抵消 ${game.cancelled} · 净化 ${game.purified}${room.settings.mode === 'coop' ? ` · 救援 ${game.helped || 0}` : ''}`);
  text('matchRulesLabel', `${Rules.presets[room.presetId]?.name || Rules.modes[room.settings.mode][0]} / ${room.settings.mode === 'coop' ? '全员合作' : !Rules.hostile(room.settings) ? '无攻击' : Rules.attacks[room.settings.attack][0]}`);
  show($('endPracticeButton'), room.settings.mode === 'practice' && self.id === room.hostId && room.status === 'playing');
  document.querySelector('.toolbar-hint').textContent = isManual() ? '点击对手棋盘 / T 切换目标' : '自动分配目标，无需点击棋盘';
  const danger = game.board.slice(0, 5).some(row => row.some(Boolean));
  text('dangerLabel', game.pending ? `待接收 ${game.pending} 行${room.settings.counter ? ' · 消行可抵消' : ''}` : danger && game.alive ? '注意顶部空间 · 补齐障碍缺口可消除' : `补齐障碍缺口可消除${room.settings.cleanse ? ' · V 预约净化' : ''}`);
  $('mainBoard').parentElement.classList.toggle('is-danger', danger || game.pending > 0);
  drawBoard($('mainBoard'), game, true);
  renderMonitors(self, target);
  renderBomb();
  text('spectatorCount', `${room.players.filter(player => player.game?.alive).length}/${room.players.length}`);
  text('gameStateLabel', room.status === 'finished' ? '本轮已结束' : room.status === 'countdown' ? '准备开始' : '对战进行中');
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = !activeGame(); });
  renderOverlay();
}

function renderMonitors(self, target) {
  const room = state.room;
  show($('spectatorTools'), canSpectatorTap());
  const ids = new Set(room.players.map(player => player.id));
  for (const [id, node] of monitors) {
    if (!ids.has(id)) { node.remove(); monitors.delete(id); }
  }
  room.players.forEach((player, index) => {
    let node = monitors.get(player.id);
    if (!node) {
      node = element('div', 'monitor-card');
      node.setAttribute('role', 'group');
      node.dataset.id = player.id;
      const heading = element('div', 'monitor-top');
      heading.append(element('strong', 'monitor-name'), kickButton(player), element('span', 'monitor-badge'));
      const body = element('div', 'monitor-body');
      const canvas = element('canvas', 'mini-board');
      const detail = element('div', 'monitor-detail');
      detail.append(element('span', 'monitor-state'), element('strong', 'monitor-lines'), element('span', 'monitor-score'), element('span', 'monitor-pending'));
      body.append(canvas, detail);
      const badge = decorateBomb(element('span', 'bomb-badge is-hidden'));
      badge.setAttribute('aria-hidden', 'true');
      detail.replaceChildren(badge, ...detail.children);
      node.append(heading, body);
      let pointer = null;
      node.addEventListener('pointerdown', event => {
        if (!canSpectatorTap()) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now(), cancelled: false };
      });
      node.addEventListener('pointermove', event => {
        if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) pointer.cancelled = true;
      });
      node.addEventListener('pointercancel', () => { if (pointer) pointer.cancelled = true; });
      canvas.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (canSpectatorTap() && player.id !== state.id && state.room.players.find(other => other.id === player.id)?.game?.alive) spectatorTap(player.id, .5, .5);
        else if (activeGame() && isManual() && validOpponents().some(other => other.id === player.id)) send({ type: 'target', id: player.id });
      });
      node.addEventListener('click', event => {
        if (canSpectatorTap() && state.room.players.find(other => other.id === player.id)?.game?.alive && player.id !== state.id) {
          if (event.detail === 0) { spectatorTap(player.id, .5, .5); return; }
          if (!pointer || pointer.cancelled || Date.now() - pointer.time > 1000) return;
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
          spectatorTap(player.id, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
          pointer = null;
        } else if (activeGame() && isManual() && validOpponents().some(other => other.id === player.id)) send({ type: 'target', id: player.id });
      });
      monitors.set(player.id, node);
      $('playerMonitors').append(node);
    }
    const own = player.id === self.id;
    const selected = target?.id === player.id;
    node.classList.toggle('is-target', selected);
    node.classList.toggle('is-out', !player.game?.alive);
    node.dataset.color = index % 6;
    const teammate = (room.settings.mode === 'coop' || (room.settings.mode === 'teams' && player.team === self.team)) && !own;
    const tappable = canSpectatorTap() && !own && player.game?.alive;
    node.disabled = !tappable && (!activeGame() || !isManual() || own || teammate || !player.game?.alive);
    node.classList.toggle('is-tappable', Boolean(tappable));
    const kick = node.querySelector('.kick-button');
    show(kick, room.hostId === self.id && !own);
    kick.disabled = !state.connected;
    const canvas = node.querySelector('canvas');
    canvas.tabIndex = node.disabled ? -1 : 0;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-disabled', String(node.disabled));
    canvas.setAttribute('aria-label', `${player.name}的棋盘`);
    node.dataset.team = room.settings.mode === 'teams' ? player.team : '';
    node.setAttribute('aria-pressed', String(selected));
    node.setAttribute('aria-label', tappable ? `${player.name}的棋盘，点击送出观战效果` : own ? `${player.name}，你的棋盘` : teammate ? `${player.name}，队友` : `${player.name}的棋盘${isManual() ? '，点击攻击' : ''}`);
    node.querySelector('.monitor-name').textContent = player.name;
    node.querySelector('.monitor-badge').textContent = own ? '你' : player.bot ? '机器人' : teammate ? '队友' : room.bountyId === player.id ? '悬赏' : selected ? '目标 ⌖' : '';
    node.querySelector('.monitor-state').textContent = !player.connected ? '离线 · 可重连' : player.game?.alive ? '仍在场上' : `第 ${player.rank || '—'} 名`;
    node.querySelector('.monitor-lines').textContent = `${player.game?.lines || 0} 行`;
    node.querySelector('.monitor-score').textContent = `${(player.game?.score || 0).toLocaleString()} 分`;
    node.querySelector('.monitor-pending').textContent = player.game?.pending ? `待接收 +${player.game.pending}` : room.settings.mode === 'coop' ? `已救援 ${player.game?.helped || 0} 行` : room.settings.mode === 'dig' ? `剩余 ${player.game?.garbageRows ?? room.settings.digRows} 行障碍` : `已发送 ${player.game?.sent || 0} 行`;
    drawBoard(node.querySelector('canvas'), player.game);
  });
}

function renderClock() {
  const room = state.room;
  if (!room || room.status === 'lobby') return;
  const now = room.status === 'finished' ? Math.min(serverNow(), room.deadline || serverNow()) : serverNow();
  let label = '坚持到最后';
  if (room.settings.mode === 'timed') {
    const seconds = Math.max(0, Math.ceil((room.deadline - now) / 1000));
    label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  } else if (room.settings.mode === 'sprint') label = `${me()?.game?.lines || 0} / ${room.settings.goal} 行`;
  else if (room.settings.mode === 'practice') label = '自由练习';
  else if (room.settings.mode === 'dig') label = `剩余 ${me()?.game?.garbageRows ?? room.settings.digRows} 行障碍`;
  else if (room.settings.mode === 'coop') label = `第 ${room.wave || 0} / ${room.settings.waves} 波`;
  else if (room.settings.mode === 'teams') label = `你在${me()?.team === 'red' ? '红' : '蓝'}队`;
  text('matchClock', label);
  const special = [];
  if (room.settings.mode === 'coop' && room.status === 'playing') {
    const deadline = room.coopEndsAt || room.nextWaveAt;
    special.push(`${room.coopEndsAt ? '过关倒计时' : '下一波'} ${Math.max(0, Math.ceil((deadline - now) / 1000))} 秒`);
  }
  if (room.nextEnvironmentAt) special.push(`乱扔垃圾 ${Math.max(0, Math.ceil((room.nextEnvironmentAt - now) / 1000))} 秒后`);
  if (room.bountyId && room.settings.mode !== 'practice') special.push(`悬赏 ${room.players.find(player => player.id === room.bountyId)?.name || '等待轮换'} · ${Math.max(0, Math.ceil((room.nextBountyAt - now) / 1000))} 秒`);
  if (isManual() && room.settings.cooldown && me()?.targetChangedAt) {
    const seconds = Math.ceil((me().targetChangedAt + 3000 - now) / 1000);
    if (seconds > 0) special.push(`目标冷却 ${seconds} 秒`);
  }
  text('specialRuleLabel', special.join(' / '));
}

function renderCountdown(room) {
  const settings = room.settings;
  const practice = settings.mode === 'practice';
  text('countdownNumber', String(Math.max(1, Math.ceil((room.startsAt - serverNow()) / 1000))));
  text('countdownMode', Rules.modes[settings.mode][0]);
  const goal = Rules.summary(settings)[0];
  text('countdownGoal', settings.mode === 'teams' ? `你在${me()?.team === 'red' ? '红' : '蓝'}队。${goal}` : goal);
  text('countdownAttack', settings.mode === 'coop' ? '消行自动救援队友' : !Rules.hostile(settings) ? '本局不发送攻击' : Rules.attacks[settings.attack][0]);
  text('countdownAttackHint', settings.mode === 'coop' ? '先抵消自己的来袭，余量帮助压力最大的队友，不增加操作键。' : !Rules.hostile(settings) ? '同样的方块序列，无需选择攻击目标。' : Rules.attacks[settings.attack][1]);
  const defense = ['灰色障碍补齐缺口即可消除'];
  if (settings.randomGarbage) defense.push('乱扔垃圾：每 30 秒增加 1 行环境障碍');
  if (settings.hotPotato) defense.push('持有炸弹累计消 1 行，按 B 或点按钮传递；爆炸立即加 1 行');
  if ((Rules.hostile(settings) || settings.mode === 'coop') && settings.counter) defense.push('消行先抵消来袭');
  if ((Rules.hostile(settings) || settings.mode === 'coop') && settings.digBonus) defense.push('挖掘额外抵消');
  if (settings.cleanse && settings.mode !== 'dig') defense.push('6 能量按 V 净化');
  if (Rules.hostile(settings) && settings.combo) defense.push('连续消行有攻击加成');
  text('countdownDefense', defense.join('；') + '。');
}

function renderOverlay() {
  renderClock();
  const room = state.room;
  if (!room || room.status === 'lobby') return;
  const countdown = state.connected && room.status === 'countdown';
  show($('countdownModal'), countdown);
  const nextCountdownKey = `${room.code}:${room.roundId}:${room.startsAt}`;
  if (countdown && countdownKey !== nextCountdownKey) {
    countdownAnimation?.cancel();
    countdownAnimation = null;
    countdownKey = nextCountdownKey;
    clearIncoming();
  }
  if (countdown) {
    const remaining = Math.max(0, room.startsAt - serverNow());
    if (!countdownAnimation && $('countdownModal').animate) {
      const duration = Math.min(1000, remaining);
      countdownAnimation = $('countdownModal').animate([
        { opacity: Math.min(1, remaining / 1000) }, { opacity: 0 },
      ], { delay: Math.max(0, remaining - 1000), duration, fill: 'forwards', easing: 'ease-in-out' });
    }
  } else {
    countdownAnimation?.cancel();
    countdownAnimation = null;
    countdownKey = null;
  }
  let label = '';
  if (!state.connected) label = '正在重新连接…';
  else if (countdown) renderCountdown(room);
  else if (!me()?.game?.alive) label = '本轮已淘汰\n继续观看朋友的棋盘';
  text('overlayMessage', label);
  show($('boardOverlay'), Boolean(label));
}

function renderFinish(self) {
  const outcome = state.room.outcome;
  const results = outcome?.results || [];
  const won = outcome?.winnerIds.includes(self.id);
  text('finishTitle', state.room.settings.mode === 'coop' ? (outcome?.winningTeam === 'coop' ? '守城成功，大家赢了！' : '守城失败，再来一次。') : outcome?.winningTeam ? `${outcome.winningTeam === 'red' ? '红' : '蓝'}队获胜。` :
    state.room.settings.mode === 'practice' ? '练习结束。' : outcome?.winnerIds.length > 1 ? '本轮并列获胜。' : won ? '这一局，你赢了。' :
    outcome?.winnerIds.length ? `${results.find(player => player.id === outcome.winnerIds[0])?.name || '玩家'} 赢得本轮。` : '本轮无人获胜。');
  $('rankingList').replaceChildren(element('p', 'rule-description', outcome?.reason || '本轮结束'), ...results.map(player => {
    const row = element('div', 'ranking-row');
    row.append(element('strong', 'ranking-place', String(player.rank || '—').padStart(2, '0')),
      element('span', 'ranking-name', player.name + (player.id === self.id ? '（你）' : '') +
        (state.room.settings.mode === 'teams' ? ` / ${player.team === 'red' ? '红' : '蓝'}队` : '')),
      element('span', 'ranking-stats', `${player.lines} 行 / ${player.score} 分\n挖掘 ${player.dug} · 抵消 ${player.cancelled} · 净化 ${player.purified}${state.room.settings.mode === 'coop' ? ` · 救援 ${player.helped || 0}` : ''}`));
    return row;
  }));
  const host = self.id === state.room.hostId;
  text('rematchButton', host ? '回到大厅，再来一局' : '等待房主返回大厅');
  $('rematchButton').disabled = !host;
}

function stopRepeat(source) {
  if (source === undefined) {
    for (const key of [...heldInputs.keys()]) stopRepeat(key);
    gesture = null;
    return;
  }
  const input = heldInputs.get(source);
  if (!input) return;
  clearTimeout(input.delay);
  clearInterval(input.repeat);
  heldInputs.delete(source);
}
function startRepeat(value, source) {
  stopRepeat(source);
  action(value);
  if (!activeGame() || !['left', 'right', 'down'].includes(value)) return;
  // Only one repeating direction at once; action keys do not cancel it.
  for (const key of [...heldInputs.keys()]) stopRepeat(key);
  const input = { delay: null, repeat: null };
  heldInputs.set(source, input);
  input.delay = setTimeout(() => {
    input.repeat = setInterval(() => action(value), value === 'down' ? 40 : 60);
  }, 170);
}
function cycleTarget() {
  if (!activeGame() || !isManual()) return;
  const targets = validOpponents();
  if (!targets.length) return;
  const current = targets.findIndex(player => player.id === me().targetId);
  send({ type: 'target', id: targets[(current + 1) % targets.length].id });
}
const KEY_ACTIONS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'rotate',
  KeyA: 'left', KeyD: 'right', KeyS: 'down', KeyW: 'rotate',
  KeyX: 'rotate', KeyZ: 'rotateBack', Space: 'drop', KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold', KeyV: 'cleanse',
};
window.addEventListener('keydown', event => {
  if (!activeGame() || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.code === 'KeyB') { event.preventDefault(); if (!event.repeat) passBomb(); return; }
  if (event.code === 'KeyT') { event.preventDefault(); if (!event.repeat) cycleTarget(); return; }
  const value = KEY_ACTIONS[event.code];
  if (!value) return;
  event.preventDefault();
  if (!event.repeat) startRepeat(value, event.code);
});
window.addEventListener('keyup', event => stopRepeat(event.code));
window.addEventListener('blur', () => stopRepeat());
document.addEventListener('visibilitychange', () => { if (document.hidden) stopRepeat(); });
document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    startRepeat(button.dataset.action, `pointer:${event.pointerId}`);
  });
  button.addEventListener('pointerup', event => stopRepeat(`pointer:${event.pointerId}`));
  button.addEventListener('pointercancel', event => stopRepeat(`pointer:${event.pointerId}`));
  button.addEventListener('lostpointercapture', event => stopRepeat(`pointer:${event.pointerId}`));
  button.addEventListener('click', event => { if (event.detail === 0) action(button.dataset.action); });
});
$('inputModeButton').addEventListener('click', () => {
  stopRepeat();
  inputMode = inputMode === 'buttons' ? 'gesture' : 'buttons';
  saved('block-relay-input', inputMode);
  renderInputMode();
});
$('soundButton').addEventListener('click', () => { audio.setEnabled(!audio.isEnabled()); renderSound(); });
const gestureBoard = $('mainBoard');
gestureBoard.addEventListener('pointerdown', event => {
  if (inputMode !== 'gesture' || !activeGame() || event.pointerType === 'mouse' || gesture) return;
  event.preventDefault();
  gestureBoard.setPointerCapture(event.pointerId);
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, started: Date.now() };
});
gestureBoard.addEventListener('pointermove', event => {
  if (!gesture || gesture.id !== event.pointerId || !activeGame()) return;
  event.preventDefault();
  const step = Math.max(16, gestureBoard.getBoundingClientRect().width / 10);
  if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 8) gesture.moved = true;
  let count = 0;
  while (Math.abs(event.clientX - gesture.x) >= step && count++ < 10) {
    const direction = event.clientX > gesture.x ? 1 : -1;
    action(direction > 0 ? 'right' : 'left');
    gesture.x += direction * step;
  }
  count = 0;
  while (event.clientY - gesture.y >= step && count++ < 20) { action('down'); gesture.y += step; }
  if (event.clientY < gesture.y) gesture.y = event.clientY;
});
gestureBoard.addEventListener('pointerup', event => {
  if (!gesture || gesture.id !== event.pointerId) return;
  if (!gesture.moved && Date.now() - gesture.started < 350) action('rotate');
  gesture = null;
});
gestureBoard.addEventListener('pointercancel', () => { gesture = null; });
gestureBoard.addEventListener('lostpointercapture', () => { gesture = null; });
$('chatPanel').classList.toggle('is-collapsed', chatCollapsed);
$('chatToggle').setAttribute('aria-expanded', String(!chatCollapsed));
$('chatToggle').addEventListener('click', () => {
  chatCollapsed = !chatCollapsed;
  $('chatPanel').classList.toggle('is-collapsed', chatCollapsed);
  $('chatToggle').setAttribute('aria-expanded', String(!chatCollapsed));
  if (!chatCollapsed) scrollChatLatest();
});
$('chatLatest').addEventListener('click', scrollChatLatest);
$('chatMessages').addEventListener('scroll', () => {
  const list = $('chatMessages');
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 36) {
    chatUnread = 0; text('chatUnread', ''); show($('chatLatest'), false);
  }
});
$('chatInput').addEventListener('focus', () => stopRepeat());
$('chatInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); submitChat();
  }
});
$('chatForm').addEventListener('submit', event => { event.preventDefault(); submitChat(); });
chatControls();
renderSound();
renderInputMode();
$('leaderboardModeSelect').replaceChildren(...Object.entries(Rules.modes).map(([value, [name]]) => {
  const option = element('option', '', name);
  option.value = value;
  return option;
}));
const savedLeaderboardMode = saved('block-relay-leaderboard-mode');
$('leaderboardModeSelect').value = Object.hasOwn(Rules.modes, savedLeaderboardMode) ? savedLeaderboardMode : Rules.defaults.mode;
$('leaderboardModeSelect').addEventListener('change', () => {
  saved('block-relay-leaderboard-mode', $('leaderboardModeSelect').value);
  renderLeaderboard();
});
$('refreshLeaderboardButton').addEventListener('click', () => {
  if (send({ type: 'leaderboard' })) text('leaderboardStatus', '正在刷新最高分…');
});
$('openRuleOptions').addEventListener('click', () => {
  if (state.room?.status !== 'lobby') return;
  text('ruleOptionsMessage', '');
  renderRuleOptions();
  if (!$('ruleOptionsDialog').open) $('ruleOptionsDialog').showModal();
  $('closeRuleOptions').focus();
});
$('closeRuleOptions').addEventListener('click', closeRuleOptions);
$('ruleOptionsDialog').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeRuleOptions(); }
});
$('ruleOptionsDialog').addEventListener('click', event => {
  const rect = $('ruleOptionsDialog').getBoundingClientRect();
  if (event.target === $('ruleOptionsDialog') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeRuleOptions();
});
$('findRoomsButton').addEventListener('click', openRoomFinder);
$('closeRoomFinder').addEventListener('click', closeRoomFinder);
$('roomFinder').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeRoomFinder(); }
});
$('roomFinder').addEventListener('click', event => {
  const rect = $('roomFinder').getBoundingClientRect();
  if (event.target === $('roomFinder') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeRoomFinder();
});
window.addEventListener('resize', alignChatHeight);
window.addEventListener('resize', syncWaitingViewport);
window.addEventListener('orientationchange', syncWaitingViewport);
window.visualViewport?.addEventListener('resize', syncWaitingViewport);
window.visualViewport?.addEventListener('scroll', syncWaitingViewport);
if (window.ResizeObserver) new ResizeObserver(alignChatHeight).observe($('waitingPanel'));
$('roomSearchInput').addEventListener('input', renderDirectory);
$('refreshRoomsButton').addEventListener('click', () => {
  if (send({ type: 'rooms' })) text('roomDirectoryMessage', '正在刷新房间…');
});
$('createButton').addEventListener('click', () => join('create'));
$('joinButton').addEventListener('click', () => join('join'));
$('roomInput').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('roomInput').addEventListener('keydown', event => { if (event.key === 'Enter') join('join'); });
$('leaveButton').addEventListener('click', () => {
  saved('block-relay-token', null);
  if (!send({ type: 'leave' })) resetRoom();
});
$('addBotButton').addEventListener('click', () => {
  if (!state.connected || state.room?.hostId !== state.id || state.room.status !== 'lobby') return;
  send({ type: 'addBot', level: $('botLevelSelect').value });
});
$('readyButton').addEventListener('click', () => send({ type: 'ready', ready: !me()?.ready }));
$('startButton').addEventListener('click', () => send({ type: 'start' }));
$('rematchButton').addEventListener('click', () => send({ type: 'rematch' }));
$('copyRoomButton').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.room.code);
    text('roomMessage', '房间码已复制。');
  } catch { text('roomMessage', `房间码：${state.room.code}。可手动选中并复制。`); }
});
$('teamSelect').addEventListener('change', event => send({ type: 'team', team: event.target.value }));
$('cleanseButton').addEventListener('click', () => action('cleanse'));
decorateBomb($('mainBombBadge'));
$('passBombButton').addEventListener('click', passBomb);
$('endPracticeButton').addEventListener('click', () => send({ type: 'endPractice' }));
setupSettings();
$('nameInput').value = Rules.normalizeName(saved('block-relay-name'));
function limitNickname(event) {
  if (event.isComposing) return;
  $('nameInput').value = Array.from($('nameInput').value).slice(0, 12).join('');
}
$('nameInput').addEventListener('input', limitNickname);
$('nameInput').addEventListener('compositionend', limitNickname);
$('nameInput').addEventListener('blur', () => { $('nameInput').value = Rules.normalizeName($('nameInput').value); });
$('createButton').disabled = true;
$('joinButton').disabled = true;
fetch('/api/info').then(response => response.json()).then(info => {
  text('lanHint', info.addresses.length ? `朋友访问：${info.addresses.join(' 或 ')}` : `朋友访问：本机局域网 IP:${location.port || '80'}`);
}).catch(() => {});
setInterval(renderOverlay, 150);
connect();
