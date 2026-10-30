/* =========================================================
 * cv.js — 影像處理核心
 * 邊緣偵測 / 透視變換 / 幾何校正 / 濾波器底層運算
 * 純瀏覽器端運算，無任何外部依賴
 * ========================================================= */
(function (global) {
  'use strict';

  const CV = {};

  /* ---------------- canvas 工具 ---------------- */

  CV.makeCanvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };

  CV.ctx = function (c) {
    return c.getContext('2d', { willReadFrequently: true });
  };

  CV.clone = function (src) {
    const c = CV.makeCanvas(src.width, src.height);
    CV.ctx(c).drawImage(src, 0, 0);
    return c;
  };

  /** 把任意影像來源縮放到最長邊 <= maxDim 的 canvas */
  CV.drawTo = function (img, maxDim) {
    const iw = img.width || img.naturalWidth;
    const ih = img.height || img.naturalHeight;
    const s = Math.min(1, (maxDim || 4096) / Math.max(iw, ih));
    const c = CV.makeCanvas(iw * s, ih * s);
    const ctx = CV.ctx(c);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  };

  CV.getPixels = function (canvas) {
    return CV.ctx(canvas).getImageData(0, 0, canvas.width, canvas.height);
  };

  /* ---------------- 灰階 / 濾波 ---------------- */

  /** 回傳 { g: Float32Array 亮度, w, h } */
  CV.gray = function (canvas) {
    const w = canvas.width, h = canvas.height;
    const data = CV.getPixels(canvas).data;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return { g: g, w: w, h: h };
  };

  /** 一維可分離 box blur（邊界 clamp），O(n) */
  CV.boxBlurF = function (src, w, h, r) {
    r = Math.max(0, r | 0);
    if (r < 1) return src.slice();
    const n = 2 * r + 1;
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);

    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const x = i < 0 ? 0 : (i >= w ? w - 1 : i);
        sum += src[row + x];
      }
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / n;
        const ax = x + r + 1; const sx = x - r;
        sum += src[row + (ax >= w ? w - 1 : ax)] - src[row + (sx < 0 ? 0 : sx)];
      }
    }

    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const y = i < 0 ? 0 : (i >= h ? h - 1 : i);
        sum += tmp[y * w + x];
      }
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / n;
        const ay = y + r + 1; const sy = y - r;
        sum += tmp[(ay >= h ? h - 1 : ay) * w + x] - tmp[(sy < 0 ? 0 : sy) * w + x];
      }
    }
    return out;
  };

  /** 灰階高斯近似（三次 box blur） */
  CV.blurGauss = function (src, w, h, r) {
    let a = CV.boxBlurF(src, w, h, r);
    a = CV.boxBlurF(a, w, h, r);
    return CV.boxBlurF(a, w, h, r);
  };

  /** Sobel 梯度強度 */
  CV.sobel = function (g, w, h) {
    const m = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
      for (let x = 1; x < w - 1; x++) {
        const a = g[r0 + x - 1], b = g[r0 + x], c = g[r0 + x + 1];
        const d = g[r1 + x - 1], f = g[r1 + x + 1];
        const p = g[r2 + x - 1], q = g[r2 + x], s = g[r2 + x + 1];
        const gx = -a - 2 * d - p + c + 2 * f + s;
        const gy = -a - 2 * b - c + p + 2 * q + s;
        m[r1 + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return m;
  };

  /* ---------------- 四邊形幾何工具 ---------------- */

  CV.dist = function (a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** 鞋帶公式面積（絕對值） */
  CV.quadArea = function (q) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  };

  CV.isConvex = function (q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) < 1e-6) return false;
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
    return true;
  };

  /** 依 x+y / x−y 極值排序成 TL, TR, BR, BL */
  CV.orderQuad = function (pts) {
    let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
    let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    for (const p of pts) {
      const s = p.x + p.y, d = p.x - p.y;
      if (s < sMin) { sMin = s; tl = p; }
      if (s > sMax) { sMax = s; br = p; }
      if (d > dMax) { dMax = d; tr = p; }
      if (d < dMin) { dMin = d; bl = p; }
    }
    return [tl, tr, br, bl];
  };

  /** 檢查四邊形是否合理（可當作紙張邊界） */
  CV.validQuad = function (q, w, h) {
    if (!q || q.length !== 4) return false;
    if (!CV.isConvex(q)) return false;
    const area = CV.quadArea(q);
    const ratio = area / (w * h);
    if (ratio < 0.10 || ratio > 0.985) return false;
    const diag = Math.sqrt(w * w + h * h);
    for (let i = 0; i < 4; i++) {
      if (CV.dist(q[i], q[(i + 1) % 4]) < diag * 0.09) return false;
    }
    // 對邊長度不應相差過份（避免退化成三角形）
    const e0 = CV.dist(q[0], q[1]), e2 = CV.dist(q[2], q[3]);
    const e1 = CV.dist(q[1], q[2]), e3 = CV.dist(q[3], q[0]);
    if (e0 / e2 > 3.2 || e2 / e0 > 3.2) return false;
    if (e1 / e3 > 3.2 || e3 / e1 > 3.2) return false;
    return true;
  };

  /* ---------------- 連通域 ---------------- */

  function dilate(mask, w, h) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const i = r + x;
        if (mask[i]) { out[i] = 1; continue; }
        if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) ||
            (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) out[i] = 1;
      }
    }
    return out;
  }

  /** 取出前 k 大的連通域（依外接框面積） */
  function topComponents(mask, w, h, k) {
    const label = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const comps = [];

    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || label[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      label[start] = 1;

      const comp = { count: 0, minX: w, minY: h, maxX: 0, maxY: 0, px: [] };
      while (sp > 0) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        comp.count++;
        comp.px.push(p);
        if (x < comp.minX) comp.minX = x;
        if (x > comp.maxX) comp.maxX = x;
        if (y < comp.minY) comp.minY = y;
        if (y > comp.maxY) comp.maxY = y;

        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = 1; stack[sp++] = p + w; }
      }

      comp.bboxArea = (comp.maxX - comp.minX + 1) * (comp.maxY - comp.minY + 1);
      comps.push(comp);
    }

    comps.sort(function (a, b) { return b.bboxArea - a.bboxArea; });
    return comps.slice(0, k);
  }

  /** 從連通域的極值點抓四個角 */
  function quadFromComponent(comp, w, h) {
    if (!comp || comp.px.length < 40) return null;
    const pts = [];
    const step = Math.max(1, Math.floor(comp.px.length / 8000));
    for (let i = 0; i < comp.px.length; i += step) {
      const p = comp.px[i];
      pts.push({ x: p % w, y: (p - (p % w)) / w });
    }
    const q = CV.orderQuad(pts);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        if (CV.dist(q[i], q[j]) < Math.min(w, h) * 0.08) return null;
      }
    }
    return q;
  }

  function pointInQuad(x, y, q) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = q[i].x, yi = q[i].y, xj = q[j].x, yj = q[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function percentileOf(arr, p) {
    const hist = new Uint32Array(512);
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      let v = arr[i] | 0;
      if (v < 0) v = 0; else if (v > 511) v = 511;
      hist[v]++; n++;
    }
    const target = n * p;
    let acc = 0;
    for (let v = 0; v < 512; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 511;
  }

  /**
   * 評估一個四邊形「像不像一張紙」：
   * 四邊是否都貼在真實邊緣上、內部是否比外部亮、面積是否合理
   */
  function scoreQuad(gray, mag, q, w, h, ref) {
    if (!ref) ref = percentileOf(mag, 0.95) || 1;
    const sup = [];

    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < Math.min(w, h) * 0.15) return -1;
      const nx = -dy / L, ny = dx / L;
      let acc = 0, cnt = 0;
      for (let k = 1; k <= 15; k++) {
        const t = 0.06 + 0.88 * k / 16;
        const px = a.x + dx * t, py = a.y + dy * t;
        let m = 0;
        for (let d = -2; d <= 2; d++) {
          const v = sampleBilinear(mag, w, h, px + nx * d, py + ny * d);
          if (v > m) m = v;
        }
        acc += m; cnt++;
      }
      sup.push(Math.min(1, (acc / cnt) / ref));
    }

    const sMean = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
    const sMin = Math.min(sup[0], Math.min(sup[1], Math.min(sup[2], sup[3])));

    let sum = 0, c = 0;
    for (let gy = 0; gy < 9; gy++) {
      for (let gx = 0; gx < 9; gx++) {
        const px = (gx + 0.5) / 9 * w, py = (gy + 0.5) / 9 * h;
        if (pointInQuad(px, py, q)) { sum += sampleBilinear(gray, w, h, px, py); c++; }
      }
    }
    const inside = c ? (sum / c) / 255 : 0;

    const areaFrac = Math.abs(CV.quadArea(q)) / (w * h);

    let touch = 0;
    for (let i = 0; i < 4; i++) {
      const p = q[i];
      if (p.x < w * 0.012 || p.y < h * 0.012 || p.x > w * 0.988 || p.y > h * 0.988) touch++;
    }
    const penalty = 1 - 0.1 * touch;

    // 版面比例先驗：文件幾乎不是正方形
    const wTop = CV.dist(q[0], q[1]), wBot = CV.dist(q[3], q[2]);
    const hL = CV.dist(q[0], q[3]), hR = CV.dist(q[1], q[2]);
    let ratio = ((wTop + wBot) / 2) / Math.max(1, (hL + hR) / 2);
    if (ratio > 1) ratio = 1 / ratio;
    let arPenalty = 1;
    if (ratio > 0.86) arPenalty = 0.74;
    else if (ratio < 0.44) arPenalty = 0.86;

    return (0.55 * (0.5 * sMean + 0.5 * sMin) + 0.25 * inside +
      0.20 * Math.min(1, areaFrac / 0.72)) * penalty * arPenalty;
  }

  /**
   * 自動偵測文件四邊界
   * @param {HTMLCanvasElement} canvas 來源（任意尺寸，內部會縮到 420px 處理）
   * @returns {Array<{x:number,y:number}>|null} 正規化 (0~1) 座標 TL,TR,BR,BL
   */
  CV.DETECT_SIZE = 600;

  CV.detectQuad = function (canvas) {
    const small = CV.drawTo(canvas, CV.DETECT_SIZE);
    const w = small.width, h = small.height;
    const gray = CV.gray(small);
    const blurred = CV.blurGauss(gray.g, w, h, 1);
    const mag = CV.sobel(blurred, w, h);

    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < mag.length; i++) {
      const v = mag[i];
      if (!isFinite(v)) continue;
      sum += v; sum2 += v * v; n++;
    }
    if (!n) return null;
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));

    const cands = [];
    const factors = [0.8, 1.3, 1.9, 2.6];
    for (let fi = 0; fi < factors.length; fi++) {
      const th = Math.max(mean + factors[fi] * std, 14);
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = mag[i] > th ? 1 : 0;
      const d = dilate(mask, w, h);
      const comps = topComponents(d, w, h, 4);
      for (let ci = 0; ci < comps.length; ci++) {
        const q = quadFromComponent(comps[ci], w, h);
        if (q && CV.validQuad(q, w, h)) cands.push(q);
      }
    }

    // 整幅影像也是候選（避免完全偵測失敗時亂裁）
    cands.push([{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }]);

    let best = null, bestScore = 0.33;
    const refMag = percentileOf(mag, 0.95) || 1;
    const seen = [];
    for (let i = 0; i < cands.length; i++) {
      const q = cands[i];
      // 去重
      let dup = false;
      for (let j = 0; j < seen.length; j++) {
        let d = 0;
        for (let k = 0; k < 4; k++) d += CV.dist(q[k], seen[j][k]);
        if (d / 4 < Math.min(w, h) * 0.03) { dup = true; break; }
      }
      if (dup) continue;
      seen.push(q);

      const sc = scoreQuad(blurred, mag, q, w, h, refMag);
      if (sc > bestScore) { bestScore = sc; best = q; }
    }

    if (!best) return null;
    const norm = best.map(function (p) {
      return { x: p.x / w, y: p.y / h };
    });
    return norm;
  };

  /* ---------------- 邊緣精修（吸附到最強梯度） ---------------- */

  function sampleBilinear(src, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    const x0 = x | 0, y0 = y | 0;
    const x1 = x0 < w - 1 ? x0 + 1 : x0;
    const y1 = y0 < h - 1 ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = src[y0 * w + x0], b = src[y0 * w + x1];
    const c = src[y1 * w + x0], d = src[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  function median(arr) {
    const a = arr.slice().sort(function (p, q) { return p - q; });
    const n = a.length;
    return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /**
   * 把偵測到的四邊各自吸附到最強梯度，再以擬合直線求交點
   * 可同時修正邊的位移與角度誤差
   */
  CV.refineQuad = function (canvas, quadNorm, radiusFrac) {
    const work = Math.max(canvas.width, canvas.height) > 1200 ? CV.drawTo(canvas, 1200) : canvas;
    const W = work.width, H = work.height;
    const g = CV.gray(work);
    const blurred = CV.blurGauss(g.g, W, H, 1);
    const mag = CV.sobel(blurred, W, H);

    const q = quadNorm.map(function (p) { return { x: p.x * W, y: p.y * H }; });
    const R = Math.max(6, Math.round(Math.min(W, H) * (radiusFrac || 0.022)));
    const lines = [];

    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      if (L < 30) return quadNorm;
      const ux = dx / L, uy = dy / L;
      const nx = -uy, ny = ux;

      const pts = [], offs = [];
      for (let k = 1; k <= 21; k++) {
        const t = k / 22;
        const px = a.x + dx * t, py = a.y + dy * t;
        let bestD = null, bestV = -1;
        for (let d = -R; d <= R; d += 1) {
          const v = sampleBilinear(mag, W, H, px + nx * d, py + ny * d) *
            (1 - 0.35 * Math.abs(d) / R);
          if (v > bestV) { bestV = v; bestD = d; }
        }
        if (bestD !== null) {
          offs.push(bestD);
          pts.push({ x: px + nx * bestD, y: py + ny * bestD, d: bestD });
        }
      }
      if (pts.length < 10) return quadNorm;

      // 去掉離群樣本後再擬合
      const m0 = median(offs);
      const kept = pts.filter(function (p) { return Math.abs(p.d - m0) <= 3.5; });
      if (kept.length < 8) return quadNorm;

      const line = fitLine(kept);
      if (!line || line.rms > 2.2) return quadNorm;

      // 角度與位移都不能跑太遠
      const cross = Math.abs(line.d.x * uy - line.d.y * ux);
      if (cross > 0.045) return quadNorm;
      const off = (line.p.x - (a.x + b.x) / 2) * nx + (line.p.y - (a.y + b.y) / 2) * ny;
      if (Math.abs(off) > R * 0.8) return quadNorm;

      lines.push({ p: line.p, d: line.d, n: { x: nx, y: ny }, off: off });
    }

    const out = [];
    for (let i = 0; i < 4; i++) {
      const l1 = lines[(i + 3) % 4], l2 = lines[i];
      const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
      if (Math.abs(den) < 1e-6) return quadNorm;
      const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
      out.push({ x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t });
    }

    const diag = Math.hypot(W, H);
    for (let i = 0; i < 4; i++) {
      if (!isFinite(out[i].x) || !isFinite(out[i].y)) return quadNorm;
      if (CV.dist(out[i], q[i]) > diag * 0.035) return quadNorm;
      if (out[i].x < -W * 0.02 || out[i].x > W * 1.02 ||
          out[i].y < -H * 0.02 || out[i].y > H * 1.02) return quadNorm;
    }

    const ordered = CV.orderQuad(out);
    if (!CV.validQuad(ordered, W, H)) return quadNorm;

    // 面積不應劇烈改變
    const a0 = CV.quadArea(q), a1 = CV.quadArea(ordered);
    if (Math.abs(a1 - a0) / a0 > 0.15) return quadNorm;

    return ordered.map(function (p) {
      return { x: Math.min(1, Math.max(0, p.x / W)), y: Math.min(1, Math.max(0, p.y / H)) };
    });
  };

  /** 最小平方直線擬合（PCA），回傳中心點、方向與 RMS */
  function fitLine(pts) {
    let mx = 0, my = 0;
    for (let i = 0; i < pts.length; i++) { mx += pts[i].x; my += pts[i].y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - mx, dy = pts[i].y - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const d = { x: Math.cos(theta), y: Math.sin(theta) };
    let ss = 0;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - mx, dy = pts[i].y - my;
      const perp = -dx * d.y + dy * d.x;
      ss += perp * perp;
    }
    return { p: { x: mx, y: my }, d: d, rms: Math.sqrt(ss / pts.length) };
  }

  /* ---------------- 單應性矩陣 ---------------- */

  function solveLinear(A, b) {
    const n = b.length;
    for (let i = 1; i < n; i++) {
      // 部分主元
      let piv = i - 1, maxv = Math.abs(A[piv][i - 1]);
      for (let r = i; r < n; r++) {
        const v = Math.abs(A[r][i - 1]);
        if (v > maxv) { maxv = v; piv = r; }
      }
      if (maxv < 1e-12) return null;
      if (piv !== i - 1) {
        const t = A[piv]; A[piv] = A[i - 1]; A[i - 1] = t;
        const tb = b[piv]; b[piv] = b[i - 1]; b[i - 1] = tb;
      }
      for (let r = i; r < n; r++) {
        const f = A[r][i - 1] / A[i - 1][i - 1];
        if (!f) continue;
        for (let c = i - 1; c < n; c++) A[r][c] -= f * A[i - 1][c];
        b[r] -= f * b[i - 1];
      }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      if (Math.abs(A[i][i]) < 1e-12) return null;
      x[i] = s / A[i][i];
    }
    return x;
  }

  /** 由 4 組對應點求 homography（from -> to），回傳 8 個係數 */
  CV.homography = function (from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = from[i].x, y = from[i].y;
      const u = to[i].x, v = to[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solveLinear(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
  };

  CV.applyH = function (H, x, y) {
    const den = H[6] * x + H[7] * y + 1;
    if (Math.abs(den) < 1e-9) return null;
    return {
      x: (H[0] * x + H[1] * y + H[2]) / den,
      y: (H[3] * x + H[4] * y + H[5]) / den
    };
  };

  /* ---------------- 透視變換（雙線性重採樣） ---------------- */

  /**
   * @param {HTMLCanvasElement} src
   * @param {Array<{x,y}>} quadNorm 正規化四角 TL,TR,BR,BL
   * @param {number} maxDim 輸出最長邊上限
   */
  CV.warp = function (src, quadNorm, maxDim) {
    const SW = src.width, SH = src.height;
    const quad = quadNorm.map(function (p) {
      return { x: p.x * SW, y: p.y * SH };
    });

    const wTop = CV.dist(quad[0], quad[1]);
    const wBot = CV.dist(quad[3], quad[2]);
    const hLft = CV.dist(quad[0], quad[3]);
    const hRgt = CV.dist(quad[1], quad[2]);

    let ow = Math.max(wTop, wBot);
    let oh = Math.max(hLft, hRgt);
    if (!isFinite(ow) || !isFinite(oh) || ow < 4 || oh < 4) return CV.clone(src);

    const scale = Math.min(1, (maxDim || 2400) / Math.max(ow, oh));
    ow = Math.max(24, Math.round(ow * scale));
    oh = Math.max(24, Math.round(oh * scale));

    const dst = [
      { x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }
    ];
    const H = CV.homography(dst, quad);
    if (!H) return CV.clone(src);

    const srcData = CV.getPixels(src).data;
    const out = CV.makeCanvas(ow, oh);
    const outCtx = CV.ctx(out);
    const img = outCtx.createImageData(ow, oh);
    const d = img.data;

    for (let y = 0; y < oh; y++) {
      const Y = y + 0.5;
      for (let x = 0; x < ow; x++) {
        const X = x + 0.5;
        const den = H[6] * X + H[7] * Y + 1;
        const sx = (H[0] * X + H[1] * Y + H[2]) / den;
        const sy = (H[3] * X + H[4] * Y + H[5]) / den;
        const o = (y * ow + x) * 4;

        if (sx < 0 || sy < 0 || sx > SW - 1 || sy > SH - 1) {
          d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255;
          continue;
        }
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = x0 < SW - 1 ? x0 + 1 : x0;
        const y1 = y0 < SH - 1 ? y0 + 1 : y0;
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * SW + x0) * 4, i10 = (y0 * SW + x1) * 4;
        const i01 = (y1 * SW + x0) * 4, i11 = (y1 * SW + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy, w11 = fx * fy;

        for (let ch = 0; ch < 3; ch++) {
          d[o + ch] = srcData[i00 + ch] * w00 + srcData[i10 + ch] * w10 +
            srcData[i01 + ch] * w01 + srcData[i11 + ch] * w11;
        }
        d[o + 3] = 255;
      }
    }
    outCtx.putImageData(img, 0, 0);
    return out;
  };

  /* ---------------- 旋轉 ---------------- */

  /** 90 度倍數旋轉（正數 = 順時針） */
  CV.rotate90 = function (src, deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d === 0) return CV.clone(src);
    const w = src.width, h = src.height;
    const swap = d === 90 || d === 270;
    const out = CV.makeCanvas(swap ? h : w, swap ? w : h);
    const ctx = CV.ctx(out);
    ctx.save();
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(d * Math.PI / 180);
    ctx.drawImage(src, -w / 2, -h / 2);
    ctx.restore();
    return out;
  };

  /** 任意角度旋轉（白底、自動擴張畫布） */
  CV.rotateFree = function (src, deg) {
    if (!deg) return CV.clone(src);
    const rad = deg * Math.PI / 180;
    const w = src.width, h = src.height;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const ow = Math.round(w * cos + h * sin);
    const oh = Math.round(w * sin + h * cos);
    const out = CV.makeCanvas(ow, oh);
    const ctx = CV.ctx(out);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, ow, oh);
    ctx.translate(ow / 2, oh / 2);
    ctx.rotate(rad);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -w / 2, -h / 2);
    return out;
  };

  /* ---------------- 曲面展平（水平非線性重映射） ---------------- */

  /**
   * @param {number} k -1..1，正數 = 左側被壓縮的內容向外拉伸
   */
  CV.unbend = function (src, k) {
    if (!k) return CV.clone(src);
    const w = src.width, h = src.height;
    const srcData = CV.getPixels(src).data;
    const out = CV.makeCanvas(w, h);
    const outCtx = CV.ctx(out);
    const img = outCtx.createImageData(w, h);
    const d = img.data;
    const exp = 1 + k * 0.9;

    // 預先算好每個目標 x 對應的來源 x
    const mapX = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      mapX[x] = Math.pow(t, exp) * (w - 1);
    }

    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const sx = mapX[x];
        const x0 = sx | 0;
        const x1 = x0 < w - 1 ? x0 + 1 : x0;
        const fx = sx - x0;
        const i0 = row + x0 * 4, i1 = row + x1 * 4;
        const o = row + x * 4;
        d[o] = srcData[i0] * (1 - fx) + srcData[i1] * fx;
        d[o + 1] = srcData[i0 + 1] * (1 - fx) + srcData[i1 + 1] * fx;
        d[o + 2] = srcData[i0 + 2] * (1 - fx) + srcData[i1 + 2] * fx;
        d[o + 3] = 255;
      }
    }
    outCtx.putImageData(img, 0, 0);
    return out;
  };

  /* ---------------- 修補：金字塔擴散填補 ---------------- */

  /**
   * @param {HTMLCanvasElement} src
   * @param {Uint8Array} mask 長度 w*h，1 = 要填補
   */
  CV.inpaint = function (src, mask) {
    const w = src.width, h = src.height;
    const data = CV.getPixels(src).data;

    // 建立金字塔
    const levels = [];
    let cw = w, ch = h;
    let r = new Float32Array(w * h);
    let g = new Float32Array(w * h);
    let b = new Float32Array(w * h);
    let a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const known = mask[i] ? 0 : 1;
      const o = i * 4;
      r[i] = data[o] * known; g[i] = data[o + 1] * known; b[i] = data[o + 2] * known;
      a[i] = known;
    }
    levels.push({ r: r, g: g, b: b, w: a, cw: cw, ch: ch });

    while (cw > 2 && ch > 2) {
      const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
      const pr = new Float32Array(nw * nh), pg = new Float32Array(nw * nh);
      const pb = new Float32Array(nw * nh), pa = new Float32Array(nw * nh);
      const L = levels[levels.length - 1];
      for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
          const x0 = x * 2, y0 = y * 2;
          let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
          for (let dy = 0; dy < 2; dy++) {
            const yy = y0 + dy; if (yy >= L.ch) continue;
            for (let dx = 0; dx < 2; dx++) {
              const xx = x0 + dx; if (xx >= L.cw) continue;
              const i = yy * L.cw + xx;
              sr += L.r[i]; sg += L.g[i]; sb += L.b[i]; sa += L.w[i];
              cnt++;
            }
          }
          const i = y * nw + x;
          pr[i] = sr / cnt; pg[i] = sg / cnt; pb[i] = sb / cnt; pa[i] = sa / cnt;
        }
      }
      levels.push({ r: pr, g: pg, b: pb, w: pa, cw: nw, ch: nh });
      cw = nw; ch = nh;
    }

    // 由上而下補值
    for (let l = levels.length - 2; l >= 0; l--) {
      const cur = levels[l], up = levels[l + 1];
      for (let y = 0; y < cur.ch; y++) {
        for (let x = 0; x < cur.cw; x++) {
          const i = y * cur.cw + x;
          if (cur.w[i] > 1e-4) continue;
          const ux = Math.min(up.cw - 1, Math.floor(x / 2));
          const uy = Math.min(up.ch - 1, Math.floor(y / 2));
          const j = uy * up.cw + ux;
          if (up.w[j] > 1e-4) {
            cur.r[i] = up.r[j] / up.w[j];
            cur.g[i] = up.g[j] / up.w[j];
            cur.b[i] = up.b[j] / up.w[j];
            cur.w[i] = 1;
          }
        }
      }
    }

    const base = levels[0];
    const N = w * h;
    const fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (base.w[i] > 1e-4) {
        fr[i] = base.r[i] / base.w[i];
        fg[i] = base.g[i] / base.w[i];
        fb[i] = base.b[i] / base.w[i];
      } else {
        fr[i] = fg[i] = fb[i] = 255;
      }
    }

    // 與周圍紙張色對齊（文件掃描時填補結果應接近紙白）
    let fillN = 0, fillSum = 0, ringN = 0, ringSum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (mask[i]) {
          fillSum += 0.299 * fr[i] + 0.587 * fg[i] + 0.114 * fb[i];
          fillN++;
          continue;
        }
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (mask[yy * w + xx]) { near = true; break; }
          }
        }
        if (near) {
          ringSum += 0.299 * fr[i] + 0.587 * fg[i] + 0.114 * fb[i];
          ringN++;
        }
      }
    }

    let gain = 1;
    if (fillN > 0 && ringN > 0) {
      const fillMean = fillSum / fillN;
      const ringMean = ringSum / ringN;
      if (ringMean > 165 && fillMean > 10) {
        gain = Math.min(1.55, Math.max(0.8, ringMean / fillMean));
      }
    }

    const out = CV.makeCanvas(w, h);
    const outCtx = CV.ctx(out);
    const img = outCtx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const g = mask[i] ? gain : 1;
      d[o] = fr[i] * g;
      d[o + 1] = fg[i] * g;
      d[o + 2] = fb[i] * g;
      d[o + 3] = 255;
    }
    outCtx.putImageData(img, 0, 0);
    return out;
  };

  /* ---------------- 邊框修剪 ---------------- */

  /**
   * 若畫面外緣殘留桌面背景（明顯異於紙張顏色），自動修掉細邊
   * 需要「從邊緣連續」且寬度 < 1.2%，避免修掉文件本身的深色標題列
   */
  CV.trimBorders = function (canvas) {
    const w = canvas.width, h = canvas.height;
    const data = CV.getPixels(canvas).data;
    const lumAt = function (x, y) {
      const p = (y * w + x) * 4;
      return 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    };

    // 中央區域亮度中位數
    const hist = new Uint32Array(256);
    let cnt = 0;
    const x0 = (w * 0.25) | 0, x1 = (w * 0.75) | 0;
    const y0 = (h * 0.25) | 0, y1 = (h * 0.75) | 0;
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) {
        hist[lumAt(x, y) | 0]++;
        cnt++;
      }
    }
    if (!cnt) return canvas;
    let acc = 0, med = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cnt / 2) { med = v; break; } }

    const maxBand = Math.max(2, Math.round(Math.min(w, h) * 0.012));
    const TH = 55;

    function lineMean(side, k) {
      let sum = 0, n = 0;
      if (side === 'l' || side === 'r') {
        const x = side === 'l' ? k : w - 1 - k;
        for (let y = (h * 0.15) | 0; y < (h * 0.85) | 0; y += 2) { sum += lumAt(x, y); n++; }
      } else {
        const y = side === 't' ? k : h - 1 - k;
        for (let x = (w * 0.15) | 0; x < (w * 0.85) | 0; x += 2) { sum += lumAt(x, y); n++; }
      }
      return n ? sum / n : med;
    }

    function band(side) {
      let k = 0;
      while (k < maxBand) {
        const m = lineMean(side, k);
        if (Math.abs(m - med) < TH) break;
        k++;
      }
      // 一直延伸到上限 → 視為內容（例如滿版深色標題）
      return k >= maxBand ? 0 : k;
    }

    const left = band('l'), right = band('r');
    const top = band('t'), bottom = band('b');
    if (!left && !right && !top && !bottom) return canvas;

    const nw = w - left - right, nh = h - top - bottom;
    if (nw < 40 || nh < 40) return canvas;

    const out = CV.makeCanvas(nw, nh);
    const ctx = CV.ctx(out);
    ctx.drawImage(canvas, left, top, nw, nh, 0, 0, nw, nh);
    return out;
  };

  /* ---------------- 由筆畫產生遮罩 ---------------- */

  CV.maskFromStrokes = function (w, h, strokes) {
    const c = CV.makeCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.lineWidth = Math.max(2, s.r * w);
      ctx.beginPath();
      const pts = s.points;
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x * w + 0.1, pts[0].y * h);
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * w, pts[i].y * h);
      }
      ctx.stroke();
    }
    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 127 ? 1 : 0;
    return mask;
  };

  CV.__debug = { dilate: dilate, topComponents: topComponents, quadFromComponent: quadFromComponent, scoreQuad: scoreQuad, percentileOf: percentileOf };

  global.CV = CV;
})(window);
