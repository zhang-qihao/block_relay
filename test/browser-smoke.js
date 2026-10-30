'use strict';

// Real Chrome + actual page/WebSocket/server, isolated from any user match.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const { createGame } = require('../game');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(30); }
  throw new Error(`Timed out: ${label}`);
}
async function connection(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  return { socket, call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}
async function main() {
  const executable = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await fs.access(executable);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'block-relay-browser-'));
  const app = createApp({ countdownMs: 5000 });
  let chrome;
  const connections = [];
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
    chrome.on('error', error => { console.error(error.message); });
    const port = await until(async () => {
      try { return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; }
    }, 'Chrome DevTools');
    async function page(newWindow = false) {
      let info;
      if (newWindow) {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const browser = await connection(version.webSocketDebuggerUrl);
        connections.push(browser);
        const isolated = await browser.call('Target.createBrowserContext');
        const created = await browser.call('Target.createTarget', { url: 'about:blank', newWindow: true, background: false, browserContextId: isolated.browserContextId });
        info = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.id === created.targetId), 'new window target');
      } else info = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const cdp = await connection(info.webSocketDebuggerUrl);
      connections.push(cdp);
      const errors = [];
      const audioContexts = [];
      const receivedInteractions = [];
      cdp.socket.on('message', raw => {
        const message = JSON.parse(raw);
        if (message.method === 'WebAudio.contextCreated') audioContexts.push(message.params.context);
        if (message.method === 'WebAudio.contextChanged') {
          const context = audioContexts.find(item => item.contextId === message.params.context.contextId);
          if (context) Object.assign(context, message.params.context);
        }
        if (message.method === 'Network.webSocketFrameReceived') {
          try {
            const data = JSON.parse(message.params.response.payloadData);
            if (data.type === 'spectatorInteraction') receivedInteractions.push(data.interaction);
          } catch {}
        }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      });
      await cdp.call('Network.enable');
      await cdp.call('WebAudio.enable');
      await cdp.call('Runtime.enable');
      await cdp.call('Page.enable');
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await cdp.call('Page.navigate', { url: origin });
      async function evaluate(expression) {
        const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      await until(() => evaluate(`typeof state !== 'undefined' && state.connected === true && document.querySelector('#createButton')?.disabled === false`), 'page connection');
      return { cdp, evaluate, errors, audioContexts, receivedInteractions };
    }
    const a = await page();
    const b = await page();
    await fs.mkdir(path.join(__dirname, '../.test-artifacts'), { recursive: true });
    async function layoutChecks(page, stage) {
      for (const width of [1440, 1024, 768, 375, 320]) {
        await page.cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 375 });
        const layout = await page.evaluate(`(() => {
          const board=document.querySelector('#mainBoard').getBoundingClientRect();
          const controls=document.querySelector('.touch-controls').getBoundingClientRect();
          const queue=document.querySelector('#attackQueue').getBoundingClientRect();
          return {overflow:document.documentElement.scrollWidth>innerWidth,
            boardRatio:board.width?board.height/board.width:2,boardWidth:board.width,
            controlWidth:controls.width,queueWidth:queue.width};
        })()`);
        assert.equal(layout.overflow, false, `${stage} overflow at ${width}`);
        if (stage === 'game') {
          assert.ok(Math.abs(layout.boardRatio - 2) < .02, `board ratio at ${width}`);
          assert.ok(layout.boardWidth >= 180, `board too small at ${width}`);
          assert.ok(layout.controlWidth >= 180, `controls too small at ${width}`);
          assert.ok(layout.queueWidth >= 50, `reserve too narrow at ${width}`);
        }
        if (width === 1440 || width === 375) {
          const shot = await page.cdp.call('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(__dirname, `../.test-artifacts/layout-${stage}-${width}.png`), Buffer.from(shot.data, 'base64'));
        }
      }
      await page.cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    }
    await layoutChecks(a, 'entry');
    await a.evaluate(`document.querySelector('#nameInput').value='阿岚'; document.querySelector('#createButton').click()`);
    const room = await until(() => [...app.rooms.values()][0], 'created room');
    await b.evaluate(`document.querySelector('#nameInput').value='小周'; document.querySelector('#roomInput').value='${room.code}'; document.querySelector('#joinButton').click()`);
    await until(() => room.players.size === 2, 'joined player');
    await until(() => a.evaluate(`!document.querySelector('#waitingPanel').classList.contains('is-hidden')`), 'lobby rendered');
    await layoutChecks(a, 'lobby');
    await b.evaluate(`document.querySelector('#readyButton').click()`);
    await until(() => a.evaluate(`document.querySelector('#startButton').disabled === false`), 'all ready');
    await a.evaluate(`document.querySelector('#startButton').click()`);
    await until(() => b.evaluate(`!document.querySelector('#countdownModal').classList.contains('is-hidden')`), 'countdown dialog');
    const countdown = await b.evaluate(`({mode: document.querySelector('#countdownMode').textContent, opacity: getComputedStyle(document.querySelector('#countdownModal')).opacity})`);
    assert.equal(countdown.mode, '经典生存');
    assert.equal(Number(countdown.opacity), 1);
    await until(() => b.evaluate(`(() => {const n=document.querySelector('#countdownModal'); const o=Number(getComputedStyle(n).opacity); return !n.classList.contains('is-hidden') && o > .05 && o < .9;})()`), 'final second fades', 7000);
    await until(() => room.status === 'playing', 'match start');
    await until(() => a.evaluate(`document.querySelector('#countdownModal').classList.contains('is-hidden')`), 'countdown gone');
    await layoutChecks(a, 'game');
    // Real touch unlocks audio and checks compact input at portrait/landscape sizes.
    await a.cdp.call('Page.bringToFront');
    for (const [width, height] of [[375, 812], [320, 640], [812, 375], [667, 375], [736, 414]]) {
      await a.cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await a.cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const layout = await a.evaluate(`(() => {
        const board=document.querySelector('#mainBoard').getBoundingClientRect(), pad=document.querySelector('#mobileControls').getBoundingClientRect();
        const buttons=[...document.querySelectorAll('.touch-controls button')].filter(n=>n.getBoundingClientRect().width>0);
        return {overflow:document.documentElement.scrollWidth>innerWidth,board:board.toJSON(),pad:pad.toJSON(),minHeight:Math.min(...buttons.map(n=>n.getBoundingClientRect().height)),
          buttonsVisible:buttons.every(n=>{const r=n.getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight && n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})};
      })()`);
      assert.equal(layout.overflow, false, `mobile overflow ${width}x${height}`);
      const overlaps = layout.board.right > layout.pad.left && layout.board.left < layout.pad.right && layout.board.bottom > layout.pad.top && layout.board.top < layout.pad.bottom;
      assert.equal(overlaps, false, `controls cover board ${width}x${height}`);
      assert.ok(layout.minHeight >= 44);
      assert.equal(layout.buttonsVisible, true, `controls not clickable ${width}x${height}`);
      if (width === 667 || width === 736) {
        // An O piece rotates to the same matrix. Use a known non-O piece only
        // in this isolated fixture, then wait for the real client snapshot.
        const game = [...room.players.values()][0].game;
        const matrix = [[0, 1, 0], [1, 1, 1], [0, 0, 0]];
        game.active = { type: 'T', matrix, x: 3, y: 0 };
        game.fallTime = 0;
        game.lockTime = 0;
        await a.evaluate(`document.querySelector('[data-action="left"]').click()`);
        await until(() => a.evaluate(`me().game.active.type === 'T' && me().game.active.x === 2 && JSON.stringify(me().game.active.matrix) === ${JSON.stringify(JSON.stringify(matrix))}`), 'non-O rotation fixture synchronized');
        const point = await a.evaluate(`(() => {const r=document.querySelector('[data-action="rotate"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
        const before = await a.evaluate(`JSON.stringify(me().game.active.matrix)`);
        await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await until(() => a.evaluate(`JSON.stringify(me().game.active.matrix) !== ${JSON.stringify(before)}`), `rotation at ${width}x${height}`);
        const shot = await a.cdp.call('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(__dirname, `../.test-artifacts/landscape-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
    await a.cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    const rotatePoint = await a.evaluate(`(() => {const r=document.querySelector('[data-action="rotate"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [rotatePoint] });
    await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(() => a.audioContexts.some(context => context.contextState === 'running'), 'audio unlocked by real touch');
    await a.evaluate(`document.querySelector('#inputModeButton').click()`);
    const gesturePoint = await a.evaluate(`(() => {const r=document.querySelector('#mainBoard').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height*.4};})()`);
    await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [gesturePoint] });
    await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gesturePoint.x + 25, y: gesturePoint.y + 30 }] });
    await a.cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const mobilePadShot = await a.cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(__dirname, '../.test-artifacts/mobile-controls.png'), Buffer.from(mobilePadShot.data, 'base64'));
    await a.evaluate(`document.querySelector('#inputModeButton').click()`);
    await a.cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    console.log('Mobile portrait/small/landscape controls do not cover board, real touch gestures and AudioContext running verified.');
    const [attacker, victim] = [...room.players.values()];
    function attackBoard(game) {
      game.board = Array.from({ length: 20 }, () => Array(10).fill(null));
      for (let y = 16; y < 20; y++) game.board[y] = Array.from({ length: 10 }, (_, x) => x === 4 ? null : 'J');
      game.active = { type: 'I', matrix: [[1], [1], [1], [1]], x: 4, y: 0 };
    }
    attackBoard(attacker.game);
    await b.cdp.call('Page.bringToFront');
    await a.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => victim.game.pending === 4, 'queued attack');
    await until(() => b.evaluate(`document.querySelector('#incomingToastText').textContent.includes('阿岚')`), 'attacker warning');
    assert.equal(victim.game.received, 0);
    await until(() => b.evaluate(`document.querySelectorAll('#attackQueue .reserve-row').length === 4`), 'four visible reserved rows');
    assert.equal(await b.evaluate(`document.querySelector('#attackValue').textContent`), '待入盘');
    await until(() => Date.now() >= victim.game.garbage[0].readyAt, 'two-second buffer');
    await b.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => victim.game.received === 4, 'actual garbage insertion');
    await until(() => b.evaluate(`!document.querySelector('#hitOverlay').classList.contains('is-hidden') && document.querySelector('#hitOverlay').textContent.includes('阿岚')`), 'visible hit overlay');
    await sleep(110);
    const hit = await b.evaluate(`(() => {
      const overlay=document.querySelector('#hitOverlay'), canvas=document.querySelector('#battleEffects');
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let painted=0; for(let i=3;i<pixels.length;i+=4) if(pixels[i]) painted++;
      return {text:overlay.textContent, opacity:Number(getComputedStyle(overlay).opacity), display:getComputedStyle(overlay).display, painted, title:document.querySelector('#incomingToastTitle').textContent};
    })()`);
    assert.match(hit.text, /阿岚/);
    assert.match(hit.text, /命中 \+4 行/);
    assert.ok(hit.opacity > .1 && hit.display !== 'none');
    assert.ok(hit.painted > 1000, `Expected actual FX pixels, got ${hit.painted}`);
    assert.match(hit.title, /实际受击/);
    await fs.mkdir(path.join(__dirname, '../.test-artifacts'), { recursive: true });
    const shot = await b.cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(__dirname, '../.test-artifacts/actual-hit.png'), Buffer.from(shot.data, 'base64'));
    console.log('Desktop browser: 5-second popup + fade, attacker launch, 2-second buffer, real hit overlay and FX pixels verified.', hit);

    // Reverse direction on a real mobile viewport, keeping the same client sessions.
    await a.cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await a.cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    // Reset only the isolated test boards, not the users' game or the match state.
    await a.cdp.call('Page.bringToFront');
    attacker.game = createGame(42, room.settings);
    attackBoard(victim.game);
    await b.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => attacker.game.pending === 4, 'reverse attack');
    attacker.game.board = Array.from({ length: 20 }, () => Array(10).fill(null));
    for (let y = 18; y < 20; y++) attacker.game.board[y] = Array.from({ length: 10 }, (_, x) => x === 4 ? null : 'J');
    attacker.game.active = { type: 'I', matrix: [[1], [1], [1], [1]], x: 4, y: 0 };
    await a.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => attacker.game.pending === 2, 'two reserved rows cancelled');
    await until(() => a.evaluate(`document.querySelectorAll('#attackQueue .reserve-row').length === 2 && document.querySelectorAll('#cancelledRows .reserve-row').length === 2`), 'mobile pending and cancelled visual rows');
    assert.equal(await a.evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
    const reserveShot = await a.cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(__dirname, '../.test-artifacts/mobile-reserve.png'), Buffer.from(reserveShot.data, 'base64'));
    await until(() => Date.now() >= attacker.game.garbage[0].readyAt, 'reverse buffer');
    await a.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => attacker.game.received === 2, 'reverse insertion');
    await until(() => a.evaluate(`document.querySelector('#hitOverlay').textContent.includes('小周')`), 'reverse source shown');
    const mobile = await a.evaluate(`({source: document.querySelector('#hitOverlay').textContent, visible: getComputedStyle(document.querySelector('#hitOverlay')).display, title:document.querySelector('#incomingToastTitle').textContent})`);
    assert.match(mobile.source, /小周/);
    assert.notEqual(mobile.visible, 'none');
    const mobileShot = await a.cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(__dirname, '../.test-artifacts/mobile-hit.png'), Buffer.from(mobileShot.data, 'base64'));
    assert.deepEqual(a.errors, []);
    assert.deepEqual(b.errors, []);
    console.log('Mobile browser + reduced motion: reverse attack and real source hit verified. No page exceptions.');

    // Complete the isolated round and exercise the actual simplified lobby.
    victim.game.alive = false;
    await until(() => room.status === 'finished', 'old round ends');
    await a.evaluate(`document.querySelector('#rematchButton').click()`);
    await until(() => room.status === 'lobby', 'return lobby');
    const lobby = await a.evaluate(`({closed:!document.querySelector('#customRules').open, details:document.querySelectorAll('details').length,
      presets:document.querySelector('#presetSelect').options.length, overflow:document.documentElement.scrollWidth > innerWidth})`);
    assert.equal(lobby.closed, true);
    assert.equal(lobby.details, 1);
    assert.equal(lobby.presets, 10);
    assert.equal(lobby.overflow, false);
    const lobbyShot = await a.cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(__dirname, '../.test-artifacts/mobile-lobby.png'), Buffer.from(lobbyShot.data, 'base64'));
    await a.evaluate(`document.querySelector('#presetSelect').value='dig'; document.querySelector('#presetSelect').dispatchEvent(new Event('change'))`);
    await until(() => room.settings.mode === 'dig', 'dig preset synchronized');
    await a.evaluate(`document.querySelector('#customRules').open=true; document.querySelector('#digRowsSelect').value='4'; document.querySelector('#digRowsSelect').dispatchEvent(new Event('change'))`);
    await until(() => room.settings.digRows === 4, 'dig rows customized');
    await a.evaluate(`document.querySelector('#readyButton').click()`);
    await b.evaluate(`document.querySelector('#readyButton').click()`);
    await until(() => a.evaluate(`!document.querySelector('#startButton').disabled`), 'dig ready');
    await a.evaluate(`document.querySelector('#startButton').click()`);
    await until(() => room.status === 'playing', 'dig started', 7000);
    const digGame = attacker.game;
    const hole = digGame.board[19].indexOf(null);
    digGame.active = { type:'I', matrix:[[1],[1],[1],[1]], x:hole, y:0 };
    await a.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => room.status === 'finished', 'dig completed');
    const digTitle = await a.evaluate(`document.querySelector('#finishTitle').textContent`);
    assert.match(digTitle, /你赢了/);
    await a.evaluate(`document.querySelector('#rematchButton').click()`);
    await until(() => room.status === 'lobby', 'dig rematch');
    await a.evaluate(`document.querySelector('#presetSelect').value='coop'; document.querySelector('#presetSelect').dispatchEvent(new Event('change'))`);
    await until(() => room.settings.mode === 'coop', 'coop preset');
    await until(() => a.evaluate(`document.querySelector('#presetSelect').value === 'coop' && document.querySelector('#readyButton').textContent === '我准备好了'`), 'host coop state rendered');
    await until(() => b.evaluate(`document.querySelector('#presetSelect').value === 'coop' && document.querySelector('#readyButton').textContent === '我准备好了'`), 'guest coop state rendered');
    await a.evaluate(`document.querySelector('#readyButton').click()`);
    await b.evaluate(`document.querySelector('#readyButton').click()`);
    await until(() => a.evaluate(`!document.querySelector('#startButton').disabled`), 'coop ready');
    await a.evaluate(`document.querySelector('#startButton').click()`);
    await until(() => room.status === 'playing', 'coop started', 7000);
    assert.equal(await a.evaluate(`document.querySelector('#targetName').textContent`), '自动救援队友');
    const { enqueueGarbage } = require('../game');
    enqueueGarbage(victim.game, 4, Date.now());
    attackBoard(attacker.game);
    await b.cdp.call('Page.bringToFront');
    await a.evaluate(`document.querySelector('[data-action="drop"]').click()`);
    await until(() => attacker.game.helped === 4, 'coop rescue');
    assert.equal(victim.game.pending, 0);
    assert.equal(attacker.game.sent, 0);
    await a.evaluate(`document.querySelector('[data-action="left"]').click()`);
    room.wave = room.settings.waves;
    room.nextWaveAt = null;
    room.coopEndsAt = Date.now() - 1;
    await until(() => room.status === 'finished', 'coop victory');
    await until(() => a.evaluate(`document.querySelector('#finishTitle').textContent.includes('大家赢了')`), 'coop UI victory');
    assert.deepEqual(a.errors, []);
    assert.deepEqual(b.errors, []);
    console.log('Real mobile lobby: nine presets, one closed customization section, no horizontal overflow. Dig victory and cooperative rescue/victory passed.');

    // Add the third client in a separate browser window so macOS headless does
    // not suspend the receiver's compositor while driving another target.
    await a.evaluate(`document.querySelector('#rematchButton').click()`);
    await until(() => room.status === 'lobby', 'spectator lobby');
    await until(() => a.evaluate(`!document.querySelector('#waitingPanel').classList.contains('is-hidden')`), 'spectator lobby page rendered');
    const c = await page(true);
    await c.evaluate(`document.querySelector('#nameInput').value='观众'; document.querySelector('#roomInput').value='${room.code}'; document.querySelector('#joinButton').click()`);
    try {
      await until(() => room.players.size === 3, 'spectator joined');
    } catch (error) {
      console.error('Spectator join diagnostics', await c.evaluate(`({name:document.querySelector('#nameInput').value,code:document.querySelector('#roomInput').value,message:document.querySelector('#lobbyMessage').textContent,room:state.room?.code,id:state.id,connected:state.connected})`), { code: room.code, status: room.status, players: room.players.size });
      throw error;
    }
    await a.evaluate(`document.querySelector('#presetSelect').value='friends'; document.querySelector('#presetSelect').dispatchEvent(new Event('change'))`);
    for (const client of [a, b, c]) {
      await until(() => client.evaluate(`document.querySelector('#presetSelect').value === 'friends' && document.querySelector('#readyButton').textContent === '我准备好了'`), 'spectator ready UI');
      await client.evaluate(`document.querySelector('#readyButton').click()`);
    }
    await until(() => a.evaluate(`!document.querySelector('#startButton').disabled`), 'spectator match ready');
    await a.evaluate(`document.querySelector('#startButton').click()`);
    await until(() => room.status === 'playing', 'spectator match start', 7000);
    const viewer = [...room.players.values()][2];
    viewer.game.alive = false;
    await c.cdp.call('Page.bringToFront');
    await until(() => c.evaluate(`!document.querySelector('#spectatorTools').classList.contains('is-hidden')`), 'spectator toolbar');
    await b.cdp.call('Page.bringToFront');
    await b.cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    const fxInfo = [];
    // Desktop sender -> mobile main board. Browser mouse input invokes pointer/click handlers.
    for (const [index, effect] of ['glass', 'tomato', 'confetti', 'hand', 'firework'].entries()) {
      await c.evaluate(`document.querySelector('[data-effect="${effect}"]').click()`);
      const point = await c.evaluate(`(() => {const r=document.querySelector('[data-id="${victim.id}"] canvas').getBoundingClientRect();return {x:r.left+r.width*.3,y:r.top+r.height*.4};})()`);
      const previous = room.interactionId;
      await c.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await c.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await until(() => room.interactionId > previous, `real spectator click ${effect}`);
      const interaction = await until(() => b.receivedInteractions.find(item => item.id === previous + 1), 'immediate spectator message');
      assert.ok(Math.abs(interaction.x - .3) < .02 && Math.abs(interaction.y - .4) < .02);
      assert.equal(interaction.effect, effect);
      await sleep(150);
      const pixels = await b.evaluate(`(() => {
        const board=document.querySelector('#mainBoard').getBoundingClientRect(), canvas=document.querySelector('#battleEffects'),ctx=canvas.getContext('2d');
        const x=Math.round(board.left+board.width*.3),y=Math.round(board.top+board.height*.4);
        const data=ctx.getImageData(x-8,y-8,16,16).data; let painted=0;
        for(let i=3;i<data.length;i+=4) if(data[i]) painted++;
        return painted;
      })()`);
      if (!pixels) console.log('Spectator pixel diagnostic', await b.evaluate(`({hidden:document.hidden, board:document.querySelector('#mainBoard').getBoundingClientRect().toJSON(), canvas:[document.querySelector('#battleEffects').width,document.querySelector('#battleEffects').height], viewport:[innerWidth,innerHeight], interactions:state.room.interactions, selected:state.id, body:document.body.scrollHeight})`));
      assert.ok(pixels > 0, `real effect ${effect} has no pixels at mapped point`);
      fxInfo.push({ effect, pixels });
      if (index === 1) {
        const shot = await b.cdp.call('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(__dirname, '../.test-artifacts/spectator-tomato.png'), Buffer.from(shot.data, 'base64'));
      }
      await sleep(550);
    }
    // Mobile sender -> desktop receiver, using genuine touch input.
    await c.cdp.call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await b.cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await c.evaluate(`document.querySelector('[data-id="${victim.id}"]').scrollIntoView({block:'center',inline:'center'})`);
    const touch = await c.evaluate(`(() => {const r=document.querySelector('[data-id="${victim.id}"] canvas').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5};})()`);
    const previous = room.interactionId;
    await c.cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touch.x, y: touch.y }] });
    await c.cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(() => room.interactionId > previous, 'mobile touch spectator tap');
    const mobileInteraction = await until(() => b.receivedInteractions.find(item => item.id === previous + 1), 'mobile immediate interaction');
    assert.ok(Math.abs(mobileInteraction.x - .5) < .03);
    const burstStart = room.interactionId;
    for (let i = 0; i < 20; i++) {
      await c.cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touch.x, y: touch.y }] });
      await c.cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await until(() => room.interactionId === burstStart + 20 && b.receivedInteractions.filter(item => item.id > burstStart).length === 20, 'every rapid touch delivered');
    console.log('Twenty rapid genuine touches delivered individually without cooldown.');
    assert.equal(await c.evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
    assert.deepEqual(c.errors, []);
    assert.deepEqual(b.errors, []);
    console.log('Five real spectator effects mapped desktop-to-mobile:', fxInfo, 'Mobile touch-to-desktop verified.');
  } finally {
    for (const cdp of connections) cdp.socket.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill('SIGTERM');
      await exited;
    }
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
