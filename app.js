    /* ================================================================
       Constants & Palette
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

    /* Result-page speed-line controls. These values stay mutable so they can
       also be tuned live from DevTools through window.RESULT_FX_CONFIG. */
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

      /* The wheel is circular, so the final and first segments also touch. */
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
       State
    ================================================================ */
    let entries = [];        // { id, title, weight, color }
    let nextId = 1;
    let currentMode = 'lottery'; // 'lottery' | 'grouping'
    let groupCount = 2;
    let distMode = 'even';   // 'even' | 'fill'
    let spinning = false;
    let modalOpen = false;
    let rotation = 0;         // current canvas rotation (radians)
    let rafId = null;
    let redrawRafId = null;
    let saveTimerId = null;

    /* Cancel-spin bookkeeping. preSpinRotation captures the resting angle
       right before a spin starts, so Escape can snap the wheel back cleanly.
       restoreWinnerOnCancel is the modal winner to reopen when the current
       spin was triggered from the result modal's "再来一次" button. */
    let preSpinRotation = 0;
    let restoreWinnerOnCancel = null;
    let currentModalWinner = null;

    /* Cached CSS variables — avoid getComputedStyle in render hot path */
    const CSS_VARS = {};
    function readCssVars() {
      const s = getComputedStyle(document.documentElement);
      ['--black', '--white', '--green', '--gray', '--deep-gray'].forEach(k => {
        CSS_VARS[k] = s.getPropertyValue(k).trim();
      });
    }

    /* Reduced motion preference */
    const prefersReducedMotion = () =>
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    function totalWeight() {
      return entries.reduce((sum, e) => sum + (e.weight || 1), 0);
    }

    /* Copy variants shown in the hero title area for each mode. Keeping them
       in one place makes future mode additions or text tweaks straightforward. */
    const HERO_COPY = {
      lottery: {
        eyebrow: 'Who Wins',
        title: '谁是<br>幸运儿',
        backdrop: ['WHO', 'WINS?'],
      },
      grouping: {
        eyebrow: 'Random Groups',
        title: '谁和<br>谁一组',
        backdrop: ['RANDOM', 'GROUPS'],
      },
    };

    function setMode(mode) {
      if (mode !== 'lottery' && mode !== 'grouping') return;
      currentMode = mode;
      document.body.classList.toggle('mode-lottery', mode === 'lottery');
      document.body.classList.toggle('mode-grouping', mode === 'grouping');
      document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
      });
      const copy = HERO_COPY[mode];
      const eyebrow = document.querySelector('.hero-title__eyebrow');
      const heading = document.getElementById('heroTitle');
      if (eyebrow) eyebrow.textContent = copy.eyebrow;
      if (heading) heading.innerHTML = copy.title;
      document.querySelectorAll('.hero-copy span').forEach((span, i) => {
        span.textContent = copy.backdrop[i] || '';
      });
      if (mode === 'lottery') {
        resizeCanvas();
        redraw();
      } else {
        syncGroupStage();
      }
      saveState();
    }

    /* ================================================================
       Grouping preview
    ================================================================ */
    const GROUP_MAX = 20;

    /* Layout table tuned to keep small counts feeling intentional; falls back
       to a near-square grid for larger counts. */
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

    function renderGroupStage() {
      const stage = document.getElementById('groupStage');
      if (!stage) return;
      const n = Math.max(2, Math.min(groupCount, GROUP_MAX));
      const [cols, rows] = groupGridLayout(n);
      stage.style.setProperty('--group-cols', cols);
      stage.style.setProperty('--group-rows', rows);
      stage.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const slot = document.createElement('div');
        slot.className = 'group-slot';
        slot.dataset.index = i;
        slot.innerHTML = `
          <div class="group-slot__header">Group ${String(i + 1).padStart(2, '0')}</div>
          <div class="group-slot__count">待分配</div>
        `;
        stage.appendChild(slot);
      }
    }

    /* Reconcile group-count input constraints when the entry list changes
       and re-render the preview. Safe to call in any mode. */
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
      /* Grouping animation & result modal land in S3. */
    }

    function setDistMode(mode) {
      if (mode !== 'even' && mode !== 'fill') return;
      distMode = mode;
      document.querySelectorAll('.group-dist__btn').forEach(btn => {
        const active = btn.dataset.dist === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
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
      } catch (_) { /* quota / privacy mode — ignore */ }
    }

    /* Coalesce rapid input events so typing does not redraw the wheel or write
       localStorage more than once per frame / short idle window. */
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
       Boot
    ================================================================ */
    document.addEventListener('DOMContentLoaded', () => {
      readCssVars();
      resizeCanvas();

      const entriesList = document.getElementById('entriesList');
      if (entriesList) bindEntriesListDelegation(entriesList);

      document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', () => setMode(tab.dataset.mode));
      });

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

      /* Persist remove-toggle changes */
      const toggle = document.getElementById('removeToggle');
      if (toggle) toggle.addEventListener('change', saveState);

      /* Global keyboard shortcuts:
         - Escape cancels an active spin and restores the pre-spin state
         - Space / Enter triggers a spin (when not typing / not busy) */
      document.addEventListener('keydown', (e) => {
        if (spinning && e.key === 'Escape') {
          e.preventDefault();
          cancelSpin();
          return;
        }
        if (modalOpen || spinning) return;
        if (currentMode !== 'lottery') return;
        if (e.code !== 'Space' && e.code !== 'Enter') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        e.preventDefault();
        handleSpin();
      });

      window.addEventListener('resize', () => { resizeCanvas(); redraw(); });
      document.fonts.ready.then(() => redraw());

      startSpinBtnAttentionLoop();
    });

    /* Replay the CTA arrow slide every 5s so idle users notice the button.
       Only the outward motion is visible: after the slide, we suppress the
       return transition by forcing a synchronous style commit with
       .attention-reset before restoring the normal transition rules. */
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
          /* Force sync layout so the transition:none + reset transforms are
             committed in this task; removing .attention-reset next won't
             retrigger a transition because the values are already at rest. */
          void btn.offsetWidth;
          btn.classList.remove('attention-reset');
        }, 320);
      }, 5000);
    }

    /* ================================================================
       Canvas helpers
    ================================================================ */
    function getCanvas() { return document.getElementById('wheelCanvas'); }
    function getCtx() { return getCanvas().getContext('2d'); }

    function resizeCanvas() {
      const canvas = getCanvas();
      /* 2× is visually crisp while avoiding excessive canvas memory and paint
         cost on 3×/4× mobile displays. */
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
       Draw wheel
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

      /* ── empty state ─────────────────────────── */
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

      /* ── one-entry full circle ───────────────── */
      if (entries.length === 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = entries[0].color;
        ctx.fill();
        drawOuterRing(ctx, cx, cy, R, W);
        /* hide name when only 1 participant */
        drawHub(ctx, cx, cy, R);
        return;
      }

      /* ── segments ────────────────────────────── */
      const total = totalWeight();
      let angle = rot - Math.PI / 2;   // 0° at 12-o-clock

      entries.forEach((entry) => {
        const slice = (entry.weight / total) * Math.PI * 2;
        const end = angle + slice;
        const color = entry.color;

        /* fill */
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, angle, end);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        /* label */
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
      /* Compact pointer: about 60% of the previous scale. The triangle edges
         terminate at the exact tangent points of the circular hub. */
      const hubR = Math.max(11, Math.min(20, R * 0.072));
      const needleLen = (R - hubR) * 0.18;
      const tipDistance = hubR + needleLen;
      const needleTip = cy - tipDistance;
      const tangentY = cy - (hubR * hubR) / tipDistance;
      const tangentX = hubR * Math.sqrt(tipDistance * tipDistance - hubR * hubR) / tipDistance;

      /* ── needle ────────────────────────────── */
      ctx.beginPath();
      ctx.moveTo(cx - tangentX, tangentY);
      ctx.lineTo(cx, needleTip);
      ctx.lineTo(cx + tangentX, tangentY);
      ctx.closePath();
      ctx.fillStyle = CSS_VARS['--white'];
      ctx.fill();

      /* ── simple solid hub ──────────────────── */
      ctx.beginPath();
      ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
      ctx.fillStyle = CSS_VARS['--white'];
      ctx.fill();
    }

    /* ================================================================
       Segment label — max 2 lines
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

    // Try to fit in 1 line, then 2 lines. Returns array or null.
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
       Entry management
    ================================================================ */
    function addEntry(defaultTitle) {
      if (entries.length >= MAX_ENTRIES) {
        showToast(`最多支持 ${MAX_ENTRIES} 位参与者`);
        return;
      }
      const id = nextId++;
      const title = defaultTitle || `Player ${id}`;
      const lastColor = entries.length > 0 ? entries[entries.length - 1].color : null;
      const firstColor = entries.length > 0 ? entries[0].color : null;
      const color = getNextDistinctColor(lastColor, [lastColor, firstColor]);
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
      let previousColor = null;

      ACDC_ROSTER.forEach(title => {
        const color = getNextDistinctColor(previousColor, [previousColor]);
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
      /* Update only the affected dot to preserve focus & avoid DOM churn */
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

    /* Live update during typing — accept any valid positive number, but don't
       force-clamp (that would break the user's input flow). Final clamp happens
       on blur via commitWeight. */
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
       Render list DOM
    ================================================================ */
    function renderList() {
      const list = document.getElementById('entriesList');
      list.innerHTML = '';

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
        list.appendChild(row);
      });
    }

    /* Delegated handlers for the entries list. Attached once at boot so
       dynamically rendered rows do not need per-row event wiring. */
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
       Sync UI state (button, notice, stats)
    ================================================================ */
    function syncUI() {
      syncStats();
      const spinBtn = document.getElementById('spinBtn');
      const notice = document.getElementById('notice');
      const enough = entries.length >= 2;
      if (spinBtn) {
        spinBtn.disabled = spinning;
        spinBtn.querySelector('.spin-btn__text').textContent = spinning ? '等待命运…' : '见证奇迹';
      }
      document.getElementById('removeToggle').disabled = spinning;
      notice.classList.toggle('hidden', enough);
      updateLock();
    }

    function updateLock() {
      const locked = spinning || modalOpen;
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
       Spin
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

        /* Fill the viewport with a safe margin on all sides. */
        const viewportShort = Math.min(window.innerWidth, window.innerHeight);
        const safeMargin = Math.max(24, viewportShort * 0.04);
        const availableSize = viewportShort - safeMargin * 2;
        const scale = Math.max(1, availableSize / wheelRect.width);
        wheel.style.setProperty('--spin-scale', scale.toFixed(3));
      }
      document.body.classList.add('spinning');
      syncUI();

      /* Honor reduced-motion: shorter, gentler spin while still resolving
         to a random outcome */
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
        /* Update global rotation each frame so external readers (resize,
           cancelSpin) always see the current visual angle. */
        rotation = from + fullSpins * easeSpin(t);
        drawWheel(rotation);

        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          spinning = false;
          document.body.classList.remove('spinning');
          syncUI();

          /* Determine winner from final pointer position */
          showResult(getWinnerAtPointer(rotation));
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    /* Abort the current spin animation and restore the pre-spin state. The
       wheel eases clockwise back to its resting angle (<= 360°) so the
       transition mirrors the wheel-wrap scale-back timing. `.canceling`
       keeps the draw-stage above the roster during the return so the
       shrinking wheel is never clipped or occluded. */
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

    /* Determine which segment the pointer (12-o-clock) lands on */
    function getWinnerAtPointer(rot) {
      const total = totalWeight();
      /* Pointer is at 12-o-clock; wheel is rotated by rot from its initial position.
         In drawWheel, angle starts at rot - PI/2, so the pointer points at
         the angle = -rot (mod 2PI) within the unrotated segment layout. */
      const pointerAngle = ((-rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      let cum = 0;
      for (let i = 0; i < entries.length; i++) {
        cum += (entries[i].weight || 1) / total * Math.PI * 2;
        if (pointerAngle < cum) return entries[i];
      }
      return entries[entries.length - 1];
    }

    function easeSpin(t) {
      const accelerationRatio = 0.16;
      const decelerationPower = 1.75;
      const decelerationDuration = 1 - accelerationRatio;
      const peakVelocity = 1 / (
        accelerationRatio / 2
        + decelerationDuration / (decelerationPower + 1)
      );

      if (t < accelerationRatio) {
        return peakVelocity * t * t / (2 * accelerationRatio);
      }

      const decelerationProgress = (t - accelerationRatio) / decelerationDuration;
      const accelerationDistance = peakVelocity * accelerationRatio / 2;
      const decelerationDistance = peakVelocity * decelerationDuration
        * (1 - Math.pow(1 - decelerationProgress, decelerationPower + 1))
        / (decelerationPower + 1);

      return accelerationDistance + decelerationDistance;
    }

    /* ================================================================
       Result modal
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

      /* Esc / Tab focus trap — bound to document so it works regardless of
         whether focus is currently inside the overlay */
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

      /* Defer removal until modal is closed */
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
       Toast
    ================================================================ */
    /* Toasts default to the roster panel (for entry-related feedback).
       Pass { global: true } for抽奖 flow feedback that should surface at
       the viewport's center. */
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
       Utility
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
        /* Golden-angle stepping prevents clustering; a small random offset
           keeps the result organic instead of mathematically even. */
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
