(function (root) {
  'use strict';
  const COLORS = { I: '#53d9e5', J: '#6b8bfa', L: '#f7a75f', O: '#eed36d', S: '#77d5ad', T: '#b394ef', Z: '#ed8198', G: '#69788e' };
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const mix = (a, b, t) => a + (b - a) * t;

  function create({ canvas, resolve, onIncoming = () => {}, onHit = () => {}, onClear = () => {} }) {
    const ctx = canvas.getContext('2d');
    const motion = root.matchMedia('(prefers-reduced-motion: reduce)');
    const shakes = new Set();
    let active = [];
    let taps = [];
    let lastTapId = 0;
    let frame = null;
    let key = null;
    let lastId = 0;
    let selfId = null;
    let width = 0;
    let height = 0;

    function clear(forget = false) {
      if (frame !== null) root.cancelAnimationFrame(frame);
      frame = null;
      active = [];
      taps = [];
      for (const animation of shakes) animation.cancel();
      shakes.clear();
      ctx.clearRect(0, 0, width, height);
      if (forget) { key = null; lastId = 0; lastTapId = 0; }
    }
    function resize() {
      const ratio = Math.min(root.devicePixelRatio || 1, 2);
      width = root.innerWidth;
      height = root.innerHeight;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    function anchor(id) {
      const info = resolve(id);
      if (!info?.element) return null;
      const rect = info.element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const clip = info.clip?.getBoundingClientRect() || { left: 0, top: 0, right: width, bottom: height };
      const left = Math.max(12, clip.left);
      const right = Math.min(width - 12, clip.right);
      const top = Math.max(12, clip.top);
      const bottom = Math.min(height - 12, clip.bottom);
      const visible = right > left && bottom > top && rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
      if (visible) {
        // Respect horizontally clipped monitors rather than drawing outside them.
        const l = Math.max(rect.left, left), r = Math.min(rect.right, right);
        const t = Math.max(rect.top, top), b = Math.min(rect.bottom, bottom);
        return { left: l, top: t, width: r - l, height: b - t, element: info.element, name: info.name, offscreen: false };
      }
      const x = clamp((rect.left + rect.right) / 2, clamp(left + 25, 30, width - 30), clamp(right - 25, 30, width - 30));
      const y = clamp((rect.top + rect.bottom) / 2, clamp(top + 25, 30, height - 30), clamp(bottom - 25, 30, height - 30));
      return { left: x - 24, top: y - 20, width: 48, height: 40, element: null, name: info.name, offscreen: true };
    }
    function label(value, x, y, color, alpha = 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 12px "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const measured = ctx.measureText(value).width + 16;
      x = clamp(x, measured / 2 + 5, width - measured / 2 - 5);
      y = clamp(y, 16, height - 16);
      ctx.fillStyle = '#0b1020ed';
      ctx.fillRect(x - measured / 2, y - 12, measured, 24);
      ctx.fillStyle = color;
      ctx.fillText(value, x, y);
      ctx.restore();
    }
    function halo(rect, color, alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.strokeRect(rect.left - 3, rect.top - 3, rect.width + 6, rect.height + 6);
      ctx.restore();
    }
    function rowStrip(cells, x, y, rowWidth, rowHeight, alpha = 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      const cellWidth = rowWidth / 10;
      cells.forEach((cell, i) => {
        ctx.fillStyle = COLORS[cell] || '#53d9e5';
        ctx.fillRect(x + i * cellWidth + .6, y, Math.max(1, cellWidth - 1.2), Math.max(2, rowHeight - 1));
      });
      ctx.restore();
    }
    function shake(rect, incoming) {
      if (motion.matches || !rect.element?.animate) return;
      const amount = incoming ? 6 : 3;
      const animation = rect.element.animate([
        { transform: 'translate(0,0)' }, { transform: `translate(${-amount}px,2px)` },
        { transform: `translate(${amount}px,-1px)` }, { transform: 'translate(-2px,1px)' }, { transform: 'translate(0,0)' },
      ], { duration: 260, easing: 'ease-out' });
      shakes.add(animation);
      animation.finished.then(() => shakes.delete(animation), () => shakes.delete(animation));
    }
    function impact(target, lines, elapsed, color, incoming, flight, sourceName) {
      const progress = clamp(elapsed / 500, 0, 1);
      const x = target.left + target.width / 2;
      const y = target.top + target.height * .72;
      if (!flight.hit) { flight.hit = true; shake(target, incoming); }
      halo(target, color, (1 - progress) * .9);
      ctx.save();
      ctx.globalAlpha = (1 - progress) * .85;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * (1 - progress) + 1;
      ctx.beginPath();
      ctx.arc(x, y, 10 + progress * Math.min(85, target.width), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      for (let i = 0; i < 12; i++) {
        const angle = i * Math.PI / 6;
        const distance = 10 + progress * (30 + (i % 3) * 10);
        ctx.fillRect(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, 3, 3);
      }
      ctx.restore();
      label(incoming ? `${sourceName} 攻击你 +${lines} 行` : `${target.name} +${lines} 待接收`, x, y - 20 - progress * 18, color, 1 - progress);
    }
    function drawEffect(effect, now) {
      const age = now - effect.born;
      if (effect.kind === 'rescue') {
        const source = anchor(effect.sourceId);
        for (const item of effect.targets) {
          const target = anchor(item.targetId);
          if (!target) continue;
          const fade = 1 - clamp(age / 900, 0, 1);
          halo(target, '#77d5ad', fade);
          label(`${effect.sourceName} 救援 −${item.lines} 行`, target.left + target.width / 2, target.top + target.height * .5, '#77d5ad', fade);
          if (source && !motion.matches) {
            ctx.save(); ctx.globalAlpha = fade * .5; ctx.strokeStyle = '#77d5ad'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(source.left + source.width / 2, source.top + source.height / 2);
            ctx.lineTo(target.left + target.width / 2, target.top + target.height / 2); ctx.stroke(); ctx.restore();
          }
        }
        return;
      }
      if (effect.kind === 'hit') {
        const target = anchor(effect.targetId);
        if (!target) return;
        const duration = motion.matches ? 700 : 1150;
        const progress = clamp(age / duration, 0, 1);
        const incoming = effect.targetId === selfId;
        const names = effect.sources.map(source => `${source.sourceName} ${source.lines}行`).join('、');
        halo(target, '#ff6488', 1 - progress);
        ctx.save();
        ctx.globalAlpha = (1 - progress) * .6;
        ctx.fillStyle = '#ff6488';
        const stripHeight = target.height * Math.min(20, effect.lines) / 20;
        ctx.fillRect(target.left, target.top + target.height - stripHeight, target.width, stripHeight);
        ctx.restore();
        if (!motion.matches) impact(target, effect.lines, age * 500 / duration, '#ff6488', incoming, effect, names);
        label(`${incoming ? '实际受击' : target.name + ' 受击'} +${effect.lines} 行 · ${names}`,
          target.left + target.width / 2, target.top + target.height * .42, '#ffb0c2', 1 - progress);
        return;
      }
      const source = anchor(effect.sourceId) || { left: 18, top: 90, width: 60, height: 40, name: effect.sourceName || '对手', offscreen: true };
      source.name = effect.sourceName || source.name;
      const own = effect.sourceId === selfId;
      const rows = effect.rows;
      if (age < 260) {
        const alpha = 1 - age / 260;
        for (const row of rows) {
          const rowHeight = source.height / 20;
          rowStrip(row.cells, source.left, source.top + row.y * rowHeight, source.width, rowHeight, alpha);
          ctx.save();
          ctx.globalAlpha = alpha * .8;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(source.left, source.top + row.y * rowHeight, source.width, Math.max(2, rowHeight * .24));
          ctx.restore();
        }
      }
      if (effect.cancelled && age < 700) label(`消除 ${rows.length} 行 · 抵消 ${effect.cancelled}`, source.left + source.width / 2, source.top + source.height * .65, '#53d9e5', 1 - age / 700);
      if (!effect.targets.length && !effect.cancelled && age < 650) label(`消除 ${rows.length} 行`, source.left + source.width / 2, source.top + source.height * .65, '#eed36d', 1 - age / 650);
      effect.targets.forEach((flight, index) => {
        const target = anchor(flight.targetId);
        if (!target) return;
        const incoming = flight.targetId === selfId;
        const color = incoming ? '#ed8198' : own ? '#53d9e5' : '#eed36d';
        const time = age - 180 - index * 35;
        if (motion.matches) {
          if (age < 700) {
            halo(source, color, .55 * (1 - age / 700));
            halo(target, color, .75 * (1 - age / 700));
            label(`${source.name} → ${target.name} +${flight.lines}`, target.left + target.width / 2, target.top + target.height * .7, color, 1 - age / 700);
          }
          return;
        }
        if (time < 0) return;
        if (time >= 620) {
          if (time < 1120) impact(target, flight.lines, time - 620, color, incoming, flight, source.name);
          return;
        }
        const progress = clamp(time / 620, 0, 1);
        const t = progress * progress * (3 - 2 * progress);
        const rowY = rows.reduce((sum, row) => sum + row.y + .5, 0) / rows.length;
        const from = { x: source.left + source.width / 2, y: source.top + source.height * rowY / 20 };
        const to = { x: target.left + target.width / 2, y: target.top + target.height * .72 };
        const lift = Math.min(140, Math.hypot(to.x - from.x, to.y - from.y) * .25);
        const point = fraction => ({ x: mix(from.x, to.x, fraction), y: mix(from.y, to.y, fraction) - Math.sin(Math.PI * fraction) * lift });
        const current = point(t);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        for (let trail = 5; trail > 0; trail--) {
          const a = point(Math.max(0, t - trail * .035));
          const b = point(Math.max(0, t - (trail - 1) * .035));
          ctx.globalAlpha = (1 - trail / 6) * .55;
          ctx.lineWidth = 3 + (6 - trail) * 1.4;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.globalAlpha = own || incoming ? 1 : .7;
        ctx.translate(current.x, current.y);
        ctx.rotate(Math.sin(Math.PI * t) * (to.x > from.x ? .18 : -.18));
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        const shrink = 1 - .62 * Math.sin(Math.PI * t);
        const rowWidth = mix(source.width, target.width, t) * shrink;
        const rowHeight = Math.max(4, Math.min(18, rowWidth / 10));
        rows.forEach((row, i) => rowStrip(row.cells, -rowWidth / 2, (i - (rows.length - 1) / 2) * (rowHeight + 1), rowWidth, rowHeight));
        ctx.restore();
        label(flight.targetId === selfId ? `${source.name} → 你 +${flight.lines}` : `${source.name} → ${target.name} +${flight.lines}`, current.x, current.y - rows.length * 7 - 16, color);
      });
    }
    function drawTap(tap, now) {
      const info = resolve(tap.targetId);
      if (!info?.element) return;
      const rect = info.element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const clip = info.clip?.getBoundingClientRect() || rect;
      const x = rect.left + tap.x * rect.width;
      const y = rect.top + tap.y * rect.height;
      const age = now - tap.born;
      const t = motion.matches ? 0 : clamp(age / 950, 0, 1);
      const fade = 1 - clamp(age / (motion.matches ? 650 : 1050), 0, 1);
      const size = clamp(rect.width * .15, 10, 30);
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(rect.left, clip.left), Math.max(rect.top, clip.top),
        Math.max(0, Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left)),
        Math.max(0, Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top)));
      ctx.clip();
      ctx.globalAlpha = fade * .8;
      ctx.translate(x, y);
      ctx.lineWidth = 2;
      if (tap.effect === 'glass') {
        ctx.strokeStyle = '#a3edfa';
        for (let ring = 0; ring < 2; ring++) {
          ctx.beginPath(); ctx.arc(0, 0, size * (.4 + ring * .4 + t), 0, Math.PI * 2); ctx.stroke();
        }
        for (let i = 0; i < 5; i++) {
          const a = i * Math.PI * 2 / 5;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * size * .45, Math.sin(a) * size * .45);
          ctx.lineTo(Math.cos(a + .2) * size * .9, Math.sin(a + .2) * size * .9); ctx.stroke();
        }
      } else if (tap.effect === 'tomato') {
        ctx.fillStyle = '#f26870';
        ctx.beginPath(); ctx.ellipse(0, 0, size * .65, size * .5, -.2, 0, Math.PI * 2); ctx.fill();
        for (let i = 0; i < 7; i++) {
          const a = i * Math.PI * 2 / 7;
          const d = size * (.7 + t * .8);
          ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, size * .12, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = '#77d5ad';
        ctx.beginPath(); ctx.moveTo(-size * .2, -size * .4); ctx.lineTo(0, -size * .65); ctx.lineTo(size * .2, -size * .4); ctx.stroke();
      } else if (tap.effect === 'hand') {
        ctx.fillStyle = '#b394ef';
        ctx.beginPath(); ctx.ellipse(0, size * .15, size * .4, size * .45, 0, 0, Math.PI * 2); ctx.fill();
        for (let i = 0; i < 4; i++) {
          ctx.beginPath(); ctx.ellipse((i - 1.5) * size * .24, -size * (.35 + (i === 1 || i === 2 ? .1 : 0)), size * .11, size * .38, 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.ellipse(-size * .48, 0, size * .16, size * .32, -.7, 0, Math.PI * 2); ctx.fill();
      } else {
        const colors = ['#53d9e5', '#eed36d', '#ed8198', '#b394ef', '#77d5ad'];
        for (let i = 0; i < 16; i++) {
          const a = i * Math.PI * 2 / 16;
          const d = size * (.4 + t * 1.8) * (i % 2 ? .65 : 1);
          const px = Math.cos(a) * d;
          const py = Math.sin(a) * d + (tap.effect === 'confetti' ? t * t * size : 0);
          ctx.fillStyle = colors[i % colors.length];
          ctx.strokeStyle = colors[i % colors.length];
          if (tap.effect === 'confetti') ctx.fillRect(px, py, size * .16, size * .28);
          else { ctx.beginPath(); ctx.moveTo(px * .7, py * .7); ctx.lineTo(px, py); ctx.stroke(); }
        }
      }
      ctx.restore();
      // Keep the nickname on the visible board, not inside a clipped particle.
      if (x >= Math.max(0, clip.left) && x <= Math.min(width, clip.right) && y >= Math.max(0, clip.top) && y <= Math.min(height, clip.bottom)) {
        label(`${tap.sourceName} · ${root.BlockRules.spectatorEffects[tap.effect][0]}`, x, y - size - 12, '#d8f3f0', fade);
      }
    }
    function draw(now) {
      frame = null;
      resize();
      ctx.clearRect(0, 0, width, height);
      active = active.filter(effect => now - effect.born < (motion.matches ? 720 : 1500));
      taps = taps.filter(tap => now - tap.born < (motion.matches ? 650 : 1050));
      for (const tap of taps) drawTap(tap, now);
      for (const effect of active) drawEffect(effect, now);
      if (active.length || taps.length) frame = root.requestAnimationFrame(draw);
    }
    function sync(room, id, now) {
      selfId = id;
      const nextKey = `${room.code}:${room.roundId}`;
      const records = room.effects || [];
      const interactions = room.interactions || [];
      const latestTap = interactions.reduce((max, tap) => Math.max(max, tap.id), key === nextKey ? lastTapId : 0);
      const latest = records.reduce((max, record) => Math.max(max, record.id), key === nextKey ? lastId : 0);
      if (key !== nextKey) { clear(); key = nextKey; lastId = latest; lastTapId = latestTap; return; }
      if (!['playing', 'finished'].includes(room.status) || root.document.hidden) {
        clear(); lastId = latest; lastTapId = latestTap; return;
      }
      for (const tap of interactions) {
        if (room.status === 'playing' && tap.id > lastTapId && now - tap.at >= -250 && now - tap.at < 1500 &&
            Object.hasOwn(root.BlockRules.spectatorEffects, tap.effect)) taps.push({ ...tap, born: root.performance.now() });
      }
      taps = taps.slice(-12);
      lastTapId = latestTap;
      const fresh = records.filter(record => record.id > lastId && now - record.at >= -250 && now - record.at < 2500);
      lastId = latest;
      for (const record of fresh) {
        if (record.kind === 'rescue') {
          active.push({ ...record, born: root.performance.now(), relevant: record.sourceId === id || record.targets.some(target => target.targetId === id) });
          if (active.length > 24) active.shift();
          continue;
        }
        if (record.kind === 'hit') {
          if (record.targetId === id) onHit(record);
          active.push({ ...record, born: root.performance.now(), relevant: record.targetId === id, hit: false });
          if (active.length > 24) active.splice(Math.max(0, active.findIndex(item => !item.relevant)), 1);
          continue;
        }
        for (const target of record.targets || []) {
          if (target.targetId === id) onIncoming({ sourceId: record.sourceId,
            sourceName: record.sourceName || resolve(record.sourceId)?.name || '对手', lines: target.lines });
        }
        if (!record.rows?.length) continue;
        if (record.sourceId === id) onClear(record);
        const relevant = record.sourceId === id || record.targets.some(target => target.targetId === id);
        const effect = { ...record, born: root.performance.now(), relevant, targets: record.targets.map(target => ({ ...target, hit: false })) };
        // Prefer the local player's feedback during dense six-player exchanges.
        if (active.length >= 24) {
          const replace = active.findIndex(item => !item.relevant);
          if (replace >= 0) active.splice(replace, 1);
          else if (!relevant) continue;
          else active.shift();
        }
        active.push(effect);
      }
      if ((active.length || taps.length) && frame === null) frame = root.requestAnimationFrame(draw);
    }
    root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) clear(); });
    motion.addEventListener('change', () => clear());
    return { sync, clear };
  }
  root.BlockEffects = { create };
})(window);
