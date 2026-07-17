    /* ================================================================
       常量与调色板
    ================================================================ */
    const MAX_ENTRIES = 1000;

    const PALETTE = [
      '#F06A6A', '#6AF078', '#856AF0', '#F0936A',
      '#6AF0A0', '#AD6AF0', '#F0BB6A', '#6AF0C8',
      '#D66AF0', '#F0E36A', '#6AF0F0', '#F06AE3',
      '#D6F06A', '#6AC8F0', '#F06ABB', '#ADF06A',
      '#6AA0F0', '#F06A93', '#85F06A', '#6A78F0',
    ];

    const ACDC_ROSTER = [
      '唐晨', '毛星融', '周迪', '黄伟', '周剑',
      '杨阳', '雷咏梅', '邓小璐', '黄健', '张恒',
    ];

    /* 结果页速度线特效参数。挂到 window.RESULT_FX_CONFIG 上便于 DevTools
       实时调参。 */
    const RESULT_FX_CONFIG = {
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

    function getNextDistinctColor(currentColor, neighborColors = []) {
      const forbidden = new Set(neighborColors.filter(Boolean));
      const currentIndex = PALETTE.indexOf(currentColor);
      const startIndex = currentIndex >= 0 ? currentIndex : -1;

      for (let step = 1; step <= PALETTE.length; step++) {
        const candidate = PALETTE[(startIndex + step) % PALETTE.length];
        if (!forbidden.has(candidate)) return candidate;
      }

      return PALETTE[0];
    }

    function ensureDistinctAdjacentColors() {
      entries.forEach((entry, index) => {
        const previousColor = index > 0 ? entries[index - 1].color : null;
        const colorIsInvalid = !PALETTE.includes(entry.color);
        if (colorIsInvalid || entry.color === previousColor) {
          entry.color = getNextDistinctColor(entry.color, [previousColor]);
        }
      });

      /* 转盘是环形的，首尾扇区也相邻，需要额外去重一次。 */
      if (entries.length > 1) {
        const firstColor = entries[0].color;
        const lastIndex = entries.length - 1;
        const lastEntry = entries[lastIndex];
        if (lastEntry.color === firstColor) {
          lastEntry.color = getNextDistinctColor(lastEntry.color, [
            entries[lastIndex - 1].color,
            firstColor,
          ]);
        }
      }
    }

    /* ================================================================
       状态
    ================================================================ */
    let entries = [];        // { id, title, weight, color }
    let nextId = 1;
    let currentMode = 'lottery'; // 'lottery' | 'grouping'
    let groupCount = 2;
    let distMode = 'even';   // 'even' | 'fill'
    let spinning = false;
    let grouping = false;
    let currentGroupResult = null; // Array of Array<entry>，分组完成后保存最终名单
    let groupAnimTimers = { chaos: null, settle: null };
    let modalOpen = false;
    let rotation = 0;         // 当前 canvas 旋转角度（弧度）
    let rafId = null;
    let redrawRafId = null;
    let saveTimerId = null;

    /* 取消抽奖用的状态：preSpinRotation 记录抽奖开始前的静止角度，ESC 时可
       以顺滑回位；restoreWinnerOnCancel 保存上一轮结果 modal 的胜者，用于
       从「再来一次」触发的抽奖被取消时把结算页复原。 */
    let preSpinRotation = 0;
    let restoreWinnerOnCancel = null;
    let currentModalWinner = null;

    /* 缓存 CSS 变量，避免每帧 getComputedStyle 的性能开销。 */
    const CSS_VARS = {};
    function readCssVars() {
      const s = getComputedStyle(document.documentElement);
      ['--black', '--white', '--green', '--gray', '--deep-gray'].forEach(k => {
        CSS_VARS[k] = s.getPropertyValue(k).trim();
      });
    }

    /* 是否偏好减少动画（prefers-reduced-motion）。 */
    const prefersReducedMotion = () =>
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    function totalWeight() {
      return entries.reduce((sum, e) => sum + (e.weight || 1), 0);
    }

    function setMode(mode) {
      if (mode !== 'lottery' && mode !== 'grouping') return;
      currentMode = mode;
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
       分组预览
    ================================================================ */
    const GROUP_MAX = 20;

    /* 小组数手工调好的行列布局，让 2/3/6 这种常见值感觉自然；其余组数回退
       到近似正方形的 ceil(sqrt) 计算。 */
    const GROUP_GRID_LAYOUTS = {
      1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2],
      5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2],
      9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3],
    };

    function groupGridLayout(n) {
      if (GROUP_GRID_LAYOUTS[n]) return GROUP_GRID_LAYOUTS[n];
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      return [cols, rows];
    }

    function groupCapForEntries() {
      return Math.max(2, Math.min(entries.length || 2, GROUP_MAX));
    }

    /* 芯片视觉缩放系数 —— 组内人数少时芯片放大填满卡片，人数多时紧凑排布。
       通过设在组容器上的 --chip-scale CSS 变量下发，预览槽、动画卡片、结果
       页芯片共用同一套规则。 */
    function chipScaleForCount(count) {
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

    function renderGroupStage() {
      const stage = document.getElementById('groupStage');
      if (!stage) return;
      const n = Math.max(2, Math.min(groupCount, GROUP_MAX));
      const [cols, rows] = groupGridLayout(n);
      stage.style.setProperty('--group-cols', cols);
      stage.style.setProperty('--group-rows', rows);
      const sizes = groupSizes(entries.length, n, distMode);
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
    function syncGroupStage() {
      const input = document.getElementById('groupCount');
      const cap = groupCapForEntries();
      if (groupCount > cap) groupCount = cap;
      if (groupCount < 2) groupCount = 2;
      if (input) {
        input.max = String(cap);
        input.value = String(groupCount);
      }
      renderGroupStage();
    }

    function updateGroupCount(raw) {
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return;
      const cap = groupCapForEntries();
      groupCount = Math.max(2, Math.min(parsed, cap));
      renderGroupStage();
      saveState();
    }

    function commitGroupCount(input) {
      const cap = groupCapForEntries();
      const raw = input.value.trim();
      const parsed = parseInt(raw, 10);
      let toast = null;

      if (raw !== '' && Number.isFinite(parsed)) {
        if (parsed < 2) {
          toast = '组数不能少于 2';
        } else if (parsed > cap) {
          toast = entries.length < GROUP_MAX
            ? `组数不能超过选手数（${entries.length}）`
            : `最多支持 ${GROUP_MAX} 组`;
        }
      } else if (raw === '') {
        toast = '请填写组数';
      } else {
        toast = '组数需为整数';
      }

      groupCount = Number.isFinite(parsed)
        ? Math.max(2, Math.min(parsed, cap))
        : 2;
      input.value = String(groupCount);
      renderGroupStage();
      saveState();
      if (toast) showToast(toast, { global: true });
    }

    function handleGroup() {
      if (entries.length < 2) {
        showToast('⚠️ 至少需要 2 位参与者才能分组', { global: true });
        return;
      }
      if (grouping) return;
      const k = Math.max(2, Math.min(groupCount, entries.length));
      const assignment = assignEntriesToGroups(entries, k, distMode);
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

    function setDistMode(mode) {
      if (mode !== 'even' && mode !== 'fill') return;
      distMode = mode;
      document.querySelectorAll('.group-dist__btn').forEach(btn => {
        const active = btn.dataset.dist === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      renderGroupStage();
      saveState();
    }

    /* ================================================================
       Persistence (localStorage)
    ================================================================ */
    const STORAGE_KEY = 'lucky-wheel-state-v1';

    function saveState() {
      try {
        const toggle = document.getElementById('removeToggle');
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          entries,
          nextId,
          removeMode: toggle ? toggle.checked : false,
          mode: currentMode,
          groupCount,
          distMode,
        }));
      } catch (_) { /* 配额 / 隐私模式下失败，直接忽略 */ }
    }

    /* 用 rAF 合并高频输入事件，避免打字时每次按键都触发重绘或写盘。 */
    function scheduleRedraw() {
      if (redrawRafId !== null) return;
      redrawRafId = requestAnimationFrame(() => {
        redrawRafId = null;
        redraw();
      });
    }

    function scheduleSave() {
      clearTimeout(saveTimerId);
      saveTimerId = setTimeout(() => {
        saveTimerId = null;
        saveState();
      }, 180);
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!Array.isArray(data.entries) || data.entries.length === 0) return false;
        entries = data.entries.map(e => ({
          id: Number(e.id),
          title: String(e.title ?? ''),
          weight: Number(e.weight) || 1,
          color: typeof e.color === 'string' ? e.color : PALETTE[0],
        }));
        ensureDistinctAdjacentColors();
        nextId = Number(data.nextId) ||
          (entries.reduce((m, e) => Math.max(m, e.id), 0) + 1);
        const toggle = document.getElementById('removeToggle');
        if (toggle && data.removeMode) toggle.checked = true;
        if (data.mode === 'grouping' || data.mode === 'lottery') currentMode = data.mode;
        if (Number.isFinite(data.groupCount) && data.groupCount >= 2) {
          groupCount = Math.floor(data.groupCount);
        }
        if (data.distMode === 'even' || data.distMode === 'fill') distMode = data.distMode;
        return true;
      } catch (_) {
        return false;
      }
    }

    /* ================================================================
       启动引导
    ================================================================ */
    document.addEventListener('DOMContentLoaded', () => {
      readCssVars();
      resizeCanvas();

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

      const restored = loadState();
      if (restored) {
        renderList();
        redraw();
        syncUI();
      } else {
        addEntry('Player 1');
        addEntry('Player 2');
        addEntry('Player 3');
      }

      setDistMode(distMode);
      syncGroupStage();
      setMode(currentMode);

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
        if (spinning && e.key === 'Escape') {
          e.preventDefault();
          cancelSpin();
          return;
        }
        if (grouping && e.key === 'Escape') {
          e.preventDefault();
          cancelGrouping();
          return;
        }
        if (modalOpen || spinning || grouping) return;
        if (e.code !== 'Space' && e.code !== 'Enter') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        e.preventDefault();
        if (currentMode === 'lottery') handleSpin();
        else if (currentMode === 'grouping') handleGroup();
      });

      window.addEventListener('resize', () => { resizeCanvas(); redraw(); });
      document.fonts.ready.then(() => redraw());

      startSpinBtnAttentionLoop();
    });

    /* 每 5s 重放一次「见证奇迹」按钮的箭头滑动，让闲置用户注意到按钮。
       只播放向右滑出，不让回位动画可见：滑出后加 .attention-reset 用
       transition: none 同步提交重置状态，再恢复正常 transition 规则。 */
    function startSpinBtnAttentionLoop() {
      const btn = document.getElementById('spinBtn');
      if (!btn) return;
      setInterval(() => {
        if (currentMode !== 'lottery') return;
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
       Canvas 工具
    ================================================================ */
    function getCanvas() { return document.getElementById('wheelCanvas'); }
    function getCtx() { return getCanvas().getContext('2d'); }

    function resizeCanvas() {
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

    /* ================================================================
       绘制转盘
    ================================================================ */
    function redraw(rot) {
      if (rot !== undefined) rotation = rot;
      drawWheel(rotation);
    }

    function drawWheel(rot) {
      const canvas = getCanvas();
      const ctx = getCtx();
      const W = parseFloat(canvas.style.width) || canvas.width;
      const H = parseFloat(canvas.style.height) || canvas.height;
      const cx = W / 2, cy = H / 2;
      const R = W / 2 - Math.max(7, W * 0.018);

      ctx.clearRect(0, 0, W, H);

      /* ── 空状态 ─────────────────────────── */
      if (entries.length === 0) {
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
      if (entries.length === 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = entries[0].color;
        ctx.fill();
        drawOuterRing(ctx, cx, cy, R, W);
        /* 只有 1 人时不画名字 */
        drawHub(ctx, cx, cy, R);
        return;
      }

      /* ── 扇区 ────────────────────────────── */
      const total = totalWeight();
      let angle = rot - Math.PI / 2;   // 0° 定在 12 点方向

      entries.forEach((entry) => {
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
       选手条目管理
    ================================================================ */
    function addEntry(defaultTitle) {
      if (entries.length >= MAX_ENTRIES) {
        showToast(`最多支持 ${MAX_ENTRIES} 位参与者`);
        return;
      }
      const id = nextId++;
      const title = defaultTitle || `Player ${id}`;
      let color;
      if (entries.length === 0) {
        /* 首位选手随机取 PALETTE 一个色，避免每次新建阵容都以同一色开头。
           后续新增沿用 getNextDistinctColor 从这个随机种子往下推。 */
        color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      } else {
        const lastColor = entries[entries.length - 1].color;
        const firstColor = entries[0].color;
        color = getNextDistinctColor(lastColor, [lastColor, firstColor]);
      }
      entries.push({ id, title, weight: 1, color });
      renderList();
      redraw();
      syncGroupStage();
      syncUI();
      saveState();
    }

    function deleteEntry(id) {
      entries = entries.filter(e => e.id !== id);
      ensureDistinctAdjacentColors();
      renderList();
      redraw();
      syncGroupStage();
      syncUI();
      saveState();
    }

    function clearAll() {
      if (entries.length === 0) return;
      entries = [];
      nextId = 1;
      renderList();
      redraw();
      syncGroupStage();
      syncUI();
      saveState();
    }

    function loadPresetRoster() {
      entries = [];
      nextId = 1;
      /* 用一个随机 palette 色作为种子，每次载入 ACDC 都会得到不同的配色序列。 */
      let previousColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];

      ACDC_ROSTER.forEach((title, idx) => {
        const color = idx === 0
          ? previousColor
          : getNextDistinctColor(previousColor, [previousColor]);
        entries.push({ id: nextId++, title, weight: 1, color });
        previousColor = color;
      });

      renderList();
      redraw();
      syncGroupStage();
      syncUI();
      saveState();
      showToast('已载入 ACDC 阵容');
    }

    function cycleColor(id) {
      const entryIndex = entries.findIndex(entry => entry.id === id);
      if (entryIndex < 0) return;
      const e = entries[entryIndex];
      const previousColor = entries.length > 1
        ? entries[(entryIndex - 1 + entries.length) % entries.length].color
        : null;
      const nextColor = entries.length > 1
        ? entries[(entryIndex + 1) % entries.length].color
        : null;
      e.color = getNextDistinctColor(e.color, [previousColor, nextColor]);
      /* 只更新当前色块，保持输入焦点，避免整行 DOM 重建。 */
      const dot = document.querySelector(`.entry-row[data-id="${id}"] .entry-dot`);
      if (dot) dot.style.background = e.color;
      redraw();
      saveState();
    }

    function updateTitle(id, val) {
      const e = entries.find(e => e.id === id);
      if (!e) return;
      e.title = val;
      scheduleRedraw();
      scheduleSave();
    }

    /* 打字过程中实时更新 —— 接受任意有效的正数，但不强制夹范围（会干扰
       输入流程）。最终的夹取在 blur 时由 commitWeight 完成。 */
    function updateWeight(id, val) {
      const e = entries.find(e => e.id === id);
      if (!e) return;
      const w = parseFloat(val);
      if (!Number.isFinite(w) || w < 0.1) return;
      e.weight = Math.min(Math.round(w * 10) / 10, 99999);
      scheduleRedraw();
      syncStats();
      scheduleSave();
    }

    function commitWeight(id, input) {
      const e = entries.find(e => e.id === id);
      if (!e) return;
      const w = parseFloat(input.value);
      e.weight = (!Number.isFinite(w) || w < 0.1)
        ? 0.1
        : Math.min(Math.round(w * 10) / 10, 99999);
      input.value = e.weight;
      redraw();
      syncStats();
      saveState();
    }

    /* ================================================================
       渲染选手列表 DOM
    ================================================================ */
    function renderList() {
      const list = document.getElementById('entriesList');
      const notice = document.getElementById('notice');
      /* 只清理 .entry-row，保留 notice 兄弟节点，让「至少 2 位」提示直接
         挂在最后一条选手之下；1 位 ↔ 2 位切换时也不再触发上方条目跳位。 */
      list.querySelectorAll('.entry-row').forEach(row => row.remove());

      entries.forEach((entry, index) => {
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

    /* ================================================================
       同步 UI 状态（按钮、提示、统计）
    ================================================================ */
    function syncUI() {
      syncStats();
      const spinBtn = document.getElementById('spinBtn');
      const groupBtn = document.getElementById('groupBtn');
      const notice = document.getElementById('notice');
      const enough = entries.length >= 2;
      if (spinBtn) {
        spinBtn.disabled = spinning;
        spinBtn.querySelector('.spin-btn__text').textContent = spinning ? '等待命运…' : '见证奇迹';
      }
      if (groupBtn) {
        groupBtn.disabled = grouping;
        groupBtn.querySelector('.spin-btn__text').textContent = grouping ? '等待结果…' : '开始分组';
      }
      document.getElementById('removeToggle').disabled = spinning;
      notice.classList.toggle('hidden', enough);
      updateLock();
    }

    function updateLock() {
      const locked = spinning || grouping || modalOpen;
      const panel = document.querySelector('.roster');
      if (!panel) return;
      panel.inert = locked;
      panel.setAttribute('aria-busy', String(locked));
    }

    function syncStats() {
      const total = totalWeight();
      document.getElementById('statCount').textContent = entries.length;
      document.getElementById('statWeight').textContent = Number.isInteger(total) ? total : total.toFixed(1);
    }

    /* ================================================================
       分组动画
    ================================================================ */
    function runGroupingAnimation(finalGroups) {
      grouping = true;
      currentGroupResult = finalGroups;

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
      const CHAOS_DURATION = reduceMotion ? 400 : 1600;
      const chaosStart = performance.now();

      function chaosStep(iteration) {
        if (!grouping) return;
        const elapsed = performance.now() - chaosStart;
        if (elapsed >= CHAOS_DURATION) {
          renderGroupSlots(finalGroups);
          groupAnimTimers.settle = setTimeout(() => {
            if (!grouping) return;
            finishGroupingAnimation();
          }, reduceMotion ? 200 : 480);
          return;
        }
        renderGroupSlots(sampleRandomGroups(finalGroups));
        const interval = 120 + iteration * 20;
        groupAnimTimers.chaos = setTimeout(() => chaosStep(iteration + 1), Math.min(interval, 260));
      }
      chaosStep(0);
    }

    /* 中止分组动画，让 stage 滑回原位。流程与 cancelSpin 对齐，也复用
       .canceling 类保证 520ms 回位期间 stage 一直盖在阵容之上。 */
    function cancelGrouping() {
      if (!grouping) return;
      if (groupAnimTimers.chaos !== null) {
        clearTimeout(groupAnimTimers.chaos);
        groupAnimTimers.chaos = null;
      }
      if (groupAnimTimers.settle !== null) {
        clearTimeout(groupAnimTimers.settle);
        groupAnimTimers.settle = null;
      }
      grouping = false;
      currentGroupResult = null;
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
      const shuffled = shuffledEntries(entries);
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

    function renderGroupSlots(groups) {
      const stage = document.getElementById('groupStage');
      if (!stage) return;
      const [cols, rows] = groupGridLayout(groups.length);
      stage.style.setProperty('--group-cols', cols);
      stage.style.setProperty('--group-rows', rows);
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
    }

    function finishGroupingAnimation() {
      grouping = false;
      document.body.classList.remove('grouping-active');
      syncUI();
      showGroupResult(currentGroupResult);
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

      modalOpen = true;
      document.body.appendChild(overlay);
      updateLock();
      bindGroupResultDragDrop(overlay);

      const primaryBtn = overlay.querySelector('.btn--primary');
      if (primaryBtn) primaryBtn.focus();

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeGroupResult();
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
      const members = currentGroupResult[groupIdx] || [];
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
      if (!Array.isArray(currentGroupResult)) return;
      const source = currentGroupResult[sourceIdx];
      const target = currentGroupResult[targetIdx];
      if (!source || !target) return;
      const memberIdx = source.findIndex(m => m.id === memberId);
      if (memberIdx < 0) return;
      const [moved] = source.splice(memberIdx, 1);
      target.push(moved);
    }

    function closeGroupResult(onDone) {
      const el = document.getElementById('groupResultOverlay');
      if (!el) { if (typeof onDone === 'function') onDone(); return; }
      modalOpen = false;
      if (typeof el._cleanup === 'function') el._cleanup();
      updateLock();
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        renderGroupStage();
        if (typeof onDone === 'function') onDone();
      }, 240);
    }

    /* ================================================================
       抽奖旋转
    ================================================================ */
    function handleSpin(restoreWinner = null) {
      if (entries.length < 2) {
        showToast('⚠️ 至少需要 2 位参与者才能开始抽奖', { global: true });
        return;
      }
      if (spinning) return;

      spinning = true;
      preSpinRotation = rotation;
      restoreWinnerOnCancel = restoreWinner;
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
      const from = rotation;
      const duration = reduceMotion
        ? 700
        : 4500 + Math.random() * 1200;
      const t0 = performance.now();

      function tick(now) {
        const t = Math.min((now - t0) / duration, 1);
        /* 每帧同步全局 rotation，让 resize / cancelSpin 等外部读者拿到当前
           实际的视觉角度。 */
        rotation = from + fullSpins * easeSpin(t);
        drawWheel(rotation);

        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          spinning = false;
          document.body.classList.remove('spinning');
          syncUI();

          /* 根据指针最终停在的角度反推胜者。 */
          showResult(getWinnerAtPointer(rotation));
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    /* 中止当前抽奖并回到抽奖前状态。转盘沿顺时针方向平滑归位（≤ 360°），
       缓动时长与 wheel-wrap 缩放回位一致；`.canceling` 类保证 520ms 回位期
       间 draw-stage 一直盖在阵容之上，缩小的转盘不会被裁切或遮挡。 */
    function cancelSpin() {
      if (!spinning) return;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      spinning = false;
      document.body.classList.remove('spinning');
      document.body.classList.add('canceling');
      syncUI();
      showToast('抽奖已取消', { global: true });

      const twoPi = Math.PI * 2;
      const startRotation = rotation;
      const delta = ((preSpinRotation - startRotation) % twoPi + twoPi) % twoPi;
      const endRotation = startRotation + delta;

      const CANCEL_DURATION = 520;
      const easeOut = t => 1 - Math.pow(1 - t, 3);
      const t0 = performance.now();

      function tick(now) {
        const t = Math.min((now - t0) / CANCEL_DURATION, 1);
        drawWheel(startRotation + delta * easeOut(t));
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
          return;
        }
        rotation = endRotation;
        drawWheel(rotation);
        rafId = null;
        document.body.classList.remove('canceling');
        const restore = restoreWinnerOnCancel;
        restoreWinnerOnCancel = null;
        if (restore) showResult(restore);
      }

      rafId = requestAnimationFrame(tick);
    }

    /* 判断指针（12 点方向）落在哪个扇区。 */
    function getWinnerAtPointer(rot) {
      const total = totalWeight();
      /* 指针固定在 12 点方向；转盘从初始位置旋转了 rot。drawWheel 里 angle
         起点是 rot - π/2，因此指针在未旋转扇区布局中的对应角度就是
         -rot（对 2π 取正模）。 */
      const pointerAngle = ((-rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      let cum = 0;
      for (let i = 0; i < entries.length; i++) {
        cum += (entries[i].weight || 1) / total * Math.PI * 2;
        if (pointerAngle < cum) return entries[i];
      }
      return entries[entries.length - 1];
    }

    function easeSpin(t) {
      /* Anticipation 前奏 —— 转盘先反向拉回一点再爆发向前，制造出手感张力。 */
      const ANTICIPATION_RATIO = 0.05;
      const ANTICIPATION_DIP = -0.006;

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
      currentModalWinner = winner;

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

      modalOpen = true;
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
      pendingRemoveId = removeMode ? winner.id : null;
    }

    let pendingRemoveId = null;

    function closeModal(onDone) {
      const el = document.getElementById('resultOverlay');
      if (!el) { if (typeof onDone === 'function') onDone(); return; }
      modalOpen = false;
      if (typeof el._cleanup === 'function') el._cleanup();
      if (typeof el._fxCleanup === 'function') el._fxCleanup();
      updateLock();
      el.classList.add('out');
      setTimeout(() => {
        currentModalWinner = null;
        el.remove();
        if (pendingRemoveId !== null) {
          entries = entries.filter(e => e.id !== pendingRemoveId);
          ensureDistinctAdjacentColors();
          pendingRemoveId = null;
          renderList();
          syncUI();
          saveState();
        }
        redraw();
        if (typeof onDone === 'function') onDone();
      }, 240);
    }

    function spinAgain() {
      const restoreWinner = currentModalWinner;
      closeModal(() => {
        if (entries.length >= 2) handleSpin(restoreWinner);
        else showToast('⚠️ 参与者不足，无法继续抽奖', { global: true });
      });
    }

    /* ================================================================
       Tooltip（挂在 body 上，逃出祖先容器的 overflow 裁切）
    ================================================================ */
    function bindTooltipDelegation() {
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

    /* ================================================================
       Toast
    ================================================================ */
    /* Toast 默认挂在阵容面板底部（用于选手操作反馈）。传 { global: true }
       让抽奖/分组流程等全局反馈出现在视口中央下方。 */
    function showToast(msg, { global = false } = {}) {
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

    function esc(str) {
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
