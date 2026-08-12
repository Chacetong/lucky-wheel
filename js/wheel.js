import {
  state,
  CSS_VARS,
  RESULT_FX_CONFIG,
  totalWeight,
  prefersReducedMotion,
  ensureDistinctAdjacentColors,
  saveState,
} from './state.js';
import { esc, syncUI, updateLock, renderList, showToast } from './ui.js';

/* ================================================================
   Canvas 工具
================================================================ */
function getCanvas() { return document.getElementById('wheelCanvas'); }
function getCtx() { return getCanvas().getContext('2d'); }

export function resizeCanvas() {
  const canvas = getCanvas();
  /* 2× 已经够清晰，同时避免 3×/4× 移动屏上的 canvas 内存和绘制开销。 */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wrap = canvas.closest('.wheel-wrap');
  const bounds = wrap ? wrap.getBoundingClientRect() : null;
  const avail = bounds && bounds.width > 0
    ? Math.min(bounds.width, bounds.height || bounds.width)
    : Math.min(window.innerWidth * 0.72, 680);
  const size = Math.max(220, Math.floor(avail));
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* 用 rAF 合并高频输入事件，避免打字时每次按键都触发重绘或写盘。 */
export function scheduleRedraw() {
  if (state.redrawRafId !== null) return;
  state.redrawRafId = requestAnimationFrame(() => {
    state.redrawRafId = null;
    redraw();
  });
}

/* ================================================================
   绘制转盘
================================================================ */
export function redraw(rot) {
  if (rot !== undefined) state.rotation = rot;
  drawWheel(state.rotation);
}

export function drawWheel(rot) {
  const canvas = getCanvas();
  const ctx = getCtx();
  const W = parseFloat(canvas.style.width) || canvas.width;
  const H = parseFloat(canvas.style.height) || canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = W / 2 - Math.max(7, W * 0.018);

  ctx.clearRect(0, 0, W, H);

  /* ── 空状态 ─────────────────────────── */
  if (state.entries.length === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = CSS_VARS['--deep-gray'];
    ctx.fill();
    drawOuterRing(ctx, cx, cy, R, W);
    ctx.fillStyle = CSS_VARS['--gray'];
    ctx.font = `800 ${Math.floor(W * 0.045)}px 'Noto Sans SC', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('请添加参与者', cx, cy);
    return;
  }

  /* ── 单人满圆 ───────────────── */
  if (state.entries.length === 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = state.entries[0].color;
    ctx.fill();
    drawOuterRing(ctx, cx, cy, R, W);
    /* 只有 1 人时不画名字 */
    drawHub(ctx, cx, cy, R);
    return;
  }

  /* ── 扇区 ────────────────────────────── */
  const total = totalWeight();
  let angle = rot - Math.PI / 2;   // 0° 定在 12 点方向

  state.entries.forEach((entry) => {
    const slice = (entry.weight / total) * Math.PI * 2;
    const end = angle + slice;
    const color = entry.color;

    /* 填充 */
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, end);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    /* 标签 */
    drawSegmentLabel(ctx, entry.title, angle, slice, cx, cy, R);

    angle = end;
  });

  drawOuterRing(ctx, cx, cy, R, W);
  drawHub(ctx, cx, cy, R);
}

function drawOuterRing(ctx, cx, cy, R, W) {
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = CSS_VARS['--black'];
  ctx.lineWidth = Math.max(6, W * 0.016);
  ctx.stroke();
}

function drawHub(ctx, cx, cy, R) {
  /* 紧凑指针：三角形边正好切在圆形轮毂的切点，视觉上无空隙。 */
  const hubR = Math.max(11, Math.min(20, R * 0.072));
  const needleLen = (R - hubR) * 0.18;
  const tipDistance = hubR + needleLen;
  const needleTip = cy - tipDistance;
  const tangentY = cy - (hubR * hubR) / tipDistance;
  const tangentX = hubR * Math.sqrt(tipDistance * tipDistance - hubR * hubR) / tipDistance;

  /* ── 指针三角 ────────────────────────────── */
  ctx.beginPath();
  ctx.moveTo(cx - tangentX, tangentY);
  ctx.lineTo(cx, needleTip);
  ctx.lineTo(cx + tangentX, tangentY);
  ctx.closePath();
  ctx.fillStyle = CSS_VARS['--white'];
  ctx.fill();

  /* ── 中心实心轮毂 ──────────────────── */
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fillStyle = CSS_VARS['--white'];
  ctx.fill();
}

/* ================================================================
   扇区标签 —— 最多两行
================================================================ */
function drawSegmentLabel(ctx, title, angle, slice, cx, cy, R) {
  if (slice < 0.1) return;

  const mid = angle + slice / 2;
  const lr = R * 0.65;
  const lx = cx + Math.cos(mid) * lr;
  const ly = cy + Math.sin(mid) * lr;

  const availW = 2 * lr * Math.sin(Math.min(slice, Math.PI) / 2) * 0.80;

  const MAX_FS = 28, MIN_FS = 12;
  let chosen = null;

  for (let fs = MAX_FS; fs >= MIN_FS; fs--) {
    ctx.font = `700 ${fs}px 'Noto Sans SC', sans-serif`;
    const lines = labelTryFit(ctx, title, availW);
    if (lines) { chosen = { fs, lines }; break; }
  }

  if (!chosen) {
    ctx.font = `700 ${MIN_FS}px 'Noto Sans SC', sans-serif`;
    chosen = { fs: MIN_FS, lines: labelForceFit(ctx, title, availW) };
  }

  const { fs, lines } = chosen;

  ctx.save();
  ctx.translate(lx, ly);
  ctx.rotate(mid + Math.PI / 2);

  ctx.font = `700 ${fs}px 'Noto Sans SC', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lineH = fs * 1.1;
  const startY = lines.length === 1 ? 0 : -lineH / 2;

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    ctx.fillStyle = CSS_VARS['--black'];
    ctx.fillText(line, 0, y);
  });

  ctx.restore();
}

// 先尝试单行装下，再尝试拆两行。返回文本数组或 null。
function labelTryFit(ctx, text, availW) {
  if (ctx.measureText(text).width <= availW) return [text];

  let best = null, bestDiff = Infinity;
  for (let i = 1; i < text.length; i++) {
    const a = text.slice(0, i);
    const b = text.slice(i);
    const wa = ctx.measureText(a).width;
    const wb = ctx.measureText(b).width;
    if (wa <= availW && wb <= availW) {
      const diff = Math.abs(wa - wb);
      if (diff < bestDiff) { bestDiff = diff; best = [a, b]; }
    }
  }
  return best;
}

function labelForceFit(ctx, text, availW) {
  const split = labelTryFit(ctx, text, availW);
  if (split) return split;

  let label = text;
  while (label.length > 1 && ctx.measureText(label + '…').width > availW) {
    label = label.slice(0, -1);
  }
  return [label + '…'];
}

/* ================================================================
   抽奖旋转
================================================================ */
export function handleSpin(restoreWinner = null) {
  if (state.entries.length < 2) {
    showToast('⚠️ 至少需要 2 位参与者才能开始抽奖', { global: true });
    return;
  }
  if (state.spinning) return;

  state.spinning = true;
  state.preSpinRotation = state.rotation;
  state.restoreWinnerOnCancel = restoreWinner;
  const wheel = document.querySelector('.wheel-wrap');
  if (wheel) {
    const wheelRect = wheel.getBoundingClientRect();
    const shiftX = window.innerWidth / 2
      - (wheelRect.left + wheelRect.width / 2);
    const shiftY = window.innerHeight / 2
      - (wheelRect.top + wheelRect.height / 2);
    wheel.style.setProperty('--spin-shift-x', `${shiftX.toFixed(1)}px`);
    wheel.style.setProperty('--spin-shift-y', `${shiftY.toFixed(1)}px`);

    /* 让转盘尽量填满视口，四周留出安全边距。 */
    const viewportShort = Math.min(window.innerWidth, window.innerHeight);
    const safeMargin = Math.max(24, viewportShort * 0.04);
    const availableSize = viewportShort - safeMargin * 2;
    const scale = Math.max(1, availableSize / wheelRect.width);
    wheel.style.setProperty('--spin-scale', scale.toFixed(3));
  }
  document.body.classList.add('spinning');
  syncUI();

  /* 尊重 reduced-motion 偏好：缩短时长、降低圈数，但仍随机产生一个胜者。 */
  const reduceMotion = prefersReducedMotion();
  const fullSpins = reduceMotion
    ? (1 + Math.random()) * Math.PI * 2
    : (6 + Math.random()) * Math.PI * 2;
  const from = state.rotation;
  const duration = reduceMotion
    ? 700
    : 4500 + Math.random() * 1200;
  const t0 = performance.now();

  function tick(now) {
    const t = Math.min((now - t0) / duration, 1);
    /* 每帧同步全局 rotation，让 resize / cancelSpin 等外部读者拿到当前
       实际的视觉角度。 */
    state.rotation = from + fullSpins * easeSpin(t);
    drawWheel(state.rotation);

    if (t < 1) {
      state.rafId = requestAnimationFrame(tick);
    } else {
      state.spinning = false;
      document.body.classList.remove('spinning');
      syncUI();

      /* 根据指针最终停在的角度反推胜者。 */
      showResult(getWinnerAtPointer(state.rotation));
    }
  }

  state.rafId = requestAnimationFrame(tick);
}

/* 中止当前抽奖并回到抽奖前状态。转盘沿顺时针方向平滑归位（≤ 360°），
   缓动时长与 wheel-wrap 缩放回位一致；`.canceling` 类保证 520ms 回位期
   间 draw-stage 一直盖在阵容之上，缩小的转盘不会被裁切或遮挡。 */
export function cancelSpin() {
  if (!state.spinning) return;
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  state.spinning = false;
  document.body.classList.remove('spinning');
  document.body.classList.add('canceling');
  syncUI();
  showToast('抽奖已取消', { global: true });

  const twoPi = Math.PI * 2;
  const startRotation = state.rotation;
  const delta = ((state.preSpinRotation - startRotation) % twoPi + twoPi) % twoPi;
  const endRotation = startRotation + delta;

  const CANCEL_DURATION = 520;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const t0 = performance.now();

  function tick(now) {
    const t = Math.min((now - t0) / CANCEL_DURATION, 1);
    drawWheel(startRotation + delta * easeOut(t));
    if (t < 1) {
      state.rafId = requestAnimationFrame(tick);
      return;
    }
    state.rotation = endRotation;
    drawWheel(state.rotation);
    state.rafId = null;
    document.body.classList.remove('canceling');
    const restore = state.restoreWinnerOnCancel;
    state.restoreWinnerOnCancel = null;
    if (restore) showResult(restore);
  }

  state.rafId = requestAnimationFrame(tick);
}

/* 判断指针（12 点方向）落在哪个扇区。 */
function getWinnerAtPointer(rot) {
  const total = totalWeight();
  /* 指针固定在 12 点方向；转盘从初始位置旋转了 rot。drawWheel 里 angle
     起点是 rot - π/2，因此指针在未旋转扇区布局中的对应角度就是
     -rot（对 2π 取正模）。 */
  const pointerAngle = ((-rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let cum = 0;
  for (let i = 0; i < state.entries.length; i++) {
    cum += (state.entries[i].weight || 1) / total * Math.PI * 2;
    if (pointerAngle < cum) return state.entries[i];
  }
  return state.entries[state.entries.length - 1];
}

function easeSpin(t) {
  /* Anticipation 前奏 —— 转盘先反向拉回再向前，制造出手感张力。DIP 是占总
     旋转量的比例，实际角度 = DIP × fullSpins，默认 6–7 圈下约 32°–38°。原先
     的 0.6%（约 13°）不足半个扇区，拉回幅度看不清就白做了这个前奏。
     RATIO 跟着放宽一档：行程涨 2.5 倍而时长不变会把拉回变成瞬间抽动。 */
  const ANTICIPATION_RATIO = 0.065;
  const ANTICIPATION_DIP = -0.015;

  if (t < ANTICIPATION_RATIO) {
    const p = t / ANTICIPATION_RATIO;
    return ANTICIPATION_DIP * (1 - Math.pow(1 - p, 2));
  }

  const mainT = (t - ANTICIPATION_RATIO) / (1 - ANTICIPATION_RATIO);
  const accelerationRatio = 0.16;
  const decelerationPower = 1.75;
  const decelerationDuration = 1 - accelerationRatio;
  const peakVelocity = 1 / (
    accelerationRatio / 2
    + decelerationDuration / (decelerationPower + 1)
  );

  let progress;
  if (mainT < accelerationRatio) {
    progress = peakVelocity * mainT * mainT / (2 * accelerationRatio);
  } else {
    const decelerationProgress = (mainT - accelerationRatio) / decelerationDuration;
    const accelerationDistance = peakVelocity * accelerationRatio / 2;
    const decelerationDistance = peakVelocity * decelerationDuration
      * (1 - Math.pow(1 - decelerationProgress, decelerationPower + 1))
      / (decelerationPower + 1);
    progress = accelerationDistance + decelerationDistance;
  }

  return ANTICIPATION_DIP + (1 - ANTICIPATION_DIP) * progress;
}

/* ================================================================
   抽奖结果 modal
================================================================ */
function showResult(winner) {
  closeModal();
  state.currentModalWinner = winner;

  const removeMode = document.getElementById('removeToggle').checked;
  const color = winner.color;
  const pct = ((winner.weight / totalWeight()) * 100).toFixed(1);
  const resultDate = new Date();
  const resultTime = formatResultTime(resultDate);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'resultOverlay';
  overlay.style.setProperty('--winner-color', color);
  overlay.style.setProperty('--result-ink', '#F4F4EF');

  overlay.innerHTML = `
    <canvas class="result-fx" aria-hidden="true"></canvas>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalWinner" style="--winner-color:${color}">
      <div class="modal__trophy" aria-hidden="true">01</div>
      <div class="modal__label" aria-hidden="true">THE<br>WINNER<br>IS</div>
      <div class="modal__winner" id="modalWinner">${esc(winner.title)}</div>
      <div class="modal__details">
        <div class="modal__weight">胜出概率 / ${pct}%</div>
        <time class="modal__time" datetime="${resultDate.toISOString()}">${resultTime.date} <strong>${resultTime.time}</strong></time>
      </div>
      <div class="modal__actions">
        <button type="button" class="btn btn--primary" data-action="spin-again">
          <span>再来一次</span>
          <span class="spin-btn__arrow-stage" aria-hidden="true">
            <svg class="spin-btn__arrow spin-btn__arrow--current" width="96" height="48" viewBox="0 0 96 48" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
              <path d="M0 24H96M96 24C82.7452 24 72 13.2548 72 0M96 24C82.7452 24 72 34.7452 72 48" stroke="currentColor" stroke-width="8" />
            </svg>
            <svg class="spin-btn__arrow spin-btn__arrow--next" width="96" height="48" viewBox="0 0 96 48" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
              <path d="M0 24H96M96 24C82.7452 24 72 13.2548 72 0M96 24C82.7452 24 72 34.7452 72 48" stroke="currentColor" stroke-width="8" />
            </svg>
          </span>
        </button>
        <button type="button" class="btn btn--ghost" data-action="close">关闭</button>
      </div>
    </div>`;

  state.modalOpen = true;
  document.body.appendChild(overlay);
  overlay._fxCleanup = initResultEffect(
    overlay.querySelector('.result-fx'),
    overlay.querySelector('.modal__winner')
  );
  updateLock();

  const focusables = overlay.querySelectorAll('button');
  const primaryBtn = overlay.querySelector('.btn--primary');
  if (primaryBtn) primaryBtn.focus();

  /* Esc / Tab 焦点陷阱 —— 挂在 document 上，无论焦点当前是否在 overlay
     内都能拦到；实现 Tab 循环 + Escape 关闭。 */
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key === 'Tab' && focusables.length) {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (!overlay.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey);
  overlay._cleanup = () => document.removeEventListener('keydown', onKey);

  overlay.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (trigger) {
      if (trigger.dataset.action === 'spin-again') spinAgain();
      else if (trigger.dataset.action === 'close') closeModal();
      return;
    }
    if (event.target === overlay) closeModal();
  });

  /* 中奖者的移除延迟到 modal 关闭时执行。 */
  state.pendingRemoveId = removeMode ? winner.id : null;
}

export function closeModal(onDone) {
  const el = document.getElementById('resultOverlay');
  if (!el) { if (typeof onDone === 'function') onDone(); return; }
  state.modalOpen = false;
  if (typeof el._cleanup === 'function') el._cleanup();
  if (typeof el._fxCleanup === 'function') el._fxCleanup();
  updateLock();
  el.classList.add('out');
  setTimeout(() => {
    state.currentModalWinner = null;
    el.remove();
    if (state.pendingRemoveId !== null) {
      state.entries = state.entries.filter(e => e.id !== state.pendingRemoveId);
      ensureDistinctAdjacentColors();
      state.pendingRemoveId = null;
      renderList();
      syncUI();
      saveState();
    }
    redraw();
    if (typeof onDone === 'function') onDone();
  }, 240);
}

function spinAgain() {
  const restoreWinner = state.currentModalWinner;
  closeModal(() => {
    if (state.entries.length >= 2) handleSpin(restoreWinner);
    else showToast('⚠️ 参与者不足，无法继续抽奖', { global: true });
  });
}

/* ================================================================
   工具函数
================================================================ */
function formatResultTime(date) {
  const pad = value => String(value).padStart(2, '0');
  return {
    date: `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function initResultEffect(canvas, target) {
  if (!canvas) return () => { };

  const ctx = canvas.getContext('2d');
  const reduceMotion = prefersReducedMotion();
  const speedLines = [];
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  let width = 0;
  let height = 0;
  let raf = null;
  let active = true;
  let lastFrame = 0;
  let originTimer = null;
  let emissionCarry = 0;
  let emissionIndex = 0;
  const origin = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };

  function updateOrigin() {
    if (target && target.textContent) {
      const range = document.createRange();
      range.selectNodeContents(target);
      const rect = range.getBoundingClientRect();
      range.detach();
      origin.x = rect.width ? rect.left + rect.width / 2 : width / 2;
      origin.y = rect.height ? rect.top + rect.height / 2 : height / 2;
    } else {
      origin.x = width / 2;
      origin.y = height / 2;
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateOrigin();
  }

  function randomBetween(range) {
    return range.min + Math.random() * (range.max - range.min);
  }

  function emitLine() {
    /* 用黄金角步进避免线段聚簇，再加一点随机偏移让结果看起来有机而非
       数学式均匀。 */
    const angle = emissionIndex++ * GOLDEN_ANGLE
      + (Math.random() - 0.5) * RESULT_FX_CONFIG.angleJitter;

    speedLines.push({
      angle,
      distance: RESULT_FX_CONFIG.spawnRadius,
      speed: randomBetween(RESULT_FX_CONFIG.lineSpeed),
      acceleration: randomBetween(RESULT_FX_CONFIG.lineAcceleration),
      length: randomBetween(RESULT_FX_CONFIG.lineLength),
      age: 0,
      growDuration: randomBetween(RESULT_FX_CONFIG.lineGrowDuration),
      width: randomBetween(RESULT_FX_CONFIG.lineWidth),
    });

    if (speedLines.length > RESULT_FX_CONFIG.maxLines) speedLines.shift();
  }

  function draw(now = 0) {
    if (!active) return;
    ctx.clearRect(0, 0, width, height);

    const delta = lastFrame ? Math.min(now - lastFrame, 32) : 16;
    lastFrame = now;
    const maxRadius = Math.hypot(width, height) * 0.72;

    if (reduceMotion && speedLines.length === 0) {
      for (let i = 0; i < Math.min(42, RESULT_FX_CONFIG.maxLines); i++) {
        emitLine();
        const line = speedLines[speedLines.length - 1];
        line.distance = Math.random() * maxRadius;
        line.age = line.growDuration;
      }
    } else if (!reduceMotion) {
      emissionCarry += RESULT_FX_CONFIG.linesPerSecond * delta / 1000;
      while (emissionCarry >= 1) {
        emitLine();
        emissionCarry -= 1;
      }
    }

    for (let i = speedLines.length - 1; i >= 0; i--) {
      const line = speedLines[i];
      if (!reduceMotion) {
        const deltaSeconds = delta / 1000;
        line.age += delta;
        line.speed += line.acceleration * deltaSeconds;
        line.distance += line.speed * deltaSeconds;
      }

      if (line.distance > maxRadius + line.length) {
        speedLines.splice(i, 1);
        continue;
      }

      const ux = Math.cos(line.angle);
      const uy = Math.sin(line.angle);
      const startX = origin.x + ux * line.distance;
      const startY = origin.y + uy * line.distance;
      const growProgress = Math.min(line.age / line.growDuration, 1);
      const easedGrowth = 1 - Math.pow(1 - growProgress, 3);
      const visibleLength = line.length * easedGrowth;
      const endX = startX + ux * visibleLength;
      const endY = startY + uy * visibleLength;

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = line.width;
      ctx.lineCap = 'butt';
      ctx.stroke();
    }

    if (!reduceMotion) raf = requestAnimationFrame(draw);
  }

  resize();
  draw(performance.now());
  window.addEventListener('resize', resize, { passive: true });
  document.fonts.ready.then(() => {
    if (!active) return;
    updateOrigin();
    originTimer = setTimeout(updateOrigin, 720);
  });

  return () => {
    active = false;
    if (raf !== null) cancelAnimationFrame(raf);
    if (originTimer !== null) clearTimeout(originTimer);
    window.removeEventListener('resize', resize);
  };
}
