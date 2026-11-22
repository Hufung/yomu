/* Yomu — PDF support.
 *
 * PDFs are rendered with pdf.js into a canvas per page, with the pdf.js text
 * layer on top so selection (and therefore highlighting) works on real text.
 *
 * Chapter model: one chapter per page. That keeps resume/progress and the
 * prev/next buttons identical to a book, and a highlight only needs to anchor
 * within one page's text — the same mechanism the EPUB path uses.
 */
(function () {
  'use strict';

  let libPromise = null;

  function loadLib() {
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      const s = document.createElement('script');
      s.src = 'js/vendor/pdfjs/pdf.min.js';
      s.onload = () => {
        if (!window.pdfjsLib) { reject(new Error(window.YomuI18n ? window.YomuI18n.t('err.pdf.init') : 'pdf.js failed to initialise')); return; }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdfjs/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = () => reject(new Error(window.YomuI18n ? window.YomuI18n.t('err.pdf.load') : 'Could not load pdf.js'));
      document.head.appendChild(s);
    });
    return libPromise;
  }

  async function openPdf(buffer, fileName) {
    const lib = await loadLib();
    const task = lib.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: 'js/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'js/vendor/pdfjs/standard_fonts/',
    });

    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error(window.YomuI18n ? window.YomuI18n.t('err.pdf.password') : 'This PDF is password-protected and cannot be opened.');
      throw new Error(window.YomuI18n ? window.YomuI18n.t('err.pdf.read', { msg: e && e.message ? e.message : e }) : 'Could not read this PDF (' + (e && e.message ? e.message : e) + ').');
    }

    let info = {};
    try { info = (await doc.getMetadata()).info || {}; } catch (_) {}

    const chapters = [];
    for (let i = 1; i <= doc.numPages; i++) {
      chapters.push({ index: i - 1, path: `pdf:${i}`, href: String(i), title: (window.YomuI18n ? window.YomuI18n.t('reader.page', { n: i }) : 'Page ' + i), titleKind: 'page', page: i });
    }

    let tocCache = null;
    const clean = (s) => String(s || '').replace(/\u0000/g, '').trim();

    const api = {
      format: 'pdf',
      title: clean(info.Title) || (fileName || '').replace(/\.pdf$/i, '') || 'Untitled',
      author: clean(info.Author),
      language: '',
      description: clean(info.Subject),
      chapters,
      toc: [],
      pageCount: doc.numPages,

      /* The app asks for chapter metadata synchronously, then calls
       * paintChapter() on the returned host. */
      renderChapter(index) {
        const pageNo = Math.min(doc.numPages, Math.max(1, index + 1));
        return {
          html: '',
          css: '',
          title: (window.YomuI18n ? window.YomuI18n.t('reader.page', { n: pageNo }) : 'Page ' + pageNo),
          titleKind: 'page',
          path: `pdf:${pageNo}`,
          host: api,
          page: pageNo,
        };
      },

      async paintChapter(index, host) {
        const pageNo = Math.min(doc.numPages, Math.max(1, index + 1));
        const page = await doc.getPage(pageNo);
        host.innerHTML = '';

        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        const canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        const textLayer = document.createElement('div');
        textLayer.className = 'pdf-text-layer';
        wrap.appendChild(textLayer);
        host.appendChild(wrap);

        // Fit to the reader column; cap the device-pixel scale so a long page
        // does not allocate a huge canvas on a phone.
        const avail = Math.max(280, host.clientWidth || 700);
        const base = page.getViewport({ scale: 1 });
        const cssScale = Math.min(avail / base.width, 2.4);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const renderVp = page.getViewport({ scale: cssScale * dpr });
        const cssVp = page.getViewport({ scale: cssScale });

        canvas.width = Math.ceil(renderVp.width);
        canvas.height = Math.ceil(renderVp.height);
        canvas.style.width = Math.ceil(cssVp.width) + 'px';
        canvas.style.height = Math.ceil(cssVp.height) + 'px';

        await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;

        if (lib.renderTextLayer) {
          const tc = await page.getTextContent();
          const tl = lib.renderTextLayer({
            textContentSource: tc,
            container: textLayer,
            viewport: cssVp,
            textDivs: [],
          });
          await (tl.promise || tl);
        }
        return (window.YomuI18n ? window.YomuI18n.t('reader.page', { n: pageNo }) : 'Page ' + pageNo);
      },

      /* Document outline → TOC entries with page indices. */
      async outline() {
        if (tocCache) return tocCache;
        let items = [];
        try { items = await doc.getOutline(); } catch (_) { return []; }
        const out = [];
        const walk = async (nodes, depth) => {
          for (const n of nodes || []) {
            try {
              let dest = n.dest;
              if (typeof dest === 'string') dest = await doc.getDestination(dest);
              if (Array.isArray(dest) && dest[0] !== undefined) {
                let pageIdx = null;
                if (typeof dest[0] === 'number') pageIdx = dest[0];
                else if (dest[0] && typeof dest[0] === 'object') pageIdx = await doc.getPageIndex(dest[0]);
                if (pageIdx !== null && pageIdx >= 0) out.push({ label: n.title || '—', chapter: pageIdx });
              }
            } catch (_) { /* skip a broken destination */ }
            if (n.items && n.items.length && depth < 3) await walk(n.items, depth + 1);
          }
        };
        await walk(items, 0);
        tocCache = out;
        return out;
      },

      async coverBlob() {
        try {
          const page = await doc.getPage(1);
          const viewport = page.getViewport({ scale: 0.7 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
        } catch (_) {
          return null;
        }
      },

      destroy() {
        try { doc.destroy(); } catch (_) {}
      },
    };

    return api;
  }

  window.YomuPdf = { openPdf };
})();
