// Element descriptions and frustration signals for the interaction events
// (`[CLY]_action` click / input / submit / rage_click / dead_click / error_click).
// Used by track_clicks and track_inputs, with or without Session Replay. Its timers and
// listeners run outside any zone.js zone, like the SDK's own (Utils.getZoneJsOriginal).
import { getZoneJsOriginal, sdkSetTimeout } from "./Utils.js";

var TEXT_LIMIT = 64;
var SELECTOR_LIMIT = 128;

/**
 * Is the element inside something the page asked not to be tracked or shown?
 * @param {Element} el - element
 * @param {string} cls - class name to look for
 * @returns {boolean} true when the element or an ancestor has the class
 */
function hasAncestorClass(el, cls) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (node.classList && node.classList.contains(cls)) {
            return true;
        }
    }
    return false;
}

/**
 * Events from these elements are not recorded at all.
 * @param {Element} el - element
 * @returns {boolean} true when ignored
 */
function isIgnored(el) {
    return !!el && (hasAncestorClass(el, "cly-ignore") || hasAncestorClass(el, "cly_user_ignore"));
}

/**
 * A short, stable selector: an id, a data-cly attribute, or up to three levels of tag and classes.
 * @param {Element} el - element
 * @returns {string} selector
 */
function selectorOf(el) {
    if (!el || el.nodeType !== 1) {
        return "";
    }
    var parts = [];
    for (var node = el, depth = 0; node && node.nodeType === 1 && depth < 3; node = node.parentElement, depth++) {
        var tag = node.tagName.toLowerCase();
        if (node.getAttribute("data-cly")) {
            parts.unshift("[data-cly=\"" + node.getAttribute("data-cly") + "\"]");
            break;
        }
        // the attribute, not `node.id`: a form with a field named "id" answers `form.id` with that field
        var id = node.getAttribute("id");
        if (id && !/\d{3,}/.test(id)) {
            parts.unshift(tag + "#" + id);
            break;
        }
        var classes = (typeof node.className === "string" ? node.className : "").split(/\s+/).filter(function(c) {
            // generated class names (CSS modules, hashes) are not stable across releases
            return c && !/\d{3,}|^css-|^sc-/.test(c);
        }).slice(0, 2);
        parts.unshift(tag + (classes.length ? "." + classes.join(".") : ""));
        if (tag === "body") {
            break;
        }
    }
    return parts.join(" > ").slice(0, SELECTOR_LIMIT);
}

/**
 * The visible label of an element, unless the page masks it or it is something the user typed.
 * @param {Element} el - element
 * @param {boolean} maskAllText - the recording masks all text
 * @returns {string|undefined} label
 */
function labelOf(el, maskAllText) {
    if (!el || maskAllText || hasAncestorClass(el, "cly-mask") || hasAncestorClass(el, "cly-block")) {
        return undefined;
    }
    var tag = el.tagName && el.tagName.toLowerCase();
    if (tag === "textarea" || el.isContentEditable) {
        return undefined;
    }
    if (tag === "input") {
        var type = (el.getAttribute("type") || "text").toLowerCase();
        // only buttons show their value as a label; anything else is what the user typed
        return type === "submit" || type === "button" || type === "reset" ? trimLabel(el.value) : undefined;
    }
    return trimLabel(el.getAttribute("aria-label") || el.innerText || el.textContent || "");
}

/**
 * @param {string} text - raw text
 * @returns {string|undefined} first line, trimmed and shortened
 */
function trimLabel(text) {
    var line = String(text || "").trim().split("\n")[0].trim();
    return line ? line.slice(0, TEXT_LIMIT) : undefined;
}

/**
 * The element a click was really meant for: the closest link, button or control.
 * @param {Element} el - event target
 * @returns {Element} the target to describe
 */
function actionTarget(el) {
    if (!el || el.nodeType !== 1) {
        return el;
    }
    var control = el.closest ? el.closest("a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[data-cly]") : null;
    return control || el;
}

/**
 * Does the element look like something that does something when clicked?
 * @param {Element} el - element
 * @returns {boolean} true for links, buttons, controls and pointer-cursor elements
 */
function isInteractiveLooking(el) {
    if (!el || el.nodeType !== 1) {
        return false;
    }
    if (el.matches && el.matches("a[href],button,input,select,textarea,summary,[role=button],[role=link],[onclick]")) {
        return true;
    }
    try {
        return window.getComputedStyle(el).cursor === "pointer";
    }
    catch (e) {
        return false;
    }
}

/**
 * Does a click on the element answer with what changes no part of the page: focus, a typed or
 * picked value, a checked box (a property, not an attribute), a file dialog? A field, a label
 * that works one, an editable element. Such a click is never dead.
 * @param {Element} el - element
 * @returns {boolean} true for fields, their labels and editable elements
 */
function takesInput(el) {
    if (!el || el.nodeType !== 1 || !el.matches) {
        return false;
    }
    if (el.matches("input")) {
        // a button-like input does something visible, or nothing
        return !/^(button|submit|reset|image)$/i.test(el.type || "");
    }
    if (el.matches("select,textarea") || el.isContentEditable) {
        return true;
    }
    return el.matches("label") && !!(el.control || el.querySelector("input,select,textarea"));
}

/**
 * The segments every interaction event carries.
 * @param {Element} el - described element
 * @param {Object} options - {maskAllText, nodeId}
 * @returns {Object} sel, tag, txt and, while recording, nid
 */
function describeElement(el, options) {
    var segments = { sel: selectorOf(el), tag: el && el.tagName ? el.tagName.toLowerCase() : "" };
    var txt = labelOf(el, options && options.maskAllText);
    if (txt) {
        segments.txt = txt;
    }
    if (options && typeof options.nodeId === "function") {
        var nid = options.nodeId(el);
        if (typeof nid === "number") {
            segments.nid = nid;
        }
    }
    return segments;
}

/**
 * The form a field belongs to and the kind of field, never its value. `form` is the form's
 * selector, the same one a submit of that form carries as `sel`, so a form's fields and its
 * submits group together; a field outside any form has none. `itype` is the field's type
 * (`text`, `email`, `checkbox`, `select-one`, `textarea`…).
 * @param {Element} el - the changed field, or the submitted form
 * @returns {Object} form and itype, each only when known
 */
function describeField(el) {
    var out = {};
    if (!el || el.nodeType !== 1) {
        return out;
    }
    var isForm = el.tagName.toLowerCase() === "form";
    // `el.form` also finds a form the field joins with a form="id" attribute from outside it
    var form = isForm ? el : (el.form && el.form.nodeType === 1 ? el.form : (el.closest ? el.closest("form") : null));
    if (form) {
        out.form = selectorOf(form);
    }
    if (!isForm && typeof el.type === "string" && el.type) {
        out.itype = el.type.toLowerCase();
    }
    return out;
}

/**
 * Rage clicks: three or more clicks within a second and 30 px of each other.
 * One rage click is reported per burst.
 * @returns {function} (time, x, y) => true when this click makes the burst a rage click
 */
function createRageDetector() {
    var clicks = [];
    var reported = false;
    return function(time, x, y) {
        clicks = clicks.filter(function(c) {
            return time - c.t <= 1000 && Math.abs(c.x - x) <= 30 && Math.abs(c.y - y) <= 30;
        });
        if (!clicks.length) {
            reported = false;
        }
        clicks.push({ t: time, x: x, y: y });
        if (clicks.length >= 3 && !reported) {
            reported = true;
            return true;
        }
        return false;
    };
}

/**
 * Dead and error clicks: a click on something interactive-looking that changed nothing
 * on the page (no DOM change, navigation or scroll) within a second, or was followed by
 * a JavaScript error within a second.
 * @param {function} report - (type, target) => void, type "dead_click" or "error_click"
 * @returns {function} (target) => void, to call on every click
 */
function createClickOutcomeWatcher(report) {
    var lastMutation = 0;
    var lastError = 0;
    var lastScroll = 0;
    var observer = null;
    var started = false;

    /** Starts watching the page once, on the first click. */
    function start() {
        if (started) {
            return;
        }
        started = true;
        if (typeof MutationObserver !== "undefined") {
            observer = new MutationObserver(function() {
                lastMutation = Date.now();
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        }
        var listen = getZoneJsOriginal(window, "addEventListener");
        listen.call(window, "error", function() {
            lastError = Date.now();
        }, true);
        listen.call(window, "unhandledrejection", function() {
            lastError = Date.now();
        });
        listen.call(window, "scroll", function() {
            lastScroll = Date.now();
        }, true);
    }

    return function(target) {
        start();
        var at = Date.now();
        var href = window.location.href;
        // a field takes the click without changing the page: never a dead click
        var watchDead = isInteractiveLooking(target) && !takesInput(target);
        sdkSetTimeout(function() {
            if (lastError >= at) {
                report("error_click", target);
                return;
            }
            if (watchDead && lastMutation < at && lastScroll < at && window.location.href === href) {
                report("dead_click", target);
            }
        }, 1000);
    };
}

export { isIgnored, selectorOf, labelOf, actionTarget, isInteractiveLooking, takesInput, describeElement, describeField, createRageDetector, createClickOutcomeWatcher };
