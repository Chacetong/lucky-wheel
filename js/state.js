/* ================================================================
   常量与调色板
================================================================ */
export const MAX_ENTRIES = 1000;
export const GROUP_MAX = 20;

export const PALETTE = [
  '#F06A6A', '#6AF078', '#856AF0', '#F0936A',
  '#6AF0A0', '#AD6AF0', '#F0BB6A', '#6AF0C8',
  '#D66AF0', '#F0E36A', '#6AF0F0', '#F06AE3',
  '#D6F06A', '#6AC8F0', '#F06ABB', '#ADF06A',
  '#6AA0F0', '#F06A93', '#85F06A', '#6A78F0',
];

export const ACDC_ROSTER = [
  '唐晨', '毛星融', '周迪', '黄伟', '周剑',
  '杨阳', '雷咏梅', '邓小璐', '黄健', '张恒',
];

/* 结果页速度线特效参数。挂到 window.RESULT_FX_CONFIG 上便于 DevTools
   实时调参。 */
export const RESULT_FX_CONFIG = {
  linesPerSecond: 40,
  lineLength: { min: 50, max: 200 },
  lineWidth: { min: 1, max: 3 },
  lineSpeed: { min: 260, max: 720 },
  lineAcceleration: { min: 500, max: 800 },
  lineGrowDuration: { min: 1000, max: 2000 },
  maxLines: 220,
  spawnRadius: 8,
  angleJitter: 0.5,
};
window.RESULT_FX_CONFIG = RESULT_FX_CONFIG;

/* ================================================================
   共享可变状态
   —— 所有模块通过 import { state } 拿到同一个对象引用，
      直接读写字段即可跨模块同步；重新赋值数组用
      state.entries = [...] 而非 state = ... 保持引用。
================================================================ */
export const state = {
  entries: [],           // { id, title, weight, color }
  nextId: 1,
  currentMode: 'lottery',
  groupCount: 2,
  distMode: 'even',      // 'even' | 'fill'
  spinning: false,
  grouping: false,
  modalOpen: false,
  rotation: 0,           // 当前 canvas 旋转角度（弧度）
  rafId: null,
  redrawRafId: null,
  saveTimerId: null,
  /* 取消抽奖用的状态：preSpinRotation 记录抽奖开始前的静止角度，ESC 时可
     以顺滑回位；restoreWinnerOnCancel 保存上一轮结果 modal 的胜者，用于
     从「再来一次」触发的抽奖被取消时把结算页复原。 */
  preSpinRotation: 0,
  restoreWinnerOnCancel: null,
  currentModalWinner: null,
  pendingRemoveId: null,
  /* 分组结果，动画完成后保存最终名单，用于结果页拖拽换组。 */
  currentGroupResult: null,
  groupAnimTimers: { chaos: null, settle: null },
};

/* 缓存 CSS 变量，避免每帧 getComputedStyle 的性能开销。 */
export const CSS_VARS = {};
export function readCssVars() {
  const s = getComputedStyle(document.documentElement);
  ['--black', '--white', '--green', '--gray', '--deep-gray'].forEach(k => {
    CSS_VARS[k] = s.getPropertyValue(k).trim();
  });
}

/* 是否偏好减少动画（prefers-reduced-motion）。 */
export const prefersReducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches;

export function totalWeight() {
  return state.entries.reduce((sum, e) => sum + (e.weight || 1), 0);
}

/* ================================================================
   色彩工具
================================================================ */
export function getNextDistinctColor(currentColor, neighborColors = []) {
  const forbidden = new Set(neighborColors.filter(Boolean));
  const currentIndex = PALETTE.indexOf(currentColor);
  const startIndex = currentIndex >= 0 ? currentIndex : -1;

  for (let step = 1; step <= PALETTE.length; step++) {
    const candidate = PALETTE[(startIndex + step) % PALETTE.length];
    if (!forbidden.has(candidate)) return candidate;
  }

  return PALETTE[0];
}

export function ensureDistinctAdjacentColors() {
  state.entries.forEach((entry, index) => {
    const previousColor = index > 0 ? state.entries[index - 1].color : null;
    const colorIsInvalid = !PALETTE.includes(entry.color);
    if (colorIsInvalid || entry.color === previousColor) {
      entry.color = getNextDistinctColor(entry.color, [previousColor]);
    }
  });

  /* 转盘是环形的，首尾扇区也相邻，需要额外去重一次。 */
  if (state.entries.length > 1) {
    const firstColor = state.entries[0].color;
    const lastIndex = state.entries.length - 1;
    const lastEntry = state.entries[lastIndex];
    if (lastEntry.color === firstColor) {
      lastEntry.color = getNextDistinctColor(lastEntry.color, [
        state.entries[lastIndex - 1].color,
        firstColor,
      ]);
    }
  }
}

/* ================================================================
   localStorage 持久化
================================================================ */
const STORAGE_KEY = 'lucky-wheel-state-v1';

/* 首次持久化失败后由 UI 层弹一次 Toast；再失败保持沉默避免打扰。
   由 main.js 在启动阶段调用 setStorageErrorHandler 注入。 */
let storageErrorHandler = null;
let storageWarned = false;
export function setStorageErrorHandler(fn) { storageErrorHandler = fn; }

export function saveState() {
  try {
    const toggle = document.getElementById('removeToggle');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries: state.entries,
      nextId: state.nextId,
      removeMode: toggle ? toggle.checked : false,
      mode: state.currentMode,
      groupCount: state.groupCount,
      distMode: state.distMode,
    }));
  } catch (_) {
    /* quota exceeded / 隐私模式 / SecurityError 等；只在首次失败时提示。 */
    if (!storageWarned) {
      storageWarned = true;
      if (typeof storageErrorHandler === 'function') storageErrorHandler();
    }
  }
}

export function scheduleSave() {
  clearTimeout(state.saveTimerId);
  state.saveTimerId = setTimeout(() => {
    state.saveTimerId = null;
    saveState();
  }, 180);
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries) || data.entries.length === 0) return false;
    state.entries = data.entries.map(e => ({
      id: Number(e.id),
      title: String(e.title ?? ''),
      weight: Number(e.weight) || 1,
      color: typeof e.color === 'string' ? e.color : PALETTE[0],
    }));
    ensureDistinctAdjacentColors();
    state.nextId = Number(data.nextId) ||
      (state.entries.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    const toggle = document.getElementById('removeToggle');
    if (toggle && data.removeMode) toggle.checked = true;
    if (data.mode === 'grouping' || data.mode === 'lottery') state.currentMode = data.mode;
    if (Number.isFinite(data.groupCount) && data.groupCount >= 2) {
      state.groupCount = Math.floor(data.groupCount);
    }
    if (data.distMode === 'even' || data.distMode === 'fill') state.distMode = data.distMode;
    return true;
  } catch (_) {
    return false;
  }
}
