/* =========================================================
 * filters.js — 色彩最佳化與畫質提升管線
 * 去陰影 / 除噪 / 色度低通 / 自適應二值化 / 銳化 / 濾鏡預設
 * ========================================================= */
(function (global) {
  'use strict';

  const CV = global.CV;
  const Filters = {};

  Filters.PRESETS = [
    { id: 'auto', label: '增強並銳化', desc: '保留色彩，拉對比、銳化文字' },
    { id: 'bw', label: '黑白高對比', desc: '局部自適應二值化，去掉透印與紙紋' },
    { id: 'gray', label: '灰階', desc: '柔和灰階，適合一般文件' },
    { id: 'magic', label: '魔幻彩色', desc: '提高飽和度與白點，適合彩色圖表與印章' },
    { id: 'ink', label: '省墨', desc: '淡化底色，列印時更省碳粉' },
    { id: 'original', label: '原圖', desc: '只做幾何校正，不改色調' }
  ];

  Filters.DEFAULTS = {
    preset: 'auto',
    shadow: 95,
    sharpen: 40,
    contrast: 0,
    brightness: 0,
    denoise: false,
    moire: false
  };

  /* ---------------- 低階工具 ---------------- */

  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

  function read(canvas) {
    const img = CV.getPixels(canvas);
    return { img: img, d: img.data, w: canvas.width, h: canvas.height, n: canvas.width * canvas.height };
  }

  function write(canvas, img) {
    CV.ctx(canvas).putImageData(img, 0, 0);
  }

  function lumOf(d, n, out) {
    const lum = out || new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    return lum;
  }

  /* ---------------- 1. 智慧去陰影（紙張亮度包絡除法） ----------------
   * 以「區塊百分位」估計紙張本身的亮度（不受文字、格線拖低），
   * 再做大尺度平滑，避免在文字周圍產生光暈與斑塊。
   * ------------------------------------------------------------------ */

  function removeShadow(canvas, strength) {
    const R = read(canvas);
    const { d, w, h } = R;
    const lum = lumOf(d, R.n);

    const BS = Math.max(6, Math.round(Math.min(w, h) / 32));
    const bw = Math.ceil(w / BS), bh = Math.ceil(h / BS);
    const env = new Float32Array(bw * bh);
    const hist = new Uint32Array(256);
    const step = BS > 26 ? 2 : 1;

    for (let by = 0; by < bh; by++) {
      const y0 = by * BS, y1 = Math.min(h, y0 + BS);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * BS, x1 = Math.min(w, x0 + BS);
        hist.fill(0);
        let total = 0;
        for (let y = y0; y < y1; y += step) {
          const row = y * w;
          for (let x = x0; x < x1; x += step) {
            hist[lum[row + x] | 0]++;
            total++;
          }
        }
        const target = total * 0.82;
        let acc = 0, v = 0;
        for (; v < 256; v++) { acc += hist[v]; if (acc >= target) break; }
        env[by * bw + bx] = v > 255 ? 255 : v;
      }
    }

    // 兩次 3x3 平滑，消掉區塊接縫
    const envS = CV.boxBlurF(CV.boxBlurF(env, bw, bh, 1), bw, bh, 1);
    const fx = bw / w, fy = bh / h;

    for (let y = 0; y < h; y++) {
      const gy = Math.min(bh - 1.001, Math.max(0, (y + 0.5) * fy - 0.5));
      const y0 = gy | 0, y1 = Math.min(bh - 1, y0 + 1), ty = gy - y0;
      const r0 = y0 * bw, r1 = y1 * bw, row = y * w;
      for (let x = 0; x < w; x++) {
        const gx = Math.min(bw - 1.001, Math.max(0, (x + 0.5) * fx - 0.5));
        const x0 = gx | 0, x1 = Math.min(bw - 1, x0 + 1), tx = gx - x0;
        const cand = (envS[r0 + x0] * (1 - tx) + envS[r0 + x1] * tx) * (1 - ty) +
          (envS[r1 + x0] * (1 - tx) + envS[r1 + x1] * tx) * ty;

        let gain = 250 / (cand < 12 ? 12 : cand);
        if (gain > 2.6) gain = 2.6; else if (gain < 0.72) gain = 0.72;
        gain = 1 + (gain - 1) * strength;

        const o = (row + x) * 4;
        d[o] = clamp255(d[o] * gain);
        d[o + 1] = clamp255(d[o + 1] * gain);
        d[o + 2] = clamp255(d[o + 2] * gain);
      }
    }
    write(canvas, R.img);
  }

  /* ---------------- 1b. 紙色偏中性化 ---------------- */

  function whiteBalance(canvas, amount) {
    if (amount <= 0) return;
    const R = read(canvas);
    const { d, n } = R;
    const lum = lumOf(d, n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[lum[i] | 0]++;

    let acc = 0, thr = 220;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.08) { thr = v; break; } }

    let sr = 0, sg = 0, sb = 0, c = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (lum[i] < thr) continue;
      sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; c++;
    }
    if (!c) return;
    sr /= c; sg /= c; sb /= c;
    const mx = Math.max(sr, sg, sb);
    if (mx < 40) return;

    let kr = 1 + (mx / Math.max(sr, 1) - 1) * amount;
    let kg = 1 + (mx / Math.max(sg, 1) - 1) * amount;
    let kb = 1 + (mx / Math.max(sb, 1) - 1) * amount;
    kr = Math.min(1.35, Math.max(0.8, kr));
    kg = Math.min(1.35, Math.max(0.8, kg));
    kb = Math.min(1.35, Math.max(0.8, kb));

    for (let p = 0; p < d.length; p += 4) {
      d[p] = clamp255(d[p] * kr);
      d[p + 1] = clamp255(d[p + 1] * kg);
      d[p + 2] = clamp255(d[p + 2] * kb);
    }
    write(canvas, R.img);
  }

  /* ---------------- 2. 除噪（亮度 3×3 中值） ---------------- */

  function denoise(canvas) {
    const R = read(canvas);
    const { d, w, h, n } = R;
    const lum = lumOf(d, n);
    const med = new Float32Array(n);
    const buf = new Float32Array(9);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { med[i] = lum[i]; continue; }
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const base = i + dy * w;
          for (let dx = -1; dx <= 1; dx++) buf[k++] = lum[base + dx];
        }
        for (let a = 1; a < 9; a++) {
          const v = buf[a];
          let b = a - 1;
          while (b >= 0 && buf[b] > v) { buf[b + 1] = buf[b]; b--; }
          buf[b + 1] = v;
        }
        med[i] = buf[4];
      }
    }

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const delta = med[i] - lum[i];
      if (!delta) continue;
      d[p] = clamp255(d[p] + delta);
      d[p + 1] = clamp255(d[p + 1] + delta);
      d[p + 2] = clamp255(d[p + 2] + delta);
    }
    write(canvas, R.img);
  }

  /* ---------------- 3. 去摩爾紋（YCbCr 色度低通） ---------------- */

  function removeMoire(canvas) {
    const R = read(canvas);
    const { d, w, h, n } = R;
    const cb = new Float32Array(n);
    const cr = new Float32Array(n);
    const yy = new Float32Array(n);

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const Y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      yy[i] = Y;
      cb[i] = d[p + 2] - Y;
      cr[i] = d[p] - Y;
    }
    const r = Math.max(2, Math.round(Math.min(w, h) / 260));
    const cbB = CV.boxBlurF(cb, w, h, r);
    const crB = CV.boxBlurF(cr, w, h, r);

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const Rr = yy[i] + crB[i];
      const Bb = yy[i] + cbB[i];
      const Gg = (yy[i] - 0.299 * Rr - 0.114 * Bb) / 0.587;
      d[p] = clamp255(Rr);
      d[p + 1] = clamp255(Gg);
      d[p + 2] = clamp255(Bb);
    }
    write(canvas, R.img);
  }

  /* ---------------- 4. 自動色階 ---------------- */

  function autoLevels(canvas, loFrac, hiFrac) {
    loFrac = loFrac == null ? 0.02 : loFrac;
    hiFrac = hiFrac == null ? 0.05 : hiFrac;
    const R = read(canvas);
    const { d, n } = R;
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      hist[(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0]++;
    }

    const loTarget = n * loFrac, hiTarget = n * hiFrac;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loTarget) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= hiTarget) { hi = v; break; } }

    if (hi - lo < 40) { lo = Math.max(0, lo - 20); hi = Math.min(255, hi + 20); }
    const scale = 255 / Math.max(25, hi - lo);

    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const o = (v - lo) * scale;
      lut[v] = o < 0 ? 0 : (o > 255 ? 255 : o);
    }

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      d[p] = lut[d[p]];
      d[p + 1] = lut[d[p + 1]];
      d[p + 2] = lut[d[p + 2]];
    }
    write(canvas, R.img);
  }

  /* ---------------- 5. 自適應二值化 ---------------- */

  function adaptiveBinarize(canvas) {
    const R = read(canvas);
    const { d, w, h, n } = R;
    const lum = lumOf(d, n);
    const radius = Math.max(6, Math.round(Math.min(w, h) / 42));
    const bg = CV.blurGauss(lum, w, h, radius);

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = lum[i] < bg[i] * 0.87 ? 0 : 255;
      d[p] = v; d[p + 1] = v; d[p + 2] = v;
    }

    // 去孤立雜點
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = d[i * 4] < 128 ? 1 : 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!bin[i]) continue;
        if (bin[i - 1] + bin[i + 1] + bin[i - w] + bin[i + w] === 0) {
          const p = i * 4;
          d[p] = 255; d[p + 1] = 255; d[p + 2] = 255;
        }
      }
    }
    write(canvas, R.img);
  }

  /* ---------------- 6. 飽和度 / 灰階 ---------------- */

  function saturate(canvas, k) {
    const R = read(canvas);
    const { d, n } = R;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const Y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      d[p] = clamp255(Y + (d[p] - Y) * k);
      d[p + 1] = clamp255(Y + (d[p + 1] - Y) * k);
      d[p + 2] = clamp255(Y + (d[p + 2] - Y) * k);
    }
    write(canvas, R.img);
  }

  function grayscale(canvas) {
    const R = read(canvas);
    const { d, n } = R;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const Y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      d[p] = Y; d[p + 1] = Y; d[p + 2] = Y;
    }
    write(canvas, R.img);
  }

  function applyLUT(canvas, fn) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = fn(v);
    const R = read(canvas);
    const { d, n } = R;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      d[p] = lut[d[p]];
      d[p + 1] = lut[d[p + 1]];
      d[p + 2] = lut[d[p + 2]];
    }
    write(canvas, R.img);
  }

  /* ---------------- 6a. 亮部去色（讓紙張趨近中性白） ---------------- */

  function neutralizeHighlights(canvas, knee, amount) {
    const R = read(canvas);
    const { d, n } = R;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      if (l <= knee) continue;
      let f = (l - knee) / (255 - knee);
      if (f > 1) f = 1;
      const s = 1 - amount * f;
      d[p] = clamp255(l + (d[p] - l) * s);
      d[p + 1] = clamp255(l + (d[p + 1] - l) * s);
      d[p + 2] = clamp255(l + (d[p + 2] - l) * s);
    }
    write(canvas, R.img);
  }

  /* ---------------- 6b. 紙張白化（保留中間調的柔和曲線） ---------------- */

  function whitenPaper(canvas, knee, full) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      if (v <= knee) { lut[v] = v; continue; }
      if (v >= full) { lut[v] = 255; continue; }
      const t = (v - knee) / (full - knee);
      lut[v] = v + (255 - v) * (t * t * (3 - 2 * t));
    }
    applyLUT(canvas, function (v) { return lut[v]; });
  }

  /* ---------------- 7. 銳化（unsharp mask） ---------------- */

  function unsharp(canvas, amount) {
    const R = read(canvas);
    const { d, w, h, n } = R;
    const lum = lumOf(d, n);
    const blur = CV.boxBlurF(lum, w, h, 1);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      let delta = (lum[i] - blur[i]) * amount;
      if (delta > 80) delta = 80; else if (delta < -80) delta = -80;
      if (!delta) continue;
      d[p] = clamp255(d[p] + delta);
      d[p + 1] = clamp255(d[p + 1] + delta);
      d[p + 2] = clamp255(d[p + 2] + delta);
    }
    write(canvas, R.img);
  }

  /* ---------------- 8. 亮度 / 對比 ---------------- */

  function brightnessContrast(canvas, brightness, contrast) {
    const c = 1 + contrast / 100;
    const b = brightness * 1.6;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = clamp255((v - 128) * c + 128 + b);
    applyLUT(canvas, function (v) { return lut[v]; });
  }

  /* ---------------- 主流程 ---------------- */

  Filters.apply = function (source, s) {
    s = Object.assign({}, Filters.DEFAULTS, s || {});
    const c = CV.clone(source);
    const preset = s.preset || 'auto';

    if (s.moire) removeMoire(c);
    if (s.denoise) denoise(c);

    const shadow = Math.max(0, Math.min(100, s.shadow)) / 100;
    if (shadow > 0.005) removeShadow(c, shadow);

    if (preset !== 'original') whiteBalance(c, preset === 'magic' ? 0.35 : 0.62);

    if (preset === 'bw') {
      autoLevels(c, 0.02, 0.05);
      adaptiveBinarize(c);
    } else if (preset === 'magic') {
      autoLevels(c, 0.004, 0.015);
      saturate(c, 1.42);
    } else if (preset === 'ink') {
      autoLevels(c, 0.02, 0.06);
      grayscale(c);
      whitenPaper(c, 190, 240);
      applyLUT(c, function (v) { return 255 * Math.pow(v / 255, 0.82); });
    } else if (preset === 'gray') {
      autoLevels(c, 0.015, 0.05);
      grayscale(c);
      whitenPaper(c, 195, 245);
    } else if (preset === 'original') {
      // 幾何校正後原樣輸出
    } else {
      autoLevels(c, 0.01, 0.05);
      neutralizeHighlights(c, 185, 0.92);
      whitenPaper(c, 200, 235);
      saturate(c, 1.0);
    }

    const sharp = Math.max(0, Math.min(150, s.sharpen)) / 100;
    if (sharp > 0.02 && preset !== 'bw') unsharp(c, sharp);

    if (s.contrast || s.brightness) brightnessContrast(c, s.brightness || 0, s.contrast || 0);

    return c;
  };

  global.Filters = Filters;
})(window);
