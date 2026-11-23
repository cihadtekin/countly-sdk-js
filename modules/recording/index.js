// Countly Session Replay recording module (countly_recording.js). Load it after the
// Countly SDK and before Countly.init, so it attaches during init and the page's first view
// carries the tab's stream (loaded after init, it attaches at once). It records the screen with the active recorder (cly-wire built in; rrweb
// through the plugin/rrweb file) and sends recordings to the Countly server:
//
// - triggered recordings: a rolling buffer of the last `window` seconds, sent with `after`
//   more seconds when a trigger fires (a crash, an event, a view, or Countly.recording.send());
// - Behaviour study recordings: whole sessions of devices the server put into a study,
//   streamed as they are recorded.
//
// Everything with analytical meaning is sent as ordinary Countly events by the SDK; the
// recording holds only what is needed to draw the screen. PLAN.md (session-replays plugin)
// describes the design.
import { createWireRecorder } from "./wire.js";
import { createCapture } from "./capture.js";
import { createOutbox } from "./outbox.js";
import { createBufferMirror } from "./buffer-mirror.js";
import * as zoneFree from "./zone-free.js";

var VERSION = "0.1.0";
// how long a page waits for its server settings before deciding that nothing records (see syncStream)
var SETTINGS_WAIT_MS = 3000;
var DEFAULTS = {
    enabled: true,
    window: 40,
    after: 10,
    maxDuration: 300,
    maxBytes: 2000000,
    maxPerDay: 10,
    keyframeInterval: 8,
    sampleRate: 1,
    recorder: "wire",
    triggers: { crash: { fatal: true, nonfatal: true }, events: [], views: [] },
    privacy: { maskAllText: false, maskAllInputs: true }
};
var SERVER_KEYS = {
    rec: "enabled", rec_sr: "sampleRate", rec_w: "window", rec_a: "after", rec_md: "maxDuration",
    rec_mb: "maxBytes", rec_pd: "maxPerDay"
};

var recorders = { wire: createWireRecorder };
var pendingRecorders = window.__countlyRecorders || [];

/**
 * @param {string} prefix - id prefix
 * @returns {string} a random id the server accepts ([A-Za-z0-9_-], ≤ 64)
 */
function randomId(prefix) {
    var bytes = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return prefix + Array.prototype.map.call(bytes, function(b) {
        return ("0" + b.toString(16)).slice(-2);
    }).join("");
}

/**
 * @param {string} text - device id
 * @returns {number} a stable number in [0, 1)
 */
function hashUnit(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

/**
 * Does a segment value match a trigger condition (a value, or {$lt, $lte, $gt, $gte, $eq, $ne})?
 * @param {*} value - event segment value
 * @param {*} rule - condition
 * @returns {boolean} true when it matches
 */
function matchesRule(value, rule) {
    if (rule === null || typeof rule !== "object") {
        return value === rule;
    }
    var ops = { $lt: function(a, b) {
        return a < b;
    }, $lte: function(a, b) {
        return a <= b;
    }, $gt: function(a, b) {
        return a > b;
    }, $gte: function(a, b) {
        return a >= b;
    }, $eq: function(a, b) {
        return a === b;
    }, $ne: function(a, b) {
        return a !== b;
    } };
    return Object.keys(rule).every(function(op) {
        return ops[op] ? ops[op](value, rule[op]) : false;
    });
}

/**
 * @param {string} pattern - "/checkout/*" style URL pattern
 * @param {string} path - location path
 * @returns {boolean} true when the path matches
 */
function matchesScope(pattern, path) {
    var re = new RegExp("^" + pattern.split("*").map(function(part) {
        return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }).join(".*") + "$");
    return re.test(path);
}

// chunks a closing page could not compress, as `<prefix><rid>:<seq>` (see keepForNextPage)
var CLOSING_PREFIX = "cly_rec_closing:";

/**
 * gzip a chunk's JSON with the browser's CompressionStream.
 * @param {Object} chunk - envelope
 * @returns {Promise<Blob>} gzip bytes
 */
function gzip(chunk) {
    var stream = new Blob([JSON.stringify(chunk)]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();
}

/**
 * The recording module for one Countly instance.
 * @param {Object} Countly - the SDK instance
 * @returns {Object} the public Countly.recording API
 */
function createRecordingModule(Countly) {
    var bridge = Countly._internals.recording;
    var log = function(level, message) {
        Countly._internals.log(level === "error" ? "[ERROR] " : level === "warning" ? "[WARNING] " : "[DEBUG] ", "[recording] " + message);
    };
    // wall clock, the same as the SDK's event timestamps (without their +1 ms de-duplication)
    var clock = Date.now;
    var capture = null;
    var recorder = null;
    // sealed chunks of the last `window` seconds (plus the one that reaches past it)
    var buffer = [];
    // triggered recordings still in their `after` seconds
    var openTriggered = [];
    var study = null;
    var studyRecording = null;
    // set while the page closes or recording stops: the study recording's chunk sealed then is its last
    var ending = false;
    // set while the page closes: there is no time left to compress, so chunks wait in localStorage
    var leaving = false;
    var lastRid = null;
    var bufferWanted = false;
    var stopped = false;
    // until this page's server settings arrive, or SETTINGS_WAIT_MS pass, the tab's stream is on
    // whenever consent allows, also before anything records: the page's first view leaves before
    // them, and a recording they start must still find it
    var awaitingSettings = true;
    var settingsTimer = zoneFree.setTimer(settingsArrived, SETTINGS_WAIT_MS);
    var mirror = createBufferMirror({ clock: clock });
    var outbox = createOutbox({
        clock: clock,
        log: log,
        endpoint: function() {
            return bridge.info();
        }
    });

    /** @returns {Object} the effective settings: server > init > defaults (PLAN.md 8.4) */
    function settings() {
        var init = bridge.initConfig() || {};
        var server = bridge.serverConfig() || {};
        var s = Object.assign({}, DEFAULTS, init);
        s.triggers = Object.assign({}, DEFAULTS.triggers, init.triggers || {});
        s.privacy = Object.assign({}, DEFAULTS.privacy, init.privacy || {});
        Object.keys(SERVER_KEYS).forEach(function(key) {
            if (server[key] !== undefined) {
                s[SERVER_KEYS[key]] = server[key];
            }
        });
        // crash triggers: one switch each for unhandled (rec_tcf) and handled (rec_tcn) errors
        if (typeof server.rec_tcf === "boolean" || typeof server.rec_tcn === "boolean") {
            s.triggers.crash = {
                fatal: typeof server.rec_tcf === "boolean" ? server.rec_tcf : s.triggers.crash.fatal,
                nonfatal: typeof server.rec_tcn === "boolean" ? server.rec_tcn : s.triggers.crash.nonfatal
            };
        }
        if (server.rec_te) {
            s.triggers.events = server.rec_te;
        }
        if (server.rec_tv) {
            s.triggers.views = server.rec_tv;
        }
        if (server.rec_r && server.rec_r.web) {
            s.recorder = server.rec_r.web;
        }
        if (server.rec_mask === "strict") {
            s.privacy.maskAllText = true;
        }
        s.study = server.rec_st && server.rec_st.until > Date.now() ? server.rec_st : null;
        return s;
    }

    /** @returns {string} this tab's recording stream id (kept for the tab's life) */
    function streamId() {
        var key = "cly_rsid";
        try {
            var existing = window.sessionStorage.getItem(key);
            if (existing) {
                return existing;
            }
            var id = randomId("s");
            window.sessionStorage.setItem(key, id);
            return id;
        }
        catch (e) {
            return randomId("s");
        }
    }

    /** Recordings sent today by this device, for maxPerDay. */
    function dailyCount(add) {
        var key = "cly_rec_day";
        var today = new Date().toISOString().slice(0, 10);
        var state = { day: today, n: 0 };
        try {
            var stored = JSON.parse(window.localStorage.getItem(key) || "null");
            if (stored && stored.day === today) {
                state = stored;
            }
            if (add) {
                state.n += add;
                window.localStorage.setItem(key, JSON.stringify(state));
            }
        }
        catch (e) {
            // storage unavailable: no daily cap across page loads
        }
        return state.n;
    }

    /**
     * The fields every chunk of a recording carries (the server never decodes chunk bytes).
     * @param {Object} rec - recording
     * @returns {Object} meta
     */
    function meta(rec) {
        var info = bridge.info();
        var m = {
            kind: rec.kind,
            format: recorder.format,
            recorder: { name: recorder.name, version: recorder.version },
            sdk: { name: info.sdk_name, version: info.sdk_version },
            platform: "web",
            screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
            t0: rec.t0
        };
        if (info.app_version) {
            m.app_version = String(info.app_version);
        }
        if (rec.kind === "study") {
            m.study = rec.study;
        }
        else {
            m.trigger = rec.trigger;
        }
        return m;
    }

    /**
     * Queue one chunk of a recording for upload.
     * @param {Object} rec - recording
     * @param {Object} chunk - sealed chunk
     * @param {boolean} final - the recording's last chunk
     */
    function send(rec, chunk, final) {
        var seq = rec.seq++;
        var envelope = {
            v: 1, rid: rec.rid, stream: rec.stream, seq: seq, format: chunk.format, recorder: chunk.recorder,
            t0: chunk.t0, t1: chunk.t1, keyframe: true, screen: chunk.screen, overlay: chunk.overlay, data: chunk.data
        };
        var job = { rid: rec.rid, stream: rec.stream, seq: seq, final: final, ct0: chunk.t0, ct1: chunk.t1, meta: meta(rec) };
        if (leaving) {
            keepForNextPage(job, envelope);
            return;
        }
        queue(job, envelope);
    }

    /**
     * Compress the chunk and hand it to the outbox.
     * @param {Object} job - upload job without its blob
     * @param {Object} envelope - the chunk
     */
    function queue(job, envelope) {
        gzip(envelope).then(function(blob) {
            job.blob = blob;
            outbox.add(job);
        }).catch(function(e) {
            log("error", "could not compress a chunk: " + e);
        });
    }

    /**
     * The page is closing: compression would not finish before it is gone (it runs in tasks
     * the closed page never gets), so keep the chunk as it is; the next page load sends it.
     * @param {Object} job - upload job without its blob
     * @param {Object} envelope - the chunk
     */
    function keepForNextPage(job, envelope) {
        try {
            window.localStorage.setItem(CLOSING_PREFIX + job.rid + ":" + job.seq, JSON.stringify({ job: job, envelope: envelope }));
        }
        catch (e) {
            log("warning", "could not keep chunk " + job.seq + " of " + job.rid + " for the next page: " + e);
        }
    }

    /** Send the chunks an earlier page kept while it closed. */
    function sendKeptChunks() {
        var kept = [];
        try {
            for (var i = 0; i < window.localStorage.length; i++) {
                var key = window.localStorage.key(i);
                if (key && key.indexOf(CLOSING_PREFIX) === 0) {
                    kept.push(key);
                }
            }
            kept.forEach(function(key) {
                var item = JSON.parse(window.localStorage.getItem(key));
                window.localStorage.removeItem(key);
                queue(item.job, item.envelope);
            });
        }
        catch (e) {
            log("warning", "could not send the chunks kept by an earlier page: " + e);
        }
        if (kept.length) {
            log("debug", "sending " + kept.length + " chunk(s) kept by an earlier page");
        }
    }

    /**
     * A new chunk was sealed: it joins the buffer, the triggered recordings still recording
     * their `after` seconds, and the study recording.
     * @param {Object} chunk - sealed chunk
     */
    function onChunk(chunk) {
        var s = settings();
        if (bufferWanted) {
            var tab = streamId();
            buffer.push(chunk);
            mirror.put(tab, chunk);
            var from = chunk.t1 - s.window * 1000;
            // keep the chunk that reaches back past the window start whole
            while (buffer.length > 1 && buffer[1].t0 <= from) {
                mirror.remove(tab, buffer.shift());
            }
        }
        openTriggered.forEach(function(rec) {
            rec.chunks.push(chunk);
        });
        if (studyRecording) {
            var rec = studyRecording;
            var ended = ending ? "closed" : endOfStudyRecording(rec, chunk);
            send(rec, chunk, !!ended);
            if (ended) {
                log("debug", "study recording " + rec.rid + " ended: " + ended);
                studyRecording = null;
                if (ended === "max duration" && Date.now() - capture.lastActivity() < 60000) {
                    startStudyRecording();
                }
            }
        }
    }

    /**
     * @param {Object} rec - study recording
     * @param {Object} chunk - its latest chunk
     * @returns {string|null} why it ends with this chunk, or null
     */
    function endOfStudyRecording(rec, chunk) {
        if (!study || Date.now() >= study.until) {
            return "study ended";
        }
        if (chunk.t1 - rec.t0 >= study.md * 1000) {
            return "max duration";
        }
        if (chunk.t1 - capture.lastActivity() >= study.idle * 1000) {
            return "idle";
        }
        return null;
    }

    /**
     * The tab's stream on the SDK's requests (PLAN.md 5.4): on while capturing, and while this page
     * still waits for its server settings; off otherwise.
     */
    function syncStream() {
        var on = !stopped && bridge.hasConsent() && bridge.isTracking() && (!!capture || awaitingSettings);
        bridge.setStream(on ? streamId() : null);
    }

    /** This page's server settings arrived (or will not): the stream stays on only while capturing. */
    function settingsArrived() {
        if (awaitingSettings) {
            awaitingSettings = false;
            zoneFree.clearTimer(settingsTimer);
            syncStream();
        }
    }

    /** Begin what the settings and consent allow, and set the stream to match. */
    function ensureCapture() {
        startCapture();
        syncStream();
    }

    /** Begin the rolling buffer and/or study capture, as the settings and consent allow. */
    function startCapture() {
        if (stopped || !bridge.hasConsent() || !bridge.isTracking()) {
            if (capture && !bridge.isTracking()) {
                stopCapture();
            }
            return;
        }
        var s = settings();
        var info = bridge.info();
        bufferWanted = !!s.enabled && hashUnit(String(info.device_id || "")) < s.sampleRate;
        study = s.study && (!s.study.scope || s.study.scope.some(function(p) {
            return matchesScope(p, window.location.pathname);
        })) ? s.study : null;
        if (!bufferWanted && !study) {
            return;
        }
        if (typeof CompressionStream === "undefined") {
            log("warning", "this browser cannot compress recordings (no CompressionStream); not recording");
            return;
        }
        if (!capture) {
            var factory = recorders[s.recorder] || recorders.wire;
            if (!recorders[s.recorder]) {
                log("warning", "recorder \"" + s.recorder + "\" is not loaded; using cly-wire");
            }
            recorder = factory({ privacy: s.privacy, clock: clock });
            capture = createCapture({ recorder: recorder, keyframeInterval: s.keyframeInterval, clock: clock, onChunk: onChunk });
            bridge.setStream(streamId());
            capture.start();
            log("debug", "capture started with " + recorder.format + (study ? " for study " + study.id : ""));
            if (bufferWanted) {
                restoreBuffer(s);
            }
        }
        if (study && !studyRecording) {
            startStudyRecording();
            if (study.ia) {
                bridge.enableStudyInteractions(function() {
                    return !!studyRecording;
                });
            }
            if (study.av) {
                watchNavigation();
            }
        }
    }

    /**
     * Put back the chunks the tab's previous pages left in the window, ahead of this page's.
     * @param {Object} s - settings
     */
    function restoreBuffer(s) {
        var format = recorder.format;
        mirror.load(streamId(), clock() - s.window * 1000, format).then(function(previous) {
            if (!capture || !bufferWanted || recorder.format !== format || !previous.length) {
                return;
            }
            var firstHere = buffer.length ? buffer[0].t0 : Infinity;
            buffer = previous.filter(function(chunk) {
                return chunk.t1 <= firstHere;
            }).concat(buffer);
            log("debug", "buffer restored " + previous.length + " chunk(s) from earlier pages of this tab");
        });
    }

    /** Start a study recording (at load, and again after one ends at its maximum duration). */
    function startStudyRecording() {
        var t0 = clock();
        studyRecording = { rid: randomId("r"), kind: "study", study: study.id, stream: streamId(), t0: t0, seq: 0 };
        lastRid = studyRecording.rid;
        bridge.recordStart({ rid: studyRecording.rid, kind: "study", study: study.id, fmt: recorder.format, rec_v: recorder.name + "@" + recorder.version }, t0);
        if (study.av) {
            Countly.track_pageview(window.location.pathname);
        }
    }

    /** Studies on apps without page views: a view on every route change of a single-page app. */
    function watchNavigation() {
        var last = window.location.pathname;
        var check = function() {
            if (studyRecording && window.location.pathname !== last) {
                last = window.location.pathname;
                Countly.track_pageview(last);
            }
        };
        ["pushState", "replaceState"].forEach(function(name) {
            var original = window.history[name];
            window.history[name] = function() {
                var result = original.apply(this, arguments);
                zoneFree.setTimer(check, 0);
                return result;
            };
        });
        zoneFree.listen(window, "popstate", check);
        zoneFree.listen(window, "hashchange", check);
    }

    function stopCapture() {
        if (capture) {
            capture.stop();
            capture = null;
        }
        buffer = [];
        mirror.clear(streamId());
        bridge.setStream(null);
    }

    /**
     * Turn the buffer into a triggered recording (PLAN.md 7.3): the past `window` seconds,
     * and `after` more seconds; sent once it has ended.
     * @param {string} type - crash, event, view or api
     * @param {string} key - event key, view name or api reason
     * @param {number} [after] - seconds to keep recording, overriding the setting
     * @returns {string|null} recording id
     */
    function trigger(type, key, after) {
        if (!capture || !bufferWanted) {
            return null;
        }
        var s = settings();
        if (dailyCount(0) >= s.maxPerDay) {
            log("warning", "maxPerDay (" + s.maxPerDay + ") recordings reached; not recording this " + type);
            return null;
        }
        dailyCount(1);
        // The buffer holds sealed chunks only: seal the one in progress, or a trigger soon
        // after a seal (or before the first) would lose the seconds just before it.
        capture.seal();
        var now = clock();
        var chunks = buffer.slice();
        var t0 = chunks.length ? chunks[0].t0 : now;
        var rec = {
            rid: randomId("r"), kind: "triggered", stream: streamId(), t0: t0, seq: 0, chunks: chunks,
            trigger: { type: type, ts: now }
        };
        if (key) {
            rec.trigger.key = String(key).slice(0, 256);
        }
        lastRid = rec.rid;
        bridge.recordStart({ rid: rec.rid, kind: "triggered", trigger: type, trigger_key: rec.trigger.key, fmt: recorder.format, rec_v: recorder.name + "@" + recorder.version }, t0);
        openTriggered.push(rec);
        var seconds = Math.min(typeof after === "number" ? after : s.after, s.maxDuration);
        rec.timer = zoneFree.setTimer(function() {
            finishTriggered(rec);
        }, seconds * 1000);
        log("debug", "triggered recording " + rec.rid + " (" + type + (key ? " " + key : "") + ")");
        return rec.rid;
    }

    /**
     * The triggered recording has ended: seal the current chunk and send all of them.
     * @param {Object} rec - recording
     */
    function finishTriggered(rec) {
        zoneFree.clearTimer(rec.timer);
        if (capture) {
            capture.seal();
        }
        openTriggered = openTriggered.filter(function(r) {
            return r !== rec;
        });
        var s = settings();
        var chunks = rec.chunks;
        // keep the newest chunks within maxBytes (sizes are estimated from the JSON)
        var total = 0;
        var kept = [];
        for (var i = chunks.length - 1; i >= 0; i--) {
            total += JSON.stringify(chunks[i].data).length;
            if (total > s.maxBytes && kept.length) {
                break;
            }
            kept.unshift(chunks[i]);
        }
        kept.forEach(function(chunk, index) {
            send(rec, chunk, index === kept.length - 1);
        });
    }

    // --- SDK notifications ---------------------------------------------------------------------
    bridge.attach({
        isRecording: function() {
            return !!capture;
        },
        maskAllText: function() {
            return !!settings().privacy.maskAllText;
        },
        nodeId: function(el) {
            return recorder && capture ? recorder.nodeId(el) : undefined;
        },
        onEvent: function(event) {
            if (!capture) {
                return;
            }
            var t = settings().triggers;
            if (event.key === "[CLY]_view" && event.segmentation && event.segmentation.visit) {
                if ((t.views || []).indexOf(event.segmentation.name) !== -1) {
                    trigger("view", event.segmentation.name);
                }
                return;
            }
            (t.events || []).some(function(rule) {
                var key = typeof rule === "string" ? rule : rule && rule.key;
                if (key !== event.key) {
                    return false;
                }
                var sg = (rule && rule.sg) || {};
                var segments = event.segmentation || {};
                if (Object.keys(sg).every(function(k) {
                    return matchesRule(segments[k], sg[k]);
                })) {
                    trigger("event", event.key);
                    return true;
                }
                return false;
            });
        },
        onCrash: function(crash) {
            var c = settings().triggers.crash || {};
            if (crash.nonfatal ? c.nonfatal : c.fatal) {
                trigger("crash", crash.nonfatal ? "nonfatal" : "fatal");
            }
        },
        onConsent: function(given) {
            if (given) {
                ensureCapture();
            }
            else {
                // consent withdrawn: drop what is buffered and stop; stored recordings stay (PLAN.md 13.2)
                openTriggered.forEach(function(rec) {
                    zoneFree.clearTimer(rec.timer);
                });
                openTriggered = [];
                studyRecording = null;
                stopCapture();
            }
        },
        onServerConfig: function() {
            ensureCapture();
            settingsArrived();
        }
    });

    zoneFree.listen(window, "pagehide", function() {
        // the tab is going away: end what is open, keep what is not compressed yet for the
        // next page load, and send what is ready in keepalive requests
        leaving = true;
        openTriggered.slice().forEach(finishTriggered);
        // seal the page's last seconds: the study ends with them, the buffer mirror keeps them for the next page
        if ((studyRecording || bufferWanted) && capture) {
            ending = true;
            capture.seal();
            ending = false;
        }
        leaving = false;
        outbox.flushOnHide();
    });

    zoneFree.listen(window, "pageshow", function(e) {
        // back from the back/forward cache: send what the page kept, and follow the ended study recording with a new one
        if (e.persisted) {
            sendKeptChunks();
            ensureCapture();
        }
    });

    outbox.restore();
    sendKeptChunks();
    ensureCapture();

    return {
        /** Start the rolling buffer (when init did not, or after stop()). */
        start: function() {
            stopped = false;
            ensureCapture();
        },
        /**
         * Send a recording now: the past window and `after` more seconds.
         * @param {Object} [options] - {reason, after}
         * @returns {string|null} recording id, or null when nothing is being recorded
         */
        send: function(options) {
            options = options || {};
            return trigger("api", options.reason || "api", options.after);
        },
        /** Stop recording; open recordings are sent first. */
        stop: function() {
            stopped = true;
            openTriggered.slice().forEach(finishTriggered);
            if (studyRecording && capture) {
                ending = true;
                capture.seal();
                ending = false;
            }
            studyRecording = null;
            stopCapture();
        },
        /** @param {Element} el - mask this element's text in recordings */
        mask: function(el) {
            if (el && el.classList) {
                el.classList.add("cly-mask");
            }
        },
        /** @param {Element} el - stop masking this element's text */
        unmask: function(el) {
            if (el && el.classList) {
                el.classList.remove("cly-mask");
            }
        },
        /** @returns {Object} what is being recorded */
        status: function() {
            var oldest = buffer.length ? buffer[0].t0 : null;
            return {
                buffering: !!capture && bufferWanted,
                bufferedMs: oldest ? clock() - oldest : 0,
                study: studyRecording ? { id: studyRecording.study, rid: studyRecording.rid } : null,
                recorder: recorder ? recorder.format : null,
                lastRid: lastRid,
                pendingUploads: outbox.size(),
                version: VERSION
            };
        }
    };
}

/**
 * Registers a recorder (the rrweb plugin calls this when it loads).
 * @param {string} name - recorder name, as the rec_r setting names it
 * @param {function} factory - (options) => recorder adapter
 */
function registerRecorder(name, factory) {
    recorders[name] = factory;
}

pendingRecorders.forEach(function(entry) {
    registerRecorder(entry[0], entry[1]);
});
window.__countlyRecorders = { push: function(entry) {
    registerRecorder(entry[0], entry[1]);
} };

/**
 * Attach to an initialized SDK instance, once, and make its API `Countly.recording`.
 * @param {Object} Countly - the global Countly object, which carries the API
 * @param {Object} instance - the SDK instance to record for
 */
function attachTo(Countly, instance) {
    if (Countly.recording && Countly.recording.version) {
        return;
    }
    var queued = Array.isArray(Countly.recording) ? Countly.recording : [];
    Countly.recording = createRecordingModule(instance);
    Countly.recording.version = VERSION;
    queued.forEach(function(call) {
        if (Countly.recording[call[0]]) {
            Countly.recording[call[0]].apply(null, call.slice(1));
        }
    });
}

// the global Countly object the init hook was left on: a page that puts another one there gets the hook too
var waitingOn = null;

/**
 * Attach to the SDK. Loaded after init, at once. Loaded before it, during init
 * (`Countly._onInit`), before the page's first requests are made, so they carry the tab's
 * stream. As a fallback, it looks again every 200 ms.
 *
 * Loaded before the SDK (or before the loader, countly-sdk-web/loader), it makes the global
 * Countly object itself: the SDK and the loader take over the one they find, so the hook
 * left on it runs at init.
 */
function attach() {
    var Countly = window.Countly = window.Countly || {};
    if (Countly._internals && Countly._internals.recording && Countly.app_key) {
        attachTo(Countly, Countly);
        return;
    }
    if (Countly.recording && Countly.recording.version) {
        return;
    }
    if (waitingOn !== Countly) {
        waitingOn = Countly;
        Countly._onInit = Countly._onInit || [];
        Countly._onInit.push(function(instance) {
            if (instance._internals && instance._internals.recording) {
                attachTo(Countly, instance);
            }
        });
    }
    zoneFree.setTimer(attach, 200);
}

if (typeof window !== "undefined") {
    attach();
}

export { createRecordingModule, registerRecorder, matchesRule, matchesScope, hashUnit };
