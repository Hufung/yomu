/* Yomu — IndexedDB storage layer.
 *
 * Stores:
 *   books      { id, title, author, language, cover(Blob|null), bytes,
 *                chapterCount, addedAt, lastOpenedAt }
 *   files      { id, data: ArrayBuffer }   (the raw .epub, kept apart so the
 *                                          library grid never loads book bytes)
 *   highlights { id, bookId, chapter, color, text, note,
 *                start, end, prefix, suffix, createdAt }
 *   progress   { bookId, chapter, ratio, updatedAt }
 *   shelves    { id, name, sort, createdAt }
 *
 * A book's shelves are a plain array on the book row (`shelves: [shelfId]`),
 * not a join store: the library is always read whole, so an array costs one
 * field instead of a second round trip per book, and deleting a shelf is a
 * single pass over the books that still works when the shelf row is already
 * gone. v2 only adds the store and back-fills nothing — an absent array means
 * "no shelves", which is exactly what older rows should mean.
 */
(function () {
  'use strict';

  const DB_NAME = 'yomu';
  const DB_VERSION = 2;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('highlights')) {
          const s = db.createObjectStore('highlights', { keyPath: 'id' });
          s.createIndex('byBook', 'bookId');
        }
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains('shelves')) {
          db.createObjectStore('shelves', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  /* Run one transaction and resolve with the request result. Errors are
   * propagated with their DOMException name intact — callers need to tell
   * QuotaExceededError apart from a closed connection. */
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(store, mode);
      } catch (e) {
        reject(e);
        return;
      }
      const s = t.objectStore(store);
      let result;
      try {
        result = fn(s);
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new DOMException('Transaction aborted', 'AbortError'));
    });
  }

  const reqOf = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const Store = {
    /* ---- books ---- */
    async listBooks() {
      const db = await open();
      const books = await reqOf(db.transaction('books').objectStore('books').getAll());
      books.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
      return books;
    },

    async getBook(id) {
      const db = await open();
      return reqOf(db.transaction('books').objectStore('books').get(id));
    },

    async putBook(book) {
      return new Promise(async (resolve, reject) => {
        const db = await open();
        const t = db.transaction('books', 'readwrite');
        try {
          t.objectStore('books').put(book);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(book);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },

    /* Writes the metadata row and the raw file in one transaction, so a
     * half-imported book can never appear in the library. */
    async addBook(book, buffer) {
      return new Promise(async (resolve, reject) => {
        const db = await open();
        const t = db.transaction(['books', 'files'], 'readwrite');
        try {
          t.objectStore('books').put(book);
          t.objectStore('files').put({ id: book.id, data: buffer });
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(book);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },

    async getFile(id) {
      const db = await open();
      const row = await reqOf(db.transaction('files').objectStore('files').get(id));
      return row ? row.data : null;
    },

    async deleteBook(id) {
      return new Promise(async (resolve, reject) => {
        const db = await open();
        const t = db.transaction(['books', 'files', 'highlights', 'progress'], 'readwrite');
        t.objectStore('books').delete(id);
        t.objectStore('files').delete(id);
        t.objectStore('progress').delete(id);
        const idx = t.objectStore('highlights').index('byBook');
        const cur = idx.openKeyCursor(IDBKeyRange.only(id));
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          t.objectStore('highlights').delete(c.primaryKey);
          c.continue();
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },

    /* ---- shelves ---- */

    async listShelves() {
      const db = await open();
      const rows = await reqOf(db.transaction('shelves').objectStore('shelves').getAll());
      return rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    },

    async putShelf(shelf) {
      return tx('shelves', 'readwrite', (s) => s.put(shelf));
    },

    /* Delete the shelf and unfile every book that pointed at it, in one
     * transaction. Books are never deleted — that is the whole point of
     * shelves being a view rather than a folder. */
    async deleteShelf(id) {
      return new Promise(async (resolve, reject) => {
        const db = await open();
        const t = db.transaction(['shelves', 'books'], 'readwrite');
        t.objectStore('shelves').delete(id);
        const books = t.objectStore('books');
        const cur = books.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          const row = c.value;
          if (Array.isArray(row.shelves) && row.shelves.includes(id)) {
            const next = { ...row, shelves: row.shelves.filter((x) => x !== id) };
            c.update(next);
          }
          c.continue();
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },

    /* Set membership in one place so the UI never hand-builds the array. */
    async setBookShelves(bookId, shelfIds) {
      return new Promise(async (resolve, reject) => {
        const db = await open();
        const t = db.transaction('books', 'readwrite');
        const books = t.objectStore('books');
        const get = books.get(bookId);
        get.onsuccess = () => {
          const row = get.result;
          if (!row) return;                  // deleted under us; nothing to do
          books.put({ ...row, shelves: Array.from(new Set(shelfIds)) });
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },

    /* Toggle one shelf on/off for a book; returns the resulting array. */
    async toggleBookShelf(bookId, shelfId, on) {
      const book = await this.getBook(bookId);
      if (!book) return [];
      const cur = Array.isArray(book.shelves) ? book.shelves : [];
      const next = on ? [...cur, shelfId] : cur.filter((x) => x !== shelfId);
      await this.setBookShelves(bookId, next);
      return Array.from(new Set(next));
    },

    /* Adding several books to a shelf at once (drag onto a chip / bulk move). */
    async addBooksToShelf(bookIds, shelfId) {
      for (const id of bookIds) {
        const book = await this.getBook(id);
        if (!book) continue;
        const cur = Array.isArray(book.shelves) ? book.shelves : [];
        if (cur.includes(shelfId)) continue;
        await this.putBook({ ...book, shelves: [...cur, shelfId] });
      }
    },

    /* ---- highlights ---- */
    async listHighlights(bookId) {
      const db = await open();
      const idx = db.transaction('highlights').objectStore('highlights').index('byBook');
      const rows = await reqOf(idx.getAll(IDBKeyRange.only(bookId)));
      return rows.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
    },

    async allHighlights() {
      const db = await open();
      return reqOf(db.transaction('highlights').objectStore('highlights').getAll());
    },

    async putHighlight(h) {
      return new Promise(async (resolve, reject) => {
        const db = await open();
        const t = db.transaction('highlights', 'readwrite');
        try {
          t.objectStore('highlights').put(h);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(h);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },

    async deleteHighlight(id) {
      return tx('highlights', 'readwrite', (s) => s.delete(id));
    },

    /* ---- progress ---- */
    async getProgress(bookId) {
      const db = await open();
      return reqOf(db.transaction('progress').objectStore('progress').get(bookId));
    },

    async putProgress(p) {
      return tx('progress', 'readwrite', (s) => s.put(p));
    },

    /* ---- backup ---- */
    async exportData() {
      const db = await open();
      const [books, highlights, progress, shelves] = await Promise.all([
        reqOf(db.transaction('books').objectStore('books').getAll()),
        reqOf(db.transaction('highlights').objectStore('highlights').getAll()),
        reqOf(db.transaction('progress').objectStore('progress').getAll()),
        reqOf(db.transaction('shelves').objectStore('shelves').getAll()),
      ]);
      return {
        app: 'yomu',
        version: DB_VERSION,
        exportedAt: new Date().toISOString(),
        // Blobs are not JSON-friendly; the cover is regenerable from the .epub.
        books: books.map(({ cover, ...rest }) => rest),
        highlights,
        progress,
        shelves,
      };
    },

    async importData(payload) {
      const db = await open();
      const t = db.transaction(['books', 'highlights', 'progress', 'shelves'], 'readwrite');
      const shel = t.objectStore('shelves');
      for (const sh of payload.shelves || []) {
        const get = shel.get(sh.id);
        get.onsuccess = () => { if (!get.result) shel.put(sh); };
      }
      const books = t.objectStore('books');
      for (const b of payload.books || []) {
        // Merge: never clobber an existing book row (it holds the cover Blob).
        const cur = await reqOf(books.get(b.id));
        if (!cur) books.put({ ...b, cover: null, missing: true });
      }
      const hl = t.objectStore('highlights');
      for (const h of payload.highlights || []) {
        const cur = await reqOf(hl.get(h.id));
        if (!cur || (h.updatedAt || 0) >= (cur.updatedAt || 0)) hl.put(h);
      }
      const pg = t.objectStore('progress');
      for (const p of payload.progress || []) {
        const cur = await reqOf(pg.get(p.bookId));
        if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) pg.put(p);
      }
      return new Promise((res, rej) => {
        t.oncomplete = () => res(true);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    },
  };

  window.YomuStore = Store;
})();
