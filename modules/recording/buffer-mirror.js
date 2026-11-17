// The rolling buffer's mirror in IndexedDB, per tab (PLAN.md 8.2). A multi-page site starts a
// new document on every navigation; the mirror gives the new page the chunks of the last
// `window` seconds, so a trigger on page two still shows how the user got there. A tab is
// its recording stream (`cly_rsid` in sessionStorage), which also survives navigations.

import { openDb, withStore, STORES } from "./db.js";

// at most this many chunks per tab, whatever the window (8 s chunks: ten minutes)
var MAX_CHUNKS = 75;
// other tabs' chunks older than this are left over from closed tabs
var STALE_MS = 60 * 60 * 1000;

/**
 * @param {string} tab - recording stream of the tab
 * @param {Object} chunk - sealed chunk
 * @returns {string} the chunk's key
 */
function keyOf(tab, chunk) {
    return tab + ":" + chunk.t0 + ":" + chunk.t1;
}

/**
 * @param {Object} options - {clock}
 * @returns {Object} mirror: put, remove, load, clear
 */
function createBufferMirror(options) {
    return {
        /**
         * @param {string} tab - recording stream
         * @param {Object} chunk - sealed chunk
         */
        put: function(tab, chunk) {
            withStore(STORES.BUFFER, "readwrite", function(store) {
                store.put({ id: keyOf(tab, chunk), tab: tab, t0: chunk.t0, t1: chunk.t1, format: chunk.format, chunk: chunk });
            });
        },

        /**
         * @param {string} tab - recording stream
         * @param {Object} chunk - chunk that left the buffer
         */
        remove: function(tab, chunk) {
            withStore(STORES.BUFFER, "readwrite", function(store) {
                store.delete(keyOf(tab, chunk));
            });
        },

        /**
         * The tab's chunks that reach into the window, oldest first, of the given format; the
         * rest of the tab's chunks and other tabs' stale ones are deleted.
         * @param {string} tab - recording stream
         * @param {number} since - window start (ms)
         * @param {string} format - the recorder's format; chunks of another are dropped
         * @returns {Promise<Object[]>} chunks
         */
        load: function(tab, since, format) {
            return openDb().then(function(db) {
                if (!db) {
                    return [];
                }
                return new Promise(function(resolve) {
                    try {
                        var store = db.transaction(STORES.BUFFER, "readwrite").objectStore(STORES.BUFFER);
                        var req = store.getAll();
                        req.onsuccess = function() {
                            var now = options.clock();
                            var keep = [];
                            (req.result || []).forEach(function(row) {
                                if (row.tab === tab && row.t1 >= since && row.format === format) {
                                    keep.push(row);
                                }
                                else if (row.tab === tab || now - row.t1 > STALE_MS) {
                                    store.delete(row.id);
                                }
                            });
                            keep.sort(function(a, b) {
                                return a.t0 - b.t0;
                            });
                            keep.slice(0, Math.max(0, keep.length - MAX_CHUNKS)).forEach(function(row) {
                                store.delete(row.id);
                            });
                            resolve(keep.slice(-MAX_CHUNKS).map(function(row) {
                                return row.chunk;
                            }));
                        };
                        req.onerror = function() {
                            resolve([]);
                        };
                    }
                    catch (e) {
                        resolve([]);
                    }
                });
            });
        },

        /**
         * Forget the tab's chunks (consent withdrawn, recording stopped).
         * @param {string} tab - recording stream
         */
        clear: function(tab) {
            withStore(STORES.BUFFER, "readwrite", function(store) {
                var req = store.index("tab").getAllKeys(tab);
                req.onsuccess = function() {
                    (req.result || []).forEach(function(id) {
                        store.delete(id);
                    });
                };
            });
        }
    };
}

export { createBufferMirror, MAX_CHUNKS };
