/* Yomu — MOBI / AZW3 dispatch.
 *
 * Two code paths:
 *   1. MOBI 7 (the common case): the hand-written reader in mobi7.js.
 *   2. KF8 / AZW3: @lingo-reader/mobi-parser, loaded lazily. Its KF8 branch is
 *      the one that works; its MOBI7 branch is what mis-handles <body>/<img>.
 *
 * Detection is by MOBI version, read straight out of record 0.
 */
(function () {
  'use strict';

  function peeks(bytes) {
    // PDB header is 78 bytes + 8 per record entry; record 0 starts after that.
    const u16 = (o) => (bytes[o] << 8) | bytes[o + 1];
    const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    const n = u16(0x4C);
    if (!n || bytes.length < 80) return null;
    const rec0 = u32(78);
    if (rec0 + 32 > bytes.length) return null;
    const magic = String.fromCharCode(bytes[rec0 + 16], bytes[rec0 + 17], bytes[rec0 + 18], bytes[rec0 + 19]);
    if (magic !== 'MOBI') return null;
    // MOBI fields are offset from the "MOBI" magic (record 0 + 16), so the
    // version at MOBI+0x14 lives at record0+0x24.
    return {
      compression: u16(rec0),
      version: u32(rec0 + 16 + 0x14),
      records: n,
    };
  }

  async function openMobi(buffer, fileName) {
    const bytes = new Uint8Array(buffer);
    const info = peeks(bytes);

    // version >= 8 → KF8 / AZW3. Everything else → MOBI 7.
    if (info && info.version >= 8) {
      const mod = await import('./vendor/mobi/lingo-mobi.mjs');
      const book = await mod.initKf8File(bytes, fileName || 'book.azw3');

      // KF8 TOC hrefs look like "pos:frag:off"; resolveHref maps them to a
      // skeleton id + selector, which is the same id the spine uses.
      const flatToc = [];
      const walkToc = (items) => {
        for (const it of items || []) {
          flatToc.push(it);
          if (it.children) walkToc(it.children);
        }
      };
      try { walkToc(book.getToc() || []); } catch (_) {}

      const spine = book.getSpine() || [];
      const chapters = [];
      const spineToChapter = new Map();
      for (const ch of spine) {
        const processed = book.loadChapter(ch.id);
        if (!processed || !processed.html) continue;
        const text = processed.html.replace(/<[^>]*>/g, '').trim();
        if (!text && !/<img/i.test(processed.html)) continue;
        spineToChapter.set(String(ch.id), chapters.length);
        chapters.push({
          index: chapters.length,
          path: `kf8:${ch.id}`,
          href: String(ch.id),
          title: '',
          html: processed.html,
        });
      }
      if (!chapters.length) throw new Error(window.YomuI18n ? window.YomuI18n.t('err.azw3.notext') : 'This AZW3 has no readable content.');

      // Attach TOC labels.
      const toc = [];
      for (const item of flatToc) {
        let target = null;
        try {
          const resolved = book.resolveHref(item.href);
          if (resolved && spineToChapter.has(String(resolved.id))) target = spineToChapter.get(String(resolved.id));
        } catch (_) {}
        if (target === null) continue;
        if (!chapters[target].title) chapters[target].title = item.label;
        toc.push({ label: item.label, chapter: target });
      }

      const meta = book.getMetadata() || {};
      const clean = (s) => String(s || '').replace(/\u0000/g, '').trim();
      for (const c of chapters) if (!c.title) { c.title = (window.YomuI18n ? window.YomuI18n.t('reader.section', { n: c.index + 1 }) : 'Section ' + (c.index + 1)); c.titleKind = 'section'; }
      const cache = new Map();
      return {
        format: 'azw3',
        title: clean(meta.title) || (fileName || '').replace(/\.(azw3|mobi|azw|prc)$/i, '') || 'Untitled',
        author: Array.isArray(meta.author) ? clean(meta.author.join(', ')) : clean(meta.author),
        language: clean(meta.language),
        description: clean(meta.description),
        chapters,
        toc,
        async coverBlob() {
          try {
            const url = book.getCoverImage();
            if (!url) return null;
            const blob = await (await fetch(url)).blob();
            URL.revokeObjectURL(url);
            return blob;
          } catch (_) { return null; }
        },
      renderChapter(index) {
        const ch = chapters[index];
        if (!ch) return { html: '', css: '', title: '', path: '' };
        if (cache.has(index)) return cache.get(index);
        const doc = new DOMParser().parseFromString(
          `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${ch.html}</body></html>`,
          'text/html');
        doc.querySelectorAll('script, iframe, object, embed, form, base, noscript').forEach((el) => el.remove());
        doc.querySelectorAll('*').forEach((el) => {
          for (const attr of Array.from(el.attributes)) {
            const n = attr.name.toLowerCase();
            if (n.startsWith('on')) el.removeAttribute(attr.name);
            else if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
          }
        });
        // Internal links in KF8 use "kindle:pos:fid:off" — drop them rather than
        // letting the browser navigate somewhere meaningless.
        doc.querySelectorAll('a[href^="kindle:"], a[href^="pos:"]').forEach((a) => a.removeAttribute('href'));
        const html = doc.body ? doc.body.innerHTML : '';
        const out = { html: `<div class="mobi-body">${html}</div>`, css: '', title: ch.title, titleKind: ch.titleKind, path: ch.path };
        cache.set(index, out);
        return out;
      },
        destroy() { try { book.destroy(); } catch (_) {} cache.clear(); },
      };
    }

    // MOBI 7 path.
    const book = window.YomuMobi7.openMobi7(buffer, fileName);
    return book;
  }

  window.YomuMobi = { openMobi, peek: peeks };
})();
