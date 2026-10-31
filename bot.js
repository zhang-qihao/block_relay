'use strict';

const { WIDTH, HEIGHT, SHAPES } = require('./game');

const levels = Object.freeze({
  easy: Object.freeze({ label: '简单', interval: 400, pieceDelay: 2400, reactionDelay: 1400, mistakeChance: .5, scoreTolerance: 24, choices: 6 }),
  normal: Object.freeze({ label: '普通', interval: 220, pieceDelay: 1300, reactionDelay: 650, mistakeChance: .25, scoreTolerance: 12, choices: 3 }),
  hard: Object.freeze({ label: '困难', interval: 65, pieceDelay: 0, reactionDelay: 0, mistakeChance: 0, scoreTolerance: 0, choices: 1 }),
});
const BEAMS = { easy: 0, normal: 3, hard: 8 };
const FULL = (1 << WIDTH) - 1;
const MAX_NODES = 1000;
const MAX_DEPTH = 36;
// Same order as game.act: the first non-colliding kick wins, not any valid kick.
const KICKS = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]];
const ACTIONS = ['left', 'right', 'rotate', 'rotateBack', 'down'];

function orientations(matrix) {
  const result = [];
  for (let r = 0; r < 4; r++) {
    const cells = [];
    matrix.forEach((row, y) => row.forEach((cell, x) => { if (cell) cells.push([x, y]); }));
    result.push(cells);
    matrix = matrix.map((row, y) => row.map((_, x) => matrix[matrix.length - 1 - x][y]));
  }
  return result;
}
const SPAWNS = Object.fromEntries(Object.entries(SHAPES).map(([type, matrix]) => [type, {
  type, x: Math.floor((WIDTH - matrix.length) / 2), y: 0, shapes: orientations(matrix),
}]));

function fits(board, cells, x, y) {
  for (let i = 0; i < cells.length; i++) {
    const cx = x + cells[i][0], cy = y + cells[i][1];
    if (cx < 0 || cx >= WIDTH || cy >= HEIGHT || (cy >= 0 && (board[cy] & (1 << cx)))) return false;
  }
  return true;
}

// Only the compact, public board is copied. No game/queue/RNG is ever constructed.
function settle(board, garbage, cells, x, y, context) {
  const rows = board.slice(), gray = garbage.slice();
  for (const [dx, dy] of cells) {
    if (y + dy < 0) return null;
    rows[y + dy] |= 1 << (x + dx);
  }
  let cleared = 0, dug = 0, write = HEIGHT - 1;
  for (let read = HEIGHT - 1; read >= 0; read--) {
    if (rows[read] === FULL) { cleared++; if (gray[read]) dug++; }
    else { rows[write] = rows[read]; gray[write--] = gray[read]; }
  }
  while (write >= 0) { rows[write] = 0; gray[write--] = 0; }
  let purified = 0;
  if (context.cleanse && context.energy + cleared >= 6) {
    write = HEIGHT - 1;
    for (let read = HEIGHT - 1; read >= 0; read--) {
      if (gray[read] && purified < 2) purified++;
      else { rows[write] = rows[read]; gray[write--] = gray[read]; }
    }
    while (write >= 0) { rows[write] = 0; gray[write--] = 0; }
  }
  return { board: rows, garbage: gray, cleared, dug, purified };
}

function evaluate(state, context) {
  let total = 0, highest = 0, holes = 0, covered = 0, bumpiness = 0, wells = 0;
  const heights = [];
  for (let x = 0; x < WIDTH; x++) {
    let height = 0, blocks = 0;
    for (let y = 0; y < HEIGHT; y++) {
      if (state.board[y] & (1 << x)) {
        if (!height) height = HEIGHT - y;
        blocks++;
      } else if (height) { holes++; covered += blocks; }
    }
    heights.push(height);
    total += height;
    highest = Math.max(highest, height);
    if (x) bumpiness += Math.abs(height - heights[x - 1]);
  }
  for (let x = 0; x < WIDTH; x++) {
    const depth = Math.min(x ? heights[x - 1] : HEIGHT, x < WIDTH - 1 ? heights[x + 1] : HEIGHT) - heights[x];
    if (depth > 2) wells += depth - 2;
  }
  // Pending garbage raises the safety margin, but its hidden holes/timing are not guessed.
  const danger = Math.max(0, highest + Math.min(6, context.pending) - 12);
  state.value = -12 * holes - .65 * covered - .55 * total - .8 * highest - .65 * bumpiness - .3 * wells - 2 * danger * danger;
  state.reward = 8 * state.cleared + 3 * state.cleared ** 2 + (context.dig ? 45 : 7) * state.dug + 6 * state.purified;
  state.won = (context.dig && state.dug > 0 && !state.garbage.some(Boolean)) ||
    (context.goal > 0 && context.lines + state.cleared >= context.goal);
  if (state.won) state.reward += 10000;
  state.score = state.value + state.reward;
  return state;
}

// BFS over (rotation, x, y); drop endpoints are cached and deduplicated. Parents
// reconstruct executable paths without cloning a board or action array per node.
function placements(board, garbage, piece, context) {
  const minY = Math.min(-4, piece.y), stride = WIDTH + 8;
  const size = 4 * stride * (HEIGHT - minY + 4);
  const seen = new Uint8Array(size), landed = new Uint8Array(size);
  const drops = new Int16Array(size).fill(-32768);
  const key = (r, x, y) => ((y - minY) * stride + x + 4) * 4 + r;
  const nodes = [{ r: 0, x: piece.x, y: piece.y, parent: -1, action: -1, depth: 0 }];
  const results = [];
  if (!fits(board, piece.shapes[0], piece.x, piece.y)) return results;
  seen[key(0, piece.x, piece.y)] = 1;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], cells = piece.shapes[node.r];
    const id = key(node.r, node.x, node.y);
    let bottom = drops[id];
    if (bottom === -32768) {
      bottom = node.y;
      while (fits(board, cells, node.x, bottom + 1)) bottom++;
      for (let y = node.y; y <= bottom; y++) drops[key(node.r, node.x, y)] = bottom;
    }
    const landing = key(node.r, node.x, bottom);
    if (!landed[landing]) {
      landed[landing] = 1;
      const state = settle(board, garbage, cells, node.x, bottom, context);
      if (state) results.push({ ...evaluate(state, context), nodes, index });
    }
    if (node.depth >= MAX_DEPTH || nodes.length >= MAX_NODES) continue;
    for (let action = 0; action < ACTIONS.length && nodes.length < MAX_NODES; action++) {
      let r = node.r, x = node.x, y = node.y;
      if (action === 0 || action === 1) x += action === 0 ? -1 : 1;
      else if (action === 4) y++;
      else {
        r = (r + (action === 2 ? 1 : 3)) % 4;
        let kicked = false;
        for (const [dx, dy] of KICKS) {
          if (fits(board, piece.shapes[r], x + dx, y + dy)) {
            x += dx; y += dy; kicked = true; break;
          }
        }
        if (!kicked) continue;
      }
      if (x < -4 || x >= WIDTH || y < minY || y >= HEIGHT || !fits(board, piece.shapes[r], x, y)) continue;
      const nextId = key(r, x, y);
      if (seen[nextId]) continue;
      seen[nextId] = 1;
      nodes.push({ r, x, y, parent: index, action, depth: node.depth + 1 });
    }
  }
  return results;
}

function path(candidate) {
  const actions = ['drop'];
  for (let i = candidate.index; candidate.nodes[i].parent >= 0; i = candidate.nodes[i].parent) {
    actions.push(ACTIONS[candidate.nodes[i].action]);
  }
  if (candidate.held) actions.push('hold');
  return actions.reverse();
}

/** Plan one lock from snapshotGame() only. Replan after gravity or board changes.
 * Unknown incoming garbage and bomb timing cannot be simulated from a snapshot.
 * easy: current only; normal/hard: two locks with beams of 3/8 and optional hold.
 * Limits: 1000 BFS nodes/search, 36 moves, <= 2 + 2*beam searches/call.
 */
function chooseCandidate(candidates, level, choice) {
  const config = levels[level] || levels.normal;
  if (choice >= config.mistakeChance || choice <= 0) return candidates[0];
  const seen = new Set([candidates[0].board.join(',')]);
  const alternatives = candidates.slice(1).filter(candidate => {
    const key = candidate.board.join(',');
    if (seen.has(key) || candidate.score < candidates[0].score - config.scoreTolerance) return false;
    seen.add(key);
    return true;
  }).slice(0, config.choices - 1);
  return alternatives[Math.min(alternatives.length - 1, Math.floor(choice / config.mistakeChance * alternatives.length))] || candidates[0];
}

function reactionReady(state, key, eligible, now, delay) {
  if (!eligible) { delete state[key]; return false; }
  if (state[key] == null) state[key] = now + delay;
  return now >= state[key];
}

function plan(snapshot, settings = {}, level = 'normal', choice = 0) {
  if (!snapshot?.alive || !snapshot.active || !Array.isArray(snapshot.board) || snapshot.board.length !== HEIGHT) return [];
  const active = snapshot.active, matrix = active.matrix;
  if (!Object.hasOwn(SPAWNS, active.type) || !Number.isInteger(active.x) || !Number.isInteger(active.y) ||
      active.x < -4 || active.x >= WIDTH || active.y < -HEIGHT || active.y >= HEIGHT ||
      !Array.isArray(matrix) || matrix.length < 1 || matrix.length > 4 ||
      !matrix.every(row => Array.isArray(row) && row.length === matrix.length) || !matrix.some(row => row.some(Boolean))) return [];
  const board = [], garbage = [];
  for (const row of snapshot.board) {
    if (!Array.isArray(row) || row.length !== WIDTH) return [];
    let occupied = 0, gray = 0;
    for (let x = 0; x < WIDTH; x++) {
      if (row[x]) occupied |= 1 << x;
      if (row[x] === 'G') gray |= 1 << x;
    }
    board.push(occupied); garbage.push(gray);
  }
  const beam = Object.hasOwn(BEAMS, level) ? BEAMS[level] : BEAMS.normal;
  // Read only visible previews, and never replace missing previews with random pieces.
  const next = beam && Array.isArray(snapshot.next) ? snapshot.next.slice(0, 3) : [];
  const context = {
    dig: settings.mode === 'dig', pending: snapshot.pending || 0,
    cleanse: settings.mode !== 'dig' && settings.cleanse && snapshot.cleanseQueued,
    energy: snapshot.energy || 0, lines: snapshot.lines || 0,
    goal: settings.mode === 'sprint' ? settings.goal : 0,
  };
  const piece = { type: active.type, x: active.x, y: active.y, shapes: orientations(matrix) };
  let candidates = placements(board, garbage, piece, context);
  for (const candidate of candidates) { candidate.nextIndex = 0; candidate.hold = snapshot.hold; }
  if (beam && !snapshot.holdUsed) {
    const heldType = snapshot.hold || next[0];
    if (Object.hasOwn(SPAWNS, heldType)) {
      const held = placements(board, garbage, SPAWNS[heldType], context);
      for (const candidate of held) {
        candidate.held = true;
        candidate.nextIndex = snapshot.hold ? 0 : 1;
        candidate.hold = active.type;
      }
      candidates = candidates.concat(held);
    }
  }
  if (!candidates.length) return fits(board, piece.shapes[0], piece.x, piece.y) ? ['drop'] : [];
  const compare = (a, b) => b.score - a.score || Number(Boolean(a.held)) - Number(Boolean(b.held)) ||
    a.nodes[a.index].depth - b.nodes[b.index].depth;
  candidates.sort(compare);
  if (!beam) return path(chooseCandidate(candidates, level, choice));
  // Deduplicate identical resulting boards before spending the small second-ply beam.
  const unique = new Set();
  candidates = candidates.filter(candidate => {
    const key = `${candidate.board.join(',')}/${candidate.nextIndex}/${candidate.hold}`;
    if (unique.has(key)) return false;
    unique.add(key); return true;
  }).slice(0, Math.max(beam, (levels[level] || levels.normal).choices));
  for (const candidate of candidates) {
    if (candidate.won) continue;
    const nextType = next[candidate.nextIndex];
    if (!Object.hasOwn(SPAWNS, nextType)) continue;
    // A blocked spawn loses before hold can be pressed.
    const upcoming = SPAWNS[nextType];
    if (!fits(candidate.board, upcoming.shapes[0], upcoming.x, upcoming.y)) { candidate.score -= 100000; continue; }
    const futureContext = { ...context, cleanse: false, lines: context.lines + candidate.cleared };
    let future = placements(candidate.board, candidate.garbage, upcoming, futureContext);
    const heldType = candidate.hold || next[candidate.nextIndex + 1];
    if (Object.hasOwn(SPAWNS, heldType) && heldType !== nextType) {
      future = future.concat(placements(candidate.board, candidate.garbage, SPAWNS[heldType], futureContext));
    }
    if (!future.length) { candidate.score -= 100000; continue; }
    let best = -Infinity;
    for (const option of future) best = Math.max(best, option.score);
    candidate.score = candidate.reward + .15 * candidate.value + .85 * best;
  }
  candidates.sort(compare);
  return path(chooseCandidate(candidates, level, choice));
}

module.exports = { levels, plan, reactionReady };
