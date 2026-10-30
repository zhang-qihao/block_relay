'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');

const publicFile = file => fs.readFileSync(path.join(__dirname, '../public', file));

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
