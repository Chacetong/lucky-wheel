import { state, totalWeight } from './state.js';

export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ================================================================
   同步 UI 状态（按钮、提示、统计）
================================================================ */
export function syncUI() {
  syncStats();
  const spinBtn = document.getElementById('spinBtn');
  const groupBtn = document.getElementById('groupBtn');
  const notice = document.getElementById('notice');
  const enough = state.entries.length >= 2;
  if (spinBtn) {
    spinBtn.disabled = state.spinning;
    spinBtn.querySelector('.spin-btn__text').textContent = state.spinning ? '等待命运…' : '见证奇迹';
  }
  if (groupBtn) {
    groupBtn.disabled = state.grouping;
    groupBtn.querySelector('.spin-btn__text').textContent = state.grouping ? '等待结果…' : '开始分组';
  }
  document.getElementById('removeToggle').disabled = state.spinning;
  notice.classList.toggle('hidden', enough);
  updateLock();
}

export function updateLock() {
  const locked = state.spinning || state.grouping || state.modalOpen;
  const panel = document.querySelector('.roster');
  if (!panel) return;
  panel.inert = locked;
  panel.setAttribute('aria-busy', String(locked));
}

export function syncStats() {
  const total = totalWeight();
  document.getElementById('statCount').textContent = state.entries.length;
  document.getElementById('statWeight').textContent = Number.isInteger(total) ? total : total.toFixed(1);
}

/* ================================================================
   渲染选手列表 DOM
================================================================ */
export function renderList() {
  const list = document.getElementById('entriesList');
  const notice = document.getElementById('notice');
  /* 只清理 .entry-row，保留 notice 兄弟节点，让「至少 2 位」提示直接
     挂在最后一条选手之下；1 位 ↔ 2 位切换时也不再触发上方条目跳位。 */
  list.querySelectorAll('.entry-row').forEach(row => row.remove());

  state.entries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'entry-row';
    row.dataset.id = entry.id;

    row.innerHTML = `
      <span class="entry-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <button type="button" class="entry-dot" data-action="cycle-color" style="background:${entry.color}" title="切换颜色" aria-label="切换颜色"></button>
      <input class="entry-input"
             type="text"
             value="${esc(entry.title)}"
             placeholder="名称"
             maxlength="30"
             aria-label="参与者名称" />
      <span class="weight-label" aria-label="权重"></span>
      <input class="weight-input"
             type="number"
             inputmode="decimal"
             value="${entry.weight}"
             min="0.1" max="99999" step="0.1"
             aria-label="${esc(entry.title)} 的权重" />
      <button type="button" class="del-btn" data-action="delete" title="移除" aria-label="移除 ${esc(entry.title)}">✕</button>
    `;
    if (notice) list.insertBefore(row, notice);
    else list.appendChild(row);
  });
}

/* ================================================================
   Toast
================================================================ */
/* Toast 默认挂在阵容面板底部（用于选手操作反馈）。传 { global: true }
   让抽奖/分组流程等全局反馈出现在视口中央下方。 */
export function showToast(msg, { global = false } = {}) {
  const root = document.getElementById(global ? 'globalToastRoot' : 'toastRoot');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  root.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

/* ================================================================
   Tooltip（挂在 body 上，逃出祖先容器的 overflow 裁切）
================================================================ */
export function bindTooltipDelegation() {
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltip);

  function show(target) {
    const text = target.dataset.tooltip;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.setAttribute('aria-hidden', 'false');
    tooltip.classList.add('is-visible');
    /* 先写入文本再测量宽度，最后夹到视口内。 */
    const rect = target.getBoundingClientRect();
    const tRect = tooltip.getBoundingClientRect();
    const gap = 10;
    let left = rect.left + rect.width / 2 - tRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tRect.width - 8));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(rect.top - tRect.height - gap)}px`;
  }

  function hide() {
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('mouseover', (event) => {
    const trigger = event.target.closest('[data-tooltip]');
    if (trigger) show(trigger);
  });
  document.addEventListener('mouseout', (event) => {
    const trigger = event.target.closest('[data-tooltip]');
    if (!trigger) return;
    if (!trigger.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (event) => {
    const trigger = event.target.closest('[data-tooltip]');
    if (trigger) show(trigger);
  });
  document.addEventListener('focusout', (event) => {
    const trigger = event.target.closest('[data-tooltip]');
    if (trigger) hide();
  });
}
