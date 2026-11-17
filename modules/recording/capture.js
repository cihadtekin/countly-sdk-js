// One capture of the page, cut into chunks (PLAN.md 6.1, 8.2): every chunk starts with a
// keyframe, so it can be replayed on its own. The recorder adapter serializes the screen;
// this file owns the chunk timer and the format-independent overlay tracks.

var POINTER_INTERVAL = 50;
var SCROLL_INTERVAL = 100;

/**
 * @param {Object} options - {recorder, keyframeInterval (s), clock, onChunk(chunk), screen}
 * @returns {Object} capture: start, stop, seal, isRunning, lastActivity
 */
function createCapture(options) {
    var recorder = options.recorder;
    var clock = options.clock || Date.now;
    var interval = Math.max(2, options.keyframeInterval || 8) * 1000;
    var current = null;
    var timer = null;
    var running = false;
    var listeners = [];
    var lastPointer = 0;
    var lastScroll = 0;
    var lastActivity = clock();
    var lastLocation = null;
    // rrweb carries its own cursor and scroll; the overlay keeps only what it lacks
    var ownPointer = recorder.format !== "rrweb/2";

    /** @returns {Object} an empty chunk starting now */
    function newChunk() {
        return {
            t0: clock(),
            t1: clock(),
            frames: [],
            overlay: { pointer: [], scroll: [], viewport: [], visibility: [], location: [] },
            screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }
        };
    }

    var sink = {
        keyframe: function(t, frame) {
            if (current && current.frames.length) {
                finish();
            }
            if (!current) {
                current = newChunk();
            }
            current.t0 = Math.min(current.t0, t);
            current.frames.push(frame);
            current.t1 = Math.max(current.t1, t);
            noteLocation();
        },
        delta: function(t, frame) {
            if (!current) {
                return;
            }
            current.frames.push(frame);
            current.t1 = Math.max(current.t1, t);
        }
    };

    /** Close the current chunk and hand it over. */
    function finish() {
        if (!current || !current.frames.length) {
            return;
        }
        current.t1 = Math.max(current.t1, clock());
        var chunk = current;
        current = null;
        chunk.data = recorder.packChunk(chunk.frames);
        delete chunk.frames;
        chunk.format = recorder.format;
        chunk.recorder = { name: recorder.name, version: recorder.version };
        options.onChunk(chunk);
    }

    /** Seal the chunk now and start the next one with a keyframe. */
    function seal() {
        if (!running) {
            return;
        }
        finish();
        current = newChunk();
        recorder.keyframe();
    }

    /** @param {string} kind - pointer kind for the track */
    function activity() {
        lastActivity = clock();
    }

    /** Address-bar track; also catches SPA navigations between captures. */
    function noteLocation() {
        var href = window.location.pathname + window.location.hash;
        if (current && href !== lastLocation) {
            lastLocation = href;
            current.overlay.location.push([clock(), href]);
        }
    }

    /**
     * @param {Object} target - event target
     * @param {string} type - event
     * @param {function} fn - listener
     */
    function listen(target, type, fn) {
        target.addEventListener(type, fn, { capture: true, passive: true });
        listeners.push([target, type, fn]);
    }

    /**
     * @param {number} kind - 0 move, 1 down, 2 up, 3 touch start, 4 touch move, 5 touch end
     * @returns {function} listener recording the pointer
     */
    function pointer(kind) {
        return function(event) {
            activity();
            if (!current || !ownPointer) {
                return;
            }
            var t = clock();
            if (kind === 0 || kind === 4) {
                if (t - lastPointer < POINTER_INTERVAL) {
                    return;
                }
                lastPointer = t;
            }
            var point = event.touches && event.touches[0] ? event.touches[0] : (event.changedTouches && event.changedTouches[0]) || event;
            current.overlay.pointer.push([t, Math.round(point.clientX || 0), Math.round(point.clientY || 0), kind]);
        };
    }

    return {
        start: function() {
            if (running) {
                return;
            }
            running = true;
            current = newChunk();
            listen(document, "mousemove", pointer(0));
            listen(document, "mousedown", pointer(1));
            listen(document, "mouseup", pointer(2));
            listen(document, "touchstart", pointer(3));
            listen(document, "touchmove", pointer(4));
            listen(document, "touchend", pointer(5));
            listen(document, "keydown", activity);
            listen(window, "scroll", function() {
                activity();
                var t = clock();
                if (!current || !ownPointer || t - lastScroll < SCROLL_INTERVAL) {
                    return;
                }
                lastScroll = t;
                current.overlay.scroll.push([t, Math.round(window.scrollX || 0), Math.round(window.scrollY || 0)]);
            });
            listen(window, "resize", function() {
                if (current) {
                    current.overlay.viewport.push([clock(), window.innerWidth, window.innerHeight]);
                }
            });
            listen(document, "visibilitychange", function() {
                if (current) {
                    current.overlay.visibility.push([clock(), document.visibilityState === "hidden" ? 0 : 1]);
                }
            });
            recorder.start(sink, {});
            if (current) {
                current.overlay.scroll.push([clock(), Math.round(window.scrollX || 0), Math.round(window.scrollY || 0)]);
            }
            timer = setInterval(function() {
                noteLocation();
                // a hidden tab draws nothing new: no empty chunks every few seconds
                if (document.visibilityState !== "hidden") {
                    seal();
                }
            }, interval);
        },

        stop: function() {
            if (!running) {
                return;
            }
            finish();
            running = false;
            clearInterval(timer);
            recorder.stop();
            listeners.forEach(function(l) {
                l[0].removeEventListener(l[1], l[2], true);
            });
            listeners = [];
            current = null;
        },

        seal: seal,
        isRunning: function() {
            return running;
        },
        lastActivity: function() {
            return lastActivity;
        }
    };
}

export { createCapture };
