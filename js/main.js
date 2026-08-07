import {
  state,
  MAX_ENTRIES,
  PALETTE,
  ACDC_ROSTER,
  prefersReducedMotion,
  readCssVars,
  loadState,
  saveState,
  scheduleSave,
  setStorageErrorHandler,
  getNextDistinctColor,
  ensureDistinctAdjacentColors,
} from './state.js';
import {
  showToast,
  bindTooltipDelegation,
  syncUI,
  syncStats,
  renderList,
} from './ui.js';
import {
  resizeCanvas,
  redraw,
  scheduleRedraw,
  handleSpin,
  cancelSpin,
} from './wheel.js';
import {
  syncGroupStage,
  setDistMode,
  updateGroupCount,
  commitGroupCount,
  handleGroup,
  cancelGrouping,
} from './grouping.js';

/* ================================================================
   模式切换
================================================================ */
function setMode(mode) {
  if (mode !== 'lottery' && mode !== 'grouping') return;
  state.currentMode = mode;
  document.body.classList.toggle('mode-lottery', mode === 'lottery');
  document.body.classList.toggle('mode-grouping', mode === 'grouping');
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  });
  document.querySelectorAll('.hero-title__body').forEach(body => {
    body.setAttribute('aria-hidden', String(body.dataset.mode !== mode));
  });
  const cancelHint = document.querySelector('.shortcut-hint--cancel');
  if (cancelHint) {
    cancelHint.textContent = mode === 'lottery' ? '按 ESC 取消抽奖' : '按 ESC 取消分组';
  }
  if (mode === 'lottery') {
    resizeCanvas();
    redraw();
  } else {
    syncGroupStage();
  }
  saveState();
}

/* ================================================================
   选手条目管理
================================================================ */
function addEntry(defaultTitle) {
  if (state.entries.length >= MAX_ENTRIES) {
    showToast(`最多支持 ${MAX_ENTRIES} 位参与者`);
    return;
  }
  const id = state.nextId++;
  const title = defaultTitle || `Player ${id}`;
  let color;
  if (state.entries.length === 0) {
    /* 首位选手随机取 PALETTE 一个色，避免每次新建阵容都以同一色开头。
       后续新增沿用 getNextDistinctColor 从这个随机种子往下推。 */
    color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  } else {
    const lastColor = state.entries[state.entries.length - 1].color;
    const firstColor = state.entries[0].color;
    color = getNextDistinctColor(lastColor, [lastColor, firstColor]);
  }
  state.entries.push({ id, title, weight: 1, color });
  renderList();
  redraw();
  syncGroupStage();
  syncUI();
  saveState();
}

function deleteEntry(id) {
  state.entries = state.entries.filter(e => e.id !== id);
  ensureDistinctAdjacentColors();
  renderList();
  redraw();
  syncGroupStage();
  syncUI();
  saveState();
}

function clearAll() {
  if (state.entries.length === 0) return;
  state.entries = [];
  state.nextId = 1;
  renderList();
  redraw();
  syncGroupStage();
  syncUI();
  saveState();
}

function loadPresetRoster() {
  state.entries = [];
  state.nextId = 1;
  /* 用一个随机 palette 色作为种子，每次载入 ACDC 都会得到不同的配色序列。 */
  let previousColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];

  ACDC_ROSTER.forEach((title, idx) => {
    const color = idx === 0
      ? previousColor
      : getNextDistinctColor(previousColor, [previousColor]);
    state.entries.push({ id: state.nextId++, title, weight: 1, color });
    previousColor = color;
  });

  renderList();
  redraw();
  syncGroupStage();
  syncUI();
  saveState();
  showToast('已载入 ACDC 阵容');
}

/* ================================================================
   随机权重
   —— 全部选手同时从当前值插值到新的随机值，先快后慢。
================================================================ */
const RANDOM_WEIGHT_MIN_STEP = 10;   // 1.0 → 10（以 0.1 为单位的整数域）
const RANDOM_WEIGHT_MAX_STEP = 100;  // 10.0 → 100
const WEIGHT_ANIM_MS = 900;

/* 与 CSS 的 --ease-out-quart 同一条曲线，保持项目内动效一致。 */
const easeOutQuart = t => 1 - Math.pow(1 - t, 4);

/* 在 0.1 步进的整数域里取随机，避免浮点累积误差，含两端。 */
function randomWeight() {
  const span = RANDOM_WEIGHT_MAX_STEP - RANDOM_WEIGHT_MIN_STEP + 1;
  return (RANDOM_WEIGHT_MIN_STEP + Math.floor(Math.random() * span)) / 10;
}

function randomizeWeights() {
  if (state.entries.length === 0) return;
  if (state.spinning || state.grouping || state.weightAnimRafId !== null) return;

  /* 缓存 input 引用，避免每帧重新查询 DOM。动画期间若某行被删除，写入
     已脱离文档的 input 无副作用，转盘按新的 entries 重绘，不需要额外兜底。 */
  const plan = state.entries.map(entry => ({
    entry,
    input: document.querySelector(`.entry-row[data-id="${entry.id}"] .weight-input`),
    from: entry.weight,
    to: randomWeight(),
  }));

  /* 动画中 entry.weight 保留连续浮点值来驱动扇区角度 —— 若每帧都量化到
     0.1 步进，扇区角度就是台阶式跳变，视觉上即为抖动（easeOutQuart 开头
     极快，100ms 内跨掉大量台阶，抖动最明显）。数字显示照旧 toFixed(1)，
     只有落地那一帧才把权重真正量化，保证存下去的值干净。 */
  const applyProgress = (progress, { quantize = false } = {}) => {
    plan.forEach(({ entry, input, from, to }) => {
      const raw = from + (to - from) * progress;
      entry.weight = quantize ? Math.round(raw * 10) / 10 : raw;
      if (input) input.value = entry.weight.toFixed(1);
    });
    redraw();
    syncStats();
  };

  const finish = () => {
    state.weightAnimRafId = null;
    syncUI();
    saveState();
    /* 数值停稳后才提示，避免 Toast 与跳动的数字同时抢注意力。 */
    showToast('已随机全员权重');
  };

  if (prefersReducedMotion()) {
    applyProgress(1, { quantize: true });
    finish();
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / WEIGHT_ANIM_MS);
    if (t < 1) {
      applyProgress(easeOutQuart(t));
      state.weightAnimRafId = requestAnimationFrame(step);
    } else {
      applyProgress(1, { quantize: true });
      finish();
    }
  };
  state.weightAnimRafId = requestAnimationFrame(step);
  /* 先置句柄再同步，让「随机权重」和抽奖按钮立刻进入禁用态。 */
  syncUI();
}

function cycleColor(id) {
  const entryIndex = state.entries.findIndex(entry => entry.id === id);
  if (entryIndex < 0) return;
  const e = state.entries[entryIndex];
  const previousColor = state.entries.length > 1
    ? state.entries[(entryIndex - 1 + state.entries.length) % state.entries.length].color
    : null;
  const nextColor = state.entries.length > 1
    ? state.entries[(entryIndex + 1) % state.entries.length].color
    : null;
  e.color = getNextDistinctColor(e.color, [previousColor, nextColor]);
  /* 只更新当前色块，保持输入焦点，避免整行 DOM 重建。 */
  const dot = document.querySelector(`.entry-row[data-id="${id}"] .entry-dot`);
  if (dot) dot.style.background = e.color;
  redraw();
  saveState();
}

function updateTitle(id, val) {
  const e = state.entries.find(e => e.id === id);
  if (!e) return;
  e.title = val;
  scheduleRedraw();
  scheduleSave();
}

/* 打字过程中实时更新 —— 接受任意有效的正数，但不强制夹范围（会干扰
   输入流程）。最终的夹取在 blur 时由 commitWeight 完成。 */
function updateWeight(id, val) {
  const e = state.entries.find(e => e.id === id);
  if (!e) return;
  const w = parseFloat(val);
  if (!Number.isFinite(w) || w < 0.1) return;
  e.weight = Math.min(Math.round(w * 10) / 10, 99999);
  scheduleRedraw();
  syncStats();
  scheduleSave();
}

/* 超过该阈值给一次性提示 —— 不阻塞输入，让用户自行确认是否真要极端偏斜。 */
const WEIGHT_WARN_THRESHOLD = 100;

function commitWeight(id, input) {
  const e = state.entries.find(e => e.id === id);
  if (!e) return;
  const w = parseFloat(input.value);
  const prevWeight = e.weight;
  e.weight = (!Number.isFinite(w) || w < 0.1)
    ? 0.1
    : Math.min(Math.round(w * 10) / 10, 99999);
  /* 失焦时才补齐一位小数；打字过程中不格式化，否则输入 "1.5" 打到 "1."
     时就会被改写成 "1.0"，没法继续输入。 */
  input.value = e.weight.toFixed(1);
  redraw();
  syncStats();
  saveState();
  /* 只在跨越阈值时提示一次，反复微调不会连续弹 Toast。 */
  if (e.weight > WEIGHT_WARN_THRESHOLD && prevWeight <= WEIGHT_WARN_THRESHOLD) {
    showToast('权重过大将挤压其他扇区', { global: true });
  }
}

/* 阵容列表的事件委托。启动时挂一次，动态生成的行不需要单独绑事件。 */
function bindEntriesListDelegation(list) {
  const rowId = (target) => {
    const row = target.closest('.entry-row');
    return row ? Number(row.dataset.id) : null;
  };

  list.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const id = rowId(trigger);
    if (id === null) return;
    if (trigger.dataset.action === 'cycle-color') cycleColor(id);
    else if (trigger.dataset.action === 'delete') deleteEntry(id);
  });

  list.addEventListener('input', (event) => {
    const target = event.target;
    const id = rowId(target);
    if (id === null) return;
    if (target.classList.contains('entry-input')) updateTitle(id, target.value);
    else if (target.classList.contains('weight-input')) updateWeight(id, target.value);
  });

  list.addEventListener('focusout', (event) => {
    const target = event.target;
    const id = rowId(target);
    if (id === null) return;
    if (target.classList.contains('weight-input')) commitWeight(id, target);
  });
}

/* 每 5s 重放一次「见证奇迹」按钮的箭头滑动，让闲置用户注意到按钮。
   只播放向右滑出，不让回位动画可见：滑出后加 .attention-reset 用
   transition: none 同步提交重置状态，再恢复正常 transition 规则。 */
function startSpinBtnAttentionLoop() {
  const btn = document.getElementById('spinBtn');
  if (!btn) return;
  setInterval(() => {
    if (state.currentMode !== 'lottery') return;
    if (btn.disabled || prefersReducedMotion()) return;
    btn.classList.add('attention');
    setTimeout(() => {
      btn.classList.add('attention-reset');
      btn.classList.remove('attention');
      /* 强制同步 layout 让 transition:none + 重置 transform 在当前任务
         内落地；紧接着移除 .attention-reset 时不会再触发过渡，因为值
         已经是静止态。 */
      void btn.offsetWidth;
      btn.classList.remove('attention-reset');
    }, 320);
  }, 5000);
}

/* ================================================================
   启动引导
================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  readCssVars();
  resizeCanvas();

  /* 存储不可用（quota / 隐私模式）时首次弹一次全局 Toast，之后保持沉默。 */
  setStorageErrorHandler(() => {
    showToast('存储不可用，本次修改退出后不会保留', { global: true });
  });

  const entriesList = document.getElementById('entriesList');
  if (entriesList) bindEntriesListDelegation(entriesList);

  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  bindTooltipDelegation();

  const groupCountInput = document.getElementById('groupCount');
  if (groupCountInput) {
    groupCountInput.addEventListener('input', () => updateGroupCount(groupCountInput.value));
    groupCountInput.addEventListener('blur', () => commitGroupCount(groupCountInput));
  }
  document.querySelectorAll('.group-dist__btn').forEach(btn => {
    btn.addEventListener('click', () => setDistMode(btn.dataset.dist));
  });
  const groupBtn = document.getElementById('groupBtn');
  if (groupBtn) groupBtn.addEventListener('click', handleGroup);

  /* 把原本的 inline onclick 迁到模块脚本里绑定。 */
  const spinBtn = document.getElementById('spinBtn');
  if (spinBtn) spinBtn.addEventListener('click', () => handleSpin());
  const addBtn = document.getElementById('addBtn');
  if (addBtn) addBtn.addEventListener('click', () => addEntry());
  const randomWeightBtn = document.getElementById('randomWeightBtn');
  if (randomWeightBtn) randomWeightBtn.addEventListener('click', randomizeWeights);
  /* 「随机权重」也用 .preset-btn 样式，选择器要排除掉它才能拿到 ACDC。 */
  const presetBtn = document.querySelector('.preset-btn:not(#randomWeightBtn)');
  if (presetBtn) presetBtn.addEventListener('click', loadPresetRoster);
  const clearBtn = document.querySelector('.clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearAll);

  const restored = loadState();
  if (restored) {
    renderList();
    redraw();
    syncUI();
  } else {
    for (let i = 1; i <= 8; i++) addEntry(`Player ${i}`);
  }

  setDistMode(state.distMode);
  syncGroupStage();
  setMode(state.currentMode);

  /* is-preload 类会在首帧把所有 transition/animation 短路，让初始模式
     状态一次性呈现而不产生跨态过渡。首帧提交后移除 is-preload，同时挂
     上 is-entering 让"入场专用"的更长、错落的过渡接管；1.8s 后清理，
     之后切换模式再回到基础 transition 时长。 */
  requestAnimationFrame(() => {
    document.body.classList.remove('is-preload');
    document.body.classList.add('is-entering');
    setTimeout(() => document.body.classList.remove('is-entering'), 1800);
  });

  /* 「胜出后移除」开关变化时持久化。 */
  const toggle = document.getElementById('removeToggle');
  if (toggle) toggle.addEventListener('change', saveState);

  /* 全局快捷键：
     - Escape：抽奖 / 分组进行中时取消当前动作
     - Space / Enter：非输入态、非忙时启动抽奖或分组 */
  document.addEventListener('keydown', (e) => {
    if (state.spinning && e.key === 'Escape') {
      e.preventDefault();
      cancelSpin();
      return;
    }
    if (state.grouping && e.key === 'Escape') {
      e.preventDefault();
      cancelGrouping();
      return;
    }
    if (state.modalOpen || state.spinning || state.grouping) return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    e.preventDefault();
    if (state.currentMode === 'lottery') handleSpin();
    else if (state.currentMode === 'grouping') handleGroup();
  });

  window.addEventListener('resize', () => { resizeCanvas(); redraw(); });
  document.fonts.ready.then(() => redraw());

  startSpinBtnAttentionLoop();
});
