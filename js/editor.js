/* =========================================================
 * editor.js — 單頁編輯器
 * 四角拖曳裁切 / 濾鏡調整 / 修補筆刷 / 效果預覽
 * ========================================================= */
(function (global) {
  'use strict';

  const CV = global.CV;
  const Pipeline = global.Pipeline;
  const Filters = global.Filters;

  const Editor = {};
  let el = {};
  let st = null;
  let inited = false;

  function $(id) { return document.getElementById(id); }

  function cloneSettings(s) { return Object.assign({}, s); }

  function toast(msg) {
    if (global.App && global.App.toast) global.App.toast(msg);
  }

  function tick() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    if (inited) return;
    inited = true;

    el = {
      root: $('editor'),
      stage: $('edStage'),
      canvas: $('edCanvas'),
      overlay: $('edOverlay'),
      mini: $('edMini'),
      loading: $('edLoading'),
      index: $('edIndex'),
      total: $('edTotal'),
      hint: $('stageHint'),
      toggle: $('btnToggleView'),
      close: $('edClose'),
      apply: $('edApply'),
      presetChips: $('presetChips'),
      rngBend: $('rngBend'), valBend: $('valBend'),
      rngFine: $('rngFine'), valFine: $('valFine'),
      rngShadow: $('rngShadow'), valShadow: $('valShadow'),
      rngSharpen: $('rngSharpen'), valSharpen: $('valSharpen'),
      rngContrast: $('rngContrast'), valContrast: $('valContrast'),
      rngBright: $('rngBright'), valBright: $('valBright'),
      rngBrush: $('rngBrush'), valBrush: $('valBrush'),
      chkDenoise: $('chkDenoise'),
      chkMoire: $('chkMoire'),
      chkBrush: $('chkBrush')
    };

    // 濾鏡 chips
    Filters.PRESETS.forEach(function (p) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.preset = p.id;
      b.textContent = p.label;
      b.title = p.desc;
      b.addEventListener('click', function () {
        st.page.settings.preset = p.id;
        syncChips();
        onSettingsChange();
      });
      el.presetChips.appendChild(b);
    });

    // 滑桿
    bindRange(el.rngBend, el.valBend, function (v) {
      st.page.settings.bend = v; geometryChanged();
    }, function (v) { return v; });
    bindRange(el.rngFine, el.valFine, function (v) {
      st.page.settings.fine = v; geometryChanged();
    }, function (v) { return v + '°'; });
    bindRange(el.rngShadow, el.valShadow, function (v) {
      st.page.settings.shadow = v; onSettingsChange();
    });
    bindRange(el.rngSharpen, el.valSharpen, function (v) {
      st.page.settings.sharpen = v; onSettingsChange();
    });
    bindRange(el.rngContrast, el.valContrast, function (v) {
      st.page.settings.contrast = v; onSettingsChange();
    });
    bindRange(el.rngBright, el.valBright, function (v) {
      st.page.settings.brightness = v; onSettingsChange();
    });
    bindRange(el.rngBrush, el.valBrush, function () {});

    el.chkDenoise.addEventListener('change', function () {
      st.page.settings.denoise = el.chkDenoise.checked; onSettingsChange();
    });
    el.chkMoire.addEventListener('change', function () {
      st.page.settings.moire = el.chkMoire.checked; onSettingsChange();
    });
    el.chkBrush.addEventListener('change', function () {
      setBrush(el.chkBrush.checked);
    });

    $('btnAutoDetect').addEventListener('click', autoDetect);
    $('btnFullFrame').addEventListener('click', function () {
      st.page.quad = Pipeline.fullQuad();
      st.quad = st.page.quad.map(function (p) { return { x: p.x, y: p.y }; });
      geometryChanged();
      drawOverlay();
    });
    $('btnResetQuad').addEventListener('click', function () {
      st.page.quad = st.origQuad.map(function (p) { return { x: p.x, y: p.y }; });
      st.quad = st.page.quad.map(function (p) { return { x: p.x, y: p.y }; });
      geometryChanged();
      drawOverlay();
    });
    $('btnRotL').addEventListener('click', function () { rotate(-90); });
    $('btnRotR').addEventListener('click', function () { rotate(90); });
    $('btnUndoStroke').addEventListener('click', function () {
      if (!st.strokes.length) return;
      st.strokes.pop();
      renderResult();
    });
    $('btnClearStroke').addEventListener('click', function () {
      if (!st.strokes.length) return;
      st.strokes = [];
      renderResult();
    });

    el.close.addEventListener('click', function () { close(); });
    el.apply.addEventListener('click', apply);
    el.toggle.addEventListener('click', function () {
      setView(st.view === 'crop' ? 'result' : 'crop');
    });

    el.overlay.addEventListener('pointerdown', onDown);
    el.overlay.addEventListener('pointermove', onMove);
    el.overlay.addEventListener('pointerup', onUp);
    el.overlay.addEventListener('pointercancel', onUp);

    global.addEventListener('resize', function () {
      if (st && !el.root.classList.contains('hidden')) { fit(); drawOverlay(); }
    });
  }

  function bindRange(input, out, onInput, fmt) {
    const upd = function () {
      const v = parseFloat(input.value);
      if (out) out.textContent = fmt ? fmt(v) : v;
      onInput(v);
    };
    input.addEventListener('input', upd);
    return upd;
  }

  /* ---------------- 開啟 ---------------- */

  Editor.open = function (page, index, total, onSave) {
    init();
    const s = cloneSettings(page.settings || Pipeline.defaultSettings());
    const quad = (page.quad || Pipeline.fullQuad()).map(function (p) { return { x: p.x, y: p.y }; });

    st = {
      page: { file: page.file, quad: quad, settings: s, strokes: [] },
      origQuad: quad.map(function (p) { return { x: p.x, y: p.y }; }),
      quad: quad.map(function (p) { return { x: p.x, y: p.y }; }),
      strokes: (page.strokes || []).map(function (k) {
        return { r: k.r, points: k.points.map(function (p) { return { x: p.x, y: p.y }; }) };
      }),
      index: index, total: total,
      onSave: onSave,
      view: 'crop',
      src: null,
      drag: -1,
      brushOn: false,
      drawing: null,
      timer: null,
      disp: { w: 0, h: 0, s: 1 }
    };

    el.index.textContent = index + 1;
    el.total.textContent = total;
    el.root.classList.remove('hidden');
    el.chkBrush.checked = false;
    setBrush(false, true);
    setView('crop', true);
    syncControls();
    showLoading(true);

    Pipeline.decode(page.file, 1600).then(function (canvas) {
      if (!st) return;
      st.src = canvas;
      drawStage();
      renderMini();
      showLoading(false);
    }).catch(function (err) {
      showLoading(false);
      toast(err.message || '讀取圖片失敗');
    });
  };

  function close() {
    el.root.classList.add('hidden');
    st = null;
  }

  /* ---------------- 控制項同步 ---------------- */

  function syncControls() {
    const s = st.page.settings;
    el.rngBend.value = s.bend || 0; el.valBend.textContent = s.bend || 0;
    el.rngFine.value = s.fine || 0; el.valFine.textContent = (s.fine || 0) + '°';
    el.rngShadow.value = s.shadow; el.valShadow.textContent = s.shadow;
    el.rngSharpen.value = s.sharpen; el.valSharpen.textContent = s.sharpen;
    el.rngContrast.value = s.contrast; el.valContrast.textContent = s.contrast;
    el.rngBright.value = s.brightness; el.valBright.textContent = s.brightness;
    el.chkDenoise.checked = !!s.denoise;
    el.chkMoire.checked = !!s.moire;
    $('rotLabel').textContent = (((s.rotate || 0) % 360) + 360) % 360 + '°';
    syncChips();
  }

  function syncChips() {
    const cur = st.page.settings.preset;
    Array.prototype.forEach.call(el.presetChips.children, function (c) {
      c.classList.toggle('on', c.dataset.preset === cur);
    });
  }

  function showLoading(on) {
    el.loading.classList.toggle('hidden', !on);
  }

  /* ---------------- 版面 ---------------- */

  function fit() {
    if (!st || !st.src) return;
    const rect = el.stage.getBoundingClientRect();
    const pad = 26;
    const aw = Math.max(80, rect.width - pad);
    const ah = Math.max(80, rect.height - pad);
    const cw = el.canvas.width, ch = el.canvas.height;
    if (!cw || !ch) return;
    const scale = Math.min(aw / cw, ah / ch);
    const w = Math.max(20, Math.round(cw * scale));
    const h = Math.max(20, Math.round(ch * scale));
    el.canvas.style.width = w + 'px';
    el.canvas.style.height = h + 'px';
    el.overlay.style.width = w + 'px';
    el.overlay.style.height = h + 'px';
    st.disp = { w: w, h: h, s: w / cw };
  }

  function setCanvasSize(w, h) {
    el.canvas.width = w; el.canvas.height = h;
    el.overlay.width = w; el.overlay.height = h;
  }

  function drawStage() {
    if (!st || !st.src) return;
    const src = st.src;
    setCanvasSize(src.width, src.height);
    const ctx = CV.ctx(el.canvas);
    ctx.clearRect(0, 0, src.width, src.height);
    ctx.drawImage(src, 0, 0);
    fit();
    drawOverlay();
  }

  /* ---------------- 覆蓋層 ---------------- */

  function drawOverlay() {
    if (!st || !st.src) return;
    const w = el.overlay.width, h = el.overlay.height;
    const ctx = CV.ctx(el.overlay);
    ctx.clearRect(0, 0, w, h);

    if (st.view === 'result') return;

    const q = st.quad.map(function (p) { return { x: p.x * w, y: p.y * h }; });

    // 遮暗裁切範圍以外
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(q[0].x, q[0].y);
    ctx.lineTo(q[1].x, q[1].y);
    ctx.lineTo(q[2].x, q[2].y);
    ctx.lineTo(q[3].x, q[3].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(4,8,14,0.52)';
    ctx.fill('evenodd');
    ctx.restore();

    // 邊框
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
    ctx.lineWidth = Math.max(1.5, 2 / st.disp.s);
    ctx.strokeStyle = '#3d8bff';
    ctx.stroke();

    // 角點
    const r = Math.max(6, 11 / st.disp.s);
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(q[i].x, q[i].y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(61,139,255,0.22)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(q[i].x, q[i].y, r * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = Math.max(1.2, 2 / st.disp.s);
      ctx.strokeStyle = '#3d8bff';
      ctx.stroke();
    }
  }

  /* ---------------- 指標互動 ---------------- */

  function toNorm(e) {
    const rect = el.overlay.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height
    };
  }

  function onDown(e) {
    if (!st || !st.src) return;

    if (st.view === 'result') {
      if (!st.brushOn) return;
      const p = toNorm(e);
      st.drawing = { r: parseFloat(el.rngBrush.value) / 1000, points: [p] };
      el.overlay.setPointerCapture(e.pointerId);
      paintStroke();
      return;
    }

    const p = toNorm(e);
    const screenR = 26 / el.overlay.getBoundingClientRect().width; // 26px 在正規化空間
    let best = -1, bestD = 1e9;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(st.quad[i].x - p.x, st.quad[i].y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > Math.max(screenR, 0.045)) return;
    st.drag = best;
    el.overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onMove(e) {
    if (!st) return;
    if (st.drawing) {
      const p = toNorm(e);
      const last = st.drawing.points[st.drawing.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 0.004) {
        st.drawing.points.push(p);
        paintStroke();
      }
      return;
    }
    if (st.drag < 0) {
      // 靠近角點時顯示可拖曳游標
      const p = toNorm(e);
      const rect = el.overlay.getBoundingClientRect();
      const tol = 26 / rect.width;
      let near = false;
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(st.quad[i].x - p.x, st.quad[i].y - p.y) < tol) { near = true; break; }
      }
      el.overlay.style.cursor = near ? 'grab' : 'default';
      return;
    }
    const p = toNorm(e);
    st.quad[st.drag] = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
    drawOverlay();
    e.preventDefault();
  }

  function onUp(e) {
    if (!st) return;
    if (st.drawing) {
      if (st.drawing.points.length) {
        st.strokes.push(st.drawing);
      }
      st.drawing = null;
      renderResult();
      return;
    }
    if (st.drag >= 0) {
      st.drag = -1;
      st.page.quad = st.quad.map(function (p) { return { x: p.x, y: p.y }; });
      if (st.strokes.length) {
        st.strokes = [];
        toast('重新裁切後已清除修補痕跡');
      }
      renderMini();
    }
  }

  /* ---------------- 筆刷 ---------------- */

  function setBrush(on, silent) {
    st.brushOn = on;
    el.overlay.style.cursor = on ? 'crosshair' : '';
    if (on && st.view !== 'result') setView('result');
    if (!on && st.view === 'result' && !silent) {
      el.hint.textContent = '點「返回裁切」可調整四角';
      return;
    }
    if (!silent) {
      el.hint.textContent = on ? '在畫面上塗抹要移除的區域' : '';
    }
  }

  function paintStroke() {
    // 立即畫在覆蓋層做視覺回饋
    const ctx = CV.ctx(el.overlay);
    const w = el.overlay.width, h = el.overlay.height;
    ctx.clearRect(0, 0, w, h);
    const s = st.drawing;
    ctx.strokeStyle = 'rgba(255,80,90,0.55)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, s.r * w);
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * w, s.points[0].y * h);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x * w, s.points[i].y * h);
    }
    if (s.points.length === 1) ctx.lineTo(s.points[0].x * w + 0.1, s.points[0].y * h);
    ctx.stroke();
  }

  /* ---------------- 檢視切換 ---------------- */

  function setView(v, silent) {
    if (!st) return;
    st.view = v;

    if (v === 'result') {
      el.toggle.textContent = '返回裁切';
      el.hint.textContent = st.brushOn ? '在畫面上塗抹要移除的區域' : '這是套用濾鏡後的結果';
      el.overlay.style.cursor = st.brushOn ? 'crosshair' : 'default';
      renderResult();
    } else {
      el.toggle.textContent = '預覽效果';
      el.hint.textContent = '拖曳四角調整紙張邊界';
      el.overlay.style.cursor = '';
      if (st.brushOn) {
        st.brushOn = false;
        el.chkBrush.checked = false;
      }
      if (!silent && st.src) { drawStage(); renderMini(); }
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderResult() {
    if (!st || !st.src) return;
    st.page.strokes = st.strokes;
    const out = Pipeline.render(st.src, st.page, Pipeline.PREVIEW_DIM);
    setCanvasSize(out.width, out.height);
    const ctx = CV.ctx(el.canvas);
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.drawImage(out, 0, 0);
    CV.ctx(el.overlay).clearRect(0, 0, el.overlay.width, el.overlay.height);
    fit();
  }

  function renderMini() {
    if (!st || !st.src) return;
    st.page.strokes = st.strokes;
    const out = Pipeline.render(st.src, st.page, 520);
    const mini = el.mini;
    mini.width = out.width;
    mini.height = out.height;
    CV.ctx(mini).drawImage(out, 0, 0);
  }

  function scheduleRender() {
    if (!st) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(function () {
      if (!st) return;
      if (st.view === 'result') renderResult();
      else renderMini();
    }, 110);
  }

  function onSettingsChange() {
    scheduleRender();
  }

  function geometryChanged() {
    if (st.strokes.length) {
      st.strokes = [];
      toast('變更幾何設定後已清除修補痕跡');
    }
    scheduleRender();
  }

  function rotate(delta) {
    const s = st.page.settings;
    s.rotate = (((s.rotate || 0) + delta) % 360 + 360) % 360;
    $('rotLabel').textContent = s.rotate + '°';
    geometryChanged();
  }

  function autoDetect() {
    if (!st || !st.src) return;
    showLoading(true);
    setTimeout(function () {
      const q = Pipeline.detect(st.src);
      if (q) {
        st.quad = q.map(function (p) { return { x: p.x, y: p.y }; });
        st.page.quad = q.map(function (p) { return { x: p.x, y: p.y }; });
        geometryChanged();
        drawOverlay();
        toast('已偵測紙張邊界');
      } else {
        toast('找不到明顯的紙張邊界，請手動拖曳四角');
      }
      showLoading(false);
    }, 30);
  }

  /* ---------------- 套用 ---------------- */

  async function apply() {
    if (!st) return;
    showLoading(true);
    await tick();
    try {
      const full = await Pipeline.decode(st.page.file, Pipeline.MAX_DIM);
      const out = Pipeline.render(full, st.page, Pipeline.MAX_DIM);
      const page = st.page;
      page.outCanvas = out;
      page.thumb = Pipeline.thumb(out, 420);
      page.strokes = st.strokes;
      page.settings = Object.assign({}, st.page.settings);
      page.quad = st.quad.map(function (p) { return { x: p.x, y: p.y }; });
      page.width = out.width;
      page.height = out.height;
      const cb = st.onSave;
      showLoading(false);
      close();
      if (cb) cb(page);
    } catch (err) {
      showLoading(false);
      toast(err.message || '套用失敗');
    }
  }

  global.Editor = Editor;
})(window);
