/*!
 * opt-topdf.js — OptPdfEditor 共通モジュール
 * 画像／テキストを pdf-lib の PDFDocument にページとして追加する処理をまとめたもの。
 * 依存: lib/pdf-lib.min.js, lib/fontkit.umd.min.js（テキストを使う場合のみ）
 *       lib/font-bizudgothic.js, lib/hb-subset-wasm.js（必要になったときだけ動的に読み込む）
 * 使い方: window.OptToPdf
 */
(() => {
  const { PDFDocument, degrees, PDFHexString, pushGraphicsState, popGraphicsState,
          concatTransformationMatrix, drawObject } = PDFLib;

  // このスクリプト自身の場所から lib/ の位置を割り出す（HTMLがどこにあっても動くように）
  const LIB_BASE = (() => {
    const s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/[^/]*$/, '') : 'lib/';
  })();

  const IMG_EXT = /\.(jpe?g|png|webp)$/i;
  const TXT_EXT = /\.(txt|md|csv|log)$/i;
  const PDF_EXT = /\.pdf$/i;
  const PX_TO_PT = 0.75;          // 96dpi 換算（1px = 0.75pt）
  const MAX_PT = 14400;           // PDFのページ寸法上限
  const TEXT = { pageW: 595.28, pageH: 841.89, margin: 48, size: 10.5, lead: 1.6, tab: 4 };

  // ---- 文字コード判定（UTF-8 → だめなら Shift_JIS）----
  function decodeBytes(bytes) {
    let b = bytes;
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    else if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    else if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
    catch { return new TextDecoder('shift_jis').decode(b); }
  }

  // ---- JPEG の EXIF 向き ----
  function jpegOrientation(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint16(0) !== 0xFFD8) return 1;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off); const len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {
        const t = off + 10; const le = v.getUint16(t) === 0x4949;
        const ifd = t + v.getUint32(t + 4, le); const n = v.getUint16(ifd, le);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
        }
        return 1;
      }
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      off += 2 + len;
    }
    return 1;
  }

  // canvas 経由で向きを反映して再エンコード（反転を含む向き・読めない PNG 用）
  async function normalizeViaCanvas(bytes, mime, forceMime) {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const outMime = forceMime || (mime === 'image/png' ? 'image/png' : 'image/jpeg');
    const blob = await new Promise(r => c.toBlob(r, outMime, 0.95));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: outMime };
  }

  // WebP の種類を判定（可逆圧縮か・透過ありか）
  function webpInfo(b) {
    const tag = off => String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const info = { lossless: false, alpha: false };
    if (b.length < 30 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return info;
    let off = 12;
    while (off + 8 <= b.length) {
      const t = tag(off), size = b[off + 4] | (b[off + 5] << 8) | (b[off + 6] << 16) | (b[off + 7] << 24);
      if (t === 'VP8X') info.alpha = !!(b[off + 8] & 0x10);
      if (t === 'VP8L') { info.lossless = true; if (b[off + 12] & 0x10) info.alpha = true; }
      if (t === 'ALPH') info.alpha = true;
      off += 8 + size + (size & 1);
    }
    return info;
  }

  function fitPage(wPx, hPx) {
    let w = wPx * PX_TO_PT, h = hPx * PX_TO_PT;
    const k = Math.min(1, MAX_PT / Math.max(w, h));
    return { w: w * k, h: h * k };
  }

  // ---- PNG をなるべく元の圧縮のまま埋め込む ----
  // pdf-lib の embedPng は PNG を展開して予測フィルタなしで再圧縮するため、元より大きくなる。
  // 透過なし PNG は圧縮データ（IDAT）をそのまま、透過あり PNG は色と透過を分けて
  // PNG と同じ予測フィルタ付きで再圧縮して埋め込む。
  function parsePng(b) {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 8, ihdr = null, plte = null, trns = false, total = 0;
    const idat = [];
    while (off + 8 <= b.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      const data = b.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') ihdr = { width: dv.getUint32(off + 8), height: dv.getUint32(off + 12), bitDepth: b[off + 16], colorType: b[off + 17], interlace: b[off + 20] };
      else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = true;
      else if (type === 'IDAT') { idat.push(data); total += data.length; }
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!ihdr || !idat.length) return null;
    const all = new Uint8Array(total); let p = 0;
    for (const d of idat) { all.set(d, p); p += d.length; }
    return { ...ihdr, plte, trns, idat: all };
  }

  const pipeBytes = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  function pngUnfilter(data, h, rowLen, bpp) {
    const out = new Uint8Array(rowLen * h);
    let prev = new Uint8Array(rowLen);
    for (let y = 0; y < h; y++) {
      const base = y * (rowLen + 1), ft = data[base];
      const cur = out.subarray(y * rowLen, (y + 1) * rowLen);
      for (let x = 0; x < rowLen; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v = data[base + 1 + x];
        if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1; else if (ft === 4) v += paeth(a, b, c);
        cur[x] = v;
      }
      prev = cur;
    }
    return out;
  }

  function pngFilter(raw, h, rowLen, bpp) {
    const out = new Uint8Array((rowLen + 1) * h);
    const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowLen));
    let prev = new Uint8Array(rowLen);
    for (let y = 0; y < h; y++) {
      const cur = raw.subarray(y * rowLen, (y + 1) * rowLen);
      for (let x = 0; x < rowLen; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = cur[x];
        cand[0][x] = v; cand[1][x] = v - a; cand[2][x] = v - b; cand[3][x] = v - ((a + b) >> 1); cand[4][x] = v - paeth(a, b, c);
      }
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        let s = 0; const cf = cand[f];
        for (let x = 0; x < rowLen && s < bestSum; x++) s += cf[x] < 128 ? cf[x] : 256 - cf[x];
        if (s < bestSum) { bestSum = s; best = f; }
      }
      out[y * (rowLen + 1)] = best;
      out.set(cand[best], y * (rowLen + 1) + 1);
      prev = cur;
    }
    return out;
  }

  async function embedPngCompact(pdf, bytes) {
    const png = parsePng(bytes);
    if (!png || png.interlace !== 0) return null;
    const { width: w, height: h, bitDepth: bd, colorType: ct } = png;
    const ctx = pdf.context;
    const image = (data, colors, cs, extra = {}, bpc = bd) => ctx.register(ctx.stream(data, {
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: cs, BitsPerComponent: bpc,
      Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: bpc, Columns: w }, ...extra,
    }));

    // 透過なし・8bit以下：圧縮データをそのまま使う
    if ((ct === 0 || ct === 2 || ct === 3) && !png.trns && bd <= 8) {
      if (ct === 3) {
        if (!png.plte) return null;
        const hex = [...png.plte].map(v => v.toString(16).padStart(2, '0')).join('');
        const cs = ['Indexed', 'DeviceRGB', png.plte.length / 3 - 1, PDFHexString.of(hex)];
        return { ref: image(png.idat, 1, cs), width: w, height: h };
      }
      return { ref: image(png.idat, ct === 0 ? 1 : 3, ct === 0 ? 'DeviceGray' : 'DeviceRGB'), width: w, height: h };
    }

    // 透過あり、または 16bit：展開して 8bit の色と透過に分け、予測フィルタ付きで再圧縮
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
    if (channels && !png.trns && (bd === 8 || bd === 16)) {
      const bps = bd / 8, hasAlpha = ct === 4 || ct === 6, cch = hasAlpha ? channels - 1 : channels;
      const raw = pngUnfilter(await pipeBytes(png.idat, new DecompressionStream('deflate')), h, w * channels * bps, channels * bps);
      const color = new Uint8Array(w * h * cch), alpha = hasAlpha ? new Uint8Array(w * h) : null;
      let opaque = true;
      for (let i = 0, ci = 0, ai = 0; i < raw.length; ) {
        for (let k = 0; k < cch; k++) { color[ci++] = raw[i]; i += bps; }   // 16bit は上位バイトを使う
        if (hasAlpha) { const v = raw[i]; i += bps; alpha[ai++] = v; if (v !== 255) opaque = false; }
      }
      const pack = async (buf, ch) => pipeBytes(pngFilter(buf, h, w * ch, ch), new CompressionStream('deflate'));
      const cs = cch === 1 ? 'DeviceGray' : 'DeviceRGB';
      const extra = hasAlpha && !opaque ? { SMask: image(await pack(alpha, 1), 1, 'DeviceGray', {}, 8) } : {};
      return { ref: image(await pack(color, cch), cch, cs, extra, 8), width: w, height: h };
    }
    return null; // それ以外（インターレース・透明色指定など）は pdf-lib 標準の方式に任せる
  }

  function drawCompactImagePage(pdf, x) {
    const { w, h } = fitPage(x.width, x.height);
    const page = pdf.addPage([w, h]);
    const name = page.node.newXObject('Image', x.ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject(name), popGraphicsState());
  }

  // 画像1枚を1ページとして追加する。path は拡張子の判定にのみ使う。
  async function addImagePage(pdf, bytes, path) {
    // PNG（と可逆・透過あり WebP）は、サイズが膨らまない方式を先に試す
    let pngBytes = /\.png$/i.test(path) ? bytes : null;
    if (/\.webp$/i.test(path)) {
      const info = webpInfo(bytes);
      if (info.lossless || info.alpha) { try { pngBytes = (await normalizeViaCanvas(bytes, 'image/webp', 'image/png')).bytes; } catch {} }
    }
    if (pngBytes) {
      let compact = null;
      try { compact = await embedPngCompact(pdf, pngBytes); } catch {}
      if (compact) { drawCompactImagePage(pdf, compact); return 1; }
    }

    const isJpg = /\.jpe?g$/i.test(path);
    let orient = isJpg ? jpegOrientation(bytes) : 1;
    let img;
    try {
      if (/\.webp$/i.test(path)) {
        // PDF は WebP を直接扱えないため変換する（可逆・透過あり → PNG、それ以外 → JPEG）
        const info = webpInfo(bytes);
        const n = await normalizeViaCanvas(bytes, 'image/webp', info.lossless || info.alpha ? 'image/png' : 'image/jpeg');
        img = n.mime === 'image/png' ? await pdf.embedPng(n.bytes) : await pdf.embedJpg(n.bytes);
      } else if ([2, 4, 5, 7].includes(orient)) {
        const n = await normalizeViaCanvas(bytes, 'image/jpeg');
        img = await pdf.embedJpg(n.bytes); orient = 1;
      } else {
        img = isJpg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
      }
    } catch {
      const n = await normalizeViaCanvas(bytes, isJpg ? 'image/jpeg' : 'image/png');
      img = n.mime === 'image/png' ? await pdf.embedPng(n.bytes) : await pdf.embedJpg(n.bytes);
      orient = 1;
    }
    const { w, h } = fitPage(img.width, img.height);
    if (orient === 6 || orient === 8) {
      const page = pdf.addPage([h, w]);
      if (orient === 6) page.drawImage(img, { x: 0, y: w, width: w, height: h, rotate: degrees(-90) });
      else page.drawImage(img, { x: h, y: 0, width: w, height: h, rotate: degrees(90) });
    } else if (orient === 3) {
      const page = pdf.addPage([w, h]);
      page.drawImage(img, { x: w, y: h, width: w, height: h, rotate: degrees(180) });
    } else {
      const page = pdf.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    return 1;
  }

  // ---- 日本語フォント（必要になったときだけ読み込む）----
  // pdf-lib 標準のサブセット化は日本語フォントで字が欠けるため、harfbuzz でサブセット化してから埋め込む
  const loaded = {};
  function loadB64Script(src, globalName) {
    if (loaded[globalName]) return Promise.resolve(loaded[globalName]);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => {
        const bin = atob(window[globalName]);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        delete window[globalName];
        loaded[globalName] = u; resolve(u);
      };
      s.onerror = () => reject(new Error(`${src} を読み込めません`));
      document.head.appendChild(s);
    });
  }

  let hb = null;
  async function subsetFont(text) {
    const fontBytes = await loadB64Script(LIB_BASE + 'font-bizudgothic.js', 'OPT_FONT_BIZUDGOTHIC');
    if (!hb) {
      const wasm = await loadB64Script(LIB_BASE + 'hb-subset-wasm.js', 'OPT_HB_SUBSET_WASM');
      hb = (await WebAssembly.instantiate(wasm, {})).instance.exports;
    }
    const ptr = hb.malloc(fontBytes.byteLength);
    new Uint8Array(hb.memory.buffer).set(fontBytes, ptr);
    const blob = hb.hb_blob_create(ptr, fontBytes.byteLength, 2, 0, 0);
    const face = hb.hb_face_create(blob, 0);
    hb.hb_blob_destroy(blob);
    const input = hb.hb_subset_input_create_or_fail();
    const uset = hb.hb_subset_input_unicode_set(input);
    for (const ch of new Set(text + '□ ')) hb.hb_set_add(uset, ch.codePointAt(0));
    const sub = hb.hb_subset_or_fail(face, input);
    hb.hb_subset_input_destroy(input);
    if (!sub) { hb.hb_face_destroy(face); hb.free(ptr); throw new Error('フォントのサブセット化に失敗しました'); }
    const res = hb.hb_face_reference_blob(sub);
    const off = hb.hb_blob_get_data(res, 0), len = hb.hb_blob_get_length(res);
    const out = new Uint8Array(hb.memory.buffer).slice(off, off + len);
    hb.hb_blob_destroy(res); hb.hb_face_destroy(sub); hb.hb_face_destroy(face); hb.free(ptr);
    return out;
  }

  // すべてのテキストで使う文字を集めてから1回だけ呼ぶこと（subset の対象を確定させるため）
  async function embedTextFont(pdf, allText) {
    if (typeof fontkit === 'undefined') throw new Error('fontkit.umd.min.js が読み込まれていません');
    pdf.registerFontkit(fontkit);
    return pdf.embedFont(await subsetFont(allText.replace(/\t/g, ' ')), { subset: false });
  }

  // テキストを行に折り返す（ページ数の見積もりにも使う）
  function layoutText(font, text, opt = {}) {
    const { pageW, pageH, margin, size, lead, tab } = { ...TEXT, ...opt };
    const maxW = pageW - margin * 2;
    const lineH = size * lead;
    const supported = new Set(font.getCharacterSet());
    const clean = [...text.replace(/\r\n?/g, '\n').replace(/\t/g, ' '.repeat(tab))]
      .map(ch => ch === '\n' || supported.has(ch.codePointAt(0)) ? ch : '□').join('');

    // 1文字ずつ幅を測って折り返す
    const lines = [];
    for (const para of clean.split('\n')) {
      if (para === '') { lines.push(''); continue; }
      let line = '', w = 0;
      for (const ch of para) {
        const cw = font.widthOfTextAtSize(ch, size);
        if (w + cw > maxW && line) { lines.push(line); line = ''; w = 0; }
        line += ch; w += cw;
      }
      lines.push(line);
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) lines.push('');
    const perPage = Math.floor((pageH - margin * 2) / lineH);
    return { lines, perPage, pages: Math.ceil(lines.length / perPage), lineH, size, margin, pageW, pageH };
  }

  // テキストをページとして追加し、追加したページ数を返す
  function addTextPages(pdf, font, text, opt = {}) {
    const L = layoutText(font, text, opt);
    for (let i = 0; i < L.lines.length; i += L.perPage) {
      const page = pdf.addPage([L.pageW, L.pageH]);
      L.lines.slice(i, i + L.perPage).forEach((ln, j) => {
        if (ln) page.drawText(ln, { x: L.margin, y: L.pageH - L.margin - L.size - j * L.lineH, size: L.size, font });
      });
    }
    return L.pages;
  }

  window.OptToPdf = {
    IMG_EXT, TXT_EXT, PDF_EXT, TEXT, LIB_BASE,
    decodeBytes, addImagePage, embedTextFont, layoutText, addTextPages,
    // 下位の道具（必要なら個別に使える）
    jpegOrientation, normalizeViaCanvas, webpInfo, fitPage, embedPngCompact, subsetFont,
  };
})();
