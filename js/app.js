/* =========================================================
 * app.js — 應用主控
 * 相片佇列 / 頁面管理 / 匯出 PDF
 * ========================================================= */
(function (global) {
  'use strict';

  const CV = global.CV;
  const Pipeline = global.Pipeline;
  const Filters = global.Filters;

  const App = {};
  const state = {
    pages: [],
    seq: 0,
    defaults: Pipeline.defaultSettings(),
    busy: false
  };

  const COLOR_KEYS = ['preset', 'shadow', 'sharpen', 'contrast', 'brightness', 'denoise', 'moire'];

  function $(id) { return document.getElementById(id); }

  let toastTimer = null;
  App.toast = function (msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  };

  /* ---------------- 加入相片 ---------------- */

  App.addFiles = async function (fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    const imgs = files.filter(function (f) {
      return /^image\//i.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name || '');
    });
    if (!imgs.length) {
      App.toast('請選擇圖片檔案');
      return;
    }

    imgs.forEach(function (f) {
      state.pages.push({
        id: ++state.seq,
        file: f,
        name: f.name || ('page-' + state.seq),
        quad: Pipeline.fullQuad(),
        settings: pickDefaults(),
        strokes: [],
        thumb: null,
        status: 'pending',
        width: 0,
        height: 0
      });
    });

    renderGrid();
    updateSummary();
    processQueue();
  };

  function pickDefaults() {
    const s = Pipeline.defaultSettings();
    COLOR_KEYS.forEach(function (k) { if (k in state.defaults) s[k] = state.defaults[k]; });
    return s;
  }

  /* ---------------- 背景處理佇列 ---------------- */

  let running = false;

  async function processQueue() {
    if (running) return;
    running = true;

    while (true) {
      const page = state.pages.find(function (p) { return p.status === 'pending'; });
      if (!page) break;

      page.status = 'processing';
      updateCard(page);

      try {
        const src = await Pipeline.decode(page.file, 1400);
        page.srcW = src.width;
        page.srcH = src.height;

        const q = Pipeline.detect(src);
        if (q) page.quad = q;

        const out = Pipeline.render(src, page, Pipeline.THUMB_DIM);
        page.thumb = Pipeline.thumb(out, Pipeline.THUMB_DIM);
        page.width = out.width;
        page.height = out.height;
        page.status = 'ready';
      } catch (err) {
        page.status = 'error';
        console.error(err);
      }
      updateCard(page);
      await nextFrame();
    }

    running = false;
    updateSummary();
  }

  function nextFrame() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  /* ---------------- 頁面列表 ---------------- */

  function renderGrid() {
    const grid = $('pageGrid');
    grid.innerHTML = '';

    state.pages.forEach(function (page, i) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.id = page.id;

      const img = document.createElement('div');
      img.className = 'card-img' + (page.thumb ? '' : ' placeholder');
      if (page.thumb) img.style.backgroundImage = 'url(' + page.thumb + ')';

      const num = document.createElement('div');
      num.className = 'card-num';
      num.textContent = i + 1;

      const ops = document.createElement('div');
      ops.className = 'card-ops';
      [['left', '◀', '往前移'], ['rot', '⟳', '旋轉 90°'], ['right', '▶', '往後移'], ['del', '✕', '刪除']]
        .forEach(function (o) {
          const b = document.createElement('button');
          b.className = 'op' + (o[0] === 'del' ? ' del' : '');
          b.dataset.act = o[0];
          b.title = o[2];
          b.textContent = o[1];
          ops.appendChild(b);
        });

      card.appendChild(img);
      card.appendChild(num);
      card.appendChild(ops);
      grid.appendChild(card);
    });

    const tile = document.createElement('button');
    tile.className = 'add-tile';
    tile.id = 'addTile';
    tile.innerHTML = '<span>＋</span>加入相片';
    tile.addEventListener('click', function () { $('fileInput').click(); });
    grid.appendChild(tile);

    $('emptyState').classList.toggle('hidden', state.pages.length > 0);
    $('pagesArea').classList.toggle('hidden', state.pages.length === 0);
  }

  function updateCard(page) {
    const card = $('pageGrid').querySelector('.card[data-id="' + page.id + '"]');
    if (!card) { renderGrid(); return; }
    const img = card.querySelector('.card-img');
    if (page.thumb) {
      img.style.backgroundImage = 'url(' + page.thumb + ')';
      img.classList.remove('placeholder');
    } else {
      img.classList.add('placeholder');
    }
    if (page.status === 'error') {
      img.style.backgroundImage = 'none';
      img.classList.add('placeholder');
    }
  }

  function updateSummary() {
    $('pageCount').textContent = state.pages.length;
    const total = state.pages.reduce(function (a, p) { return a + (p.width * p.height > 0 ? 1 : 0); }, 0);
    $('sizeInfo').textContent = total ? '· 已處理 ' + total : '';
  }

  function findPage(id) {
    return state.pages.find(function (p) { return String(p.id) === String(id); });
  }

  function movePage(page, delta) {
    const i = state.pages.indexOf(page);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.pages.length) return;
    state.pages.splice(i, 1);
    state.pages.splice(j, 0, page);
    renderGrid();
  }

  async function rotatePage(page) {
    const s = page.settings;
    s.rotate = (((s.rotate || 0) + 90) % 360 + 360) % 360;
    page.outCanvas = null;
    try {
      const src = await Pipeline.decode(page.file, 1000);
      const out = Pipeline.render(src, page, 420);
      page.thumb = Pipeline.thumb(out, 420);
      page.width = out.width;
      page.height = out.height;
    } catch (e) { /* 忽略 */ }
    updateCard(page);
  }

  function deletePage(page) {
    const i = state.pages.indexOf(page);
    if (i < 0) return;
    state.pages.splice(i, 1);
    page.outCanvas = null;
    renderGrid();
    updateSummary();
  }

  function openEditor(page) {
    if (page.status === 'pending' || page.status === 'processing') {
      App.toast('這張相片還在處理中');
      return;
    }
    if (page.status === 'error') {
      App.toast('這張相片無法讀取');
      return;
    }
    const idx = state.pages.indexOf(page);
    global.Editor.open(page, idx, state.pages.length, function (updated) {
      Object.assign(page, updated);
      COLOR_KEYS.forEach(function (k) {
        if (k in updated.settings) state.defaults[k] = updated.settings[k];
      });
      renderGrid();
      updateSummary();
    });
  }

  /* ---------------- 全部套用預設 ---------------- */

  async function applyAll() {
    if (state.busy) return;
    const targets = state.pages.filter(function (p) { return p.status === 'ready'; });
    if (!targets.length) { App.toast('還沒有可套用的頁面'); return; }

    state.busy = true;
    App.toast('正在套用預設到 ' + targets.length + ' 頁…');
    for (const page of targets) {
      const keep = { rotate: page.settings.rotate, fine: page.settings.fine, bend: page.settings.bend };
      page.settings = Object.assign({}, page.settings, keep, pickDefaults());
      page.outCanvas = null;
      try {
        const src = await Pipeline.decode(page.file, 1200);
        const out = Pipeline.render(src, page, Pipeline.THUMB_DIM);
        page.thumb = Pipeline.thumb(out, Pipeline.THUMB_DIM);
        page.width = out.width;
        page.height = out.height;
      } catch (e) { /* 忽略 */ }
      updateCard(page);
      await nextFrame();
    }
    state.busy = false;
    App.toast('已套用預設設定');
  }

  /* ---------------- 匯出 ---------------- */

  const QUALITY = {
    high: { dim: 2200, q: 0.92 },
    mid: { dim: 1700, q: 0.86 },
    low: { dim: 1200, q: 0.76 }
  };

  function canvasToBlob(canvas, type, q) {
    return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, type, q); });
  }

  function openExport() {
    if (!state.pages.length) { App.toast('先加入相片'); return; }
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    $('exName').value = 'scan_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes());
    $('exSummary').textContent = '共 ' + state.pages.length + ' 頁，將合併為單一 PDF 檔';
    $('exForm').classList.remove('hidden');
    $('exProgress').classList.add('hidden');
    $('exGo').disabled = false;
    $('exGo').textContent = '開始匯出';
    $('exportModal').classList.remove('hidden');
  }

  function closeExport() {
    $('exportModal').classList.add('hidden');
  }

  async function doExport() {
    const qk = $('exQuality').value;
    const cfg = QUALITY[qk] || QUALITY.mid;
    const pageSize = $('exSize').value;
    const margin = parseFloat($('exMargin').value) || 0;
    let name = ($('exName').value || 'scan').trim().replace(/\.pdf$/i, '');
    if (!name) name = 'scan';

    $('exForm').classList.add('hidden');
    $('exProgress').classList.remove('hidden');
    $('exGo').disabled = true;
    closeBtnState(true);

    const items = [];
    try {
      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        setProgress(i / state.pages.length, '處理第 ' + (i + 1) + ' / ' + state.pages.length + ' 頁…');
        await nextFrame();

        let canvas = page.outCanvas;
        if (!canvas) {
          const src = await Pipeline.decode(page.file, cfg.dim);
          canvas = Pipeline.render(src, page, cfg.dim);
        } else if (Math.max(canvas.width, canvas.height) > cfg.dim) {
          canvas = CV.drawTo(canvas, cfg.dim);
        }

        const blob = await canvasToBlob(canvas, 'image/jpeg', cfg.q);
        const buf = new Uint8Array(await blob.arrayBuffer());
        items.push({ data: buf, w: canvas.width, h: canvas.height });
        await nextFrame();
      }

      setProgress(0.95, '組裝 PDF…');
      await nextFrame();

      const pdf = global.PDF.build(items, { pageSize: pageSize, margin: margin });
      setProgress(1, '完成，開始下載');
      await nextFrame();

      download(pdf, name + '.pdf');
      App.toast('已匯出 ' + state.pages.length + ' 頁 PDF');
      closeExport();
    } catch (err) {
      console.error(err);
      App.toast('匯出失敗：' + (err.message || '未知錯誤'));
      $('exProgress').classList.add('hidden');
      $('exForm').classList.remove('hidden');
    } finally {
      closeBtnState(false);
      $('exGo').disabled = false;
    }
  }

  function closeBtnState(disabled) {
    $('exCancel').disabled = disabled;
    $('exClose').disabled = disabled;
  }

  function setProgress(ratio, text) {
    $('progBar').style.width = Math.round(ratio * 100) + '%';
    $('progText').textContent = text;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 4000);
  }

  /* ---------------- 事件綁定 ---------------- */

  function bind() {
    const fileInput = $('fileInput');
    const cameraInput = $('cameraInput');

    const pickFiles = function () { fileInput.click(); };
    const pickCamera = function () { cameraInput.click(); };

    ['btnAdd', 'btnPickFiles', 'mBtnAdd'].forEach(function (id) {
      const n = $(id); if (n) n.addEventListener('click', pickFiles);
    });
    ['btnPickCamera'].forEach(function (id) {
      const n = $(id); if (n) n.addEventListener('click', pickCamera);
    });

    [fileInput, cameraInput].forEach(function (inp) {
      inp.addEventListener('change', function () {
        if (inp.files && inp.files.length) App.addFiles(inp.files);
        inp.value = '';
      });
    });

    $('btnExport').addEventListener('click', openExport);
    $('mBtnExport').addEventListener('click', openExport);
    $('exClose').addEventListener('click', closeExport);
    $('exCancel').addEventListener('click', closeExport);
    $('exGo').addEventListener('click', doExport);

    $('btnApplyAll').addEventListener('click', applyAll);
    $('btnClearAll').addEventListener('click', function () {
      if (!state.pages.length) return;
      if (!confirm('確定要清空所有頁面？')) return;
      state.pages = [];
      renderGrid();
      updateSummary();
    });

    $('btnHelp').addEventListener('click', function () { $('helpModal').classList.remove('hidden'); });
    $('helpClose').addEventListener('click', function () { $('helpModal').classList.add('hidden'); });
    $('helpOk').addEventListener('click', function () { $('helpModal').classList.add('hidden'); });

    $('pageGrid').addEventListener('click', function (e) {
      const card = e.target.closest('.card');
      if (!card) return;
      const page = findPage(card.dataset.id);
      if (!page) return;
      const op = e.target.closest('.op');
      if (!op) { openEditor(page); return; }
      const act = op.dataset.act;
      if (act === 'del') deletePage(page);
      else if (act === 'rot') rotatePage(page);
      else if (act === 'left') movePage(page, -1);
      else if (act === 'right') movePage(page, 1);
    });

    // 拖放
    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        if (!e.dataTransfer || !Array.prototype.includes.call(e.dataTransfer.types, 'Files')) return;
        e.preventDefault();
        dz.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        if (ev === 'drop') {
          e.preventDefault();
          if (e.dataTransfer && e.dataTransfer.files.length) App.addFiles(e.dataTransfer.files);
        }
        if (ev === 'dragleave' && e.relatedTarget) return;
        dz.classList.remove('dragover');
      });
    });

    // 貼上
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      const files = [];
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        const it = e.clipboardData.items[i];
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        App.addFiles(files);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('helpModal').classList.contains('hidden')) $('helpModal').classList.add('hidden');
        else if (!$('exportModal').classList.contains('hidden')) closeExport();
      }
    });
  }

  /* ---------------- 啟動 ---------------- */

  function start() {
    bind();
    renderGrid();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.App = App;
})(window);
