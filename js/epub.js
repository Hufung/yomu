/* Yomu — EPUB parsing, in the browser.
 *
 * No server, no upload: the .epub is unzipped locally with fflate, the OPF is
 * read, the spine is ordered, and every chapter is handed back as sanitised
 * HTML whose <img>/<link>/url() references point at blob: URLs inside the zip.
 */
(function () {
  'use strict';

  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
    css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
    woff2: 'font/woff2', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4',
    xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
    js: 'text/javascript', xml: 'application/xml', txt: 'text/plain',
  };

  const textDecoder = new TextDecoder('utf-8');

  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  /* Resolve a possibly-relative path against a base directory inside the zip. */
  function resolve(baseDir, rel) {
    let clean = String(rel).split('#')[0].split('?')[0];
    if (!clean) return '';
    try { clean = decodeURIComponent(clean); } catch (_) { /* keep raw */ }
    clean = clean.replace(/\\/g, '/');
    if (clean.startsWith('/')) return clean.slice(1);
    const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
    for (const seg of clean.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  function extOf(p) {
    const m = /\.([^./]+)$/.exec(p || '');
    return m ? m[1].toLowerCase() : '';
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('Malformed XML in the EPUB: ' + err.textContent.slice(0, 120));
    return doc;
  }

  function q(doc, sel) {
    return doc.querySelector(sel);
  }

  /* Namespace-agnostic local-name lookup — real-world EPUBs disagree wildly
   * about whether dc: / opf: prefixes are declared. */
  function allByLocal(doc, local) {
    return Array.from(doc.getElementsByTagName('*')).filter(
      (el) => el.localName && el.localName.toLowerCase() === local.toLowerCase()
    );
  }

  class EpubBook {
    constructor(zip, opfPath, doc, entries) {
      this.zip = zip;
      this.entries = entries;                  // Set of zip entry names
      this.opfPath = opfPath;
      this.opfDir = dirname(opfPath);
      this.doc = doc;
      this.urlCache = new Map();               // zipPath -> blob: URL
      this.cssCache = new Map();               // zipPath -> rewritten CSS text
      this._readMeta();
      this._readManifest();
      this._readSpine();
    }

    /* ---------- reading zip entries ---------- */
    readBinary(path) {
      const f = this.zip[path];
      if (!f) return null;
      return f;
    }

    readText(path) {
      const f = this.readBinary(path);
      if (!f) return null;
      return textDecoder.decode(f);
    }

    /* blob: URL for an in-zip resource, memoised per book. */
    urlFor(path) {
      if (!path) return '';
      if (this.urlCache.has(path)) return this.urlCache.get(path);
      const f = this.readBinary(path);
      if (!f) {
        this.urlCache.set(path, '');
        return '';
      }
      const mime = MIME[extOf(path)] || 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([f], { type: mime }));
      this.urlCache.set(path, url);
      return url;
    }

    /* ---------- metadata ---------- */
    _readMeta() {
      const md = q(this.doc, 'metadata') || this.doc.documentElement;
      const pick = (local) => {
        const el = allByLocal(md, local)[0];
        return el ? el.textContent.trim() : '';
      };
      this.title = pick('title') || 'Untitled';
      this.language = pick('language') || '';
      this.publisher = pick('publisher') || '';
      const creators = allByLocal(md, 'creator')
        .map((el) => el.textContent.trim())
        .filter(Boolean);
      this.author = creators.length ? creators.join(', ') : '';
      this.description = pick('description').replace(/<[^>]*>/g, '').trim();

      // Cover: EPUB3 properties="cover-image" wins, then <meta name="cover">.
      this.coverPath = '';
      const metas = allByLocal(md, 'meta');
      const coverId = (metas.find((m) => (m.getAttribute('name') || '').toLowerCase() === 'cover') || {})
        .getAttribute && metas.find((m) => (m.getAttribute('name') || '').toLowerCase() === 'cover');
      this._coverId = coverId ? coverId.getAttribute('content') : '';
    }

    /* ---------- manifest / spine ---------- */
    _readManifest() {
      this.manifest = new Map();
      const items = allByLocal(this.doc, 'item');
      for (const it of items) {
        const id = it.getAttribute('id');
        const href = it.getAttribute('href');
        if (!id || !href) continue;
        const path = resolve(this.opfDir, href);
        this.manifest.set(id, {
          id,
          href,
          path,
          type: (it.getAttribute('media-type') || '').toLowerCase(),
          properties: (it.getAttribute('properties') || '').toLowerCase(),
        });
      }

      // Cover fallbacks
      if (!this.coverPath) {
        const byProp = Array.from(this.manifest.values()).find((m) => m.properties.includes('cover-image'));
        const byId = this._coverId ? this.manifest.get(this._coverId) : null;
        const byName = Array.from(this.manifest.values()).find((m) =>
          /cover/i.test(m.id) && /^image\//.test(m.type));
        const firstImg = Array.from(this.manifest.values()).find((m) => /^image\//.test(m.type));
        const chosen = byProp || byId || byName || firstImg;
        if (chosen) this.coverPath = chosen.path;
      }
    }

    _readSpine() {
      const spineEl = allByLocal(this.doc, 'spine')[0];
      const idrefs = spineEl
        ? allByLocal(spineEl, 'itemref').map((r) => ({
            id: r.getAttribute('idref'),
            linear: (r.getAttribute('linear') || 'yes').toLowerCase() !== 'no',
          }))
        : Array.from(this.manifest.values()).map((m) => ({ id: m.id, linear: true }));

      this.chapters = [];
      this.spineIndexByName = new Map();
      for (const ref of idrefs) {
        const item = this.manifest.get(ref.id);
        if (!item) continue;
        if (!/x?html/.test(item.type) && !/\.x?html?$/i.test(item.path)) continue;
        this.spineIndexByName.set(item.path, this.chapters.length);
        this.chapters.push({
          index: this.chapters.length,
          path: item.path,
          href: item.href,
          linear: ref.linear,
          title: '',
        });
      }
      this.toc = this._readToc();
      // Attach TOC labels to the chapters they point at.
      const counts = new Map();
      for (const entry of this.toc) {
        const idx = this.spineIndexByName.get(entry.path);
        if (idx === undefined) continue;
        if (!this.chapters[idx].title) this.chapters[idx].title = entry.label;
        counts.set(idx, (counts.get(idx) || 0) + 1);
      }
    }

    /* ---------- table of contents ---------- */
    _readToc() {
      const out = [];
      // EPUB3 nav document
      const nav = Array.from(this.manifest.values()).find((m) => m.properties.includes('nav'));
      if (nav) {
        const text = this.readText(nav.path);
        if (text) {
          try {
            const nd = parseXml(text);
            const navEls = Array.from(nd.getElementsByTagName('*'))
              .filter((e) => e.localName === 'nav');
            const tocNav = navEls.find((n) => /toc/i.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navEls[0];
            if (tocNav) {
              for (const a of Array.from(tocNav.getElementsByTagName('a'))) {
                const label = (a.textContent || '').replace(/\s+/g, ' ').trim();
                const href = a.getAttribute('href');
                if (!label || !href) continue;
                out.push({ label, path: resolve(dirname(nav.path), href), href });
              }
            }
          } catch (_) { /* fall through to NCX */ }
        }
      }
      // EPUB2 NCX
      if (!out.length) {
        const ncxId = allByLocal(this.doc, 'spine')[0] &&
          allByLocal(this.doc, 'spine')[0].getAttribute('toc');
        let ncxItem = ncxId ? this.manifest.get(ncxId) : null;
        if (!ncxItem) {
          ncxItem = Array.from(this.manifest.values()).find((m) => /ncx/.test(m.type) || /\.ncx$/i.test(m.path));
        }
        if (!ncxItem) return out;
        const text = this.readText(ncxItem.path);
        if (!text) return out;
        try {
          const nd = parseXml(text);
          for (const np of Array.from(nd.getElementsByTagName('*')).filter((e) => e.localName === 'navPoint')) {
            const labelEl = Array.from(np.getElementsByTagName('*')).find((e) => e.localName === 'text');
            const contentEl = Array.from(np.getElementsByTagName('*')).find((e) => e.localName === 'content');
            const label = labelEl ? labelEl.textContent.replace(/\s+/g, ' ').trim() : '';
            const src = contentEl ? contentEl.getAttribute('src') : '';
            if (!label || !src) continue;
            out.push({ label, path: resolve(dirname(ncxItem.path), src), href: src });
          }
        } catch (_) { /* ignore a broken NCX; chapters still work */ }
      }
      return out;
    }

    /* ---------- chapter rendering ---------- */
    /* Rewrite every url() inside a stylesheet to a blob URL, then return the
     * CSS text. Inlining beats linking: a blob: stylesheet cannot resolve its
     * own relative url()s. */
    _cssText(path, depth) {
      if (depth > 4) return '';
      if (this.cssCache.has(path)) return this.cssCache.get(path);
      const raw = this.readText(path);
      if (raw == null) return '';
      const baseDir = dirname(path);
      const rewritten = raw.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, quote, ref) => {
        if (/^(data:|blob:|https?:|#)/i.test(ref)) return m;
        const target = resolve(baseDir, ref);
        const url = this.urlFor(target);
        return url ? `url("${url}")` : m;
      }).replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?\s*;/g, (m, quote, ref) => {
        const target = resolve(baseDir, ref);
        return this._cssText(target, depth + 1);
      });
      this.cssCache.set(path, rewritten);
      return rewritten;
    }

    /* Return the chapter body as HTML, ready for innerHTML. */
    renderChapter(index) {
      const ch = this.chapters[index];
      if (!ch) return { html: '', title: '', path: '' };
      const raw = this.readText(ch.path);
      if (raw == null) return { html: '<p class="yomu-missing">This chapter is missing from the file.</p>', title: ch.title, path: ch.path };

      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const baseDir = dirname(ch.path);

      // Drop anything that could execute or reach the network.
      for (const sel of ['script', 'iframe', 'object', 'embed', 'form', 'base', 'noscript', 'audio[autoplay]', 'video[autoplay]']) {
        doc.querySelectorAll(sel).forEach((el) => el.remove());
      }
      doc.querySelectorAll('*').forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
          const n = attr.name.toLowerCase();
          if (n.startsWith('on')) el.removeAttribute(attr.name);
          else if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
            el.removeAttribute(attr.name);
          }
        }
      });

      // Stylesheets → inline <style> in <head>
      const head = doc.head || doc.createElement('head');
      const styles = [];
      doc.querySelectorAll('link[rel~="stylesheet" i]').forEach((link) => {
        const href = link.getAttribute('href');
        if (!href) { link.remove(); return; }
        const target = resolve(baseDir, href);
        const css = this._cssText(target, 0);
        link.remove();
        if (css) styles.push(css);
      });
      doc.querySelectorAll('style').forEach((s) => {
        styles.push(this._inlineCss(s.textContent || '', baseDir));
        s.remove();
      });

      // Images / media / svg image refs → blob URLs
      const rewriteAttr = (el, attr) => {
        const v = el.getAttribute(attr);
        if (!v || /^(data:|blob:|https?:)/i.test(v)) return;
        const target = resolve(baseDir, v);
        const url = this.urlFor(target);
        if (url) el.setAttribute(attr, url);
      };
      doc.querySelectorAll('img').forEach((img) => {
        rewriteAttr(img, 'src');
        rewriteAttr(img, 'data-src');
        if (img.getAttribute('srcset')) img.removeAttribute('srcset');
        // Lazy-loaded books put the real file in data-src.
        if (!img.getAttribute('src') && img.getAttribute('data-src')) {
          img.setAttribute('src', img.getAttribute('data-src'));
        }
        img.removeAttribute('loading');
        img.setAttribute('referrerpolicy', 'no-referrer');
      });
      doc.querySelectorAll('image').forEach((im) => {
        rewriteAttr(im, 'xlink:href');
        rewriteAttr(im, 'href');
      });
      doc.querySelectorAll('video, audio, source, track').forEach((el) => {
        rewriteAttr(el, 'src');
      });
      // Inline style="background:url(...)"
      doc.querySelectorAll('[style]').forEach((el) => {
        const v = el.getAttribute('style');
        if (!v || !/url\(/i.test(v)) return;
        el.setAttribute('style', this._inlineCss(v, baseDir));
      });

      // Internal links: rewrite to a data-anchor we can intercept on click.
      doc.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (/^(https?:|mailto:|tel:)/i.test(href)) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          return;
        }
        const target = resolve(baseDir, href);
        const frag = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
        const idx = this.spineIndexByName.get(target);
        if (idx !== undefined) {
          a.setAttribute('data-yomu-chapter', String(idx));
          if (frag) a.setAttribute('data-yomu-anchor', frag);
          a.removeAttribute('href');
        } else {
          a.removeAttribute('href');
        }
      });

      const body = doc.body;
      let html = body ? body.innerHTML : '';
      if (!html.trim()) html = '<p class="yomu-missing">This chapter is empty.</p>';

      // The <head> above is thrown away with the parsed document, so the CSS
      // travels back with the chapter and is injected scoped to the reader.
      const css = scopeCss(styles.join('\n'));

      // Best-effort heading for the TOC when the book has none.
      let title = ch.title;
      if (!title) {
        const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
        title = h ? h[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
      }
      return { html, css, title: title || `Section ${index + 1}`, path: ch.path };
    }

    _inlineCss(css, baseDir) {
      return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, quote, ref) => {
        if (/^(data:|blob:|https?:|#)/i.test(ref)) return m;
        const url = this.urlFor(resolve(baseDir, ref));
        return url ? `url("${url}")` : m;
      });
    }

    coverUrl() {
      if (!this.coverPath) return '';
      return this.urlFor(this.coverPath);
    }
  }

  /* Book CSS is authored against a whole document, but it gets injected inside
   * the reader's <article>. Point html/body at the article itself (that is what
   * :scope resolves to there) and drop the rest untouched. */
  function scopeCss(css) {
    return String(css || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[\s,{}>+~])(?:html\s+body|html|body)(?=[\s,{:.#\[>+~])/gi, (m, pre) => pre + ':scope');
  }

  const YomuEpub = {
    /* Parse an .epub ArrayBuffer into an EpubBook. */
    async open(buffer) {
      const u8 = new Uint8Array(buffer);
      let zip;
      try {
        zip = fflate.unzipSync(u8, { filter: (f) => f.name !== 'mimetype' || true });
      } catch (e) {
        throw new Error('This file is not a readable EPUB (zip error: ' + (e.message || e) + ').');
      }
      const find = (p) => zip[p];
      const containerKey = Object.keys(zip).find((k) => /^META-INF\/container\.xml$/i.test(k));
      if (!containerKey) throw new Error('Not an EPUB: no META-INF/container.xml. (Is this a PDF renamed to .epub?)');
      const container = parseXml(textDecoder.decode(zip[containerKey]));
      const rootEl = allByLocal(container, 'rootfile')[0];
      const opfPath = rootEl && resolve('', rootEl.getAttribute('full-path') || '');
      if (!opfPath || !find(opfPath)) throw new Error('Not an EPUB: container.xml points at a missing OPF.');

      // DRM guard: font obfuscation is legal, content encryption is not ours to break.
      const encKey = Object.keys(zip).find((k) => /^META-INF\/encryption\.xml$/i.test(k));
      if (encKey) {
        const enc = textDecoder.decode(zip[encKey]);
        if (!/FontObfuscation/i.test(enc)) {
          throw new Error('This EPUB is DRM-encrypted and cannot be opened.');
        }
      }

      const opfDoc = parseXml(textDecoder.decode(zip[opfPath]));
      const book = new EpubBook(zip, opfPath, opfDoc, new Set(Object.keys(zip)));
      if (!book.chapters.length) throw new Error('This EPUB has no readable chapters in its spine.');
      return book;
    },
  };

  window.YomuEpub = YomuEpub;
})();
