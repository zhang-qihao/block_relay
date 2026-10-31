'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
}
function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block relay scripts '));
  for (const file of ['app.sh', 'update.sh', 'server.js', 'bomb.js', 'leaderboard.js', 'game.js', 'match.js', 'package.json', '.gitignore']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

test('app.sh manages only its own service and preserves custom port', async t => {
  const dir = fixture();
  const port = String(await unusedPort());
  t.after(() => { run('bash', ['app.sh', 'stop'], dir); fs.rmSync(dir, { recursive: true, force: true }); });
  ok(run('bash', ['-n', 'app.sh', 'update.sh'], dir));
  ok(run('bash', ['app.sh', 'start'], dir, { PORT: port }));
  const pid = fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8');
  assert.equal((await fetch(`http://localhost:${port}/api/info`)).status, 200);
  ok(run('bash', ['app.sh', 'start'], dir));
  assert.equal(fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8'), pid);
  ok(run('bash', ['app.sh', 'restart'], dir));
  assert.notEqual(fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8'), pid);
  assert.equal(fs.readFileSync(path.join(dir, '.run/port'), 'utf8').trim(), port);
  assert.equal((await fetch(`http://localhost:${port}/api/info`)).status, 200);
  ok(run('bash', ['app.sh', 'stop'], dir));
  ok(run('bash', ['app.sh', 'stop'], dir));
  assert.equal(fs.existsSync(path.join(dir, '.run/app.pid')), false);
  // A stale PID file pointing at another process must never kill it.
  fs.writeFileSync(path.join(dir, '.run/app.pid'), String(process.pid));
  fs.writeFileSync(path.join(dir, '.run/identity'), 'not this process');
  ok(run('bash', ['app.sh', 'stop'], dir));
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.notEqual(run('bash', ['app.sh', 'start'], dir, { PORT: 'invalid' }).status, 0);
  assert.notEqual(run('bash', ['app.sh', 'unknown'], dir).status, 0);
});

test('app.sh refuses an occupied port and never stops an unmanaged service', async t => {
  const dir = fixture();
  const port = String(await unusedPort());
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'0.0.0.0',()=>console.log('ready'))`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); run('bash', ['app.sh', 'stop'], dir); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  assert.notEqual(run('bash', ['app.sh', 'start'], dir, { PORT: port }).status, 0);
  ok(run('bash', ['app.sh', 'stop'], dir));
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test('update.sh fast-forwards master, rejects dirty/diverged work, and does not restart on install failure', async t => {
  const dir = fixture();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'block-relay-update-'));
  const remote = path.join(storage, 'remote.git');
  const author = path.join(storage, 'author');
  const bin = path.join(storage, 'bin');
  fs.mkdirSync(bin);
  // Isolate package-manager failure/success; do not access the network in tests.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env bash\nif [[ "${TEST_NPM_FAIL:-}" == "yes" ]]; then exit 9; fi\nexit 0\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, PORT: String(await unusedPort()) };
  const git = (...args) => ok(run('git', args, dir));
  t.after(() => { run('bash', ['app.sh', 'stop'], dir); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true }); });
  git('init', '-b', 'master');
  git('config', 'user.name', 'Script test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '.');
  git('commit', '-m', 'initial fixture');
  ok(run('git', ['init', '--bare', remote], storage));
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'master');
  ok(run('git', ['clone', '-b', 'master', remote, author], storage));
  const authorGit = (...args) => ok(run('git', args, author));
  authorGit('config', 'user.name', 'Script test');
  authorGit('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(author, 'release.txt'), 'release one');
  authorGit('add', 'release.txt'); authorGit('commit', '-m', 'release'); authorGit('push', 'origin', 'master');
  ok(run('bash', ['app.sh', 'start'], dir, env));
  const first = fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8');
  ok(run('bash', ['update.sh'], dir, env));
  assert.equal(fs.readFileSync(path.join(dir, 'release.txt'), 'utf8'), 'release one');
  const updated = fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8');
  assert.notEqual(first, updated);
  fs.writeFileSync(path.join(dir, 'local.txt'), 'do not overwrite');
  assert.notEqual(run('bash', ['update.sh'], dir, env).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8'), updated);
  fs.unlinkSync(path.join(dir, 'local.txt'));
  assert.notEqual(run('bash', ['update.sh'], dir, { ...env, TEST_NPM_FAIL: 'yes' }).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8'), updated);
  fs.writeFileSync(path.join(dir, 'local.txt'), 'local commit');
  git('add', 'local.txt'); git('commit', '-m', 'local-only');
  assert.notEqual(run('bash', ['update.sh'], dir, env).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.run/app.pid'), 'utf8'), updated);
});
