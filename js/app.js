/* Yomu — app shell: library, reader, highlights, settings, PWA.
 *
 * Everything runs in the tab. The .epub bytes live in IndexedDB and are unzipped
 * on demand; nothing is ever POSTed anywhere. */
(function () {
  'use strict';

  const Store = window.YomuStore;
  const Epub = window.YomuEpub;
  const HL = window.YomuHL;
  const TTS = window.YomuTTS;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PREFS_KEY = 'yomu.prefs.v1';
  const DEFAULTS = {
    theme: 'auto', size: 100, leading: 170, width: 700, font: 'serif',
    fullBleed: false, lang: 'auto', zen: false, sort: 'recent',
    // Read-aloud. `ttsOn` is the mode switch; the rest persist the user's
    // speed/voice so listening does not have to be reconfigured per book.
    ttsOn: false, ttsRate: 1, ttsVoice: '',
  };

  const I18N = window.YomuI18n;
  const t = (key, vars) => I18N.t(key, vars);

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
    shelves: [],          // [{id, name, ...}]
    shelf: null,          // active shelf id, null = All books
    sort: 'recent',       // recent | added | title | author
    pickShelfFor: null,   // book id whose shelf picker is open
    shelfManagerOpen: false,
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
    state.sort = state.prefs.sort || 'recent';
    // Language first: everything applied after this point is already translated.
    I18N.set(state.prefs.lang === 'auto' ? I18N.detect() : state.prefs.lang);
    I18N.applyI18n();
    applyPrefs();
  }

  /* Switching language rewrites the chrome in place — no reload, so the book
   * and the reading position stay exactly where they were. */
  function setLanguage(value) {
    state.prefs.lang = value;
    I18N.set(value === 'auto' ? I18N.detect() : value);
    I18N.applyI18n();
    closeSortMenu();
    const sel = $('#opt-lang');
    if (sel) sel.dataset.built = '';   // force relabelling in the new language
    savePrefs();
    applyPrefs();
    // Generated labels (Section 12 / Page 3) live in the parsed book, so the
    // current chapter and the TOC have to be re-rendered with the new locale.
    if (state.epub) {
      renderToc();
      if (state.chapter >= 0) {
        const ch = state.epub.renderChapter(state.chapter);
        $('#rd-chapter').textContent = ch.title || (ch.titleKind === 'page'
          ? t('reader.page', { n: state.chapter + 1 })
          : t('reader.section', { n: state.chapter + 1 }));
      }
      renderNotes();
    }
    renderShelfChrome();
    renderShelf();
    renderContinue();
    // The storage note is built from a template too; without this it keeps the
    // previous language until the next import.
    updateStorageNote();
    toast(t('toast.langchanged'), 'ok', 1400);
  }

  /* Cycle through every supported language in picker order. With more than two
   * locales a blind cycle stops being useful, so the settings drawer's select is
   * the precise control; this is the quick one-key path. */
  function cycleLanguage() {
    const list = I18N.SUPPORTED;
    const at = list.indexOf(I18N.get());
    setLanguage(list[(at + 1) % list.length]);
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

  /* One-tap dark toggle. It always lands on an explicit theme (never 'auto'),
   * because a button that appears to do nothing — because the OS already said
   * dark — is worse than no button. */
  async function toggleTheme() {
    const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
    state.prefs.theme = next;
    applyPrefs();
    savePrefs();
    // The browser can theme its own chrome on Android; ask it to match.
    if (navigator.setAppBadge === undefined && document.body) { /* noop guard */ }
    const bt = $('#btn-theme');
    if (bt) bt.setAttribute('aria-pressed', String(next === 'dark'));
    return next;
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

    // Theme icon: show the theme you would switch TO.
    const bt = $('#btn-theme');
    if (bt) {
      bt.setAttribute('aria-pressed', String(theme === 'dark'));
      bt.dataset.current = theme;
    }

    // Sync the controls that exist in the DOM.
    const map = [
      ['#opt-size', p.size], ['#opt-leading', p.leading], ['#opt-width', p.width],
    ];
    for (const [sel, v] of map) { const el = $(sel); if (el) el.value = v; }
    const os = $('#out-size'); if (os) os.textContent = p.size + '%';
    const ol = $('#out-leading'); if (ol) ol.textContent = (p.leading / 100).toFixed(1);
    const ow = $('#out-width'); if (ow) ow.textContent = String(p.width);
    const of = $('#opt-font'); if (of) of.value = p.font;
    const ot = $('#opt-tts'); if (ot) ot.checked = !!p.ttsOn;
    const orr = $('#opt-tts-rate');
    if (orr) { orr.value = p.ttsRate; }
    const ort = $('#out-tts-rate');
    if (ort) ort.textContent = (Number(p.ttsRate) || 1).toFixed(1) + '×';
    const fb = $('#opt-fullbleed'); if (fb) fb.checked = !!p.fullBleed;
    const lg = $('#opt-lang');
    if (lg) {
      // Rebuild each time: the option labels are language names, and the list
      // grows when a locale is added.
      const want = p.lang === 'auto' ? 'auto' : I18N.get();
      if (lg.dataset.built !== I18N.SUPPORTED.join(',')) {
        I18N.fillLanguageSelect(lg);
        lg.dataset.built = I18N.SUPPORTED.join(',');
      }
      lg.value = want;
    }
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
    await refreshShelves();
    renderShelfChrome();
    renderShelf();
    renderContinue();
    updateStorageNote();
  }


  /* ─────────────────────────── shelves ─────────────────────────── */

  /* Shelf state lives in IndexedDB (rows) + an array on each book. Keeping the
   * two in step is the whole job here; the render is deliberately dumb. */

  async function refreshShelves() {
    try {
      state.shelves = await Store.listShelves();
    } catch (e) {
      state.shelves = [];
      toast(t('toast.libfail', { msg: e.message || e }), 'err', 5000);
    }
    // A shelf deleted in another tab (or by a restore) must not stay selected,
    // otherwise the grid goes permanently empty with no way back.
    if (state.shelf && !state.shelves.some((sh) => sh.id === state.shelf)) state.shelf = null;
  }

  function activeShelf() {
    return state.shelf ? state.shelves.find((sh) => sh.id === state.shelf) || null : null;
  }

  function shelfName(id) {
    const sh = state.shelves.find((x) => x.id === id);
    return sh ? sh.name : '';
  }

  function bookShelves(b) {
    return Array.isArray(b.shelves) ? b.shelves.filter((id) => shelfName(id)) : [];
  }

  /* Chips row + toolbar. This is chrome, so it is re-rendered on language
   * change and after every shelf mutation. */
  function renderShelfChrome() {
    const row = $('#shelf-chips');
    if (!row) return;
    row.innerHTML = '';

    const total = state.books.length;
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (state.shelf === null ? ' on' : '');
    all.dataset.shelf = '';
    all.setAttribute('aria-label', t('shelf.all') + ' · ' + total);
    all.append(chipLabel(t('shelf.all'), total));
    all.addEventListener('click', () => selectShelf(null));
    row.appendChild(all);

    for (const sh of state.shelves) {
      const n = state.books.filter((b) => bookShelves(b).includes(sh.id)).length;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (state.shelf === sh.id ? ' on' : '');
      chip.dataset.shelf = sh.id;
      chip.dataset.count = String(n);
      chip.append(chipLabel(sh.name, n));
      chip.title = sh.name + ' · ' + n;
      chip.setAttribute('aria-label', sh.name + ' · ' + n);
      chip.addEventListener('click', () => selectShelf(sh.id));
      // Dropping a book card onto a chip files it — the fastest way to sort a
      // pile of new imports.
      chip.addEventListener('dragover', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('text/plain')) return;
        e.preventDefault();
        chip.classList.add('drop');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
      chip.addEventListener('drop', async (e) => {
        chip.classList.remove('drop');
        const id = e.dataTransfer && e.dataTransfer.getData('text/plain');
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        await Store.toggleBookShelf(id, sh.id, true);
        await refreshLibrary();
        toast(t('toast.moved', { name: sh.name }), 'ok', 1600);
      });
      row.appendChild(chip);
    }

    const add = $('#btn-new-shelf');
    if (add) {
      add.setAttribute('aria-label', t('lib.newShelf'));
      add.title = t('lib.newShelf');
      add.querySelector('.lbl').textContent = t('lib.newShelf');
    }

    const SORTS = [['recent', 'lib.sort.recent'], ['added', 'lib.sort.added'],
                   ['title', 'lib.sort.title'], ['author', 'lib.sort.author']];
    const sort = $('#sort-select');
    if (sort) {
      sort.innerHTML = '';
      for (const [value, key] of SORTS) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = t(key);
        sort.appendChild(o);
      }
      sort.value = state.sort;
    }
    // Phone control: a button showing the current order, plus a popover. Kept
    // in sync here so both controls always agree on the label.
    const now = $('#sort-now');
    if (now) {
      const key = (SORTS.find((x) => x[0] === state.sort) || SORTS[0])[1];
      now.textContent = t(key);
    }
    const pop = $('#sort-pop');
    if (pop) {
      pop.innerHTML = '';
      for (const [value, key] of SORTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.sort = value;
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(state.sort === value));
        b.className = state.sort === value ? 'on' : '';
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = '✓';
        const lbl = document.createElement('span');
        lbl.textContent = t(key);
        b.append(tick, lbl);
        b.addEventListener('click', () => {
          setSort(value);
          closeSortMenu();
        });
        pop.appendChild(b);
      }
    }
    const sortLabel = $('#sort-label');
    if (sortLabel) sortLabel.textContent = t('lib.sort');
    wireChipScrollHint();
  }

  function setSort(value) {
    state.sort = value;
    state.prefs.sort = value;
    savePrefs();
    renderShelfChrome();
    renderShelf();
  }

  function closeSortMenu() {
    const pop = $('#sort-pop');
    const btn = $('#btn-sort');
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  /* Chip contents: <span class=chip-name> + <span class=chip-count>. Splitting
   * them lets the name ellipsis-truncate inside a fixed max-width while the
   * count stays legible; a single text node would either overflow the bar or be
   * clipped mid-number. */
  function chipLabel(name, n) {
    const frag = document.createDocumentFragment();
    const nm = document.createElement('span');
    nm.className = 'chip-name';
    nm.textContent = name;
    const ct = document.createElement('span');
    ct.className = 'chip-count';
    ct.textContent = String(n);
    frag.append(nm, ct);
    return frag;
  }

  /* The shelf bar sticks directly UNDER the sticky library header, so a long
   * grid can still be filtered without scrolling back to the top. The header's
   * height is published as --lib-head-h because it includes a safe-area inset
   * that plain CSS cannot read; measuring it keeps the two from overlapping on
   * notched phones. */
  function wireStickyShelfBar() {
    const bar = $('#shelf-bar');
    const head = $('.lib-head');
    if (!bar || !head) return;

    const syncHead = () => {
      const h = Math.round(head.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--lib-head-h', h + 'px');
    };
    syncHead();
    if (bar.dataset.stickyBound !== '1') {
      window.addEventListener('resize', syncHead);
      window.addEventListener('orientationchange', syncHead);
      if (window.ResizeObserver) new ResizeObserver(syncHead).observe(head);
      bar.dataset.stickyBound = '1';
    }

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const top = bar.getBoundingClientRect().top;
        bar.classList.toggle('stuck', top <= head.getBoundingClientRect().height + 0.5);
      });
    };
    if (bar.dataset.scrollBound !== '1') {
      window.addEventListener('scroll', onScroll, { passive: true });
      bar.dataset.scrollBound = '1';
    }
    onScroll();
  }

  /* The chip strip is the only scrolling part of the bar. A right-edge fade
   * appears while content remains off-screen — without it the last chip looks
   * cut off by accident rather than scrollable. */
  function wireChipScrollHint() {
    const strip = $('#shelf-chips');
    const bar = $('#shelf-bar');
    if (!strip || !bar) return;
    const tools = $('.shelf-tools');
    const sync = () => {
      const more = strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 4;
      bar.classList.toggle('more', more);
      if (tools) {
        // The fade is pinned to the strip's right edge, which is the bar width
        // minus the fixed cluster. Measuring beats hard-coding a rem value that
        // is 4x off on a phone.
        document.documentElement.style.setProperty(
          '--tools-w', Math.round(tools.getBoundingClientRect().width) + 'px');
      }
    };
    if (strip.dataset.hintBound !== '1') {
      strip.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      // A mouse has no horizontal wheel, so translate a vertical wheel over the
      // strip into horizontal scrolling — but only while it can still move, so
      // the page keeps scrolling normally at either end.
      strip.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        const max = strip.scrollWidth - strip.clientWidth;
        if (max <= 4) return;
        const goingRight = e.deltaY > 0;
        const canMove = goingRight ? strip.scrollLeft < max - 1 : strip.scrollLeft > 0;
        if (!canMove) return;
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }, { passive: false });
      strip.dataset.hintBound = '1';
    }
    requestAnimationFrame(sync);
  }

  function sortedBooks(list) {
    const items = list.slice();
    const by = state.sort;
    const az = (x, y) => String(x || '').localeCompare(String(y || ''), I18N.get(), { sensitivity: 'base' });
    if (by === 'title') items.sort((a, b) => az(a.title, b.title));
    else if (by === 'author') items.sort((a, b) => az(a.author, b.author) || az(a.title, b.title));
    else if (by === 'added') items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    else items.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0));
    return items;
  }

  function selectShelf(id) {
    state.shelf = id || null;
    renderShelfChrome();
    renderShelf();
    // Keep the choice in the URL hash so a reload (or a phone share) lands on
    // the same shelf instead of silently back on "All books".
    try {
      const u = new URL(location.href);
      if (id) u.hash = 'shelf=' + encodeURIComponent(id); else u.hash = '';
      history.replaceState(null, '', u);
    } catch (_) {}
  }

  function restoreShelfFromHash() {
    const m = /(?:^#|&)shelf=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    try {
      const id = decodeURIComponent(m[1]);
      if (state.shelves.some((sh) => sh.id === id)) state.shelf = id;
    } catch (_) {}
  }

  async function createShelf() {
    const name = (window.prompt(t('shelf.namePrompt')) || '').trim();
    if (!name) return;
    if (state.shelves.some((sh) => sh.name.toLowerCase() === name.toLowerCase())) {
      toast(t('shelf.nameTaken'), 'err', 2400);
      return;
    }
    const shelf = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, createdAt: Date.now() };
    await Store.putShelf(shelf);
    await refreshShelves();
    selectShelf(shelf.id);
    toast(t('shelf.created', { name }), 'ok');
  }

  async function renameShelf(sh) {
    const name = (window.prompt(t('shelf.rename'), sh.name) || '').trim();
    if (!name || name === sh.name) return;
    if (state.shelves.some((x) => x.id !== sh.id && x.name.toLowerCase() === name.toLowerCase())) {
      toast(t('shelf.nameTaken'), 'err', 2400);
      return;
    }
    await Store.putShelf({ ...sh, name });
    await refreshShelves();
    renderShelfChrome();
    renderShelf();
    toast(t('shelf.renamed'), 'ok');
  }

  async function deleteShelf(sh) {
    if (!window.confirm(t('shelf.deleteConfirm', { name: sh.name }))) return;
    await Store.deleteShelf(sh.id);
    if (state.shelf === sh.id) state.shelf = null;
    await refreshShelves();
    await refreshLibrary();
    toast(t('shelf.deleted'), 'ok');
  }

  /* Per-book shelf picker: a checkbox list of every shelf. Used from the card
   * menu, because a book can sit on several shelves at once. */
  function openShelfPicker(book) {
    state.pickShelfFor = book.id;
    const pop = $('#shelf-pop');
    if (!pop) return;
    $('#shelf-pop-title').textContent = t('shelf.picker', { title: book.title || '—' });
    const list = $('#shelf-pop-list');
    list.innerHTML = '';

    if (!state.shelves.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = t('shelf.empty');
      list.appendChild(p);
    }

    for (const sh of state.shelves) {
      const on = bookShelves(book).includes(sh.id);
      const lab = document.createElement('label');
      lab.className = 'shelf-pick';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.dataset.shelf = sh.id;
      cb.addEventListener('change', async () => {
        await Store.toggleBookShelf(book.id, sh.id, cb.checked);
        await refreshLibrary();
        renderShelfChrome();
      });
      const span = document.createElement('span');
      span.textContent = sh.name;
      lab.append(cb, span);
      list.appendChild(lab);
    }

    const foot = $('#shelf-pop-foot');
    foot.innerHTML = '';
    if (bookShelves(book).length) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'btn btn-sm';
      off.textContent = t('lib.removeFromShelf');
      off.addEventListener('click', async () => {
        await Store.setBookShelves(book.id, []);
        await refreshLibrary();
        renderShelfChrome();
        closeShelfPicker();
      });
      foot.appendChild(off);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-sm btn-primary';
    add.textContent = '+ ' + t('lib.newShelf');
    add.addEventListener('click', async () => {
      const name = (window.prompt(t('shelf.namePrompt')) || '').trim();
      if (!name) return;
      if (state.shelves.some((sh) => sh.name.toLowerCase() === name.toLowerCase())) {
        toast(t('shelf.nameTaken'), 'err', 2400);
        return;
      }
      const shelf = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, createdAt: Date.now() };
      await Store.putShelf(shelf);
      await Store.toggleBookShelf(book.id, shelf.id, true);
      await refreshShelves();
      await refreshLibrary();
      renderShelfChrome();
      openShelfPicker({ ...book, shelves: [...bookShelves(book), shelf.id] });
    });
    foot.appendChild(add);

    pop.hidden = false;
    $('#scrim').hidden = false;
  }

  function closeShelfPicker() {
    const pop = $('#shelf-pop');
    if (pop) pop.hidden = true;
    if ($('#drawer-aa').hidden && $('#drawer-toc').hidden && $('#drawer-notes').hidden) {
      $('#scrim').hidden = true;
    }
    state.pickShelfFor = null;
  }

  /* Shelf manager: rename / delete every shelf in one list. */
  function openShelfManager() {
    const pop = $('#shelf-manager');
    if (!pop) return;
    const list = $('#shelf-manager-list');
    list.innerHTML = '';
    if (!state.shelves.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = t('shelf.empty');
      list.appendChild(p);
    }
    for (const sh of state.shelves) {
      const n = state.books.filter((b) => bookShelves(b).includes(sh.id)).length;
      const row = document.createElement('div');
      row.className = 'shelf-mrow';
      const name = document.createElement('strong');
      name.textContent = sh.name;
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = t('shelf.bookCount', { n });
      const rn = document.createElement('button');
      rn.type = 'button';
      rn.className = 'btn btn-sm';
      rn.textContent = t('shelf.rename');
      rn.addEventListener('click', () => renameShelf(sh).then(() => openShelfManager()));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-sm btn-danger';
      del.textContent = t('shelf.delete');
      del.addEventListener('click', () => deleteShelf(sh).then(() => openShelfManager()));
      row.append(name, count, rn, del);
      list.appendChild(row);
    }
    pop.hidden = false;
    $('#scrim').hidden = false;
  }

  function closeShelfManager() {
    const pop = $('#shelf-manager');
    if (pop) pop.hidden = true;
    if ($('#drawer-aa').hidden && $('#drawer-toc').hidden && $('#drawer-notes').hidden) {
      $('#scrim').hidden = true;
    }
  }

  function renderShelf() {
    const shelf = $('#shelf');
    const q = ($('#search').value || '').trim().toLowerCase();
    const inShelf = (b) => !state.shelf || bookShelves(b).includes(state.shelf);
    const books = sortedBooks(state.books.filter((b) => {
      if (!inShelf(b)) return false;
      if (!q) return true;
      return (b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q);
    }));

    // "Empty" means an empty library, not an empty filter — a filtered grid
    // shows the no-match line instead, so the import button does not vanish.
    $('#empty').hidden = state.books.length > 0;
    const noShelfBooks = $('#shelf-empty');
    if (noShelfBooks) noShelfBooks.hidden = !(state.shelf && !books.length && !q);

    shelf.innerHTML = '';
    for (const b of books) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.id = b.id;
      // Drag a card onto a shelf chip to file it.
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', b.id);
        e.dataTransfer.effectAllowed = 'copy';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      const cover = document.createElement('div');
      cover.className = 'card-cover';
      cover.tabIndex = 0;
      cover.setAttribute('role', 'button');
      cover.setAttribute('aria-label', t('continue.open') + ' ' + b.title);

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

      // Shelf button: only when shelves exist, so a fresh library stays clean.
      if (state.shelves.length) {
        const shb = document.createElement('button');
        shb.className = 'card-shelf';
        shb.type = 'button';
        shb.title = t('lib.moveTo');
        shb.setAttribute('aria-label', t('lib.moveTo') + ' — ' + (b.title || ''));
        shb.textContent = '▤';
        const on = bookShelves(b);
        if (on.length) shb.dataset.count = String(on.length);
        shb.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openShelfPicker(b);
        });
        cover.appendChild(shb);
      }

      const del = document.createElement('button');
      del.className = 'card-del';
      del.type = 'button';
      del.title = t('hl.delete') + ' ' + b.title;
      del.setAttribute('aria-label', t('hl.delete') + ' ' + b.title);
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDelete(b);
      });
      cover.appendChild(del);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      // NB: do not name these `t` — that shadows the t() translator in scope.
      const titleEl = document.createElement('p');
      titleEl.className = 'card-title';
      titleEl.textContent = b.title || 'Untitled';
      const authorEl = document.createElement('span');
      authorEl.className = 'card-author';
      authorEl.textContent = b.author || '—';
      meta.append(titleEl, authorEl);
      // Where it is filed, so you can tell at a glance in "All books".
      const onShelves = bookShelves(b).map(shelfName).filter(Boolean);
      if (onShelves.length && !state.shelf) {
        const shEl = document.createElement('span');
        shEl.className = 'card-shelves';
        shEl.textContent = onShelves.join(' · ');
        meta.appendChild(shEl);
      }

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

    if (!books.length && state.books.length && q) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.gridColumn = '1 / -1';
      p.textContent = t('empty.nomatch', { q });
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
      note.textContent = t('storage.used', { mb }) + (persist ? t('storage.persisted') : '');
    } catch (_) { note.textContent = ''; }
  }

  async function confirmDelete(book) {
    const n = (await Store.listHighlights(book.id)).length;
    const msg = n ? t('toast.deleteconfirmnotes', { title: book.title, n }) : t('toast.deleteconfirm', { title: book.title });
    if (!window.confirm(msg)) return;
    await Store.deleteBook(book.id);
    const u = coverUrls.get(book.id);
    if (u) { URL.revokeObjectURL(u); coverUrls.delete(book.id); }
    if (state.book && state.book.id === book.id) closeReader();
    await refreshLibrary();
    toast(t('toast.deleted'), 'ok');
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
      s.onerror = () => reject(new Error(t('toast.openfail', { msg: src })));
      document.head.appendChild(s);
    });
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []).map((f) => ({ file: f, format: formatOf(f) }))
      .filter((x) => x.format);
    if (!files.length) {
      toast(t('toast.pickformat'), 'err');
      return;
    }
    // Ask for durable storage up front — browsers may otherwise evict the books.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    for (const { file, format } of files) {
      toast(t('toast.importing', { name: file.name }), null, 60000);
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
        toast(t('toast.imported', { title: entry.title }), 'ok');
      } catch (err) {
        console.error(err);
        toast(t('toast.importfail', { name: file.name, msg: err.message || err }), 'err', 6000);
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
    if (!meta) { toast(t('toast.notfound'), 'err'); return; }
    const buf = await Store.getFile(id);
    if (!buf) {
      toast(t('toast.missingfile'), 'err', 7000);
      return;
    }
    toast(t('toast.opening'), null, 8000);
    try {
      state.epub = await openAny(meta.format || 'epub', buf, meta.title || '');
    } catch (e) {
      toast(t('toast.openfail', { msg: e.message || e }), 'err', 7000);
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
    if (TTS.playing) ttsStop();
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


  /* ─────────────────────────── read aloud ─────────────────────────── */

  /* The book's own language decides the voice. It is the only honest source:
   * the UI language says nothing about the text being read. */
  function bookLang() {
    const raw = (state.book && state.book.language) || (state.epub && state.epub.language) || '';
    const l = String(raw).trim().toLowerCase().replace('_', '-');
    if (!l) return '';
    // dc:language is often "zh" or "zho"; normalise the three-letter codes the
    // metadata actually uses so voice matching has something to match.
    const map = { zho: 'zh', chi: 'zh', eng: 'en', jpn: 'ja', kor: 'ko', cmn: 'zh' };
    const base = map[l] || l;
    // A bare "zh" says nothing about script; lean on the UI locale for that,
    // because a Cantonese reader wants zh-HK and will have it installed.
    if (base === 'zh') return I18N.get() === 'zh-Hans' ? 'zh-CN' : (I18N.get() === 'en' ? 'zh' : 'zh-HK');
    return base;
  }

  function ttsVoiceOptions() {
    const sel = $('#opt-tts-voice');
    if (!sel) return;
    const lang = bookLang();
    const list = TTS.voices();
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    const autoVoice = TTS.pickVoice(lang, state.prefs.ttsVoice);
    auto.textContent = autoVoice
      ? t('tts.auto') + ' — ' + autoVoice.name
      : t('tts.auto');
    sel.appendChild(auto);

    // Show the book's language first, then everything else: a device can carry
    // dozens of voices and the relevant ones are what you want at the top.
    const base = String(lang).toLowerCase().split('-')[0];
    const matching = list.filter((v) => String(v.lang || '').toLowerCase().startsWith(base));
    const others = list.filter((v) => !matching.includes(v));
    for (const v of matching.concat(others)) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name + ' · ' + v.lang;
      sel.appendChild(o);
    }
    sel.value = state.prefs.ttsVoice || '';

    // Honest note when the device cannot read this book at all.
    const note = $('#tts-note');
    if (note) {
      const has = TTS.canSpeak(lang);
      const zh = String(lang).startsWith('zh');
      const anyZh = TTS.voices().some((v) => String(v.lang || '').toLowerCase().startsWith('zh'));
      if (!TTS.supported) { note.textContent = t('tts.unsupported'); note.hidden = false; }
      else if (zh && !anyZh) { note.textContent = t('tts.nozh'); note.hidden = false; }
      else if (!has) { note.textContent = t('tts.novoice', { lang }); note.hidden = false; }
      else { note.hidden = true; note.textContent = ''; }
    }
  }

  function ttsSyncUi() {
    const btn = $('#btn-tts');
    const bar = $('#tts-bar');
    const playing = TTS.playing;
    const paused = TTS.paused;
    if (btn) {
      btn.setAttribute('aria-pressed', String(playing && !paused));
      btn.classList.toggle('on', playing);
    }
    if (bar) {
      bar.hidden = !playing;
      bar.classList.toggle('paused', paused);
    }
    const play = $('#tts-play');
    if (play) {
      play.setAttribute('aria-pressed', String(paused));
      play.setAttribute('aria-label', paused ? t('tts.play') : t('tts.pause'));
    }
    const fill = $('#tts-fill');
    if (fill) {
      const total = TTS.total || 1;
      fill.style.width = (playing ? Math.round(((TTS.index + 1) / total) * 100) : 0) + '%';
    }
    const pos = $('#tts-pos');
    if (pos) pos.textContent = playing ? t('tts.pos', { i: TTS.index + 1, n: TTS.total }) : '';
  }

  /* Start listening from a block element (a tapped paragraph) or the top. */
  function ttsStart(fromEl) {
    if (!TTS.supported) { toast(t('tts.unsupported'), 'err', 4000); return; }
    state.prefs.ttsOn = true;
    savePrefs();
    const ok = TTS.start($('#chapter'), {
      fromEl: fromEl || null,
      rate: state.prefs.ttsRate,
      voiceURI: state.prefs.ttsVoice,
      lang: bookLang(),
    });
    if (!ok) { toast(t('tts.empty'), 'err', 3000); }
    ttsSyncUi();
  }

  function ttsStop() {
    TTS.stop();
    ttsSyncUi();
  }

  /* The mode switch in the settings drawer is also the on/off for tap-to-read:
   * with it on, a tap on a paragraph starts there; with it off the reader
   * behaves as before. */
  function ensureTtsWired() {
    if (state.ttsWired) return;
    state.ttsWired = true;

    TTS.on('change', () => {
      ttsSyncUi();
      // Voices arrive asynchronously; refresh the picker when they do.
      ttsVoiceOptions();
    });
    TTS.on('fail', (kind) => {
      ttsSyncUi();
      if (kind === 'unsupported') toast(t('tts.unsupported'), 'err', 4000);
      else if (kind === 'empty') toast(t('tts.empty'), 'err', 3000);
      else if (kind === 'silent') {
        // Nothing came out. Say the useful thing: which language has no voice.
        const lang = bookLang();
        const why = TTS.voices().length
          ? t('tts.novoice', { lang })
          : (String(lang).startsWith('zh') ? t('tts.nozh') : t('tts.unsupported'));
        toast(why, 'err', 6500);
      }
      else if (kind && kind !== 'interrupted') {
        // 'not-allowed' is the browser refusing speech — usually a policy, and
        // the user needs to know rather than wonder why nothing happened.
        toast(t('tts.unsupported') + ' (' + kind + ')', 'err', 4000);
      }
    });
  }

  async function renderChapter(index, anchor) {
    if (!state.epub) return;
    // The speech queue references the old chapter's DOM; speaking on after a
    // jump would read a paragraph that is no longer on screen.
    if (TTS.playing) ttsStop();
    const total = state.epub.chapters.length;
    index = Math.max(0, Math.min(index, total - 1));
    state.chapter = index;

    const ch = state.epub.renderChapter(index);
    const root = $('#chapter');

    // Update the chrome BEFORE the (possibly async) page paint: a PDF takes a
    // few hundred ms to draw, and leaving the old chapter's label on screen
    // during that window looks like the navigation failed.
    $('#rd-chapter').textContent = ch.title || (ch.titleKind === 'page'
      ? t('reader.page', { n: index + 1 })
      : t('reader.section', { n: index + 1 }));
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
        ? t('toast.quota')
        : t('toast.savefail', { msg: e && e.message ? e.message : e });
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
      toast(t('toast.fullscreenfallback'), null, 3200);
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
      toast(t('toast.fullscreenfail', { msg: e.message || e }), 'err', 4000);
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
        label: c.title || t(c.titleKind === 'page' ? 'reader.page' : 'reader.section', { n: i + 1 }),
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
      p.textContent = t('notes.empty');
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
        const noteEl = document.createElement('div');
        noteEl.className = 'note-text';
        noteEl.textContent = h.note;
        item.appendChild(noteEl);
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
          toast(t('toast.hlanchor'), 'err', 4000);
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
      toast(t('toast.hlsavefail', { msg: e.message || e }), 'err', 5000);
      return;
    }
    state.highlights.push(hl);
    // Repaint this chapter so the mark is exact (cheap: one chapter of DOM).
    await renderChapter(state.chapter, null);
    hideSelBar();
    window.getSelection().removeAllRanges();
    renderNotes();
    toast(t('toast.hlcreated'), 'ok', 1200);
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
      toast(t('toast.notesaved'), 'ok', 1400);
    } catch (e) {
      toast(t('toast.notesavefail', { msg: e.message || e }), 'err', 5000);
      return;
    }
    hideHlPop();
    await renderChapter(state.chapter, null);
    renderNotes();
  }

  async function deleteHl() {
    const id = $('#hl-pop').dataset.hlId;
    if (!id) return;
    if (!window.confirm(t('toast.hldeleteconfirm'))) return;
    try {
      await Store.deleteHighlight(id);
    } catch (e) {
      toast(t('toast.hldeletefail', { msg: e.message || e }), 'err', 5000);
      return;
    }
    state.highlights = state.highlights.filter((h) => h.id !== id);
    hideHlPop();
    await renderChapter(state.chapter, null);
    renderNotes();
    toast(t('toast.deleted'), 'ok', 1300);
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
    // The shelf popovers share the same scrim.
    const sp = $('#shelf-pop'); if (sp) sp.hidden = true;
    const sm = $('#shelf-manager'); if (sm) sm.hidden = true;
    state.pickShelfFor = null;
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
    toast(t('toast.exported', { n: data.highlights.length }), 'ok', 4000);
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
        if (payload.app !== 'yomu') throw new Error(t('toast.notbackup'));
        await Store.importData(payload);
        await refreshLibrary();
        toast(t('toast.restored', { n: payload.highlights ? payload.highlights.length : 0 }), 'ok', 4000);
      } catch (e) {
        toast(t('toast.restorefail', { msg: e.message || e }), 'err', 6000);
      }
    });
    input.click();
  }

  async function showAllNotes() {
    const rows = await Store.allHighlights();
    if (!rows.length) { toast(t('toast.nonotes')); return; }
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
    toast(t('toast.notesmd', { n: rows.length }), 'ok', 3500);
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function wire() {
    // library
    $('#btn-import').addEventListener('click', () => $('#file-input').click());
    // The library header gets its own theme toggle so dark mode is reachable
    // without opening a book.
    $('#btn-theme-lib').addEventListener('click', toggleTheme);
    $('#file-input').addEventListener('change', (e) => {
      importFiles(e.target.files);
      e.target.value = '';
    });
    $$('[data-action="import"]').forEach((b) => b.addEventListener('click', () => $('#file-input').click()));
    $('#search').addEventListener('input', renderShelf);
    $('#btn-continue').addEventListener('click', () => state.lastContinueId && openBook(state.lastContinueId));

    const sortSel = $('#sort-select');
    if (sortSel) {
      sortSel.addEventListener('change', (e) => setSort(e.target.value));
    }
    const sortBtn = $('#btn-sort');
    if (sortBtn) {
      sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = $('#sort-pop');
        const open = pop.hidden;
        pop.hidden = !open;
        sortBtn.setAttribute('aria-expanded', String(open));
      });
    }
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.shelf-tools')) closeSortMenu();
    });
    const newShelfBtn = $('#btn-new-shelf');
    if (newShelfBtn) newShelfBtn.addEventListener('click', createShelf);
    wireChipScrollHint();
    wireStickyShelfBar();

    const shClose = $('#shelf-pop-close');
    if (shClose) shClose.addEventListener('click', closeShelfPicker);
    const smClose = $('#shelf-manager-close');
    if (smClose) smClose.addEventListener('click', closeShelfManager);

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
      if (what === 'storage') updateStorageNote().then(() => toast($('#storage-note').textContent || t('toast.unknown')));
      if (what === 'manage') openShelfManager();
      if (what === 'lang') cycleLanguage();
      if (what === 'theme') toggleTheme();
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
      try { await navigator.clipboard.writeText(pendingSel.text); toast(t('toast.copied'), 'ok', 1200); }
      catch (_) { toast(t('toast.copyfail'), 'err'); }
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
    $('#btn-theme').addEventListener('click', toggleTheme);
    document.addEventListener('fullscreenchange', syncFullscreenUi);
    document.addEventListener('webkitfullscreenchange', syncFullscreenUi);

    // read aloud
    ensureTtsWired();
    ttsVoiceOptions();
    $('#btn-tts').addEventListener('click', () => {
      if (TTS.playing) ttsStop();
      else ttsStart(null);
    });
    $('#tts-play').addEventListener('click', () => { TTS.toggle(); ttsSyncUi(); });
    $('#tts-prev').addEventListener('click', () => { TTS.prev(); ttsSyncUi(); });
    $('#tts-next').addEventListener('click', () => { TTS.next(); ttsSyncUi(); });
    $('#tts-close').addEventListener('click', () => ttsStop());
    $('#opt-tts').addEventListener('change', (e) => {
      state.prefs.ttsOn = e.target.checked;
      savePrefs();
      if (!state.prefs.ttsOn) { ttsStop(); return; }
      // Turning it on with a book open reads from the top: the mode is not a
      // hidden preference, it has to demonstrably do something.
      closeDrawers();
      ttsStart(null);
    });
    $('#opt-tts-rate').addEventListener('input', (e) => {
      state.prefs.ttsRate = TTS.setRate(e.target.value);
      $('#out-tts-rate').textContent = Number(state.prefs.ttsRate).toFixed(1) + '×';
      savePrefs();
    });
    $('#opt-tts-voice').addEventListener('change', (e) => {
      state.prefs.ttsVoice = e.target.value;
      TTS.setVoice(e.target.value);
      savePrefs();
    });

    // language
    $('#opt-lang').addEventListener('change', (e) => setLanguage(e.target.value));

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
        if (k === 'd') { toggleTheme(); }
        if (k === 'l') { cycleLanguage(); }
        if (k === 's') { if (TTS.playing) ttsStop(); else ttsStart(null); }
        if (e.key === ' ' && TTS.playing) { e.preventDefault(); TTS.toggle(); ttsSyncUi(); }
        if (k === 'F11' || e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
      }
    });

    /* Tap-to-read: with the mode on, a tap on a paragraph reads FROM it. This
     * is the whole interaction model — no "start" button needed once enabled.
     * Links and existing highlights keep their own behaviour. */
    $('#chapter').addEventListener('click', (e) => {
      if (!state.prefs.ttsOn || !TTS.supported) return;
      if (e.target.closest('a[data-yomu-chapter], mark[data-hl-id]')) return;
      if (!window.getSelection().isCollapsed) return;   // a selection is not a tap
      const block = e.target.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, figcaption, dd, dt');
      if (!block) return;
      if (TTS.playing) {
        const i = TTS.indexOfEl(block);
        if (i >= 0) { TTS.jumpTo(i); ttsSyncUi(); }
      } else {
        ttsStart(block);
      }
    }, true);   // capture: run before the zen-tap handler below

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
      restoreShelfFromHash();
      renderShelfChrome();
      renderShelf();
    } catch (e) {
      toast(t('toast.libfail', { msg: e.message || e }), 'err', 6000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
