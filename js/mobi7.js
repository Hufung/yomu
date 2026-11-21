/* Yomu — MOBI (Mobipocket 7) reader, written from scratch.
 *
 * Why not the packaged parser: it slices the first record at a literal
 * "<body>" and indexes match()[1] on <img> tags that have no recindex, so a
 * combo MOBI/KF8 file (which is what Calibre and KindleGen produce) throws
 * before it returns a single chapter. The format itself is small:
 *
 *   PDB header → record offsets → record 0 = PalmDOC header + MOBI header
 *   + EXTH block → text records (PalmDOC LZ77) → image records at
 *   firstImageIndex → HTML with <mbp:pagebreak> chapter breaks.
 *
 * Everything here is synchronous except image decoding, which is lazy.
 */
(function () {
  'use strict';

  const PALMDOC = 2;
  const HUFF = 17480;

  const MIME_BY_MAGIC = [
    [[0xFF, 0xD8, 0xFF], 'image/jpeg'],
    [[0x89, 0x50, 0x4E, 0x47], 'image/png'],
    [[0x47, 0x49, 0x46], 'image/gif'],
    [[0x42, 0x4D], 'image/bmp'],
    [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
  ];

  function sniffMime(bytes) {
    for (const [magic, mime] of MIME_BY_MAGIC) {
      if (magic.every((b, i) => bytes[i] === b)) return mime;
    }
    return 'application/octet-stream';
  }

  /* ── PalmDOC LZ77 ──────────────────────────────────────────────── */
  function decompressPalmDOC(input, expected) {
    const out = new Uint8Array(Math.max(expected || input.length * 4, 1024));
    let o = 0;
    const ensure = (need) => {
      if (o + need <= out.length) return true;
      return false;
    };
    let grown = out;
    let i = 0;
    const push = (b) => {
      if (o >= grown.length) {
        const bigger = new Uint8Array(grown.length * 2);
        bigger.set(grown);
        grown = bigger;
      }
      grown[o++] = b;
    };
    while (i < input.length) {
      const c = input[i++];
      if (c === 0x00) { push(0); continue; }
      if (c >= 0x01 && c <= 0x08) {
        for (let k = 0; k < c && i < input.length; k++) push(input[i++]);
        continue;
      }
      if (c <= 0x7F) { push(c); continue; }
      if (c >= 0xC0) { push(0x20); push(c ^ 0x80); continue; }
      // 0x80..0xBF: 2-byte LZ77 back reference
      if (i >= input.length) break;
      const pair = (c << 8) | input[i++];
      const dist = (pair >> 3) & 0x7FF;
      const len = (pair & 0x07) + 3;
      for (let k = 0; k < len; k++) {
        const from = o - dist;
        push(from >= 0 ? grown[from] : 0);
      }
    }
    void ensure;
    return grown.slice(0, o);
  }

  /* ── record helpers ────────────────────────────────────────────── */
  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  function decodeText(bytes, encoding) {
    let label = 'utf-8';
    if (encoding === 1252) label = 'windows-1252';
    else if (encoding === 65001) label = 'utf-8';
    else if (encoding) label = 'windows-1252';
    try {
      return new TextDecoder(label).decode(bytes);
    } catch (_) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  function parseExth(rec, start, length) {
    const out = {};
    const magic = String.fromCharCode(rec[start], rec[start + 1], rec[start + 2], rec[start + 3]);
    if (magic !== 'EXTH') return out;
    const count = u32(rec, start + 8);
    let p = start + 12;
    const end = Math.min(start + length, rec.length);
    for (let i = 0; i < count && p + 8 <= end; i++) {
      const type = u32(rec, p);
      const len = u32(rec, p + 4);
      if (len < 8 || p + len > end) break;
      const value = rec.subarray(p + 8, p + len);
      // Text fields are UTF-8 in practice; numeric ones are big-endian u32.
      if (type === 201 || type === 202) out[type] = u32(value, 0);
      else out[type] = new TextDecoder('utf-8').decode(value).replace(/\0+$/, '');
      p += len;
    }
    return out;
  }

  /* ── the book ──────────────────────────────────────────────────── */
  function openMobi7(buffer, fileName) {
    const bytes = new Uint8Array(buffer);

    if (bytes.length < 100) throw new Error('檔案太小，不是有效的 MOBI。');
    const typeCreator = String.fromCharCode(bytes[0x3C], bytes[0x3D], bytes[0x3E], bytes[0x3F]);
    if (typeCreator !== 'BOOK') {
      throw new Error('不是 MOBI 檔案（PalmDB type 不是 BOOK）。');
    }
    const numRecords = u16(bytes, 0x4C);
    if (!numRecords || numRecords > 0xFFFF) throw new Error('MOBI 檔案的表頭損壞。');

    // Record offsets, guarded: a truncated download usually shows up here.
    const offs = [];
    for (let i = 0; i < numRecords + 1; i++) {
      const o = 78 + i * 8;
      if (o + 4 > bytes.length) throw new Error('MOBI 檔案不完整（記錄表被截斷）。');
      offs.push(u32(bytes, o));
    }
    const rec = (i) => {
      const s = offs[i];
      const e = i + 1 < offs.length ? offs[i + 1] : bytes.length;
      if (s >= bytes.length) return new Uint8Array(0);
      return bytes.subarray(s, Math.min(e, bytes.length));
    };

    const r0 = rec(0);
    const compression = u16(r0, 0);
    const textLength = u32(r0, 4);
    const textRecords = u16(r0, 8);
    const encryption = u16(r0, 12);

    if (encryption) throw new Error('這個 MOBI 有 DRM 保護，無法開啟。');
    if (compression === HUFF) {
      throw new Error('這個 MOBI 使用 HUFF/CDIC 壓縮，暫不支援。請用 Calibre 轉成 EPUB 或 AZW3。');
    }

    const mobiMagic = String.fromCharCode(r0[16], r0[17], r0[18], r0[19]);
    let firstImageIndex = 0xFFFFFFFF;
    let encoding = 65001;
    let fullName = '';
    let exth = {};
    let exthFlags = 0;

    if (mobiMagic === 'MOBI') {
      // Every MOBI field offset is measured from the "MOBI" magic at byte 16,
      // NOT from the start of record 0 — off by 16 and the full-name/exth/image
      // pointers all land on garbage.
      const M = 16;
      const headerLen = u32(r0, M + 4);
      const version = u32(r0, M + 0x14);
      encoding = u32(r0, M + 0x0C);
      const fullNameOffset = u32(r0, M + 0x44);
      const fullNameLength = u32(r0, M + 0x48);
      firstImageIndex = u32(r0, M + 0x5C);
      exthFlags = u32(r0, M + 0x70);
      void version;
      if (fullNameLength && fullNameOffset + fullNameLength <= r0.length) {
        fullName = decodeText(r0.subarray(fullNameOffset, fullNameOffset + fullNameLength), encoding);
      }
      if (exthFlags & 0x40) {
        const exthStart = M + headerLen;
        exth = parseExth(r0, exthStart, u32(r0, exthStart + 4));
      }
    }

    // ── text ──
    const parts = [];
    let total = 0;
    for (let i = 1; i <= textRecords && i < numRecords; i++) {
      const raw = rec(i);
      let chunk;
      if (compression === 1) chunk = raw;
      else chunk = decompressPalmDOC(raw, 0);
      parts.push(chunk);
      total += chunk.length;
      if (total >= textLength && textLength) break;
    }
    const totalBytes = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { totalBytes.set(p, at); at += p.length; }

    // Trailing entries (multibyte / TBS) sit past textLength; trimming to it is
    // the cheap, reliable way to drop them.
    const textBytes = textLength && textLength <= totalBytes.length
      ? totalBytes.subarray(0, textLength)
      : totalBytes;
    let html = decodeText(textBytes, encoding).replace(/\u0000/g, '');
    // Keep the un-sliced text: the <guide> lives in <head>, and its TOC pointer
    // is the only reliable way to find the contents page.
    const fullHtml = html;

    // Some books leave the trailing-entry bytes behind as NULs or mojibake.
    const bodyOpen = /<body\b[^>]*>/i.exec(html);
    if (bodyOpen) {
      html = html.slice(bodyOpen.index + bodyOpen[0].length);
      const close = html.search(/<\/body>/i);
      if (close !== -1) html = html.slice(0, close);
    }

    // ── images (lazy) ──
    const imageUrls = new Map();
    function imageUrl(index) {
      if (imageUrls.has(index)) return imageUrls.get(index);
      const recNo = firstImageIndex + index - 1;
      if (firstImageIndex === 0xFFFFFFFF || recNo >= numRecords) {
        imageUrls.set(index, '');
        return '';
      }
      const data = rec(recNo);
      if (!data.length) { imageUrls.set(index, ''); return ''; }
      const url = URL.createObjectURL(new Blob([data], { type: sniffMime(data) }));
      imageUrls.set(index, url);
      return url;
    }

    // Rewrite <img recindex="00001"> → blob URL before splitting, so the same
    // markup is reused for every chapter.
    html = html.replace(/<img\b[^>]*>/gi, (tag) => {
      const m = /recindex\s*=\s*["']?(\d+)/i.exec(tag);
      if (!m) return tag;
      const url = imageUrl(Number(m[1]));
      if (!url) return tag.replace(/<img/i, '<img data-missing="1"');
      let out = tag.replace(/\srecindex\s*=\s*["']?\d+["']?/i, '');
      if (/\ssrc\s*=/i.test(out)) out = out.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|\S+)/i, ` src="${url}"`);
      else out = out.replace(/<img/i, `<img src="${url}"`);
      return out;
    });

    // ── chapters ──
    const rawParts = html.split(/<mbp:pagebreak\s*\/?>/i);
    const chapters = [];
    rawParts.forEach((piece, i) => {
      const clean = piece.trim();
      if (!clean) return;
      chapters.push({
        index: chapters.length,
        path: `mobi7:${i}`,
        href: String(i),
        title: '',
        html: clean,
      });
    });
    if (!chapters.length) throw new Error('這個 MOBI 沒有可讀取的文字。');

    // A single monster chapter means the book has no pagebreaks; split on
    // headings so the prev/next controls are still meaningful.
    if (chapters.length === 1 && chapters[0].html.length > 40000) {
      const big = chapters[0].html;
      const marks = [];
      const re = /<h[12]\b/gi;
      let m;
      while ((m = re.exec(big))) marks.push(m.index);
      if (marks.length > 1) {
        const split = [];
        if (marks[0] > 0) marks.unshift(0);
        for (let i = 0; i < marks.length; i++) {
          const seg = big.slice(marks[i], marks[i + 1]);
          if (seg.trim()) split.push(seg);
        }
        chapters.length = 0;
        split.forEach((seg, i) => chapters.push({
          index: i, path: `mobi7:0:${i}`, href: '0', title: '', html: seg,
        }));
      }
    }

    // ── TOC from the guide + the book's own link table ──
    // MOBI marks the TOC page with <reference type="toc" filepos=N>. Inside it,
    // <a filepos=M> links point at chapters. filepos is a byte offset into the
    // decompressed text, so map them onto the split chapters by cumulative size.
    const toc = [];
    try {
      const guideToc = /<reference[^>]*type\s*=\s*["']toc["'][^>]*>/i.exec(fullHtml)
        || /<reference[^>]*type\s*=\s*["']toc["'][^>]*>/i.exec(fullHtml)
        || /<guide\b[^>]*>[\s\S]*?<\/guide>/i.exec(fullHtml);
      if (guideToc) {
        const fp = /filepos\s*=\s*["']?(\d+)/i.exec(guideToc[0]);
        if (fp) {
          const tocPos = Number(fp[1]);
          // Walk cumulative lengths to find which chapter holds that offset.
          let acc = 0, target = 0;
          for (let i = 0; i < chapters.length; i++) {
            acc += chapters[i].html.length;
            if (acc > tocPos) { target = i; break; }
          }
          const linksHtml = chapters[target] ? chapters[target].html : '';
          const linkRe = /<a[^>]*filepos\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
          // filepos is a byte offset into the book's text, but our chapters are
          // string slices of the body with the pagebreak tokens removed. Rebuild
          // each chapter's start offset by locating its first line in the body,
          // then map a link position to the chapter that contains it.
          const starts = [];
          {
            const bodyHtml = html;
            let from = 0;
            for (const c of chapters) {
              const head = c.html.slice(0, 80);
              const idx = bodyHtml.indexOf(head, Math.max(0, from - 120));
              const at = idx === -1 ? from : idx;
              starts.push(at);
              from = at + c.html.length;
            }
          }
          const chapterAt = (pos) => {
            let best = 0;
            for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) best = i;
            return best;
          };
          let lm;
          while ((lm = linkRe.exec(linksHtml))) {
            const label = lm[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
            if (!label) continue;
            toc.push({ label, chapter: chapterAt(Number(lm[1])) });
          }
        }
      }
    } catch (_) { /* a missing TOC is not fatal */ }

    // ── metadata ──
    const clean = (s) => String(s || '').replace(/\u0000/g, '').trim();
    const title = clean(exth[503]) || clean(fullName) || (fileName || '').replace(/\.(mobi|azw3|azw|prc)$/i, '') || 'Untitled';
    const author = clean(exth[100]);

    // Label chapters from the TOC where possible, else number them.
    for (const t of toc) if (t.chapter < chapters.length && !chapters[t.chapter].title) chapters[t.chapter].title = t.label;
    for (const c of chapters) if (!c.title) c.title = `第 ${c.index + 1} 節`;

    const cache = new Map();

    return {
      format: 'mobi',
      title,
      author,
      language: clean(exth[524]),
      description: clean(exth[103]),
      chapters,
      toc,

      async coverBlob() {
        try {
          let offset = null;
          if (typeof exth[201] === 'number') offset = exth[201];
          else if (typeof exth[202] === 'number') offset = exth[202];
          if (offset === null) return null;
          const recNo = firstImageIndex + offset;
          if (recNo >= numRecords) return null;
          const data = rec(recNo);
          if (!data.length) return null;
          return new Blob([data], { type: sniffMime(data) });
        } catch (_) {
          return null;
        }
      },

      renderChapter(index) {
        const ch = chapters[index];
        if (!ch) return { html: '', css: '', title: '', path: '' };
        if (cache.has(index)) return cache.get(index);
        const out = {
          html: `<div class="mobi-body">${ch.html}</div>`,
          css: '',
          title: ch.title || `第 ${index + 1} 節`,
          path: ch.path,
        };
        cache.set(index, out);
        return out;
      },

      destroy() {
        for (const u of imageUrls.values()) if (u) URL.revokeObjectURL(u);
        imageUrls.clear();
        cache.clear();
      },
    };
  }

  window.YomuMobi7 = { openMobi7, decompressPalmDOC };
})();
