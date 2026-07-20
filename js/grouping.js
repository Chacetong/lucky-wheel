import {
  state,
  GROUP_MAX,
  prefersReducedMotion,
  saveState,
} from './state.js';
import { esc, syncUI, updateLock, showToast } from './ui.js';
import { closeModal } from './wheel.js';

/* ================================================================
   分组预览
================================================================ */

/* 小组数手工调好的行列布局，让 2/3/6 这种常见值感觉自然；其余组数回退
   到近似正方形的 ceil(sqrt) 计算。 */
const GROUP_GRID_LAYOUTS = {
  1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2],
  5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2],
  9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3],
};

export function groupGridLayout(n) {
  if (GROUP_GRID_LAYOUTS[n]) return GROUP_GRID_LAYOUTS[n];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return [cols, rows];
}

function groupCapForEntries() {
  return Math.max(2, Math.min(state.entries.length || 2, GROUP_MAX));
}

/* 芯片视觉缩放系数 —— 组内人数少时芯片放大填满卡片，人数多时紧凑排布。
   通过设在组容器上的 --chip-scale CSS 变量下发，预览槽、动画卡片、结果
   页芯片共用同一套规则。 */
export function chipScaleForCount(count) {
  if (count <= 1) return 1.35;
  if (count <= 2) return 1.2;
  if (count <= 3) return 1.1;
  if (count <= 4) return 1.0;
  if (count <= 6) return 0.9;
  if (count <= 8) return 0.8;
  return 0.7;
}

/* 依据当前分配模式，计算每组的计划人数。跟 assignEntriesToGroups 用同
   样的分配算法，但只返回人数数组，供空闲状态的预览槽使用。 */
function groupSizes(n, k, mode) {
  const sizes = new Array(k).fill(0);
  if (n <= 0 || k <= 0) return sizes;
  if (mode === 'even') {
    const base = Math.floor(n / k);
    const remainder = n % k;
    for (let i = 0; i < k; i++) sizes[i] = base + (i < remainder ? 1 : 0);
  } else {
    const per = Math.ceil(n / k);
    let assigned = 0;
    for (let i = 0; i < k - 1 && assigned < n; i++) {
      const size = Math.min(per, n - assigned);
      sizes[i] = size;
      assigned += size;
    }
    sizes[k - 1] = Math.max(0, n - assigned);
  }
  return sizes;
}

export function renderGroupStage() {
  const stage = document.getElementById('groupStage');
  if (!stage) return;
  const n = Math.max(2, Math.min(state.groupCount, GROUP_MAX));
  const [cols, rows] = groupGridLayout(n);
  stage.style.setProperty('--group-cols', cols);
  stage.style.setProperty('--group-rows', rows);
  const sizes = groupSizes(state.entries.length, n, state.distMode);
  stage.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const slot = document.createElement('div');
    slot.className = 'group-slot';
    slot.dataset.index = i;
    slot.innerHTML = `
      <div class="group-slot__header">Group ${String(i + 1).padStart(2, '0')}</div>
      <div class="group-slot__count"><strong>${sizes[i]}</strong><span>名候选</span></div>
    `;
    stage.appendChild(slot);
  }
}

/* 阵容变化时校正组数输入的上下限并重绘预览。任何模式下都可调用。 */
export function syncGroupStage() {
  const input = document.getElementById('groupCount');
  const cap = groupCapForEntries();
  if (state.groupCount > cap) state.groupCount = cap;
  if (state.groupCount < 2) state.groupCount = 2;
  if (input) {
    input.max = String(cap);
    input.value = String(state.groupCount);
  }
  renderGroupStage();
}

export function updateGroupCount(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return;
  const cap = groupCapForEntries();
  state.groupCount = Math.max(2, Math.min(parsed, cap));
  renderGroupStage();
  saveState();
}

export function commitGroupCount(input) {
  const cap = groupCapForEntries();
  const raw = input.value.trim();
  const parsed = parseInt(raw, 10);
  let toast = null;

  if (raw !== '' && Number.isFinite(parsed)) {
    if (parsed < 2) {
      toast = '组数不能少于 2';
    } else if (parsed > cap) {
      toast = state.entries.length < GROUP_MAX
        ? `组数不能超过选手数（${state.entries.length}）`
        : `最多支持 ${GROUP_MAX} 组`;
    }
  } else if (raw === '') {
    toast = '请填写组数';
  } else {
    toast = '组数需为整数';
  }

  state.groupCount = Number.isFinite(parsed)
    ? Math.max(2, Math.min(parsed, cap))
    : 2;
  input.value = String(state.groupCount);
  renderGroupStage();
  saveState();
  if (toast) showToast(toast, { global: true });
}

export function handleGroup() {
  if (state.entries.length < 2) {
    showToast('⚠️ 至少需要 2 位参与者才能分组', { global: true });
    return;
  }
  if (state.grouping) return;
  const k = Math.max(2, Math.min(state.groupCount, state.entries.length));
  const assignment = assignEntriesToGroups(state.entries, k, state.distMode);
  runGroupingAnimation(assignment);
}

/* Fisher–Yates 洗牌返回副本，调用方原数组保持不变。 */
function shuffledEntries(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* 按分配模式返回长度为 k 的分组结果数组。
   'even'  → 各组人数差 ≤ 1（13/4 → 4,3,3,3）
   'fill'  → 前 k−1 组按 ceil(n/k) 装满，末组吃剩（13/4 → 4,4,4,1） */
function assignEntriesToGroups(list, k, mode) {
  const shuffled = shuffledEntries(list);
  const n = shuffled.length;
  const groups = Array.from({ length: k }, () => []);

  if (mode === 'even') {
    const base = Math.floor(n / k);
    const remainder = n % k;
    let idx = 0;
    for (let g = 0; g < k; g++) {
      const size = base + (g < remainder ? 1 : 0);
      for (let s = 0; s < size; s++) groups[g].push(shuffled[idx++]);
    }
  } else {
    const per = Math.ceil(n / k);
    let idx = 0;
    for (let g = 0; g < k - 1 && idx < n; g++) {
      for (let s = 0; s < per && idx < n; s++) groups[g].push(shuffled[idx++]);
    }
    while (idx < n) groups[k - 1].push(shuffled[idx++]);
  }
  return groups;
}

export function setDistMode(mode) {
  if (mode !== 'even' && mode !== 'fill') return;
  state.distMode = mode;
  document.querySelectorAll('.group-dist__btn').forEach(btn => {
    const active = btn.dataset.dist === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderGroupStage();
  saveState();
}

/* ================================================================
   分组动画 —— 中心大牌 → 移动缩小飞入目标 chip
   单个选手时序：
     0                       → 中心大牌淡入 + scale-up
     FADE_IN                 → 稳定居中（HOLD）
     FADE_IN + HOLD          → 大牌 translate + scale 飞入 target chip
                                 位置；同帧目标 chip 触发 chipLand（透明 →
                                 白闪 → chip 色）
     + FLIGHT                → 大牌销毁，chip 停在最终态
   下一个 entry 的开始时间由 computeOffsets() 决定：前面间隔长，越到后
   面越紧凑，让 20 人也能压缩在 ~6s 内。
================================================================ */
/* 第一张大牌前的静默 —— 给舞台放大 + reduced-motion 之外的用户一点视觉
   缓冲，避免点击后立刻炸出名字。 */
const INITIAL_DELAY_MS = 200;
const CENTER_FADE_IN_MS = 120;
const CENTER_HOLD_MS = 60;
const FLIGHT_MS = 170;
const CHIP_LAND_MS = 160;
const FINISH_HOLD_MS = 180;
/* MIN_STAGGER 与 FADE_IN 对齐，让尾段"入场即起飞"，中心永远只一张；
   POWER 越大，加速过程越"陡"—— 前几张明显停一下，到中段就已经压到接近
   MIN，营造节奏递进感。 */
const MIN_STAGGER_MS = 120;
const MAX_STAGGER_MS = 310;
const STAGGER_POWER = 3.0;

/* 生成 N 个 entry 各自开始的绝对偏移量。首步一定是 0；相邻步的 gap 从
   MAX 衰减到 MIN，power > 1 让曲线前段陡、后段平（一开始一个一个来，
   后面成串）。 */
function computeOffsets(n) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const offsets = [0];
  const spread = Math.max(1, n - 2);
  for (let i = 1; i < n; i++) {
    const t = (i - 1) / spread;
    const gap = MIN_STAGGER_MS + (MAX_STAGGER_MS - MIN_STAGGER_MS) * Math.pow(1 - t, STAGGER_POWER);
    offsets.push(offsets[i - 1] + gap);
  }
  return offsets;
}

function pushTimer(id) {
  state.groupAnimTimers.pending.push(id);
  return id;
}

function clearPendingTimers() {
  state.groupAnimTimers.pending.forEach(id => clearTimeout(id));
  state.groupAnimTimers.pending = [];
}

/* 把 stage 平移到视口中心，与抽奖旋转时转盘的居中处理一致。 */
function centerStage(stage) {
  const rect = stage.getBoundingClientRect();
  const shiftX = window.innerWidth / 2 - (rect.left + rect.width / 2);
  const shiftY = window.innerHeight / 2 - (rect.top + rect.height / 2);
  stage.style.setProperty('--group-shift-x', `${shiftX.toFixed(1)}px`);
  stage.style.setProperty('--group-shift-y', `${shiftY.toFixed(1)}px`);
  const viewportShort = Math.min(window.innerWidth, window.innerHeight);
  const safeMargin = Math.max(24, viewportShort * 0.04);
  const availableSize = viewportShort - safeMargin * 2;
  const scale = Math.max(1, availableSize / rect.width);
  stage.style.setProperty('--group-scale', scale.toFixed(3));
}

/* 把 slot + placeholder chip 全量渲染出来。placeholder 保留最终布局所需
   的 padding / font-size / 名字文本占位，仅背景与文字色透明，避免落地
   时因内容出现而 reflow。传 landed=true 时直接以最终状态渲染，供
   reduced-motion 分支使用。 */
function renderPlaceholderSlots(finalGroups, { landed = false } = {}) {
  const stage = document.getElementById('groupStage');
  if (!stage) return;
  const [cols, rows] = groupGridLayout(finalGroups.length);
  stage.style.setProperty('--group-cols', cols);
  stage.style.setProperty('--group-rows', rows);

  const parts = finalGroups.map((members, i) => {
    const chipScale = chipScaleForCount(members.length);
    const chips = members.map(entry => `
      <div class="group-card${landed ? '' : ' is-placeholder'}"
           data-entry-id="${entry.id}"
           style="--chip-color:${entry.color}">${esc(entry.title)}</div>
    `).join('');
    return `
      <div class="group-slot" data-index="${i}" style="--chip-scale:${chipScale}">
        <div class="group-slot__header">Group ${String(i + 1).padStart(2, '0')}</div>
        <div class="group-slot__list">${chips}</div>
      </div>
    `;
  });
  stage.innerHTML = parts.join('');
}

/* 在 body 上挂一次性 center-card-stage；后续每个选手创建独立
   center-card-transport 承载动画。stage 元素会一直存在到分组结束或
   取消。 */
function ensureCenterStage() {
  let stage = document.getElementById('centerCardStage');
  if (!stage) {
    stage = document.createElement('div');
    stage.id = 'centerCardStage';
    stage.className = 'center-card-stage';
    stage.setAttribute('aria-hidden', 'true');
    document.body.appendChild(stage);
  }
  return stage;
}

function removeCenterStage() {
  const stage = document.getElementById('centerCardStage');
  if (stage) stage.remove();
}

function createCenterCard(entry) {
  const transport = document.createElement('div');
  transport.className = 'center-card-transport';
  transport.innerHTML = `<div class="center-card" style="--chip-color:${entry.color}">${esc(entry.title)}</div>`;
  return transport;
}

/* 单个 entry 生命周期：中心大牌淡入 → hold（时长由调度侧动态给出）→
   飞入目标 chip → 落位白闪。所有 timer 注册到 pending 便于 ESC 统一清理。
   holdMs 由 runGroupingAnimation 根据下一张的到达时刻反推，保证前一张
   总是在下一张淡入前进入飞行阶段，中心不会堆积多张同时可见的大牌。 */
function placeEntry(entry, groupIdx, holdMs) {
  if (!state.grouping) return;
  const stage = document.getElementById('groupStage');
  const centerStageEl = ensureCenterStage();
  if (!stage || !centerStageEl) return;

  const transport = createCenterCard(entry);
  centerStageEl.appendChild(transport);

  /* 挂上后下一帧再切 is-visible，保证 transition 从 initial 状态开始。 */
  requestAnimationFrame(() => {
    if (!state.grouping) { transport.remove(); return; }
    transport.classList.add('is-visible');
  });

  pushTimer(setTimeout(() => {
    if (!state.grouping) { transport.remove(); return; }
    landEntry(transport, entry, groupIdx);
  }, CENTER_FADE_IN_MS + Math.max(0, holdMs)));
}

function landEntry(transport, entry, groupIdx) {
  const stage = document.getElementById('groupStage');
  if (!stage) { transport.remove(); return; }

  const placeholder = stage.querySelector(
    `.group-slot[data-index="${groupIdx}"] .group-card.is-placeholder[data-entry-id="${entry.id}"]`
  );
  if (!placeholder) { transport.remove(); return; }

  /* 计算目标位置 —— 中心大牌天然锚在视口正中央（top:50% left:50% +
     translate(-50%,-50%)），飞行时把额外偏移 dx/dy + 缩放系数写进 inline
     transform，transition 会平滑过渡到最终态。 */
  const target = placeholder.getBoundingClientRect();
  const cardRect = transport.getBoundingClientRect();
  const dx = target.left + target.width / 2 - window.innerWidth / 2;
  const dy = target.top + target.height / 2 - window.innerHeight / 2;
  const scaleFactor = Math.min(
    target.width / Math.max(1, cardRect.width),
    target.height / Math.max(1, cardRect.height),
  );

  transport.classList.remove('is-visible');
  transport.classList.add('is-flying');
  transport.style.transform =
    `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(${scaleFactor.toFixed(3)})`;

  /* 飞行结束后再触发 chip 落位动画（透明 → 白闪 → chip 色），确保中心大牌
     已消失，同一名字不会同时出现在两处。 */
  pushTimer(setTimeout(() => {
    placeholder.classList.remove('is-placeholder');
    placeholder.classList.add('is-landing');
    pushTimer(setTimeout(() => {
      placeholder.classList.remove('is-landing');
    }, CHIP_LAND_MS));
    transport.remove();
  }, FLIGHT_MS));
}

function runGroupingAnimation(finalGroups) {
  /* slot 内成员按 state.entries 顺序排列 —— 保证放置时永远是从前往后填，
     不会出现「位置 3 已有芯片、位置 1/2 还空着」这种提前泄露"还剩几人"
     的空位。分组归属仍是随机的，只是每个 slot 里的芯片位置对齐入场顺序。
     currentGroupResult 也用这份排序结果，让结果 modal 的显示顺序与动画
     结束时保持一致。 */
  const entryIndex = new Map();
  state.entries.forEach((e, i) => entryIndex.set(e.id, i));
  const orderedGroups = finalGroups.map(members =>
    [...members].sort((a, b) =>
      (entryIndex.get(a.id) ?? 0) - (entryIndex.get(b.id) ?? 0))
  );

  state.grouping = true;
  state.currentGroupResult = orderedGroups;

  const stage = document.getElementById('groupStage');
  if (!stage) return;

  const reduceMotion = prefersReducedMotion();

  /* reduced-motion：直接以 landed 状态渲染所有 chip，短暂 hold 后开结果
     modal；不出中心牌，避免快速闪烁刺激。 */
  if (reduceMotion) {
    renderPlaceholderSlots(orderedGroups, { landed: true });
    centerStage(stage);
    document.body.classList.add('grouping-active');
    syncUI();
    pushTimer(setTimeout(() => {
      if (!state.grouping) return;
      finishGroupingAnimation();
    }, 240));
    return;
  }

  /* 常规路径：先把所有 slot + placeholder chip 就位（透明），再进入舞台
     居中放大，最后调度每个选手的中心牌 → 飞入。 */
  renderPlaceholderSlots(orderedGroups, { landed: false });
  centerStage(stage);
  document.body.classList.add('grouping-active');
  syncUI();

  /* 按 state.entries 顺序生成投放列表；每个 entry 反查所属组下标（分组本身
     仍是随机的，只是投放次序按名单）。 */
  const groupByEntryId = new Map();
  orderedGroups.forEach((members, groupIdx) => {
    members.forEach(entry => groupByEntryId.set(entry.id, groupIdx));
  });
  const plan = state.entries
    .map(entry => ({ entry, groupIdx: groupByEntryId.get(entry.id) }))
    .filter(item => item.groupIdx !== undefined);

  const offsets = computeOffsets(plan.length);

  /* 逐张反推 HOLD：card i 必须在 card i+1 淡入前离开中心。
     card i 的飞行开始时刻 = offset_i + FADE_IN + HOLD_i；
     强制该时刻 ≤ offset_{i+1}，即 HOLD_i ≤ (gap - FADE_IN)。
     最后一张没有 next，用默认 CENTER_HOLD_MS 让观众有个稳定收尾。 */
  const holds = offsets.map((offset, i) => {
    if (i === offsets.length - 1) return CENTER_HOLD_MS;
    const gap = offsets[i + 1] - offset;
    return Math.max(0, gap - CENTER_FADE_IN_MS);
  });

  plan.forEach((item, i) => {
    pushTimer(setTimeout(
      () => placeEntry(item.entry, item.groupIdx, holds[i]),
      INITIAL_DELAY_MS + offsets[i]
    ));
  });

  /* 最后一个 entry 落位后再 hold 一下再开结果 modal。 */
  const lastOffset = offsets[offsets.length - 1] || 0;
  const totalDuration = INITIAL_DELAY_MS + lastOffset
    + CENTER_FADE_IN_MS + CENTER_HOLD_MS + FLIGHT_MS + FINISH_HOLD_MS;
  pushTimer(setTimeout(() => {
    if (!state.grouping) return;
    finishGroupingAnimation();
  }, totalDuration));
}

/* 中止分组动画，让 stage 滑回原位。流程与 cancelSpin 对齐，也复用
   .canceling 类保证 520ms 回位期间 stage 一直盖在阵容之上。三段编排：
     t=0    → body.canceling 触发 chip 淡出（220ms）；stage 同步开始回位
     t=260  → renderGroupStage 重建为空槽预览，count 加 .is-entering 淡入
     t=520  → 移除 canceling，动画收尾 */
export function cancelGrouping() {
  if (!state.grouping) return;
  clearPendingTimers();
  removeCenterStage();
  state.grouping = false;
  state.currentGroupResult = null;
  document.body.classList.remove('grouping-active');
  document.body.classList.add('canceling');
  syncUI();
  showToast('分组已取消', { global: true });

  setTimeout(() => {
    renderGroupStage();
    /* renderGroupStage 刚 wipe 掉 innerHTML 再重建，等下一帧再挂
       .is-entering 保证 animation 从初始 keyframe 开始播放，而不是
       同帧被浏览器优化掉。 */
    requestAnimationFrame(() => {
      const counts = document.querySelectorAll('#groupStage .group-slot__count');
      counts.forEach(el => el.classList.add('is-entering'));
      setTimeout(() => {
        counts.forEach(el => el.classList.remove('is-entering'));
      }, 340);
    });
  }, 260);

  setTimeout(() => {
    document.body.classList.remove('canceling');
  }, 520);
}

function finishGroupingAnimation() {
  state.grouping = false;
  clearPendingTimers();
  removeCenterStage();
  document.body.classList.remove('grouping-active');
  syncUI();
  showGroupResult(state.currentGroupResult);
}

/* ================================================================
   分组结果全屏 modal
================================================================ */
function showGroupResult(groups) {
  if (!groups) return;
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'overlay group-overlay';
  overlay.id = 'groupResultOverlay';
  overlay.style.setProperty('--winner-color', 'var(--soft-gray)');
  overlay.style.setProperty('--result-ink', 'var(--black)');

  const [cols] = groupGridLayout(groups.length);

  overlay.innerHTML = `
    <div class="modal group-modal" role="dialog" aria-modal="true" aria-labelledby="groupResultTitle">
      <div class="modal__label" id="groupResultTitle" aria-hidden="true">RANDOM<br>GROUPS<br>OK</div>
      <div class="group-result" style="--result-cols: ${cols}">
        ${groups.map((_, i) => renderGroupResultGroupMarkup(i)).join('')}
      </div>
      <div class="modal__actions">
        <button type="button" class="btn btn--primary" data-action="regroup">
          <span>重新分组</span>
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
  updateLock();
  bindGroupResultDragDrop(overlay);

  const focusables = overlay.querySelectorAll('button');
  const primaryBtn = overlay.querySelector('.btn--primary');
  if (primaryBtn) primaryBtn.focus();

  /* Esc 关闭 + Tab 循环焦点陷阱，与抽奖结果 modal 处理一致。挂在
     document 上，无论当前焦点在 overlay 内外都能拦到。 */
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGroupResult();
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
      if (trigger.dataset.action === 'regroup') {
        closeGroupResult(() => handleGroup());
      } else if (trigger.dataset.action === 'close') {
        closeGroupResult();
      }
      return;
    }
    if (event.target === overlay) closeGroupResult();
  });
}

/* 结果页分组卡片 + 拖拽的小工具。拆成独立函数，拖拽结束后只重绘受影响
   的两个组，不用整个 overlay 重建。 */
function renderGroupResultGroupMarkup(groupIdx) {
  const members = (state.currentGroupResult && state.currentGroupResult[groupIdx]) || [];
  const scale = chipScaleForCount(members.length);
  return `
    <div class="group-result__group" data-index="${groupIdx}" style="--chip-scale:${scale}">
      <div class="group-result__header">
        Group ${String(groupIdx + 1).padStart(2, '0')}
        <span class="group-result__count" data-count="${members.length}">人</span>
      </div>
      <ul class="group-result__list">
        ${members.map((e, i) => `
          <li class="group-result__member" draggable="true" data-entry-id="${e.id}" style="background:${e.color}">
            <span class="group-result__index">${String(i + 1).padStart(2, '0')}</span>
            <span class="group-result__name">${esc(e.title)}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function refreshGroupResultGroup(overlay, groupIdx) {
  const el = overlay.querySelector(`.group-result__group[data-index="${groupIdx}"]`);
  if (!el) return;
  el.outerHTML = renderGroupResultGroupMarkup(groupIdx);
}

/* 结果页组间成员拖拽换组，事件委托挂在 overlay 上，重渲染的组不用重新绑定。 */
function bindGroupResultDragDrop(overlay) {
  let dragMemberId = null;
  let dragSourceIdx = null;

  overlay.addEventListener('dragstart', (event) => {
    const member = event.target.closest('.group-result__member');
    if (!member) return;
    dragMemberId = Number(member.dataset.entryId);
    dragSourceIdx = Number(member.closest('.group-result__group').dataset.index);
    event.dataTransfer.effectAllowed = 'move';
    /* Firefox 需要设置 dataTransfer payload 才能真正开始拖拽。 */
    event.dataTransfer.setData('text/plain', String(dragMemberId));
    member.classList.add('is-dragging');
  });

  overlay.addEventListener('dragend', (event) => {
    const member = event.target.closest('.group-result__member');
    if (member) member.classList.remove('is-dragging');
    overlay.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
    dragMemberId = null;
    dragSourceIdx = null;
  });

  overlay.addEventListener('dragover', (event) => {
    const target = event.target.closest('.group-result__group');
    if (!target || dragMemberId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const idx = Number(target.dataset.index);
    overlay.querySelectorAll('.group-result__group.is-drop-target').forEach(el => {
      if (Number(el.dataset.index) !== idx) el.classList.remove('is-drop-target');
    });
    if (idx !== dragSourceIdx) target.classList.add('is-drop-target');
  });

  overlay.addEventListener('dragleave', (event) => {
    const target = event.target.closest('.group-result__group');
    if (!target) return;
    if (!target.contains(event.relatedTarget)) target.classList.remove('is-drop-target');
  });

  overlay.addEventListener('drop', (event) => {
    const target = event.target.closest('.group-result__group');
    if (!target || dragMemberId === null) return;
    event.preventDefault();
    const targetIdx = Number(target.dataset.index);
    target.classList.remove('is-drop-target');
    if (targetIdx === dragSourceIdx) return;
    moveGroupMember(dragSourceIdx, targetIdx, dragMemberId);
    refreshGroupResultGroup(overlay, dragSourceIdx);
    refreshGroupResultGroup(overlay, targetIdx);
  });
}

function moveGroupMember(sourceIdx, targetIdx, memberId) {
  if (!Array.isArray(state.currentGroupResult)) return;
  const source = state.currentGroupResult[sourceIdx];
  const target = state.currentGroupResult[targetIdx];
  if (!source || !target) return;
  const memberIdx = source.findIndex(m => m.id === memberId);
  if (memberIdx < 0) return;
  const [moved] = source.splice(memberIdx, 1);
  target.push(moved);
}

function closeGroupResult(onDone) {
  const el = document.getElementById('groupResultOverlay');
  if (!el) { if (typeof onDone === 'function') onDone(); return; }
  state.modalOpen = false;
  if (typeof el._cleanup === 'function') el._cleanup();
  updateLock();
  el.classList.add('out');
  /* 先重建 stage 为空槽预览，再让 overlay 淡出 —— 否则 overlay 淡出的
     240ms 里下方还留着上一轮的 chip，等 overlay 完全消失才 rebuild 会
     看到"名字瞬间切成 N 名候选"的硬切。 */
  renderGroupStage();
  setTimeout(() => {
    el.remove();
    if (typeof onDone === 'function') onDone();
  }, 240);
}
