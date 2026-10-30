/* =========================================================
 * pdf.js — 極簡 PDF 產生器
 * 把 JPEG 位元流以 /DCTDecode 直接內嵌為影像 XObject
 * 自行組裝物件樹與 xref 表，不依賴任何第三方函式庫
 * ========================================================= */
(function (global) {
  'use strict';

  const PDF = {};

  const SIZES = {
    a4: [595.28, 841.89],
    letter: [612, 792]
  };

  function num(v) {
    return (Math.round(v * 100) / 100).toString();
  }

  /**
   * @param {Array<{data:Uint8Array,w:number,h:number}>} items JPEG 位元與尺寸
   * @param {{pageSize?:string, margin?:number}} opts
   * @returns {Blob}
   */
  PDF.build = function (items, opts) {
    opts = opts || {};
    const margin = opts.margin || 0;
    const enc = new TextEncoder();
    const parts = [];
    let len = 0;
    const offsets = {};

    function put(x) {
      const b = typeof x === 'string' ? enc.encode(x) : x;
      parts.push(b);
      len += b.length;
    }
    function objStart(n) { offsets[n] = len; put(n + ' 0 obj\n'); }
    function objEnd() { put('endobj\n'); }

    put('%PDF-1.4\n');
    put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // 二進位標記

    // 版面計算
    const layouts = items.map(function (it) {
      let pw, ph;
      if (opts.pageSize === 'auto') {
        pw = SIZES.a4[0];
        ph = pw * (it.h / it.w);
      } else {
        const s = SIZES[opts.pageSize] || SIZES.a4;
        pw = s[0]; ph = s[1];
        // 依影像方向自動轉向
        if (it.w > it.h && ph > pw) { const t = pw; pw = ph; ph = t; }
      }
      const cw = Math.max(10, pw - margin * 2);
      const ch = Math.max(10, ph - margin * 2);
      const scale = Math.min(cw / it.w, ch / it.h);
      const dw = it.w * scale, dh = it.h * scale;
      return {
        pw: pw, ph: ph, dw: dw, dh: dh,
        x: (pw - dw) / 2, y: (ph - dh) / 2
      };
    });

    const total = items.length;
    const PAGE_BASE = 4;                 // 1 catalog, 2 pages, 3 info
    const ids = items.map(function (_, i) {
      const p = PAGE_BASE + i * 3;
      return { page: p, content: p + 1, image: p + 2 };
    });

    // 1. Catalog
    objStart(1);
    put('<< /Type /Catalog /Pages 2 0 R >>\n');
    objEnd();

    // 2. Pages
    objStart(2);
    put('<< /Type /Pages /Count ' + total + ' /Kids [' +
      ids.map(function (o) { return o.page + ' 0 R'; }).join(' ') + '] >>\n');
    objEnd();

    // 3. Info
    objStart(3);
    put('<< /Producer (ScanPro) /Creator (ScanPro Web Scanner) >>\n');
    objEnd();

    // 每頁
    for (let i = 0; i < total; i++) {
      const it = items[i], L = layouts[i], id = ids[i];

      const content = 'q\n' + num(L.dw) + ' 0 0 ' + num(L.dh) + ' ' +
        num(L.x) + ' ' + num(L.y) + ' cm\n/Im0 Do\nQ\n';
      const contentBytes = enc.encode(content);

      // 頁面物件
      objStart(id.page);
      put('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(L.pw) + ' ' + num(L.ph) + ']\n' +
        '/Resources << /XObject << /Im0 ' + id.image + ' 0 R >> /ProcSet [/PDF /ImageC] >>\n' +
        '/Contents ' + id.content + ' 0 R >>\n');
      objEnd();

      // 內容流
      objStart(id.content);
      put('<< /Length ' + contentBytes.length + ' >>\nstream\n');
      put(contentBytes);
      put('\nendstream\n');
      objEnd();

      // 影像 XObject
      objStart(id.image);
      put('<< /Type /XObject /Subtype /Image /Width ' + it.w + ' /Height ' + it.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        it.data.length + ' >>\nstream\n');
      put(it.data);
      put('\nendstream\n');
      objEnd();
    }

    // xref
    const count = 3 + total * 3;
    const xrefStart = len;
    let xref = 'xref\n0 ' + (count + 1) + '\n';
    xref += '0000000000 65535 f \n';
    for (let n = 1; n <= count; n++) {
      xref += String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n';
    }
    put(xref);

    put('trailer\n<< /Size ' + (count + 1) + ' /Root 1 0 R /Info 3 0 R >>\n' +
      'startxref\n' + xrefStart + '\n%%EOF\n');

    return new Blob(parts, { type: 'application/pdf' });
  };

  global.PDF = PDF;
})(window);
