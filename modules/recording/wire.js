// cly-wire/1 recorder: draws the page as a scene of boxes, colours and (masked) text,
// not as a copy of its DOM. Based on the Echo experiment's scene model: every frame is
// a diff of the visible scene against the previous one; a keyframe is the full scene.
//
// Chunk data (one per chunk, see packChunk):
//   { styles: [style...], frames: [[t, full, docW, docH, upserts, removes]] }
//   upsert = [id, parent, kind, x, y, w, h, style, text, flags]
//     kind:  0 surface, 1 text, 2 button, 3 field, 4 image, 5 media, 6 blocked, 7 frame
//     x, y:  page coordinates (fixed elements: viewport coordinates, flag 1)
//     style: index into styles: [background, color, border, radius, fontSize, fontWeight, fontFamily, textAlign, opacity, shadow]
//     text:  visible text, masked on the device when the privacy rules say so (null when none)
//     flags: 1 fixed, 2 text masked, 4 field (value never recorded), 8 checked
// The format's renderer is in the Countly dashboard (session-replays plugin).

var VERSION = "0.1.0";
var MAX_NODES = 1500;
var MAX_TEXT = 300;
// How far beyond the viewport the scene reaches, in viewports: enough to scroll without gaps.
var BAND = 1.5;

var KIND = { SURFACE: 0, TEXT: 1, BUTTON: 2, FIELD: 3, IMAGE: 4, MEDIA: 5, BLOCKED: 6, FRAME: 7 };
var FLAG = { FIXED: 1, MASKED: 2, FIELD: 4, CHECKED: 8 };

var TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

/**
 * @param {string} text - text to mask
 * @returns {string} same length, letters and digits replaced
 */
function maskText(text) {
    return text.replace(/[^\s]/g, "*");
}

/**
 * The element's own text: its direct text nodes, collapsed.
 * @param {Element} el - element
 * @returns {string} text, or ""
 */
function ownText(el) {
    var text = "";
    for (var child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
            text += child.nodeValue;
        }
    }
    return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/**
 * @param {Element} el - element
 * @returns {number} the scene kind
 */
function kindOf(el) {
    var tag = el.tagName;
    if (tag === "BUTTON" || (tag === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) || el.getAttribute("role") === "button") {
        return KIND.BUTTON;
    }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
        return KIND.FIELD;
    }
    if (tag === "IMG" || tag === "PICTURE" || tag === "SVG" || tag === "svg") {
        return KIND.IMAGE;
    }
    if (tag === "VIDEO" || tag === "CANVAS" || tag === "AUDIO") {
        return KIND.MEDIA;
    }
    if (tag === "IFRAME") {
        return KIND.FRAME;
    }
    return KIND.SURFACE;
}

/**
 * Creates a cly-wire recorder for one document.
 * @param {Object} options - {privacy: {maskAllText, maskAllInputs}, clock}
 * @returns {Object} recorder adapter: start, stop, keyframe, nodeId, packChunk
 */
function createWireRecorder(options) {
    var privacy = (options && options.privacy) || {};
    var clock = (options && options.clock) || Date.now;
    var ids = new WeakMap();
    var nextId = 1;
    var previous = new Map();
    var sink = null;
    var observer = null;
    var pending = null;
    var running = false;
    var listeners = [];

    /**
     * @param {Element} el - element
     * @returns {number} its stable scene id
     */
    function idOf(el) {
        var id = ids.get(el);
        if (!id) {
            id = nextId++;
            ids.set(el, id);
        }
        return id;
    }

    /**
     * Read the visible scene: significant elements in the viewport band, in DOM (paint) order.
     * @returns {Map} id -> upsert tuple without the style index resolved (style is a string key)
     */
    function readScene() {
        var scene = new Map();
        var scrollX = window.scrollX || 0;
        var scrollY = window.scrollY || 0;
        var vh = window.innerHeight;
        var top = -vh * BAND;
        var bottom = vh * (1 + BAND);
        var maskAll = !!privacy.maskAllText;
        var count = 0;

        /**
         * @param {Element} el - element to visit
         * @param {number} parentId - nearest recorded ancestor
         * @param {boolean} masked - inside cly-mask (or all text masked)
         * @param {boolean} fixedAncestor - inside a fixed element
         */
        function visit(el, parentId, masked, fixedAncestor) {
            if (count >= MAX_NODES || el.nodeType !== 1) {
                return;
            }
            var tag = el.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD" || tag === "META" || tag === "LINK") {
                return;
            }
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                return;
            }
            var rect = el.getBoundingClientRect();
            var isFixed = fixedAncestor || style.position === "fixed";
            var classList = el.classList;
            var blocked = classList && classList.contains("cly-block");
            var nowMasked = masked || (classList && classList.contains("cly-mask"));
            var inBand = rect.bottom >= top && rect.top <= bottom && rect.width > 0 && rect.height > 0;
            var kind = blocked ? KIND.BLOCKED : kindOf(el);
            var text = kind === KIND.FIELD || blocked ? "" : ownText(el);
            // an input button's label is its value, which the page sets, not the user
            if (kind === KIND.BUTTON && el.tagName === "INPUT" && !text) {
                text = String(el.value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
            }
            var hasPaint = !TRANSPARENT.test(style.backgroundColor) || style.borderTopWidth !== "0px" || style.boxShadow !== "none" || style.backgroundImage !== "none";
            var significant = inBand && (kind !== KIND.SURFACE || hasPaint || text);
            var id = parentId;
            if (significant) {
                id = idOf(el);
                var flags = 0;
                if (isFixed) {
                    flags |= FLAG.FIXED;
                }
                var shown = null;
                if (text) {
                    shown = nowMasked ? maskText(text) : text;
                    if (nowMasked) {
                        flags |= FLAG.MASKED;
                    }
                }
                if (kind === KIND.FIELD) {
                    flags |= FLAG.FIELD;
                    // the value is never recorded; a placeholder is the page's text, not the user's
                    if (el.placeholder && !el.value) {
                        shown = nowMasked ? maskText(el.placeholder) : el.placeholder.slice(0, MAX_TEXT);
                    }
                    else if (el.value && el.type !== "checkbox" && el.type !== "radio") {
                        // only the length of what was typed
                        shown = maskText(String(el.value).slice(0, MAX_TEXT));
                    }
                    if ((el.type === "checkbox" || el.type === "radio") && el.checked) {
                        flags |= FLAG.CHECKED;
                    }
                }
                var styleKey = [
                    style.backgroundColor, style.color,
                    style.borderTopWidth !== "0px" ? style.borderTopWidth + " " + style.borderTopStyle + " " + style.borderTopColor : "",
                    style.borderTopLeftRadius, style.fontSize, style.fontWeight, style.fontFamily.split(",")[0], style.textAlign,
                    style.opacity, style.boxShadow === "none" ? "" : "1"
                ];
                scene.set(id, [
                    id, parentId, kind,
                    Math.round(rect.left + (isFixed ? 0 : scrollX)),
                    Math.round(rect.top + (isFixed ? 0 : scrollY)),
                    Math.round(rect.width), Math.round(rect.height),
                    styleKey, shown, flags
                ]);
                count++;
            }
            if (blocked || kind === KIND.FIELD || kind === KIND.IMAGE || kind === KIND.MEDIA || kind === KIND.FRAME) {
                return;
            }
            // elements far outside the band can still have visible (e.g. fixed) children
            for (var child = el.firstElementChild; child; child = child.nextElementSibling) {
                visit(child, id, nowMasked || maskAll, isFixed);
            }
        }

        if (document.body) {
            visit(document.body, 0, maskAll, false);
        }
        return scene;
    }

    /**
     * Capture now and hand the frame to the sink.
     * @param {boolean} full - a keyframe (the whole scene) rather than a diff
     */
    function capture(full) {
        if (!running || !sink) {
            return;
        }
        var started = clock();
        var scene = readScene();
        var upserts = [];
        var removes = [];
        scene.forEach(function(node, id) {
            var before = previous.get(id);
            if (full || !before || JSON.stringify(before) !== JSON.stringify(node)) {
                upserts.push(node);
            }
        });
        if (!full) {
            previous.forEach(function(_node, id) {
                if (!scene.has(id)) {
                    removes.push(id);
                }
            });
        }
        previous = scene;
        if (!full && !upserts.length && !removes.length) {
            return;
        }
        var frame = {
            t: started,
            full: full,
            docW: Math.max(document.documentElement.scrollWidth, window.innerWidth),
            docH: Math.max(document.documentElement.scrollHeight, window.innerHeight),
            upserts: upserts,
            removes: removes,
            captureMs: clock() - started
        };
        if (full) {
            sink.keyframe(started, frame);
        }
        else {
            sink.delta(started, frame);
        }
    }

    /** Coalesce bursts of changes into one capture. */
    function schedule() {
        if (pending || !running) {
            return;
        }
        pending = setTimeout(function() {
            pending = null;
            capture(false);
        }, 200);
    }

    /**
     * @param {Object} target - event target
     * @param {string} type - event
     * @param {function} fn - listener
     */
    function listen(target, type, fn) {
        target.addEventListener(type, fn, true);
        listeners.push([target, type, fn]);
    }

    return {
        name: "countly-wire",
        version: VERSION,
        format: "cly-wire/1",

        /**
         * Begin observing; frames go to sink.keyframe / sink.delta.
         * @param {Object} frameSink - {keyframe(t, frame), delta(t, frame)}
         */
        start: function(frameSink) {
            sink = frameSink;
            running = true;
            previous = new Map();
            if (typeof MutationObserver !== "undefined") {
                observer = new MutationObserver(schedule);
                observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            }
            listen(window, "scroll", schedule);
            listen(window, "resize", schedule);
            listen(document, "input", schedule);
            listen(document, "change", schedule);
            listen(document, "transitionend", schedule);
            capture(true);
        },

        /** A full snapshot now: the start of a new chunk. */
        keyframe: function() {
            capture(true);
        },

        stop: function() {
            running = false;
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            clearTimeout(pending);
            pending = null;
            listeners.forEach(function(l) {
                l[0].removeEventListener(l[1], l[2], true);
            });
            listeners = [];
        },

        /**
         * The scene id of an element (or of its nearest recorded ancestor), for sg.nid on events.
         * @param {Element} el - element
         * @returns {number|undefined} id
         */
        nodeId: function(el) {
            for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
                var id = ids.get(node);
                if (id && previous.has(id)) {
                    return id;
                }
            }
            return undefined;
        },

        /**
         * One chunk's data from its keyframe and deltas, with the styles deduplicated into a table.
         * @param {Array} frames - frames the sink collected for the chunk, keyframe first
         * @returns {Object} {styles, frames}
         */
        packChunk: function(frames) {
            var styles = [];
            var index = new Map();
            var styleIndex = function(key) {
                var k = JSON.stringify(key);
                if (!index.has(k)) {
                    index.set(k, styles.length);
                    styles.push(key);
                }
                return index.get(k);
            };
            return {
                styles: styles,
                frames: frames.map(function(f) {
                    return [f.t, f.full ? 1 : 0, f.docW, f.docH, f.upserts.map(function(n) {
                        return [n[0], n[1], n[2], n[3], n[4], n[5], n[6], styleIndex(n[7]), n[8], n[9]];
                    }), f.removes];
                }),
                captureMs: frames.reduce(function(sum, f) {
                    return sum + (f.captureMs || 0);
                }, 0)
            };
        }
    };
}

export { createWireRecorder, KIND, FLAG };
