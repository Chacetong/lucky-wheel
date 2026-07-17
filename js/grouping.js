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
   分组动画
================================================================ */
function runGroupingAnimation(finalGroups) {
  state.grouping = true;
  state.currentGroupResult = finalGroups;

  const stage = document.getElementById('groupStage');
  if (!stage) return;
  renderGroupStage();

  /* 把 stage 平移到视口中心，与抽奖旋转时转盘的居中处理一致。 */
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

  document.body.classList.add('grouping-active');
  syncUI();

  const reduceMotion = prefersReducedMotion();

  /* reduced-motion 下跳过 chaos 洗牌阶段：直接渲染最终结果，短暂停顿后开启
     结果 modal。避免 CSS cardFlash 与高频 DOM 更新叠加造成闪烁。 */
  if (reduceMotion) {
    renderGroupSlots(finalGroups);
    state.groupAnimTimers.settle = setTimeout(() => {
      if (!state.grouping) return;
      finishGroupingAnimation();
    }, 200);
    return;
  }

  const CHAOS_DURATION = 1600;
  const chaosStart = performance.now();

  function chaosStep(iteration) {
    if (!state.grouping) return;
    const elapsed = performance.now() - chaosStart;
    if (elapsed >= CHAOS_DURATION) {
      renderGroupSlots(finalGroups);
      state.groupAnimTimers.settle = setTimeout(() => {
        if (!state.grouping) return;
        finishGroupingAnimation();
      }, 480);
      return;
    }
    renderGroupSlots(sampleRandomGroups(finalGroups));
    const interval = 120 + iteration * 20;
    state.groupAnimTimers.chaos = setTimeout(() => chaosStep(iteration + 1), Math.min(interval, 260));
  }
  chaosStep(0);
}

/* 中止分组动画，让 stage 滑回原位。流程与 cancelSpin 对齐，也复用
   .canceling 类保证 520ms 回位期间 stage 一直盖在阵容之上。 */
export function cancelGrouping() {
  if (!state.grouping) return;
  if (state.groupAnimTimers.chaos !== null) {
    clearTimeout(state.groupAnimTimers.chaos);
    state.groupAnimTimers.chaos = null;
  }
  if (state.groupAnimTimers.settle !== null) {
    clearTimeout(state.groupAnimTimers.settle);
    state.groupAnimTimers.settle = null;
  }
  state.grouping = false;
  state.currentGroupResult = null;
  document.body.classList.remove('grouping-active');
  document.body.classList.add('canceling');
  syncUI();
  showToast('分组已取消', { global: true });
  setTimeout(() => {
    document.body.classList.remove('canceling');
    renderGroupStage();
  }, 520);
}

/* chaos 阶段用，返回一份和最终分组人数一致但内容随机的洗牌，让每格
   都闪出「看起来对但顺序还没定」的名字。 */
function sampleRandomGroups(finalGroups) {
  const shuffled = shuffledEntries(state.entries);
  let idx = 0;
  return finalGroups.map(group => {
    const picks = [];
    for (let i = 0; i < group.length; i++) {
      picks.push(shuffled[idx % shuffled.length]);
      idx++;
    }
    return picks;
  });
}

/* chaos 阶段每 120-260ms 调用一次；sampleRandomGroups 保证每次调用的
   各组成员数量不变，所以只在第一次（或组数 / 组内人数变化时）重建 DOM，
   之后的 tick 只更新已有芯片的背景色与文本，并通过重置 animation 让
   cardFlash 重放。相较原来的 stage.innerHTML='' 全量重建，chaos 期间
   DOM 操作大幅减少。 */
function renderGroupSlots(groups) {
  const stage = document.getElementById('groupStage');
  if (!stage) return;
  const [cols, rows] = groupGridLayout(groups.length);
  stage.style.setProperty('--group-cols', cols);
  stage.style.setProperty('--group-rows', rows);

  const existingSlots = Array.from(stage.querySelectorAll('.group-slot'));
  const structureMatches = existingSlots.length === groups.length
    && existingSlots.every((slot, i) => {
      const list = slot.querySelector('.group-slot__list');
      return list && list.children.length === groups[i].length;
    });

  if (!structureMatches) {
    stage.innerHTML = '';
    groups.forEach((members, i) => {
      const slot = document.createElement('div');
      slot.className = 'group-slot';
      slot.dataset.index = i;
      slot.style.setProperty('--chip-scale', chipScaleForCount(members.length));
      slot.innerHTML = `
        <div class="group-slot__header">Group ${String(i + 1).padStart(2, '0')}</div>
        <div class="group-slot__list">
          ${members.map(e => `<div class="group-card" style="background:${e.color}">${esc(e.title)}</div>`).join('')}
        </div>
      `;
      stage.appendChild(slot);
    });
    return;
  }

  /* 结构一致：仅更新芯片内容 + 触发 cardFlash 重放。 */
  existingSlots.forEach((slot, i) => {
    const members = groups[i];
    slot.style.setProperty('--chip-scale', chipScaleForCount(members.length));
    const cards = slot.querySelectorAll('.group-card');
    cards.forEach((card, cardIdx) => {
      const entry = members[cardIdx];
      card.style.background = entry.color;
      card.textContent = entry.title;
      /* 用 animation:none + 强制 reflow + 恢复的手法让 keyframes 从头播放。 */
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    });
  });
}

function finishGroupingAnimation() {
  state.grouping = false;
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
  setTimeout(() => {
    el.remove();
    renderGroupStage();
    if (typeof onDone === 'function') onDone();
  }, 240);
}
