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
    let spinning = false;
    let modalOpen = false;
    let rotation = 0;         // current canvas rotation (radians)
    let rafId = null;
    let redrawRafId = null;
    let saveTimerId = null;

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

      /* Persist remove-toggle changes */
      const toggle = document.getElementById('removeToggle');
      if (toggle) toggle.addEventListener('change', saveState);

      /* Keyboard shortcut: Space / Enter triggers spin (when not typing) */
      document.addEventListener('keydown', (e) => {
        if (modalOpen || spinning) return;
        if (e.code !== 'Space' && e.code !== 'Enter') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        e.preventDefault();
        handleSpin();
      });

      window.addEventListener('resize', () => { resizeCanvas(); redraw(); });
      document.fonts.ready.then(() => redraw());
    });

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
      const total = entries.reduce((s, e) => s + (e.weight || 1), 0);
      let angle = rot - Math.PI / 2;   // 0° at 12-o-clock

      entries.forEach((entry, i) => {
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
      syncUI();
      saveState();
    }

    function deleteEntry(id) {
      entries = entries.filter(e => e.id !== id);
      ensureDistinctAdjacentColors();
      renderList();
      redraw();
      syncUI();
      saveState();
    }

    function clearAll() {
      if (entries.length === 0) return;
      entries = [];
      nextId = 1;
      renderList();
      redraw();
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
      <span class="entry-dot" style="background:${entry.color}" onclick="cycleColor(${entry.id})" role="button" tabindex="0" title="切换颜色" aria-label="切换颜色" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();cycleColor(${entry.id})}"></span>
      <input class="entry-input"
             type="text"
             value="${esc(entry.title)}"
             placeholder="名称"
             maxlength="30"
             aria-label="参与者名称"
             oninput="updateTitle(${entry.id}, this.value)" />
      <div class="weight-sep" aria-hidden="true"></div>
      <span class="weight-label" id="wl-${entry.id}" aria-label="权重"></span>
      <input class="weight-input"
             type="number"
             inputmode="decimal"
             value="${entry.weight}"
             min="0.1" max="99999" step="0.1"
             aria-label="${esc(entry.title)} 的权重"
             oninput="updateWeight(${entry.id}, this.value)"
             onblur="commitWeight(${entry.id}, this)" />
      <button class="del-btn" onclick="deleteEntry(${entry.id})" title="移除" aria-label="移除 ${esc(entry.title)}">✕</button>
    `;
        list.appendChild(row);
      });
    }

    /* ================================================================
       Sync UI state (button, notice, stats)
    ================================================================ */
    function syncUI() {
      syncStats();
      const btn = document.getElementById('spinBtn');
      const notice = document.getElementById('notice');
      const enough = entries.length >= 2;
      btn.disabled = spinning;
      btn.querySelector('.spin-btn__text').textContent = spinning ? '等待命运…' : '见证奇迹';
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
      const total = entries.reduce((s, e) => s + (e.weight || 1), 0);
      document.getElementById('statCount').textContent = entries.length;
      document.getElementById('statWeight').textContent = Number.isInteger(total) ? total : total.toFixed(1);
    }

    /* ================================================================
       Spin
    ================================================================ */
    function handleSpin() {
      if (entries.length < 2) {
        showToast('⚠️ 至少需要 2 位参与者才能开始抽奖');
        return;
      }
      if (spinning) return;

      spinning = true;
      const wheel = document.querySelector('.wheel-wrap');
      if (wheel) {
        const wheelRect = wheel.getBoundingClientRect();
        const shiftX = window.innerWidth / 2
          - (wheelRect.left + wheelRect.width / 2);
        const shiftY = window.innerHeight / 2
          - (wheelRect.top + wheelRect.height / 2);
        wheel.style.setProperty('--spin-shift-x', `${shiftX.toFixed(1)}px`);
        wheel.style.setProperty('--spin-shift-y', `${shiftY.toFixed(1)}px`);
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
      const to = from + fullSpins;
      const duration = reduceMotion
        ? 700
        : 4500 + Math.random() * 1200;
      setTimeout(() => {
        const t0 = performance.now();

        function tick(now) {
          const t = Math.min((now - t0) / duration, 1);
          const r = from + fullSpins * easeSpin(t);
          drawWheel(r);

          if (t < 1) {
            rafId = requestAnimationFrame(tick);
          } else {
            rotation = to;
            drawWheel(rotation);

            spinning = false;
            document.body.classList.remove('spinning');
            syncUI();

            /* Determine winner from final pointer position */
            const { winner, winIdx } = getWinnerAtPointer(rotation);
            showResult(winner, winIdx);
          }
        }

        rafId = requestAnimationFrame(tick);
      }, 0);
    }

    /* Determine which segment the pointer (12-o-clock) lands on */
    function getWinnerAtPointer(rot) {
      const total = entries.reduce((s, e) => s + (e.weight || 1), 0);
      /* Pointer is at 12-o-clock; wheel is rotated by rot from its initial position.
         In drawWheel, angle starts at rot - PI/2, so the pointer points at
         the angle = -rot (mod 2PI) within the unrotated segment layout. */
      let pointerAngle = ((-rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      let cum = 0;
      for (let i = 0; i < entries.length; i++) {
        cum += (entries[i].weight || 1) / total * Math.PI * 2;
        if (pointerAngle < cum) return { winner: entries[i], winIdx: i };
      }
      return { winner: entries[entries.length - 1], winIdx: entries.length - 1 };
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
    function showResult(winner, winIdx) {
      closeModal();

      const removeMode = document.getElementById('removeToggle').checked;
      const color = winner.color;
      const pct = ((winner.weight / entries.reduce((s, e) => s + (e.weight || 1), 0)) * 100).toFixed(1);
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
        <button class="btn btn--primary" onclick="spinAgain()">
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
        <button class="btn btn--ghost"   onclick="closeModal()">关闭</button>
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

      overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

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
      closeModal(() => {
        if (entries.length >= 2) handleSpin();
        else showToast('⚠️ 参与者不足，无法继续抽奖');
      });
    }

    /* ================================================================
       Toast
    ================================================================ */
    function showToast(msg) {
      const root = document.getElementById('toastRoot');
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = msg;
      root.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 300);
      }, 2800);
    }

    /* ================================================================
       Utility
    ================================================================ */
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
