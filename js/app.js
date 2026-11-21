/* Yomu — app shell: library, reader, highlights, settings, PWA.
 *
 * Everything runs in the tab. The .epub bytes live in IndexedDB and are unzipped
 * on demand; nothing is ever POSTed anywhere. */
(function () {
  'use strict';

  const Store = window.YomuStore;
  const Epub = window.YomuEpub;
  const HL = window.YomuHL;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PREFS_KEY = 'yomu.prefs.v1';
  const DEFAULTS = {
    theme: 'auto', size: 100, leading: 170, width: 700, font: 'serif',
    fullBleed: false,
  };

  const state = {
    books: [],
    book: null,          // metadata row
    epub: null,          // parsed EpubBook
    chapter: 0,
    highlights: [],      // all highlights of the open book
    prefs: { ...DEFAULTS },
    saving: false,
    dirty: false,
    lastContinueId: null,
  };

  /* ─────────────────────────── helpers ─────────────────────────── */

  function toast(msg, kind, ms) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s ease, transform .25s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, ms || 2600);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function hlId() {
    return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ─────────────────────────── prefs ─────────────────────────── */

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) state.prefs = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (_) { /* corrupt prefs are not worth a dialog */ }
    applyPrefs();
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (_) {}
  }

  /* "auto" follows the OS. The media query is live, so a user who switches
   * their system theme at dusk sees the app follow without a reload. */
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolvedTheme() {
    const p = state.prefs.theme;
    if (p === 'auto') return darkQuery && darkQuery.matches ? 'dark' : 'light';
    return p;
  }

  function applyPrefs() {
    const p = state.prefs;
    const root = document.documentElement;
    const theme = resolvedTheme();
    root.dataset.theme = theme;
    root.style.setProperty('--reader-size', (p.size / 100).toFixed(3));
    root.style.setProperty('--reader-leading', (p.leading / 100).toFixed(2));
    root.style.setProperty('--reader-width', p.width + 'px');
    root.style.setProperty('--reader-font',
      p.font === 'sans' ? 'var(--sans)' : p.font === 'serif' ? 'var(--serif)' : 'inherit');
    root.classList.toggle('full-bleed', !!p.fullBleed);

    // Sync the controls that exist in the DOM.
    const map = [
      ['#opt-size', p.size], ['#opt-leading', p.leading], ['#opt-width', p.width],
    ];
    for (const [sel, v] of map) { const el = $(sel); if (el) el.value = v; }
    const os = $('#out-size'); if (os) os.textContent = p.size + '%';
    const ol = $('#out-leading'); if (ol) ol.textContent = (p.leading / 100).toFixed(1);
    const ow = $('#out-width'); if (ow) ow.textContent = String(p.width);
    const of = $('#opt-font'); if (of) of.value = p.font;
    const fb = $('#opt-fullbleed'); if (fb) fb.checked = !!p.fullBleed;
    $$('#drawer-aa .seg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === p.theme));

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#16181a' : theme === 'sepia' ? '#efe6d4' : '#f6f3ec';
  }

  if (darkQuery) {
    const onScheme = () => { if (state.prefs.theme === 'auto') applyPrefs(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onScheme);
    else if (darkQuery.addListener) darkQuery.addListener(onScheme);
  }

  /* Cover object URLs are NOT persisted: a blob: URL is only valid in the
   * session that created it, so a stored one becomes a dead link after a
   * restart (broken thumbnail + a failed-resource error). Keep a runtime cache
   * keyed by book id, built from the stored Blob each session. */
  const coverUrls = new Map();

  function coverUrlFor(book) {
    if (!book || !book.cover) return '';
    const cached = coverUrls.get(book.id);
    if (cached) return cached;
    const url = URL.createObjectURL(book.cover);
    coverUrls.set(book.id, url);
    return url;
  }

  /* ─────────────────────────── library ─────────────────────────── */

  async function refreshLibrary() {
    state.books = await Store.listBooks();
    renderShelf();
    renderContinue();
    updateStorageNote();
  }

  function renderShelf() {
    const shelf = $('#shelf');
    const q = ($('#search').value || '').trim().toLowerCase();
    const books = state.books.filter((b) => {
      if (!q) return true;
      return (b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q);
    });

    $('#empty').hidden = state.books.length > 0;

    shelf.innerHTML = '';
    for (const b of books) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.id = b.id;

      const cover = document.createElement('div');
      cover.className = 'card-cover';
      cover.tabIndex = 0;
      cover.setAttribute('role', 'button');
      cover.setAttribute('aria-label', '開啟 ' + b.title);

      const url = coverUrlFor(b);
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        cover.appendChild(img);
      } else {
        const fb = document.createElement('div');
        fb.className = 'card-fallback';
        const s = document.createElement('span');
        s.textContent = b.title || 'Untitled';
        fb.appendChild(s);
        cover.appendChild(fb);
      }

      if (typeof b.readRatio === 'number' && b.readRatio > 0.001) {
        const pr = document.createElement('div');
        pr.className = 'card-progress';
        const i = document.createElement('i');
        i.style.width = Math.min(100, Math.round(b.readRatio * 100)) + '%';
        pr.appendChild(i);
        cover.appendChild(pr);
      }

      const del = document.createElement('button');
      del.className = 'card-del';
      del.type = 'button';
      del.title = '刪除這本書';
      del.setAttribute('aria-label', '刪除 ' + b.title);
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDelete(b);
      });
      cover.appendChild(del);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      const t = document.createElement('p');
      t.className = 'card-title';
      t.textContent = b.title || 'Untitled';
      const a = document.createElement('span');
      a.className = 'card-author';
      a.textContent = b.author || '—';
      meta.append(t, a);

      // Format badge: a PDF on the shelf should not pretend to be an EPUB.
      const fmt = (b.format || 'epub').toUpperCase().replace('MARKDOWN', 'MD');
      const badge = document.createElement('span');
      badge.className = 'card-format';
      badge.dataset.format = b.format || 'epub';
      badge.textContent = fmt;
      cover.appendChild(badge);

      card.append(cover, meta);
      const open = () => openBook(b.id);
      cover.addEventListener('click', open);
      cover.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      shelf.appendChild(card);
    }

    if (!books.length && state.books.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.gridColumn = '1 / -1';
      p.textContent = `沒有符合「${q}」的書。`;
      shelf.appendChild(p);
    }
  }

  function renderContinue() {
    const card = $('#continue-card');
    const last = state.books
      .filter((b) => b.lastOpenedAt && !b.missing)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    if (!last) { card.hidden = true; return; }
    state.lastContinueId = last.id;
    card.hidden = false;
    $('#continue-title').textContent = last.title || 'Untitled';
    const bits = [];
    if (last.chapterTitle) bits.push(last.chapterTitle);
    if (typeof last.readRatio === 'number' && last.readRatio > 0) bits.push(Math.round(last.readRatio * 100) + '%');
    bits.push(fmtDate(last.lastOpenedAt));
    $('#continue-meta').textContent = bits.filter(Boolean).join(' · ');
    const c = $('#continue-cover');
    const curl = coverUrlFor(last);
    c.style.background = curl ? `center/cover no-repeat url("${curl}")` : 'var(--line)';
  }

  async function updateStorageNote() {
    const note = $('#storage-note');
    if (!navigator.storage || !navigator.storage.estimate) { note.textContent = ''; return; }
    try {
      const est = await navigator.storage.estimate();
      const used = est.usage || 0;
      const mb = (used / 1048576).toFixed(1);
      let persist = false;
      if (navigator.storage.persisted) persist = await navigator.storage.persisted();
      note.textContent = `本機已用 ${mb} MB` + (persist ? ' · 已受保護' : '');
    } catch (_) { note.textContent = ''; }
  }

  async function confirmDelete(book) {
    const n = (await Store.listHighlights(book.id)).length;
    const msg = `刪除《${book.title}》？` + (n ? `\n這會一併刪除它的 ${n} 條劃線／筆記。` : '');
    if (!window.confirm(msg)) return;
    await Store.deleteBook(book.id);
    const u = coverUrls.get(book.id);
    if (u) { URL.revokeObjectURL(u); coverUrls.delete(book.id); }
    if (state.book && state.book.id === book.id) closeReader();
    await refreshLibrary();
    toast('已刪除', 'ok');
  }

  /* ─────────────────────────── import ─────────────────────────── */

  const FORMATS = {
    epub: /\.epub$/i,
    mobi: /\.(mobi|azw3|azw|prc)$/i,
    pdf: /\.pdf$/i,
    txt: /\.(txt|md|markdown|text)$/i,
  };

  function formatOf(file) {
    const name = (file && file.name) || '';
    for (const [k, re] of Object.entries(FORMATS)) if (re.test(name)) return k;
    const t = (file && file.type) || '';
    if (t === 'application/epub+zip') return 'epub';
    if (t === 'application/pdf') return 'pdf';
    if (t.includes('mobi')) return 'mobi';
    if (t.startsWith('text/')) return 'txt';
    return null;
  }

  /* Open any supported format and normalise it to the reader's book shape:
   * { title, author, chapters:[...], renderChapter(i) -> {html|host}, coverBlob() } */
  async function openAny(format, buffer, fileName) {
    if (format === 'epub') return Epub.open(buffer);
    if (format === 'mobi' || format === 'azw3') {
      // Loaded on demand: the MOBI/KF8 parsers are ~60 KB nobody needs for EPUB.
      await loadScript('js/mobi7.js');
      await loadScript('js/mobi.js');
      return window.YomuMobi.openMobi(buffer, fileName);
    }
    if (format === 'pdf') {
      await loadScript('js/pdf.js');
      return window.YomuPdf.openPdf(buffer, fileName);
    }
    // "markdown" is what the TXT parser reports back for .md/.markdown files.
    if (format === 'txt' || format === 'markdown' || format === 'text') {
      return window.YomuText.openText(new Uint8Array(buffer), fileName);
    }
    throw new Error('unsupported format: ' + format);
  }

  /* Classic <script> injection instead of dynamic import(): it works on any
   * static host without worrying about .js MIME types, and keeps the app usable
   * as a double-clicked file:// page too. */
  const loaded = new Set();
  function loadScript(src) {
    if (loaded.has(src)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { loaded.add(src); resolve(); };
      s.onerror = () => reject(new Error('無法載入 ' + src));
      document.head.appendChild(s);
    });
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []).map((f) => ({ file: f, format: formatOf(f) }))
      .filter((x) => x.format);
    if (!files.length) {
      toast('請選擇 EPUB、MOBI／AZW3、PDF 或 TXT 檔案', 'err');
      return;
    }
    // Ask for durable storage up front — browsers may otherwise evict the books.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    for (const { file, format } of files) {
      toast(`正在匯入「${file.name}」…`, null, 60000);
      let book = null;
      try {
        const buf = await file.arrayBuffer();
        book = await openAny(format, buf.slice(0), file.name);

        // Cover: EPUB exposes a blob URL, MOBI/PDF generate one, TXT has none.
        let cover = null;
        try {
          let blob = null;
          if (format === 'epub') {
            const u = book.coverUrl();
            if (u) blob = await (await fetch(u)).blob();
          } else if (book.coverBlob) {
            blob = await book.coverBlob();
          }
          if (blob) cover = await shrinkImage(blob, 480);
        } catch (_) { cover = null; }

        const id = uid();
        const entry = {
          id,
          // Trust the parser: a .md file is stored as "markdown", not "txt".
          format: book.format || format,
          title: book.title || file.name.replace(/\.[^.]+$/, ''),
          author: book.author || '',
          language: book.language || '',
          chapterCount: book.chapters.length,
          bytes: file.size,
          cover: cover || null,
          addedAt: Date.now(),
          lastOpenedAt: 0,
          readRatio: 0,
        };
        await Store.addBook(entry, buf);
        // Free the temporary blob URLs held by this parse (urlCache is a Map).
        if (book.urlCache) for (const u of book.urlCache.values()) URL.revokeObjectURL(u);
        if (book.destroy) book.destroy();
        toast(`已加入「${entry.title}」`, 'ok');
      } catch (err) {
        console.error(err);
        toast(`「${file.name}」匯入失敗：${err.message || err}`, 'err', 6000);
      }
    }
    await refreshLibrary();
  }

  /* Re-encode a cover to a small JPEG/PNG so 200 books don't eat the quota. */
  function shrinkImage(blob, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((out) => {
            URL.revokeObjectURL(url);
            resolve(out || blob);
          }, 'image/jpeg', 0.82);
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('cover could not be decoded'));
      };
      img.src = url;
    });
  }

  /* ─────────────────────────── reader ─────────────────────────── */

  async function openBook(id) {
    const meta = await Store.getBook(id);
    if (!meta) { toast('找不到這本書', 'err'); return; }
    const buf = await Store.getFile(id);
    if (!buf) {
      toast('這本書的檔案不見了（可能已從瀏覽器清除）。請重新匯入。', 'err', 7000);
      return;
    }
    toast('正在開啟…', null, 8000);
    try {
      state.epub = await openAny(meta.format || 'epub', buf, meta.title || '');
    } catch (e) {
      toast('無法開啟：' + (e.message || e), 'err', 7000);
      return;
    }
    state.book = meta;
    state.highlights = await Store.listHighlights(id);

    const prog = await Store.getProgress(id);
    state.chapter = prog && Number.isInteger(prog.chapter) ? Math.min(prog.chapter, state.epub.chapters.length - 1) : 0;

    meta.lastOpenedAt = Date.now();
    await Store.putBook(meta);

    $('#rd-title').textContent = meta.title || 'Untitled';
    $('#view-library').hidden = true;
    $('#view-reader').hidden = false;
    document.body.style.overflow = 'hidden';
    renderToc();
    await renderChapter(state.chapter, prog ? prog.anchor : null);
    $('#scroll-area').focus();
  }

  function closeReader() {
    const scroller = $('#scroll-area');
    if (state.book) saveProgress(true);
    state.book = null;
    state.epub = null;
    state.highlights = [];
    scroller.scrollTop = 0;
    $('#view-reader').hidden = true;
    $('#view-library').hidden = false;
    document.body.style.overflow = '';
    closeDrawers();
    hideSelBar();
    hideHlPop();
    // Blob URLs held by the closed book are garbage now.
    refreshLibrary();
  }

  async function renderChapter(index, anchor) {
    if (!state.epub) return;
    const total = state.epub.chapters.length;
    index = Math.max(0, Math.min(index, total - 1));
    state.chapter = index;

    const ch = state.epub.renderChapter(index);
    const root = $('#chapter');

    // Update the chrome BEFORE the (possibly async) page paint: a PDF takes a
    // few hundred ms to draw, and leaving the old chapter's label on screen
    // during that window looks like the navigation failed.
    $('#rd-chapter').textContent = ch.title || `第 ${index + 1} 節`;
    $('#chapter-pos').textContent = `${index + 1} / ${total}`;
    $('#btn-prev').disabled = index === 0;
    $('#btn-next').disabled = index === total - 1;
    $$('#toc-list li').forEach((li) => li.classList.toggle('on', Number(li.dataset.index) === index));

    // Keep one <style> per chapter at the top of the article; it is scoped to
    // :scope (the article) so book CSS cannot leak into the app chrome.
    root.innerHTML = '';
    if (ch.css) {
      const st = document.createElement('style');
      st.dataset.bookCss = '1';
      st.textContent = ch.css;
      root.appendChild(st);
    }
    const body = document.createElement('div');
    body.className = 'chapter-body';
    root.appendChild(body);

    // PDFs render asynchronously into a host element (canvas + text layer).
    if (ch.host) {
      const target = ch.host || root;
      if (typeof target.paintChapter === 'function') {
        await target.paintChapter(index, body);
      } else {
        body.innerHTML = ch.html || '';
      }
      // Late highlights must not paint over a canvas that is still drawing.
      body.dataset.pdfReady = '1';
    } else {
      body.innerHTML = ch.html;
    }

    // Highlights for this chapter only.
    const mine = state.highlights.filter((h) => h.chapter === ch.path || h.chapter === index);
    const orphans = HL.render(root, mine);
    if (orphans.length) {
      // Keep the data, but tell the truth about why the marks are missing.
      console.warn('unanchored highlights', orphans);
    }

    const scroller = $('#scroll-area');
    scroller.scrollTop = 0;

    if (anchor) {
      // Deferred: images that change layout settle a beat later.
      requestAnimationFrame(() => {
        const el = findAnchor(root, anchor);
        if (el) el.scrollIntoView({ block: 'center' });
      });
    }

    updateProgressBar();
    if (state.book) {
      state.book.chapterTitle = ch.title || '';
      state.dirty = true;
      // Chapter changes flush at once: a debounce window here loses the reading
      // position if the tab is closed or the browser is killed right after.
      saveProgress(true);
    }
    renderNotes();
  }

  function findAnchor(root, id) {
    if (!id) return null;
    const clean = String(id);
    let el = root.querySelector(`[id="${CSS.escape(clean)}"]`) || root.querySelector(`[name="${CSS.escape(clean)}"]`);
    if (el) return el;
    // Some books number their anchors oddly; try a decoded variant.
    try {
      const dec = decodeURIComponent(clean);
      el = root.querySelector(`[id="${CSS.escape(dec)}"]`) || root.querySelector(`[name="${CSS.escape(dec)}"]`);
    } catch (_) {}
    return el || null;
  }

  function updateProgressBar() {
    if (!state.epub) return;
    const total = state.epub.chapters.length;
    const scroller = $('#scroll-area');
    const max = scroller.scrollHeight - scroller.clientHeight;
    const within = max > 4 ? Math.min(1, scroller.scrollTop / max) : 0;
    const ratio = total ? (state.chapter + within) / total : 0;
    $('#progress-fill').style.width = (ratio * 100).toFixed(2) + '%';
    $('#progress-track').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    state.readRatio = ratio;
    if (state.book) {
      state.book.readRatio = ratio;
      state.dirty = true;
      scheduleSave();
    }
  }

  /* Debounced save. Every write path is guarded: a rejected promise here used
   * to leave a silent "saving" forever, so failures re-arm the timer and toast. */
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProgress(false), 700);
  }

  async function saveProgress(immediate) {
    if (!state.book) return;
    const book = state.book;
    const payload = {
      chapter: state.chapter,
      chapterTitle: $('#rd-chapter').textContent,
      ratio: state.readRatio || 0,
      updatedAt: Date.now(),
      anchor: null,
    };
    try {
      await Store.putProgress({ bookId: book.id, ...payload });
      await Store.putBook({ ...book, readRatio: payload.ratio, chapterTitle: payload.chapterTitle, lastOpenedAt: book.lastOpenedAt });
      state.dirty = false;
    } catch (e) {
      state.dirty = true;
      const msg = e && e.name === 'QuotaExceededError'
        ? '瀏覽器儲存空間已滿，閱讀進度未能儲存。'
        : '閱讀進度儲存失敗：' + (e && e.message ? e.message : e);
      toast(msg, 'err', 5000);
      if (!immediate) scheduleSave(); // retry
    }
  }

  /* ─────────────────────────── fullscreen & immersive mode ─────────────────────────── */

  const fullscreenSupported = () => !!(
    document.fullscreenEnabled ||
    document.webkitFullscreenEnabled ||
    document.documentElement.webkitRequestFullscreen
  );

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  async function toggleFullscreen() {
    if (!fullscreenSupported()) {
      // iOS Safari has no Fullscreen API on iPhone. Fall back to immersive mode
      // rather than a dead button: the reading column expands to the same area.
      setZen(true);
      toast('這個瀏覽器不支援全螢幕，已切換為沉浸模式', null, 3200);
      return;
    }
    try {
      if (isFullscreen()) {
        await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else await el.webkitRequestFullscreen();
      }
    } catch (e) {
      // A rejected request (permissions policy, iframe, user gesture lost) must
      // not leave the icon lying about being fullscreen.
      toast('無法進入全螢幕：' + (e.message || e), 'err', 4000);
    }
    syncFullscreenUi();
  }

  function syncFullscreenUi() {
    const on = isFullscreen();
    const btn = $('#btn-full');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('is-fullscreen', on);
    // A PDF page has to be re-fitted to the new viewport size.
    if (state.epub && state.epub.format === 'pdf') {
      clearTimeout(syncFullscreenUi._t);
      syncFullscreenUi._t = setTimeout(() => renderChapter(state.chapter, null), 220);
    }
  }

  /* Immersive ("zen") mode: the toolbars step out of the way. Tapping the text
   * brings them back, and so does moving the pointer to the top edge — on a
   * phone the tap is the only one that exists, which is why it is primary. */
  function setZen(on) {
    document.body.classList.toggle('zen', on);
    const btn = $('#btn-zen');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (on) { closeDrawers(); hideSelBar(); }
    setPrefSafe('zen', on);
  }

  function setPrefSafe(key, value) {
    state.prefs[key] = value;
    try { savePrefs(); } catch (_) {}
  }

  /* ─────────────────────────── TOC / notes ─────────────────────────── */

  function renderToc() {
    const list = $('#toc-list');
    list.innerHTML = '';
    if (!state.epub) return;

    // Three shapes of TOC come out of the format readers:
    //   EPUB      → { label, path, href }  (path resolved through spineIndexByName)
    //   MOBI/PDF  → { label, chapter }     (already a chapter index)
    //   TXT       → []                     (fall back to chapter titles)
    // Never assume spineIndexByName exists: only the EPUB parser builds it.
    const book = state.epub;
    let entries;
    if (book.toc && book.toc.length && book.toc[0] && book.toc[0].chapter !== undefined) {
      entries = book.toc.map((e) => ({ label: e.label, chapter: e.chapter, anchor: e.anchor || null }));
    } else if (book.toc && book.toc.length && book.spineIndexByName) {
      entries = book.toc
        .map((e) => ({
          label: e.label,
          chapter: book.spineIndexByName.get(e.path),
          anchor: (e.href || '').split('#')[1] || null,
        }))
        .filter((e) => e.chapter !== undefined);
    } else {
      entries = book.chapters.map((c, i) => ({
        label: c.title || `第 ${i + 1} 節`,
        chapter: i,
        anchor: null,
      }));
    }
    entries = entries.filter((e) => Number.isInteger(e.chapter) && e.chapter < book.chapters.length);

    for (const e of entries) {
      const li = document.createElement('li');
      li.dataset.index = String(e.chapter);
      if (e.chapter === state.chapter) li.classList.add('on');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = e.label;
      btn.addEventListener('click', () => {
        renderChapter(e.chapter, e.anchor);
        closeDrawers();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function renderNotes() {
    const list = $('#notes-list');
    if (!state.epub) { list.innerHTML = ''; return; }
    const mine = state.highlights.slice().sort((a, b) => a.createdAt - b.createdAt);
    list.innerHTML = '';
    if (!mine.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.padding = '.8rem';
      p.textContent = '選取一段文字，就能劃線或寫筆記。';
      list.appendChild(p);
      return;
    }
    for (const h of mine) {
      const item = document.createElement('div');
      item.className = 'note-item';
      item.dataset.id = h.id;
      const quote = document.createElement('div');
      quote.className = 'note-quote';
      quote.dataset.color = h.color || 'yellow';
      quote.textContent = h.text;
      const where = document.createElement('div');
      where.className = 'note-where';
      where.innerHTML = `<span>${escapeHtml(h.chapterTitle || '')}</span><span>${escapeHtml(fmtDate(h.createdAt))}</span>`;
      item.append(quote, where);
      if (h.note) {
        const t = document.createElement('div');
        t.className = 'note-text';
        t.textContent = h.note;
        item.appendChild(t);
      }
      item.addEventListener('click', async () => {
        closeDrawers();
        await gotoTarget(h.chapter, null);
        const mark = $(`mark[data-hl-id="${CSS.escape(h.id)}"]`);
        if (mark) {
          mark.classList.add('is-active');
          mark.scrollIntoView({ block: 'center' });
          showHlPop(h, mark);
          setTimeout(() => mark.classList.remove('is-active'), 2200);
        } else {
          toast('這條劃線目前的章節文字對不上，已保留原始紀錄。', 'err', 4000);
        }
      });
      list.appendChild(item);
    }
  }

  async function gotoTarget(chapterKey, anchor) {
    if (!state.epub) return;
    let idx = null;
    if (typeof chapterKey === 'number') idx = chapterKey;
    else if (typeof chapterKey === 'string') idx = state.epub.spineIndexByName.get(chapterKey);
    if (idx === undefined || idx === null) idx = state.chapter;
    await renderChapter(idx, anchor);
  }

  /* ─────────────────────────── selection & highlights ─────────────────────────── */

  let pendingSel = null;

  function showSelBar(rect) {
    const bar = $('#sel-bar');
    bar.hidden = false;
    const pad = 12;
    const w = bar.offsetWidth || 220;
    const half = w / 2;
    let x = rect.left + rect.width / 2;
    x = Math.max(half + pad, Math.min(window.innerWidth - half - pad, x));
    let y = rect.top - 52;
    if (y < 70) y = rect.bottom + 52; // flip below on a tight selection at the very top
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  }

  function hideSelBar() {
    $('#sel-bar').hidden = true;
    pendingSel = null;
  }

  function onSelectionChange() {
    const root = $('#chapter');
    if (!state.epub || !root) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideSelBar(); return; }
    if (!root.contains(sel.anchorNode)) { hideSelBar(); return; }
    const offs = HL.selectionOffsets(root);
    if (!offs) { hideSelBar(); return; }
    pendingSel = offs;
    const rect = offs.range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideSelBar(); return; }
    showSelBar(rect);
  }

  async function createHighlight(color) {
    if (!pendingSel || !state.book) return;
    const root = $('#chapter');
    const idx = HL.buildIndex(root);
    const ctx = HL.contextAround(idx.text, pendingSel.start, pendingSel.end, 40);
    const chTitle = $('#rd-chapter').textContent;
    const chPath = state.epub.chapters[state.chapter].path;
    const hl = {
      id: hlId(),
      bookId: state.book.id,
      chapter: chPath,
      chapterIndex: state.chapter,
      chapterTitle: chTitle,
      color: color || 'yellow',
      text: pendingSel.text,
      note: '',
      start: pendingSel.start,
      end: pendingSel.end,
      prefix: ctx.prefix,
      suffix: ctx.suffix,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await Store.putHighlight(hl);
    } catch (e) {
      toast('劃線儲存失敗：' + (e.message || e), 'err', 5000);
      return;
    }
    state.highlights.push(hl);
    // Repaint this chapter so the mark is exact (cheap: one chapter of DOM).
    await renderChapter(state.chapter, null);
    hideSelBar();
    window.getSelection().removeAllRanges();
    renderNotes();
    toast('已劃線', 'ok', 1200);
  }

  function showHlPop(hl, markEl) {
    const pop = $('#hl-pop');
    pop.hidden = false;
    pop.dataset.hlId = hl.id;
    $('#hl-quote').textContent = hl.text;
    $('#hl-note').value = hl.note || '';
    $('#hl-when').textContent = fmtDate(hl.createdAt);
    $('#hl-swatch').style.background = `var(--hl-${hl.color || 'yellow'})`;
    const r = markEl.getBoundingClientRect();
    const w = 320;
    let left = Math.min(window.innerWidth - w / 2 - 12, Math.max(w / 2 + 12, r.left + r.width / 2));
    let top = r.bottom + 10;
    if (top + 220 > window.innerHeight) top = Math.max(70, r.top - 230);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.transform = 'translateX(-50%)';
  }

  function hideHlPop() {
    $('#hl-pop').hidden = true;
    $('#hl-pop').dataset.hlId = '';
  }

  async function saveHlNote() {
    const id = $('#hl-pop').dataset.hlId;
    if (!id) return;
    const hl = state.highlights.find((h) => h.id === id);
    if (!hl) { hideHlPop(); return; }
    hl.note = $('#hl-note').value;
    hl.updatedAt = Date.now();
    try {
      await Store.putHighlight(hl);
      toast('筆記已儲存', 'ok', 1400);
    } catch (e) {
      toast('筆記儲存失敗：' + (e.message || e), 'err', 5000);
      return;
    }
    hideHlPop();
    await renderChapter(state.chapter, null);
    renderNotes();
  }

  async function deleteHl() {
    const id = $('#hl-pop').dataset.hlId;
    if (!id) return;
    if (!window.confirm('刪除這條劃線？')) return;
    try {
      await Store.deleteHighlight(id);
    } catch (e) {
      toast('刪除失敗：' + (e.message || e), 'err', 5000);
      return;
    }
    state.highlights = state.highlights.filter((h) => h.id !== id);
    hideHlPop();
    await renderChapter(state.chapter, null);
    renderNotes();
    toast('已刪除', 'ok', 1300);
  }

  /* ─────────────────────────── drawers ─────────────────────────── */

  function openDrawer(name) {
    closeDrawers();
    const el = $('#drawer-' + name);
    if (!el) return;
    el.hidden = false;
    $('#scrim').hidden = false;
    const btn = { toc: '#btn-toc', notes: '#btn-notes', aa: '#btn-aa' }[name];
    if (btn) $(btn).setAttribute('aria-expanded', 'true');
    if (name === 'notes') renderNotes();
  }

  function closeDrawers() {
    ['toc', 'notes', 'aa'].forEach((n) => {
      const el = $('#drawer-' + n);
      if (el) el.hidden = true;
    });
    $('#scrim').hidden = true;
    ['#btn-toc', '#btn-notes', '#btn-aa'].forEach((s) => {
      const b = $(s);
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  /* ─────────────────────────── backup ─────────────────────────── */

  async function exportBackup() {
    const data = await Store.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yomu-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已匯出 ${data.highlights.length} 條劃線（不含書籍檔案）`, 'ok', 4000);
  }

  function restoreBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        if (payload.app !== 'yomu') throw new Error('不是 Yomu 的備份檔');
        await Store.importData(payload);
        await refreshLibrary();
        toast(`已還原 ${payload.highlights ? payload.highlights.length : 0} 條劃線`, 'ok', 4000);
      } catch (e) {
        toast('還原失敗：' + (e.message || e), 'err', 6000);
      }
    });
    input.click();
  }

  async function showAllNotes() {
    const rows = await Store.allHighlights();
    if (!rows.length) { toast('還沒有任何劃線'); return; }
    const byBook = new Map(state.books.map((b) => [b.id, b]));
    const text = rows
      .sort((a, b) => a.bookId.localeCompare(b.bookId) || a.start - b.start)
      .map((h) => {
        const b = byBook.get(h.bookId);
        return `# ${b ? b.title : h.bookId}\n> ${h.text}\n${h.note ? h.note + '\n' : ''}`;
      }).join('\n');
    const blob = new Blob([text], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'yomu-notes.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已匯出 ${rows.length} 條筆記為 Markdown`, 'ok', 3500);
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function wire() {
    // library
    $('#btn-import').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      importFiles(e.target.files);
      e.target.value = '';
    });
    $$('[data-action="import"]').forEach((b) => b.addEventListener('click', () => $('#file-input').click()));
    $('#search').addEventListener('input', renderShelf);
    $('#btn-continue').addEventListener('click', () => state.lastContinueId && openBook(state.lastContinueId));

    $('#btn-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('#menu');
      menu.hidden = !menu.hidden;
      $('#btn-menu').setAttribute('aria-expanded', String(!menu.hidden));
    });
    $('#menu').addEventListener('click', (e) => {
      const action = e.target.closest('[data-menu]');
      if (!action) return;
      $('#menu').hidden = true;
      const what = action.dataset.menu;
      if (what === 'backup') exportBackup();
      if (what === 'restore') restoreBackup();
      if (what === 'allnotes') showAllNotes();
      if (what === 'storage') updateStorageNote().then(() => toast($('#storage-note').textContent || '未知'));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.lib-actions')) $('#menu').hidden = true;
    });

    // drag & drop onto the library
    let dragDepth = 0;
    const hint = $('#drop-hint');
    window.addEventListener('dragenter', (e) => {
      if ($('#view-reader').hidden === false) return;
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++;
      hint.hidden = false;
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) hint.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      dragDepth = 0;
      hint.hidden = true;
      if ($('#view-reader').hidden === false) return;
      if (e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });

    window.addEventListener('scroll', () => {
      $('.lib-head').classList.toggle('scrolled', window.scrollY > 4);
    }, { passive: true });

    // reader chrome
    $('#btn-back').addEventListener('click', closeReader);
    $('#btn-toc').addEventListener('click', () => { $('#drawer-toc').hidden ? openDrawer('toc') : closeDrawers(); });
    $('#btn-notes').addEventListener('click', () => { $('#drawer-notes').hidden ? openDrawer('notes') : closeDrawers(); });
    $('#btn-aa').addEventListener('click', () => { $('#drawer-aa').hidden ? openDrawer('aa') : closeDrawers(); });
    $('#scrim').addEventListener('click', closeDrawers);
    $$('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));

    $('#btn-prev').addEventListener('click', () => renderChapter(state.chapter - 1, null));
    $('#btn-next').addEventListener('click', () => renderChapter(state.chapter + 1, null));

    const scroller = $('#scroll-area');
    scroller.addEventListener('scroll', updateProgressBar, { passive: true });

    // internal links inside the book
    $('#chapter').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-yomu-chapter]');
      if (a) {
        e.preventDefault();
        renderChapter(Number(a.dataset.yomuChapter), a.dataset.yomuAnchor || null);
        return;
      }
      const mark = e.target.closest('mark[data-hl-id]');
      if (mark) {
        const hl = state.highlights.find((h) => h.id === mark.dataset.hlId);
        if (hl) showHlPop(hl, mark);
      }
    });

    // selection
    document.addEventListener('selectionchange', () => {
      clearTimeout(onSelectionChange._t);
      onSelectionChange._t = setTimeout(onSelectionChange, 180);
    });
    scroller.addEventListener('pointerup', () => setTimeout(onSelectionChange, 30));
    scroller.addEventListener('touchend', () => setTimeout(onSelectionChange, 120));

    $$('#sel-bar .swatch').forEach((b) => {
      // pointerdown beats a selection-collapsing mousedown
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => createHighlight(b.dataset.color));
    });
    $('#sel-note').addEventListener('pointerdown', (e) => e.preventDefault());
    $('#sel-note').addEventListener('click', async () => {
      await createHighlight('yellow');
      // After painting, open the inspector on the fresh mark.
      const last = state.highlights[state.highlights.length - 1];
      const mark = last && $(`mark[data-hl-id="${CSS.escape(last.id)}"]`);
      if (mark) { showHlPop(last, mark); $('#hl-note').focus(); }
    });
    $('#sel-copy').addEventListener('pointerdown', (e) => e.preventDefault());
    $('#sel-copy').addEventListener('click', async () => {
      if (!pendingSel) return;
      try { await navigator.clipboard.writeText(pendingSel.text); toast('已複製', 'ok', 1200); }
      catch (_) { toast('複製失敗', 'err'); }
      hideSelBar();
    });

    $('#hl-save').addEventListener('click', saveHlNote);
    $('#hl-delete').addEventListener('click', deleteHl);

    document.addEventListener('click', (e) => {
      if ($('#hl-pop').hidden) return;
      if (!e.target.closest('#hl-pop') && !e.target.closest('mark[data-hl-id]')) hideHlPop();
    });

    // settings
    const bindRange = (sel, key, transform, out) => {
      const el = $(sel);
      el.addEventListener('input', () => {
        state.prefs[key] = transform(Number(el.value));
        applyPrefs();
        savePrefs();
      });
    };
    bindRange('#opt-size', 'size', (v) => v);
    bindRange('#opt-leading', 'leading', (v) => v);
    bindRange('#opt-width', 'width', (v) => v);
    $('#opt-font').addEventListener('change', (e) => {
      state.prefs.font = e.target.value;
      applyPrefs(); savePrefs();
    });
    $$('#drawer-aa .seg button').forEach((b) => {
      b.addEventListener('click', () => {
        state.prefs.theme = b.dataset.theme;
        applyPrefs(); savePrefs();
      });
    });
    $('#opt-fullbleed').addEventListener('change', (e) => {
      state.prefs.fullBleed = e.target.checked;
      applyPrefs(); savePrefs();
      // A PDF page has to be re-fitted to the new column width.
      if (state.epub && state.epub.format === 'pdf') renderChapter(state.chapter, null);
    });

    // fullscreen + zen (immersive) reading
    $('#btn-full').addEventListener('click', toggleFullscreen);
    $('#btn-zen').addEventListener('click', () => setZen(!document.body.classList.contains('zen')));
    document.addEventListener('fullscreenchange', syncFullscreenUi);
    document.addEventListener('webkitfullscreenchange', syncFullscreenUi);

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (!$('#view-reader').hidden) {
        if (e.key === 'Escape') {
          if (!$('#hl-pop').hidden) return hideHlPop();
          if (!$('#scrim').hidden) return closeDrawers();
          if (!window.getSelection().isCollapsed) return hideSelBar();
          if (document.body.classList.contains('zen')) return setZen(false);
          if (isFullscreen()) return toggleFullscreen();
          return closeReader();
        }
        // e.target is Document when nothing is focused — it has no .matches().
        const tgt = e.target;
        if (tgt && typeof tgt.matches === 'function' && tgt.matches('input, textarea, select')) return;
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') { renderChapter(state.chapter - 1, null); }
        if (e.key === 'ArrowRight' || e.key === 'PageDown') { renderChapter(state.chapter + 1, null); }
        const k = e.key.toLowerCase();
        if (k === 'f') { $('#btn-aa').click(); }
        if (k === 'z') { setZen(!document.body.classList.contains('zen')); }
        if (k === 'd') { state.prefs.theme = resolvedTheme() === 'dark' ? 'light' : 'dark'; applyPrefs(); savePrefs(); }
        if (k === 'F11' || e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
      }
    });

    // zen mode: a tap on the text (not on a link or a mark) toggles the chrome
    $('#chapter').addEventListener('click', (e) => {
      if (!document.body.classList.contains('zen')) return;
      if (e.target.closest('a[data-yomu-chapter], mark[data-hl-id]')) return;
      if (!window.getSelection().isCollapsed) return;   // a tap that selected text is not a chrome tap
      setZen(false);
    });
    // and a pointer resting at the very top of the window is a request for the bar
    document.addEventListener('mousemove', (e) => {
      if (!document.body.classList.contains('zen')) return;
      if (e.clientY < 12) setZen(false);
    }, { passive: true });

    // keep the reading column honest when the viewport changes (rotation,
    // desktop window resize, mobile browser chrome collapsing on scroll)
    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.epub && state.epub.format === 'pdf') renderChapter(state.chapter, null);
      }, 260);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty && state.book) {
        saveProgress(true);
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // service worker (PWA). Absent on file:// — that is fine, it still works.
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('sw', err));
    }
  }

  /* ─────────────────────────── boot ─────────────────────────── */

  async function boot() {
    loadPrefs();
    wire();
    if (navigator.storage && navigator.storage.persist) {
      try {
        const already = await navigator.storage.persisted();
        if (!already) await navigator.storage.persist();
      } catch (_) {}
    }
    try {
      await refreshLibrary();
    } catch (e) {
      toast('書架讀取失敗：' + (e.message || e), 'err', 6000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
