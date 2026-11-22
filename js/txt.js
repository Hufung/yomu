/* Yomu — plain text / Markdown support.
 *
 * A .txt has no chapters, so we split on blank lines and group paragraphs into
 * chunks of roughly `TARGET` characters. Splitting on paragraph boundaries keeps
 * offsets stable and makes the reader's prev/next buttons do something sensible
 * on a 500 KB novel. Detection: if the file starts to look like Markdown we
 * render a small, safe subset; otherwise paragraphs are escaped as-is.
 */
(function () {
  'use strict';

  const TARGET = 12000;      // characters per synthetic chapter
  const SAMPLE = 4096;       // bytes inspected for an encoding guess

  /* BOM / meta sniffing. Getting this wrong turns a whole book into tofu. */
  function detectEncoding(bytes) {
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
    const head = new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(SAMPLE, bytes.length));
    try {
      // fatal:true makes the decoder throw on invalid sequences, which is the
      // cheapest reliable UTF-8 test there is.
      new TextDecoder('utf-8', { fatal: true }).decode(head);
      return 'utf-8';
    } catch (_) {
      return 'gb18030';   // superset of GBK/Big5-ish Western misreads; Chrome supports it
    }
  }

  function decode(bytes) {
    let enc = detectEncoding(bytes);
    try {
      const text = new TextDecoder(enc).decode(bytes).replace(/^\uFEFF/, '');
      // A latin-1 file decoded as gb18030 yields replacement chars and CJK
      // garbage; if that happened, fall back to the actual single-byte codepage.
      if (enc === 'gb18030') {
        const bad = (text.match(/[\uFFFD]/g) || []).length;
        const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
        const latin = (text.match(/[ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ]/g) || []).length;
        if (bad > 0 || (cjk > 0 && latin > 0) || (cjk > 0 && cjk < text.length / 40)) {
          const alt = new TextDecoder('windows-1252').decode(bytes).replace(/^\uFEFF/, '');
          if ((alt.match(/[\uFFFD]/g) || []).length < bad) return alt;
        }
      }
      return text;
    } catch (_) {
      return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    }
  }

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /* A deliberately tiny Markdown subset: headings, bold/italic, inline code,
   * blockquotes, lists, rules. No raw HTML passes through — the text is escaped
   * first, so a .txt full of <script> stays visible text. */
  function renderInline(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  }

  function markdownToHtml(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let list = null;       // 'ul' | 'ol'
    let quote = [];

    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const flushQuote = () => {
      if (quote.length) {
        out.push(`<blockquote><p>${renderInline(escapeHtml(quote.join(' ')))}</p></blockquote>`);
        quote = [];
      }
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { closeList(); flushQuote(); continue; }

      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        closeList(); flushQuote();
        const lvl = Math.min(6, h[1].length);
        out.push(`<h${lvl}>${renderInline(escapeHtml(h[2]))}</h${lvl}>`);
        continue;
      }
      if (/^(?:---+|\*\*\*+|___+)$/.test(line.trim())) { closeList(); flushQuote(); out.push('<hr>'); continue; }

      const q = /^>\s?(.*)$/.exec(line);
      if (q) { closeList(); quote.push(q[1]); continue; }
      flushQuote();

      const ul = /^[-*+]\s+(.*)$/.exec(line);
      const ol = /^(\d+)[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        const kind = ul ? 'ul' : 'ol';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${renderInline(escapeHtml((ul ? ul[1] : ol[2])))}</li>`);
        continue;
      }
      closeList();
      out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
    }
    closeList(); flushQuote();
    return out.join('\n');
  }

  function plainToHtml(text) {
    const paras = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
    return paras.map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
  }

  function looksLikeMarkdown(text) {
    const head = text.slice(0, 8000);
    const hits = (head.match(/^#{1,6}\s+\S/gm) || []).length
      + (head.match(/^\s*[-*+]\s+\S/gm) || []).length
      + (head.match(/^\s*>\s+\S/gm) || []).length
      + (head.match(/\*\*[^*\n]+\*\*/g) || []).length;
    return hits >= 4;
  }

  /* Split paragraphs into chunks near TARGET chars without cutting a paragraph. */
  function chunk(paragraphs, target) {
    const chunks = [];
    let cur = [];
    let size = 0;
    for (const p of paragraphs) {
      if (size && size + p.length > target) { chunks.push(cur); cur = []; size = 0; }
      cur.push(p);
      size += p.length;
    }
    if (cur.length) chunks.push(cur);
    return chunks.length ? chunks : [[]];
  }

  function openText(bytes, fileName) {
    const text = decode(bytes).replace(/\u0000/g, '');
    const md = /\.(md|markdown)$/i.test(fileName || '') || looksLikeMarkdown(text);
    const body = md ? markdownToHtml(text) : plainToHtml(text);

    // Split the rendered HTML on the paragraph boundaries we just produced.
    const blocks = body.split(/\n(?=<(?:p|h[1-6]|blockquote|ul|ol|hr|pre))/);
    const chunks = chunk(blocks, TARGET);

    // Title guess: first Markdown heading, else first non-empty line.
    let title = (fileName || '').replace(/\.(txt|md|markdown|text)$/i, '');
    const h1 = /^#\s+(.+)$/m.exec(text);
    if (h1) title = h1[1].trim().slice(0, 120);
    else {
      const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (firstLine && firstLine.length <= 120) title = firstLine;
    }

    const chapters = chunks.map((cs, i) => ({
      index: i,
      path: `txt:${i}`,
      href: String(i),
      title: (window.YomuI18n ? window.YomuI18n.t('reader.section', { n: i + 1 }) : 'Section ' + (i + 1)),
      titleKind: 'section',   // generated, so it can be re-localised on a language switch
      html: cs.join('\n'),
    }));

    return {
      format: md ? 'markdown' : 'txt',
      title: title || 'Untitled',
      author: '',
      language: '',
      description: '',
      chapters,
      toc: [],
      async coverBlob() { return null; },
      renderChapter(index) {
        const ch = chapters[index];
        if (!ch) return { html: '', css: '', title: '', path: '' };
        return { html: ch.html, css: '', title: ch.title, path: ch.path, titleKind: ch.titleKind };
      },
      destroy() {},
    };
  }

  window.YomuText = { openText, decode, detectEncoding, markdownToHtml, plainToHtml };
})();
