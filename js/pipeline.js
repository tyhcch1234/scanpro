/* =========================================================
 * pipeline.js — 單頁掃描處理管線
 * 幾何校正 → 修補 → 色彩最佳化
 * ========================================================= */
(function (global) {
  'use strict';

  const CV = global.CV;
  const Filters = global.Filters;

  const Pipeline = {};

  Pipeline.MAX_DIM = 2200;   // 輸出/匯出的最長邊上限
  Pipeline.PREVIEW_DIM = 1100;
  Pipeline.THUMB_DIM = 420;

  /** 預設設定（幾何 + 色彩） */
  Pipeline.defaultSettings = function () {
    return Object.assign({ rotate: 0, fine: 0, bend: 0 }, Filters.DEFAULTS);
  };

  Pipeline.fullQuad = function () {
    return [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }
    ];
  };

  /** 載入圖片（保留 EXIF 方向） */
  Pipeline.loadImage = function (blob) {
    return new Promise(function (resolve, reject) {
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(blob, { imageOrientation: 'from-image' })
          .then(resolve)
          .catch(function () { fallback(); });
      } else {
        fallback();
      }

      function fallback() {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = function () {
          const out = {
            width: img.naturalWidth,
            height: img.naturalHeight,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            __img: img,
            close: function () { URL.revokeObjectURL(url); }
          };
          resolve(out);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('無法讀取這個圖片檔'));
        };
        img.src = url;
      }
    });
  };

  /** 解碼成受限尺寸的 canvas */
  Pipeline.decode = async function (blob, maxDim) {
    const bmp = await Pipeline.loadImage(blob);
    const c = CV.drawTo(bmp.__img || bmp, maxDim || Pipeline.MAX_DIM);
    if (bmp.close) bmp.close();
    return c;
  };

  /** 偵測邊界，回傳正規化四角（失敗回傳 null） */
  Pipeline.detect = function (srcCanvas) {
    const coarse = CV.detectQuad(srcCanvas);
    if (!coarse) return null;
    try {
      return CV.refineQuad(srcCanvas, coarse);
    } catch (e) {
      return coarse;
    }
  };

  /**
   * 完整渲染一頁
   * @param {HTMLCanvasElement} srcCanvas 原始相片（已縮放）
   * @param {object} page { quad, settings, strokes }
   * @param {number} maxDim
   */
  Pipeline.render = function (srcCanvas, page, maxDim) {
    const s = page.settings || {};
    const quad = page.quad || Pipeline.fullQuad();
    let c = CV.warp(srcCanvas, quad, maxDim || Pipeline.MAX_DIM);
    c = CV.trimBorders(c);

    const rot = (((s.rotate || 0) % 360) + 360) % 360;
    if (rot) c = CV.rotate90(c, rot);
    if (s.fine) c = CV.rotateFree(c, s.fine);
    if (s.bend) c = CV.unbend(c, s.bend / 100);

    if (page.strokes && page.strokes.length) {
      const mask = CV.maskFromStrokes(c.width, c.height, page.strokes);
      c = CV.inpaint(c, mask);
    }

    return Filters.apply(c, s);
  };

  /** 產生縮圖 dataURL */
  Pipeline.thumb = function (canvas, maxDim) {
    const t = CV.drawTo(canvas, maxDim || Pipeline.THUMB_DIM);
    return t.toDataURL('image/jpeg', 0.72);
  };

  global.Pipeline = Pipeline;
})(window);
