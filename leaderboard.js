'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { modes } = require('./public/rules');

function validEntry(entry) {
  return entry && typeof entry.name === 'string' && entry.name.trim() && Array.from(entry.name).length <= 14 &&
    Number.isSafeInteger(entry.score) && entry.score > 0 &&
    typeof entry.mode === 'string' && (Object.hasOwn(modes, entry.mode) || ['battle', 'bomb'].includes(entry.mode)) &&
    Number.isSafeInteger(entry.at) && entry.at >= 0;
}
function recordKey(entry) {
  return JSON.stringify([entry.mode, entry.name]);
}
function compare(a, b) {
  return b.score - a.score || a.at - b.at || a.name.localeCompare(b.name);
}

// One process owns one file. Tests use an in-memory store or their own temp file.
function createLeaderboard({ file = null, onError = message => console.error(message) } = {}) {
  const records = new Map();
  let readOnly = false;
  let storage = file ? 'saved' : 'memory';
  let dirty = false;
  let timer = null;
  let writing = null;
  function report(error) {
    storage = 'error';
    onError(`排行榜保存异常（原文件未主动覆盖）：${error.message}`);
  }
  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (![1, 2].includes(data.version) || !Array.isArray(data.entries) || !data.entries.every(validEntry)) throw new Error('数据格式无效');
      for (const entry of data.entries) {
        const normalized = { ...entry, name: entry.name.trim().normalize('NFC') };
        const key = recordKey(normalized);
        const old = records.get(key);
        if (!old || compare(normalized, old) < 0) records.set(key, normalized);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { readOnly = true; report(error); }
    }
  }
  function snapshot() {
    const sorted = [...records.values()].sort(compare);
    const entries = Object.keys(modes).flatMap(mode => sorted.filter(entry => entry.mode === mode).slice(0, 50).map((entry, index) => ({
      name: entry.name, score: entry.score, mode: entry.mode, at: entry.at, rank: index + 1,
    })));
    return { entries, storage, available: !readOnly };
  }
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (writing) return writing;
    if (!file || readOnly || !dirty) return storage !== 'error';
    writing = (async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        while (dirty) {
          dirty = false;
          const json = JSON.stringify({ version: 2, entries: [...records.values()].sort(compare) }, null, 2) + '\n';
          try {
            await fs.promises.writeFile(temporary, json, { mode: 0o600 });
            await fs.promises.rename(temporary, file);
            storage = 'saved';
          } catch (error) { dirty = true; throw error; }
        }
        return true;
      } catch (error) {
        report(error);
        await fs.promises.unlink(temporary).catch(() => {});
        if (!timer) {
          timer = setTimeout(() => { timer = null; void flush(); }, 5000);
          timer.unref();
        }
        return false;
      } finally { writing = null; }
    })();
    return writing;
  }
  function record(name, score, mode, at = Date.now()) {
    if (readOnly || typeof name !== 'string') return false;
    const entry = { name: name.trim().normalize('NFC'), score, mode, at };
    if (!validEntry(entry)) return false;
    const key = recordKey(entry);
    const old = records.get(key);
    if (old && old.score >= score) return false;
    records.set(key, entry);
    if (file) {
      dirty = true;
      storage = 'pending';
      if (!timer && !writing) {
        timer = setTimeout(() => { timer = null; void flush(); }, 200);
        timer.unref();
      }
    }
    return true;
  }
  return { record, snapshot, flush };
}

module.exports = { createLeaderboard };
