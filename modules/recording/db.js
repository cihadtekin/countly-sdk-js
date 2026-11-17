// The recording module's IndexedDB database: the upload outbox and the rolling buffer's mirror.

var DB_NAME = "countly_recordings";
var VERSION = 2;
var STORES = { OUTBOX: "outbox", BUFFER: "buffer" };

var opened = null;

/**
 * @returns {Promise<IDBDatabase|null>} the database, or null where IndexedDB is unavailable
 */
function openDb() {
    if (opened) {
        return opened;
    }
    opened = new Promise(function(resolve) {
        try {
            if (typeof indexedDB === "undefined") {
                resolve(null);
                return;
            }
            var req = indexedDB.open(DB_NAME, VERSION);
            req.onupgradeneeded = function() {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
                    db.createObjectStore(STORES.OUTBOX, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(STORES.BUFFER)) {
                    db.createObjectStore(STORES.BUFFER, { keyPath: "id" }).createIndex("tab", "tab");
                }
            };
            req.onsuccess = function() {
                resolve(req.result);
            };
            req.onerror = function() {
                resolve(null);
            };
            req.onblocked = function() {
                // another tab still has the old version open: run without storage this time
                resolve(null);
            };
        }
        catch (e) {
            resolve(null);
        }
    });
    return opened;
}

/**
 * Run `fn` on a store; storage failures (full, closed, private mode) are swallowed.
 * @param {string} name - store name
 * @param {string} mode - "readwrite" or "readonly"
 * @param {function} fn - (store) => void
 */
function withStore(name, mode, fn) {
    openDb().then(function(db) {
        if (!db) {
            return;
        }
        try {
            fn(db.transaction(name, mode).objectStore(name));
        }
        catch (e) {
            // kept in memory only
        }
    });
}

export { openDb, withStore, STORES };
