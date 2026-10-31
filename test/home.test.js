'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');

const publicFile = file => fs.readFileSync(path.join(__dirname, '../public', file));

test('waiting room is viewport bounded and detailed guidance lives only in the options dialog', () => {
  const html = publicFile('index.html').toString();
  const guidance = '灰色障碍补齐缺口即可消除；净化不增加消行进度。';
  const room = html.slice(html.indexOf('id="waitingPanel"'), html.indexOf('id="gamePanel"'));
  const dialog = html.slice(html.indexOf('<dialog id="ruleOptionsDialog"'), html.indexOf('<section id="countdownModal"'));
  assert.equal(room.includes(guidance), false);
  assert.equal(dialog.includes(guidance), true);
  const css = publicFile('styles.css').toString();
  assert.match(css, /body\.waiting-visible \{ height: 100dvh; overflow: hidden;/);
  assert.match(css, /\.waiting-visible \.room-view \{[^}]*grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.match(css, /\.waiting-visible \.waiting-intro \{[^}]*overflow-y: auto/);
});

test('nested board and monitor corners follow their outer radius and inset', () => {
  const css = publicFile('styles.css').toString();
  assert.match(css, /--radius: 24px/);
  assert.match(css, /--board-inner: max\(0px, calc\(var\(--board-radius\) - var\(--board-inset\)\)\)/);
  assert.match(css, /\.main-board, \.board-overlay, \.hit-overlay \{ border-radius:/);
  assert.match(css, /border-radius: calc\(var\(--board-radius\) \+ 2px\)/);
  assert.match(css, /border-radius: max\(0px, calc\(var\(--radius\) - var\(--monitor-padding\) - 1px\)\)/);
  assert.match(css, /--board-padding: 4px/);
  assert.doesNotMatch(css, /border-radius: 28px 28px 12px 28px|border-radius: 28px 12px 28px 28px/);
});

test('bomb transfer control stays below board in touch controls without shifting the board', () => {
  const html = publicFile('index.html').toString();
  const stage = html.slice(html.indexOf('<section class="board-stage">'), html.indexOf('<aside class="spectator-panel">'));
  assert.ok(stage.indexOf('id="bombPanel"') > stage.indexOf('id="mainBoard"'));
  assert.ok(stage.indexOf('id="bombPanel"') > stage.indexOf('id="mobileControls"'));
  const script = publicFile('app.js').toString();
  assert.doesNotMatch(script, /element\('option', '', '自定义'\)/);
});

test('homepage version matches package and lockfile versions', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.version, '0.1.2');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.ok(publicFile('index.html').toString().includes(`aria-label="当前版本 v${pkg.version}">v${pkg.version}</span>`));
});

test('home keeps one set of controls in introduction, ranking, room reading order', () => {
  const html = publicFile('index.html').toString();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(html.indexOf('class="lobby-copy"') < html.indexOf('class="leaderboard-panel"'));
  assert.ok(html.indexOf('class="leaderboard-panel"') < html.indexOf('class="lobby-panel"'));
  for (const id of ['nameInput', 'createButton', 'roomInput', 'findRoomsButton', 'joinButton', 'refreshLeaderboardButton']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.match(html, /class="leaderboard-scroll" tabindex="0" role="region"/);
  assert.match(html, /rel="icon" type="image\/png" sizes="64x64" href="\/favicon.png"/);
});

test('home grid retains two equal left panels and a spanning right panel', () => {
  const css = publicFile('styles.css').toString();
  assert.match(css, /grid-template-areas: "intro room" "ranking room"/);
  assert.match(css, /grid-template-areas: "intro" "ranking" "room"/);
  assert.match(css, /\.leaderboard-scroll \{[^}]*overflow-y: auto/);
});

test('select arrows share a centered icon and podiums have breathing room above', () => {
  const css = publicFile('styles.css').toString();
  const select = css.match(/select\.text-input \{([^}]+)\}/)[1];
  assert.match(css, /select\.text-input:focus \{ outline: 2px solid var\(--cyan\); outline-offset: -3px;/);
  assert.match(select, /appearance: none/);
  assert.match(select, /padding-right: 40px/);
  assert.match(select, /background-position: right 14px center/);
  assert.match(select, /background-size: 16px 16px/);
  assert.match(css, /\.leaderboard-scroll \{[^}]*display: flex; flex-direction: column/);
  assert.match(css, /\.leaderboard-scroll > ol \{ flex-shrink: 0;/);
  assert.match(css, /\.leaderboard-scroll > \.leaderboard-podium \{ margin-top: auto;/);
  assert.match(css, /\.leaderboard-scroll > \.leaderboard-list \{ margin-bottom: auto;/);
  assert.match(css, /#leaderboardStatus:empty \{ display: none;/);
});

test('home inherits the shared dark theme and shared button colors', () => {
  const css = publicFile('styles.css').toString();
  const home = css.slice(css.indexOf('.lobby-view {'), css.indexOf('/* Room search'));
  assert.doesNotMatch(home, /color-scheme: light|--(?:text|muted|line|yellow):/);
  assert.doesNotMatch(home, /#f2f3fa|#e1e2f3|#303368|#d6f76b/);
  assert.match(home, /\.lobby-panel \{[^}]*background: var\(--surface\)/);
  assert.match(home, /\.leaderboard-panel \{[^}]*background: var\(--surface\)/);
  assert.match(publicFile('index.html').toString(), /name="theme-color" content="#0b1020"/);
});

test('match information and shared mascot appear in the topbar before room status', () => {
  const html = publicFile('index.html').toString();
  const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  assert.match(topbar, /<img class="brand-icon" src="\/mascot.png"/);
  assert.doesNotMatch(html, /brand-glyph|▦/);
  assert.ok(topbar.indexOf('id="matchRulesLabel"') < topbar.indexOf('id="roomCodeLabel"'));
  for (const id of ['matchRulesLabel', 'matchClock', 'specialRuleLabel', 'endPracticeButton']) {
    assert.ok(topbar.includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  const css = publicFile('styles.css').toString();
  assert.match(css, /\.match-strip \{ display: none;/);
  assert.match(css, /\.match-visible \.match-strip \{ display: flex;/);
});

test('desktop chat and game panels share a grid row below the status toolbar', () => {
  const css = publicFile('styles.css').toString();
  const desktop = css.slice(css.indexOf('@media (min-width: 1251px)'), css.indexOf('@media (max-width: 1250px)'));
  assert.match(desktop, /\.match-visible \.room-main, \.match-visible \.game-panel \{ display: contents;/);
  assert.match(desktop, /\.match-visible \.chat-panel \{ grid-column: 1; grid-row: 2; position: static;/);
  assert.match(desktop, /\.match-visible \.game-toolbar \{ grid-column: 1 \/ -1; grid-row: 1;/);
  assert.match(desktop, /\.match-visible \.game-layout \{ grid-column: 2; grid-row: 2; min-width: 0; margin-top: 0;/);
});

test('bomb artwork is served as SVG and alerts use synchronized border states', async t => {
  const app = createApp();
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/bomb.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await response.text(), /viewBox="0 0 96 108"/);
  const css = publicFile('styles.css').toString();
  assert.match(css, /\.board-frame\.has-bomb\.bomb-lit::after/);
  assert.match(css, /\.mini-board\.has-bomb\.bomb-lit/);
  assert.match(css, /\.bomb-badge\.is-lit \.bomb-art \{ animation: bomb-jolt/);
  assert.match(css, /\.bomb-badge\.is-lit \.bomb-art \{ animation: none/);
});

test('mascot and favicon are served as PNG with the expected dimensions', async t => {
  const app = createApp();
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  for (const [file, size] of [['favicon.png', 64], ['mascot.png', 512]]) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/${file}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});
