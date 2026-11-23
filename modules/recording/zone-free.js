// The recording module's own timers, listeners and DOM observer run outside zone.js zones, as the SDK's do
// (Utils.getZoneJsOriginal): on a page with zone.js, as in Angular apps, each of them would otherwise run Angular's
// change detection, and a recording keeps them going all the time, so the app would never become stable. zone.js
// keeps each function it patches under the name Zone.__symbol__ gives; without zone.js these are the browser's own.
// The module is a file of its own, loaded next to the SDK, so it keeps its own copy of that rule.

/**
 * The value a property had before zone.js patched it.
 * @param {Object} target - the object holding it (window, an element)
 * @param {string} name - the property name
 * @returns {*} the original value
 */
function original(target, name) {
    var zone = typeof globalThis !== "undefined" ? globalThis.Zone : undefined;
    var value;
    if (zone && typeof zone.__symbol__ === "function") {
        value = target[zone.__symbol__(name)];
    }
    return value || target[name];
}

/**
 * setTimeout outside zone.js.
 * @param {function} fn - callback
 * @param {number} ms - delay
 * @returns {*} timer id
 */
function setTimer(fn, ms) {
    return original(globalThis, "setTimeout").call(globalThis, fn, ms);
}

/** @param {*} id - a timer from setTimer */
function clearTimer(id) {
    original(globalThis, "clearTimeout").call(globalThis, id);
}

/**
 * setInterval outside zone.js.
 * @param {function} fn - callback
 * @param {number} ms - interval
 * @returns {*} timer id
 */
function setRepeat(fn, ms) {
    return original(globalThis, "setInterval").call(globalThis, fn, ms);
}

/** @param {*} id - a timer from setRepeat */
function clearRepeat(id) {
    original(globalThis, "clearInterval").call(globalThis, id);
}

/**
 * addEventListener outside zone.js.
 * @param {Object} target - event target
 * @param {string} type - event
 * @param {function} fn - listener
 * @param {boolean|Object} [options] - capture, or listener options
 */
function listen(target, type, fn, options) {
    original(target, "addEventListener").call(target, type, fn, options);
}

/**
 * removeEventListener for a listener added with listen.
 * @param {Object} target - event target
 * @param {string} type - event
 * @param {function} fn - listener
 * @param {boolean|Object} [options] - capture, as when it was added
 */
function unlisten(target, type, fn, options) {
    original(target, "removeEventListener").call(target, type, fn, options);
}

/**
 * MutationObserver outside zone.js, or undefined where the browser has none.
 * @returns {function|undefined} the constructor
 */
function mutationObserver() {
    return typeof window === "undefined" || typeof window.MutationObserver === "undefined" ? undefined : original(window, "MutationObserver");
}

export { setTimer, clearTimer, setRepeat, clearRepeat, listen, unlisten, mutationObserver };
