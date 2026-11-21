/* Yomu — highlights anchored by character offset.
 *
 * A highlight stores the chapter path plus [start, end) offsets into the
 * chapter's concatenated text, and the text itself as a checksum. On reload we
 * re-walk the DOM; if the text at those offsets no longer matches (the book
 * really did change) we search for the stored prefix+suffix as a fallback and
 * drop the mark only when both fail. Paragraphs, nested inline tags and
 * cross-element selections all survive because the anchor is a flat offset,
 * not a DOM path.
 */
(function () {
  'use strict';

  /* Text nodes we care about, in document order. Style/script text is excluded
   * (book CSS lives inside the article), and marks are NOT skipped — offsets
   * must match the canonical chapter text or a selection that touches an
   * existing highlight lands on the wrong characters. Rendering always starts
   * from freshly parsed HTML, so there are no marks to trip over at paint time. */
  function textNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.length) return NodeFilter.FILTER_REJECT;
        const p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  /* Offset table: [{node, start, end}] plus the concatenated text. */
  function buildIndex(root) {
    const nodes = textNodes(root);
    const table = [];
    let pos = 0;
    const parts = [];
    for (const node of nodes) {
      const len = node.nodeValue.length;
      table.push({ node, start: pos, end: pos + len });
      parts.push(node.nodeValue);
      pos += len;
    }
    return { table, text: parts.join(''), total: pos };
  }

  /* Translate an absolute offset to {node, off} inside the text-node table.
   * On a node boundary the start of a range takes the next node's offset 0 and
   * the end takes the previous node's end — both are the same absolute offset,
   * but picking the side that actually owns the character keeps the range valid
   * when the boundary falls between two elements. */
  function locate(table, offset, isEnd) {
    if (!table.length) return null;
    let lo = 0, hi = table.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = table[mid];
      if (offset < e.start) hi = mid - 1;
      else if (offset > e.end) lo = mid + 1;
      else { hit = mid; break; }
    }
    if (hit === -1) {
      const last = table[table.length - 1];
      return { node: last.node, off: last.node.nodeValue.length };
    }
    const e = table[hit];
    if (offset === e.end) {
      const next = table[hit + 1];
      if (!isEnd && next && next.start === offset) return { node: next.node, off: 0 };
      return { node: e.node, off: e.node.nodeValue.length };
    }
    return { node: e.node, off: offset - e.start };
  }

  /* Absolute offset for a DOM point (text or element container). */
  function pointOffset(container, offset, table) {
    if (container.nodeType === 3) {
      for (const e of table) if (e.node === container) return e.start + Math.min(offset, e.node.length);
      return null;
    }
    if (container.nodeType === 1) {
      const marker = document.createRange();
      try {
        marker.setStart(container, offset);
        marker.collapse(true);
      } catch (_) {
        return null;
      }
      for (const e of table) {
        if (marker.comparePoint(e.node, 0) <= 0) return e.start;
      }
      return table.length ? table[table.length - 1].end : 0;
    }
    return null;
  }

  /* Wrap [start,end) in <mark>. Splits boundary text nodes so the mark never
   * swallows sibling content. */
  function applyMark(table, start, end, color, id) {
    if (end <= start) return null;
    const a = locate(table, start, false);
    const b = locate(table, end, true);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a.node, a.off);
      range.setEnd(b.node, b.off);
    } catch (_) {
      return null;
    }
    const mark = document.createElement('mark');
    mark.dataset.hl = color;
    mark.dataset.hlId = id;
    try {
      range.surroundContents(mark);
    } catch (_) {
      // surroundContents throws when the range crosses element boundaries;
      // extract and re-insert instead.
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
    return mark;
  }

  /* Absolute offsets for the current selection, or null when it is empty or
   * outside the chapter root. */
  function selectionOffsets(root) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    // One index build for both ends and the snippet; chapters can hold 30k chars.
    const idx = buildIndex(root);
    const start = pointOffset(range.startContainer, range.startOffset, idx.table);
    const end = pointOffset(range.endContainer, range.endOffset, idx.table);
    if (start === null || end === null || end <= start) return null;
    const text = idx.text.slice(start, end).trim();
    if (!text) return null;
    return { start, end, text, range: range.cloneRange() };
  }

  /* Snippets stored with the highlight make the anchor self-verifying. */
  function contextAround(text, start, end, span) {
    span = span || 40;
    return {
      prefix: text.slice(Math.max(0, start - span), start),
      suffix: text.slice(end, Math.min(text.length, end + span)),
    };
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function locateStored(root, hl) {
    const idx = buildIndex(root);
    const { text, table } = idx;
    if (hl.start != null && hl.end != null && hl.end <= text.length) {
      const slice = text.slice(hl.start, hl.end);
      if (norm(slice) === norm(hl.text)) return { start: hl.start, end: hl.end, table, text };
    }
    // Text shifted: search for the exact snippet, nearest the old offset first.
    const needle = hl.text;
    if (needle) {
      const hits = [];
      let at = text.indexOf(needle);
      while (at !== -1 && hits.length < 40) {
        hits.push(at);
        at = text.indexOf(needle, at + 1);
      }
      if (hits.length) {
        // Prefer a hit whose surroundings match the stored context.
        let best = hits[0], bestScore = -Infinity;
        for (const h of hits) {
          const ctx = contextAround(text, h, h + needle.length, 40);
          let score = 0;
          if (hl.prefix && ctx.prefix.endsWith(hl.prefix.slice(-24))) score += 2;
          if (hl.suffix && ctx.suffix.startsWith(hl.suffix.slice(0, 24))) score += 2;
          if (hl.start != null) score -= Math.min(1, Math.abs(h - hl.start) / 5000);
          if (score > bestScore) { bestScore = score; best = h; }
        }
        return { start: best, end: best + needle.length, table, text };
      }
    }
    // Last resort: prefix + suffix around an unknown middle.
    if (hl.prefix && hl.suffix) {
      const p = text.lastIndexOf(hl.prefix);
      if (p !== -1) {
        const from = p + hl.prefix.length;
        const s = text.indexOf(hl.suffix, from);
        if (s !== -1 && s >= from) return { start: from, end: s, table, text };
      }
    }
    return null;
  }

  window.YomuHL = {
    buildIndex,
    selectionOffsets,
    contextAround,
    locateStored,
    applyMark,
    norm,
    /* Paint every highlight whose anchor resolves in this chapter.
     * Returns the ids that could not be anchored (caller decides what to say). */
    render(root, highlights) {
      const orphans = [];
      // Back-to-front keeps earlier offsets valid while wrapping.
      const sorted = highlights.slice().sort((a, b) => b.start - a.start);
      for (const hl of sorted) {
        const loc = locateStored(root, hl);
        if (!loc) { orphans.push(hl.id); continue; }
        const mark = applyMark(loc.table, loc.start, loc.end, hl.color, hl.id);
        if (!mark) orphans.push(hl.id);
        else if (hl.note) mark.title = hl.note;
      }
      return orphans;
    },
  };
})();
