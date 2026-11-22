/* Yomu — read-aloud (speech synthesis).
 *
 * Design notes, because a naive SpeechSynthesis integration is a bug farm:
 *
 * 1. NEVER call speak() with a whole chapter. Chrome caps an utterance at a few
 *    hundred characters on some platforms and silently truncates; it also makes
 *    highlighting impossible and makes "next paragraph" unresponsive. Speak one
 *    block at a time.
 *
 * 2. Chrome/Android drops `speak()` calls (and fires `onend` immediately) if the
 *    engine is still busy — most visibly after cancel(). Every utterance is
 *    therefore started through a short, cancellable delay, and `paused` is reset
 *    before each one.
 *
 * 3. Voice lists load asynchronously (`voiceschanged`), so a stored voiceURI may
 *    not resolve on the first frame. Resolve voices lazily at speak time, and
 *    fall back to the first voice whose language matches.
 *
 * 4. `onend` also fires when an utterance is cancelled. A monotonically
 *    increasing token distinguishes "finished" from "we killed it", otherwise
 *    pressing Stop advances to the next paragraph.
 */
(function () {
  'use strict';

  const synth = window.speechSynthesis || null;
  const supported = !!(synth && window.SpeechSynthesisUtterance);

  const state = {
    queue: [],        // [{ el, text }]
    index: 0,
    playing: false,
    paused: false,
    rate: 1,
    voiceURI: '',
    lang: '',
    token: 0,
    highlight: null,  // the element currently wearing .tts-now
    timer: null,
  };

  const listeners = { change: [], fail: [] };
  const on = (evt, fn) => { (listeners[evt] || (listeners[evt] = [])).push(fn); };
  const emit = (evt, payload) => { for (const fn of listeners[evt] || []) fn(payload); };

  /* ── voices ─────────────────────────────────────────────────────── */

  function voices() {
    if (!supported) return [];
    try { return synth.getVoices() || []; } catch (_) { return []; }
  }

  /* Pick a voice for a language tag. Exact match first (en-GB over en), then a
   * primary-subtag match, then the closest regional neighbour for the big
   * Chinese/English ambiguity. Returns null rather than guessing wildly. */
  function pickVoice(lang, wantURI) {
    const all = voices();
    if (!all.length) return null;
    if (wantURI) {
      const exact = all.find((v) => v.voiceURI === wantURI);
      if (exact) return exact;
    }
    if (!lang) return all.find((v) => v.default) || all[0];
    const want = String(lang).toLowerCase().replace('_', '-');
    const base = want.split('-')[0];

    const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
    // 1. exact tag
    let v = all.find((x) => norm(x) === want);
    if (v) return v;
    // 2. zh-Hant / zh-Hans: the tag alone cannot distinguish script, so use the
    //    voice's own name (Google 國語（臺灣） vs 普通话) as the tiebreaker.
    if (base === 'zh') {
      const trad = ['tw', 'hk', 'mo', 'hant'];
      const simp = ['cn', 'sg', 'my', 'hans'];
      const wantTrad = trad.some((k) => want.includes(k));
      const zh = all.filter((x) => norm(x).startsWith('zh'));
      const named = zh.find((x) => wantTrad
        ? /(taiwan|臺灣|台湾|hong kong|香港|traditional|hant)/i.test(x.name + ' ' + norm(x))
        : /(mainland|china|中国|中國|simplified|hans|普通话|普通話)/i.test(x.name + ' ' + norm(x)));
      if (named) return named;
      const regional = zh.find((x) => (wantTrad
        ? /-(tw|hk|mo)/.test(norm(x))
        : /-(cn|sg|my)/.test(norm(x))));
      if (regional) return regional;
      if (zh.length) return zh[0];
    }
    // 3. same primary language, any region
    v = all.find((x) => norm(x).split('-')[0] === base);
    if (v) return v;
    // 4. nothing matched: null, and the engine uses its default.
    return null;
  }

  function canSpeak(lang) {
    if (!supported) return false;
    const all = voices();
    if (!all.length) return true;      // not loaded yet: let it try
    const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
    return all.some((v) => String(v.lang || '').toLowerCase().startsWith(base));
  }

  /* ── queue building ─────────────────────────────────────────────── */

  // Only containers whose content is NOT readable prose. MARK is deliberately
  // absent: a highlight wraps real text, and skipping it silently drops a word
  // from the sentence ("Alpha beta gamma" → "Alpha gamma").
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IMG', 'CANVAS', 'OBJECT', 'IFRAME', 'MATH']);
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE',
    'TD', 'TH', 'DT', 'DD', 'FIGCAPTION', 'DIV', 'SECTION', 'ARTICLE',
  ]);

  /* Turn the rendered chapter into an ordered list of speakable blocks.
   *
   * Strategy: walk the DOM, and cut a new block at every block-level element
   * that holds meaningful text. Inside a block, inline content (a, em, span,
   * code) is flattened into the same sentence — splitting at an <em> would make
   * the speech stutter.
   *
   * Each block maps back to the outermost block element so the reader can
   * highlight it while it is spoken. */
  function buildQueue(root) {
    const items = [];

    const textOf = (node) => {
      // Text only: drop mark/style internals so a highlight never gets spoken
      // twice, and normalise the whitespace the way a reader would.
      let out = '';
      const walk = (n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        // tagName is upper-case for HTML but keeps its case (lower) for SVG/MathML
        // children, so a raw SKIP.has() silently misses <svg>.
        if (SKIP.has(String(n.tagName || '').toUpperCase())) return;
        if (n.dataset && n.dataset.bookCss) return;
        for (const c of n.childNodes) walk(c);
        // A <br> is a real pause.
        if (n.tagName === 'BR') out += ' ';
      };
      walk(node);
      return out.replace(/\s+/g, ' ').trim();
    };

    const pushBlock = (el) => {
      const text = textOf(el);
      if (!text) return;
      // Minimum: a lone "1" or "*" from a page number is noise, not speech.
      const wordish = text.replace(/[^\p{L}\p{N}]/gu, '');
      if (wordish.length < 2) return;
      items.push({ el, text });
    };

    const scan = (node) => {
      for (const child of Array.from(node.children || [])) {
        if (SKIP.has(String(child.tagName || '').toUpperCase())) continue;
        if (child.dataset && child.dataset.bookCss) continue;
        if (child.dataset && child.dataset.ttsSkip) continue;   // hl inspector etc.

        if (BLOCK_TAGS.has(child.tagName)) {
          // A block with nested blocks (e.g. <li><p>…</p></li>, or a <div> of
          // <p>s) must recurse, not be read as one lump, or the highlight lands
          // on the whole list.
          // A block may hold inline wrappers that hold the real blocks
          // (<li><span><p>…). Looking only at direct element children queues the
          // whole <li> as one utterance, so the highlight covers the entire list.
          const hasBlockDescendant = (el) => Array.from(el.children || []).some((c) =>
            !SKIP.has(c.tagName) && (BLOCK_TAGS.has(c.tagName) || hasBlockDescendant(c)));
          const hasBlockChild = hasBlockDescendant(child);
          if (hasBlockChild) { scan(child); continue; }
          pushBlock(child);
        } else {
          scan(child);
        }
      }
    };

    scan(root);

    // Root-level loose text (rare: a chapter that is one bare text node).
    if (!items.length) {
      const loose = textOf(root);
      if (loose) items.push({ el: root, text: loose });
    }
    return items;
  }

  /* Highlight is a class on the block, not a <mark>: marks are user data and
   * must not be touched by the speech layer. */
  function setHighlight(el) {
    if (state.highlight === el) return;
    if (state.highlight) state.highlight.classList.remove('tts-now');
    state.highlight = el || null;
    if (state.highlight) state.highlight.classList.add('tts-now');
  }

  /* Keep the spoken block in view without yanking the page on every sentence:
   * scroll only when the block is outside the comfortable middle band. */
  function reveal(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const scroller = document.getElementById('scroll-area');
    if (!scroller) return;
    const r = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const topPad = view.height * 0.25;
    const botPad = view.height * 0.75;
    if (r.top < view.top + topPad || r.bottom > view.top + botPad) {
      const target = scroller.scrollTop + (r.top - view.top) - view.height * 0.3;
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }

  function notify() {
    emit('change', {
      supported,
      playing: state.playing,
      paused: state.paused,
      index: state.index,
      total: state.queue.length,
    });
  }

  /* ── playback ───────────────────────────────────────────────────── */

  function cancelPending() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.token++;
  }

  function speakCurrent() {
    const item = state.queue[state.index];
    if (!item) { finish(); return; }

    setHighlight(item.el);
    reveal(item.el);

    const u = new SpeechSynthesisUtterance(item.text);
    const v = pickVoice(state.lang, state.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; } else if (state.lang) u.lang = state.lang;
    u.rate = state.rate;
    const myToken = state.token;

    u.onend = () => {
      if (myToken !== state.token) return;   // superseded: not a real finish
      state.index++;
      if (state.index >= state.queue.length) finish();
      else speakCurrent();
      notify();
    };
    u.onerror = (e) => {
      if (myToken !== state.token) return;
      // 'interrupted' / 'canceled' are our own doing; 'not-allowed' means the
      // browser blocked speech without a gesture, which the user must know.
      const err = e && e.error;
      if (err === 'interrupted' || err === 'canceled') return;
      emit('fail', err || 'error');
      finish();
    };

    // Chrome keeps saying "speaking" right after cancel(); starting a new
    // utterance in the same task silently drops it. Yield first.
    cancelPending();
    state.token = myToken + 1;
    const token = state.token;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (token !== state.token || !state.playing || state.paused) return;
      const startedAt = state.index;
      try {
        if (synth.paused) synth.resume();
        synth.speak(u);
      } catch (err) {
        emit('fail', (err && err.message) || String(err));
        finish();
        return;
      }
      // Watchdog. A browser with no voice for this language (and no default)
      // accepts speak() and then does nothing — the transport would sit there
      // looking alive while silence comes out. If the engine is not speaking and
      // the queue has not advanced, say so instead of pretending.
      setTimeout(() => {
        if (token !== state.token || !state.playing || state.paused) return;
        if (state.index !== startedAt) return;      // it advanced: fine
        if (synth.speaking || synth.pending) return;
        emit('fail', 'silent');
        finish();
      }, 1500);
    }, 60);
  }

  function finish() {
    cancelPending();
    setHighlight(null);
    state.playing = false;
    state.paused = false;
    state.queue = [];
    state.index = 0;
    state.timer = null;
    try { if (synth) synth.cancel(); } catch (_) {}
    notify();
  }

  /* Start at `fromEl` (or the top). Returns false when nothing is speakable. */
  function start(root, opts) {
    if (!supported) { emit('fail', 'unsupported'); return false; }
    const o = opts || {};
    if (typeof o.rate === 'number') state.rate = o.rate;
    if (typeof o.voiceURI === 'string') state.voiceURI = o.voiceURI;
    if (typeof o.lang === 'string') state.lang = o.lang;

    const items = buildQueue(root, null);
    if (!items.length) { emit('fail', 'empty'); return false; }

    // Start at the tapped block, but keep the whole chapter queued: otherwise
    // "previous" has nowhere to go and the progress meter understates the work.
    let startAt = 0;
    if (o.fromEl) {
      const i = items.findIndex((it) => it.el === o.fromEl || (it.el && it.el.contains && it.el.contains(o.fromEl)));
      if (i > 0) startAt = i;
    }

    cancelPending();
    try { synth.cancel(); } catch (_) {}
    state.queue = items;
    state.index = startAt;
    state.playing = true;
    state.paused = false;
    notify();
    // Give the engine a beat after cancel() before the first utterance.
    setTimeout(() => { if (state.playing) speakCurrent(); }, 80);
    return true;
  }

  function stop() { if (state.playing || state.queue.length) finish(); }

  function pause() {
    if (!state.playing || state.paused) return;
    state.paused = true;
    try { synth.pause(); } catch (_) {}
    notify();
  }

  function resume() {
    if (!state.playing || !state.paused) return;
    state.paused = false;
    try { synth.resume(); } catch (_) {}
    // Some engines drop the paused utterance entirely; if nothing is speaking
    // after a resume, re-speak the current block.
    setTimeout(() => {
      if (state.playing && !state.paused && !synth.speaking && !synth.pending) speakCurrent();
    }, 260);
    notify();
  }

  function toggle() { if (state.paused) resume(); else pause(); }

  function next() {
    if (!state.queue.length) return false;
    cancelPending();
    try { synth.cancel(); } catch (_) {}
    state.index = Math.min(state.index + 1, state.queue.length - 1);
    state.paused = false;
    notify();
    speakCurrent();
    return true;
  }

  function prev() {
    if (!state.queue.length) return false;
    cancelPending();
    try { synth.cancel(); } catch (_) {}
    state.index = Math.max(state.index - 1, 0);
    state.paused = false;
    notify();
    speakCurrent();
    return true;
  }

  /* Jump to a specific block (tap a paragraph). */
  function jumpTo(i) {
    if (!state.queue.length) return false;
    const n = Math.max(0, Math.min(i, state.queue.length - 1));
    cancelPending();
    try { synth.cancel(); } catch (_) {}
    state.index = n;
    state.paused = false;
    notify();
    speakCurrent();
    return true;
  }

  function setRate(r) {
    state.rate = Math.max(0.5, Math.min(2, Number(r) || 1));
    // A live rate change needs the current sentence restarted; the Speech API
    // has no way to retune an utterance in flight.
    if (state.playing && !state.paused) {
      cancelPending();
      try { synth.cancel(); } catch (_) {}
      speakCurrent();
    }
    return state.rate;
  }

  function setVoice(uri) {
    state.voiceURI = uri || '';
    if (state.playing && !state.paused) {
      cancelPending();
      try { synth.cancel(); } catch (_) {}
      speakCurrent();
    }
  }

  /* Voices arrive late; re-emit so the settings list can fill itself. */
  if (supported) {
    try {
      synth.addEventListener('voiceschanged', () => emit('change', {
        supported, playing: state.playing, paused: state.paused,
        index: state.index, total: state.queue.length,
      }));
    } catch (_) {
      synth.onvoiceschanged = () => emit('change', { supported });
    }
    // Leaving the page must not leave a voice talking.
    window.addEventListener('pagehide', () => { try { synth.cancel(); } catch (_) {} });
  }

  window.YomuTTS = {
    supported, on, start, stop, pause, resume, toggle, next, prev, jumpTo,
    setRate, setVoice, canSpeak,
    get playing() { return state.playing; },
    get paused() { return state.paused; },
    get index() { return state.index; },
    get total() { return state.queue.length; },
    get rate() { return state.rate; },
    voices, pickVoice,
    utteranceAt: (i) => (state.queue[i] ? state.queue[i].text : ''),
    /* Which queue slot a clicked element belongs to. A tap inside a paragraph
     * lands on a <span>/<em> inside it, so walk up to the block we queued. */
    indexOfEl(el) {
      if (!el) return -1;
      for (let i = 0; i < state.queue.length; i++) {
        const q = state.queue[i].el;
        if (q === el) return i;
        if (q && q.contains && q.contains(el)) return i;
      }
      return -1;
    },
    currentEl: () => state.highlight,
  };
})();
