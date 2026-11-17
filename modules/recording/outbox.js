// Chunk uploads (PLAN.md 8.5): one request per chunk to /v2/session-replays/chunk, in order,
// with retries. Kept apart from the SDK's request queue so a large chunk never holds back
// events. Jobs are mirrored to IndexedDB, so chunks a closed tab could not send go up on
// the next page load of the site.

import { openDb, STORES } from "./db.js";

var STORE = STORES.OUTBOX;
var KEEPALIVE_LIMIT = 60 * 1024;
var MAX_JOBS = 400;

/**
 * @param {Object} options - {endpoint(), log(level, message), clock}
 * @returns {Object} outbox: add, flushOnHide, size
 */
function createOutbox(options) {
    var jobs = [];
    var busy = false;
    var retryTimer = null;
    var dbPromise = openDb();
    var restored = false;

    /**
     * @param {string} mode - "readwrite" or "readonly"
     * @param {function} fn - (store) => void
     */
    function withStore(mode, fn) {
        dbPromise.then(function(db) {
            if (!db) {
                return;
            }
            try {
                fn(db.transaction(STORE, mode).objectStore(STORE));
            }
            catch (e) {
                // storage full or closed: the job stays in memory only
            }
        });
    }

    /** Pick up jobs a previous page load left behind. */
    function restore() {
        if (restored) {
            return;
        }
        restored = true;
        withStore("readonly", function(store) {
            var req = store.getAll();
            req.onsuccess = function() {
                var known = new Set(jobs.map(function(j) {
                    return j.id;
                }));
                (req.result || []).forEach(function(job) {
                    if (!known.has(job.id)) {
                        jobs.push(job);
                    }
                });
                jobs.sort(function(a, b) {
                    return a.created - b.created;
                });
                pump();
            };
        });
    }

    /**
     * @param {Object} job - the finished job
     */
    function forget(job) {
        jobs = jobs.filter(function(j) {
            return j.id !== job.id;
        });
        withStore("readwrite", function(store) {
            store.delete(job.id);
        });
    }

    /**
     * Drop every job of a recording (the server refused it for good).
     * @param {string} rid - recording id
     */
    function dropRecording(rid) {
        jobs.filter(function(j) {
            return j.rid === rid;
        }).forEach(forget);
    }

    /**
     * @param {Object} job - upload job
     * @returns {FormData} multipart body
     */
    function body(job) {
        var form = new FormData();
        form.append("meta", JSON.stringify(job.meta));
        form.append("chunk", job.blob, "chunk.gz");
        return form;
    }

    /**
     * @param {Object} job - upload job
     * @returns {string} request url
     */
    function url(job) {
        var target = options.endpoint(job);
        var query = {
            app_key: target.app_key,
            device_id: target.device_id,
            rid: job.rid,
            stream: job.stream,
            seq: job.seq,
            final: job.final ? 1 : 0,
            ct0: job.ct0,
            ct1: job.ct1,
            t: options.clock()
        };
        return target.url + "/v2/session-replays/chunk?" + Object.keys(query).map(function(k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]);
        }).join("&");
    }

    /** @param {number} seconds - wait before the next attempt */
    function retryLater(seconds) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(function() {
            retryTimer = null;
            pump();
        }, seconds * 1000);
    }

    /** Send the oldest job; on success, the next. */
    function pump() {
        if (busy || retryTimer || !jobs.length) {
            return;
        }
        var target = options.endpoint(jobs[0]);
        if (!target || !target.url || target.isTemporaryId) {
            // no device id to send under yet: wait, as the SDK's own queue does
            retryLater(10);
            return;
        }
        var job = jobs[0];
        busy = true;
        fetch(url(job), { method: "POST", body: body(job), credentials: "omit" }).then(function(res) {
            return res.json().catch(function() {
                return {};
            }).then(function(answer) {
                busy = false;
                if (res.ok) {
                    forget(job);
                    pump();
                    return;
                }
                if (res.status === 409 || res.status === 429 || res.status >= 500) {
                    // consent or the user not known yet, quota, or a server problem: try again later
                    options.log("warning", "recording chunk " + job.seq + " of " + job.rid + " deferred (" + res.status + ")");
                    retryLater(Math.min(3600, (answer && answer.retry_after) || 60));
                    return;
                }
                // refused for good (no consent, too large, invalid): the rest of the recording would be too
                options.log("error", "recording " + job.rid + " refused (" + res.status + "): " + (answer && answer.error));
                dropRecording(job.rid);
                pump();
            });
        }).catch(function() {
            busy = false;
            retryLater(30);
        });
    }

    return {
        /**
         * Queue one chunk upload.
         * @param {Object} job - {rid, stream, seq, final, ct0, ct1, meta, blob}
         */
        add: function(job) {
            job.id = job.rid + ":" + job.seq;
            job.created = options.clock();
            if (jobs.length >= MAX_JOBS) {
                options.log("warning", "recording outbox is full, dropping the oldest chunk");
                forget(jobs[0]);
            }
            jobs.push(job);
            withStore("readwrite", function(store) {
                store.put(job);
            });
            restore();
            pump();
        },

        /** The page is going away: send what fits a keepalive request now; IndexedDB keeps the rest. */
        flushOnHide: function() {
            jobs.slice(0, 10).forEach(function(job) {
                if (job.blob.size > KEEPALIVE_LIMIT) {
                    return;
                }
                try {
                    fetch(url(job), { method: "POST", body: body(job), keepalive: true, credentials: "omit" });
                }
                catch (e) {
                    // the next page load sends it
                }
            });
        },

        restore: restore,
        size: function() {
            return jobs.length;
        }
    };
}

export { createOutbox };
