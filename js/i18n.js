/* Yomu — tiny i18n layer.
 *
 * Two languages, no build step. Strings live in one table per locale; markup
 * carries data-i18n keys and JS calls t('key'). Anything with ${} substitution
 * uses t('key', {n: 3}).
 *
 * Deliberate choice: the app starts in the browser's language (zh-Hant for
 * zh-* users, English otherwise) and remembers an explicit choice forever.
 * Switching does not reload — applyI18n() rewrites the DOM in place.
 */
(function () {
  'use strict';

  const STRINGS = {
    'zh-Hant': {
      'app.name': 'Yomu',
      'app.tagline': '本機優先 · 無帳號 · 無上傳',
      'lib.search': '搜尋書名或作者',
      'lib.import': '匯入',
      'lib.more': '更多選項',
      'lib.backup': '匯出備份 (JSON)',
      'lib.restore': '還原備份',
      'lib.allnotes': '全部筆記',
      'lib.storage': '儲存空間',
      'lib.language': '語言 / Language',
      'lib.theme': '切換深色模式',
      'lib.github': 'GitHub',
      'continue.eyebrow': '繼續閱讀',
      'continue.open': '開啟',
      'drop.hint': '放開以匯入電子書',
      'empty.title': '書架還是空的',
      'empty.body': '把 <code>.epub</code>、<code>.mobi</code>、<code>.azw3</code>、<code>.pdf</code> 或 <code>.txt</code> 拖進來，或按「匯入」。<br>檔案只會留在這部裝置，不會上傳到任何伺服器。',
      'empty.cta': '選一個檔案',
      'empty.nomatch': '沒有符合「{q}」的書。',
      'storage.used': '本機已用 {mb} MB',
      'storage.persisted': ' · 已受保護',

      'reader.back': '回到書架',
      'reader.toc': '目錄',
      'reader.notes': '劃線與筆記',
      'reader.zen': '沉浸模式（隱藏工具列）',
      'reader.full': '全螢幕',
      'reader.settings': '閱讀設定',
      'reader.theme': '切換深色模式',
      'reader.prev': '← 上一章',
      'reader.next': '下一章 →',
      'reader.section': '第 {n} 節',
      'reader.page': '第 {n} 頁',

      'sel.yellow': '黃色',
      'sel.green': '綠色',
      'sel.blue': '藍色',
      'sel.pink': '粉紅',
      'sel.note': '加筆記',
      'sel.copy': '複製',

      'toc.title': '目錄',
      'notes.title': '劃線與筆記',
      'notes.empty': '選取一段文字，就能劃線或寫筆記。',
      'close': '關閉',

      'aa.size': '字級',
      'aa.leading': '行距',
      'aa.width': '欄寬',
      'aa.theme': '主題',
      'aa.theme.light': '亮',
      'aa.theme.sepia': '紙',
      'aa.theme.dark': '暗',
      'aa.theme.auto': '自動',
      'aa.layout': '版面',
      'aa.fullbleed': '全寬閱讀（配合螢幕）',
      'aa.font': '字體',
      'aa.font.serif': '襯線（書本感）',
      'aa.font.sans': '無襯線',
      'aa.font.publisher': '跟隨書籍樣式',
      'aa.language': '語言',
      'aa.lang.auto': '跟隨瀏覽器',

      'hl.note.placeholder': '寫下你的想法…',
      'hl.delete': '刪除',
      'hl.save': '儲存',

      'toast.importing': '正在匯入「{name}」…',
      'toast.imported': '已加入「{title}」',
      'toast.importfail': '「{name}」匯入失敗：{msg}',
      'toast.pickformat': '請選擇 EPUB、MOBI／AZW3、PDF 或 TXT 檔案',
      'toast.notfound': '找不到這本書',
      'toast.missingfile': '這本書的檔案不見了（可能已從瀏覽器清除）。請重新匯入。',
      'toast.opening': '正在開啟…',
      'toast.openfail': '無法開啟：{msg}',
      'toast.deleted': '已刪除',
      'toast.deleteconfirm': '刪除《{title}》？',
      'toast.deleteconfirmnotes': '刪除《{title}》？\n這會一併刪除它的 {n} 條劃線／筆記。',
      'toast.quota': '瀏覽器儲存空間已滿，閱讀進度未能儲存。',
      'toast.savefail': '閱讀進度儲存失敗：{msg}',
      'toast.fullscreenfallback': '這個瀏覽器不支援全螢幕，已切換為沉浸模式',
      'toast.fullscreenfail': '無法進入全螢幕：{msg}',
      'toast.hlanchor': '這條劃線目前的章節文字對不上，已保留原始紀錄。',
      'toast.hlsavefail': '劃線儲存失敗：{msg}',
      'toast.hlcreated': '已劃線',
      'toast.notesaved': '筆記已儲存',
      'toast.notesavefail': '筆記儲存失敗：{msg}',
      'toast.hldeleteconfirm': '刪除這條劃線？',
      'toast.hldeletefail': '刪除失敗：{msg}',
      'toast.exported': '已匯出 {n} 條劃線（不含書籍檔案）',
      'toast.notbackup': '不是 Yomu 的備份檔',
      'toast.restored': '已還原 {n} 條劃線',
      'toast.restorefail': '還原失敗：{msg}',
      'toast.nonotes': '還沒有任何劃線',
      'toast.notesmd': '已匯出 {n} 條筆記為 Markdown',
      'toast.unknown': '未知',
      'toast.copied': '已複製',
      'toast.copyfail': '複製失敗',
      'toast.libfail': '書架讀取失敗：{msg}',
      'toast.langchanged': '語言已切換',
      'err.mobi.toosmall': '檔案太小，不是有效的 MOBI。',
      'err.mobi.notmobi': '不是 MOBI 檔案（PalmDB type 不是 BOOK）。',
      'err.mobi.badheader': 'MOBI 檔案的表頭損壞。',
      'err.mobi.truncated': 'MOBI 檔案不完整（記錄表被截斷）。',
      'err.mobi.drm': '這個 MOBI 有 DRM 保護，無法開啟。',
      'err.mobi.huff': '這個 MOBI 使用 HUFF/CDIC 壓縮，暫不支援。請用 Calibre 轉成 EPUB 或 AZW3。',
      'err.mobi.notext': '這個 MOBI 沒有可讀取的文字。',
      'err.azw3.notext': '這個 AZW3 沒有可讀取的內容。',
      'err.pdf.init': 'pdf.js 初始化失敗',
      'err.pdf.load': '無法載入 pdf.js',
      'err.pdf.password': '這個 PDF 有密碼保護，無法開啟。',
      'err.pdf.read': '無法讀取這個 PDF（{msg}）。',

    },

    en: {
      'app.name': 'Yomu',
      'app.tagline': 'Local-first · No account · Nothing uploaded',
      'lib.search': 'Search title or author',
      'lib.import': 'Import',
      'lib.more': 'More options',
      'lib.backup': 'Export backup (JSON)',
      'lib.restore': 'Restore backup',
      'lib.allnotes': 'All notes',
      'lib.storage': 'Storage',
      'lib.language': 'Language / 語言',
      'lib.theme': 'Toggle dark mode',
      'lib.github': 'GitHub',
      'continue.eyebrow': 'Continue reading',
      'continue.open': 'Open',
      'drop.hint': 'Drop to import your book',
      'empty.title': 'Your shelf is empty',
      'empty.body': 'Drop an <code>.epub</code>, <code>.mobi</code>, <code>.azw3</code>, <code>.pdf</code> or <code>.txt</code> here, or press “Import”.<br>Files stay on this device — nothing is uploaded anywhere.',
      'empty.cta': 'Choose a file',
      'empty.nomatch': 'No books match “{q}”.',
      'storage.used': '{mb} MB used on this device',
      'storage.persisted': ' · protected',

      'reader.back': 'Back to shelf',
      'reader.toc': 'Contents',
      'reader.notes': 'Highlights & notes',
      'reader.zen': 'Immersive mode (hide toolbars)',
      'reader.full': 'Fullscreen',
      'reader.settings': 'Reading settings',
      'reader.theme': 'Toggle dark mode',
      'reader.prev': '← Previous',
      'reader.next': 'Next →',
      'reader.section': 'Section {n}',
      'reader.page': 'Page {n}',

      'sel.yellow': 'Yellow',
      'sel.green': 'Green',
      'sel.blue': 'Blue',
      'sel.pink': 'Pink',
      'sel.note': 'Add note',
      'sel.copy': 'Copy',

      'toc.title': 'Contents',
      'notes.title': 'Highlights & notes',
      'notes.empty': 'Select some text to highlight it or add a note.',
      'close': 'Close',

      'aa.size': 'Text size',
      'aa.leading': 'Line height',
      'aa.width': 'Column',
      'aa.theme': 'Theme',
      'aa.theme.light': 'Light',
      'aa.theme.sepia': 'Paper',
      'aa.theme.dark': 'Dark',
      'aa.theme.auto': 'Auto',
      'aa.layout': 'Layout',
      'aa.fullbleed': 'Full width (fill the screen)',
      'aa.font': 'Typeface',
      'aa.font.serif': 'Serif (book-like)',
      'aa.font.sans': 'Sans serif',
      'aa.font.publisher': 'Publisher styles',
      'aa.language': 'Language',
      'aa.lang.auto': 'Match browser',

      'hl.note.placeholder': 'Write down what you think…',
      'hl.delete': 'Delete',
      'hl.save': 'Save',

      'toast.importing': 'Importing “{name}”…',
      'toast.imported': 'Added “{title}”',
      'toast.importfail': '“{name}” failed to import: {msg}',
      'toast.pickformat': 'Choose an EPUB, MOBI/AZW3, PDF or TXT file',
      'toast.notfound': 'Book not found',
      'toast.missingfile': 'This book’s file is gone (the browser may have cleared it). Please import it again.',
      'toast.opening': 'Opening…',
      'toast.openfail': 'Could not open: {msg}',
      'toast.deleted': 'Deleted',
      'toast.deleteconfirm': 'Delete “{title}”?',
      'toast.deleteconfirmnotes': 'Delete “{title}”?\nThis also deletes its {n} highlight(s)/note(s).',
      'toast.quota': 'Browser storage is full — your reading position was not saved.',
      'toast.savefail': 'Could not save your reading position: {msg}',
      'toast.fullscreenfallback': 'This browser has no fullscreen API — switched to immersive mode',
      'toast.fullscreenfail': 'Could not enter fullscreen: {msg}',
      'toast.hlanchor': 'This highlight no longer matches the chapter text; the record was kept.',
      'toast.hlsavefail': 'Could not save the highlight: {msg}',
      'toast.hlcreated': 'Highlighted',
      'toast.notesaved': 'Note saved',
      'toast.notesavefail': 'Could not save the note: {msg}',
      'toast.hldeleteconfirm': 'Delete this highlight?',
      'toast.hldeletefail': 'Delete failed: {msg}',
      'toast.exported': 'Exported {n} highlight(s) (book files excluded)',
      'toast.notbackup': 'That is not a Yomu backup file',
      'toast.restored': 'Restored {n} highlight(s)',
      'toast.restorefail': 'Restore failed: {msg}',
      'toast.nonotes': 'No highlights yet',
      'toast.notesmd': 'Exported {n} note(s) as Markdown',
      'toast.unknown': 'unknown',
      'toast.copied': 'Copied',
      'toast.copyfail': 'Copy failed',
      'toast.libfail': 'Could not read the shelf: {msg}',
      'toast.langchanged': 'Language switched',
      'err.mobi.toosmall': 'File is too small to be a MOBI.',
      'err.mobi.notmobi': 'Not a MOBI file (PalmDB type is not BOOK).',
      'err.mobi.badheader': 'The MOBI header is corrupt.',
      'err.mobi.truncated': 'Incomplete MOBI (record table truncated).',
      'err.mobi.drm': 'This MOBI is DRM-protected and cannot be opened.',
      'err.mobi.huff': 'This MOBI uses HUFF/CDIC compression, which is not supported. Convert it to EPUB or AZW3 with Calibre.',
      'err.mobi.notext': 'This MOBI has no readable text.',
      'err.azw3.notext': 'This AZW3 has no readable content.',
      'err.pdf.init': 'pdf.js failed to initialise',
      'err.pdf.load': 'Could not load pdf.js',
      'err.pdf.password': 'This PDF is password-protected and cannot be opened.',
      'err.pdf.read': 'Could not read this PDF ({msg}).',

    },
  };

  const SUPPORTED = ['zh-Hant', 'en'];

  function detect() {
    const langs = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'en'];
    for (const raw of langs) {
      const l = String(raw).toLowerCase();
      if (l.startsWith('zh')) return 'zh-Hant';   // hufung's default; HK/TW both read zh-Hant
      if (l.startsWith('en')) return 'en';
    }
    return 'en';
  }

  let current = 'en';

  function set(lang) {
    current = SUPPORTED.includes(lang) ? lang : detect();
    return current;
  }

  function get() { return current; }

  function t(key, vars) {
    const table = STRINGS[current] || STRINGS.en;
    let s = table[key];
    if (s === undefined) s = (STRINGS.en[key] !== undefined ? STRINGS.en[key] : key);
    if (vars) {
      for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    }
    return s;
  }

  /* Rewrite every tagged node in place. */
  function applyI18n(root) {
    const scope = root || document;
    document.documentElement.lang = current;
    // Text content
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    // Rich text (the only one: the empty-state paragraph contains <code>/<br>)
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    // Attributes: data-i18n-attr="placeholder:lib.search aria-label:x"
    scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(/\s+/)) {
        const [attr, key] = pair.split(':');
        if (attr && key) el.setAttribute(attr, t(key));
      }
    });
  }

  window.YomuI18n = { t, set, get, detect, applyI18n, SUPPORTED };
  window.t = t;
})();
