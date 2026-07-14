// Cup-warmer pure helpers (Bengle).
//
// Machine truth over REST is GET/PUT /machine/cupWarmer with a single
// `temperature` field — the SETPOINT in °C (0 = off). The field name reads
// like a measurement but it is a MatSetPoint read-back; there is no separate
// enable field on the wire, so `temperature > 0` IS the "on" state.
//
// Newer reaprime builds additionally report `currentTemperature` on the GET:
// the live mat temperature in °C (number), or null when the firmware has no
// valid reading. The field is ABSENT entirely on older builds — both null and
// absent must render as "no reading", never as fabricated data.
//
// The UI target floor is 30 °C while the wire accepts 0–80: 0 is reserved for
// "off", so a stored/typed target always normalizes into 30–80.
//
// This module is deliberately DOM-free so the node:test suite can import it
// (see test/cup-warmer.test.mjs and test/README.md).

// localStorage keys — shared by the Settings page and the header quick-toggle.
// Renaming any of these silently orphans users' persisted targets.
export const CUP_WARMER_TARGET_KEY = 'streamline.cupWarmerTarget';

/** True when a cup-warmer setpoint (°C) means "on" — 0 / null / absent = off. */
export function isCupWarmerOn(temperature) {
    return (temperature ?? 0) > 0;
}

/**
 * Stored target string → valid whole °C. In-range values (30–80) pass through;
 * anything else (unset, NaN, out of range) falls to the 70 °C default — the
 * read path snaps to the default rather than clamping.
 */
export function readCupWarmerTarget(stored) {
    const v = parseInt(stored || '70', 10);
    return (v >= 30 && v <= 80) ? v : 70;
}

/** User-entered target → whole °C clamped into 30–80 (NaN and 0 fall to 70). */
export function clampCupWarmerTarget(value) {
    return Math.max(30, Math.min(80, Math.round(value) || 70));
}

/**
 * GET response `currentTemperature` (number | null | absent) → display string
 * with one decimal ("36.5"), or null meaning "no reading" (render a
 * placeholder, never fake data). Non-numbers and non-finite values are
 * defensively treated as "no reading".
 */
export function formatCurrentMatTemp(currentTemperature) {
    return (typeof currentTemperature === 'number' && Number.isFinite(currentTemperature))
        ? currentTemperature.toFixed(1)
        : null;
}

// ── Shared cup-warmer snapshot (the ONE app-side copy of machine state) ──────
// Historically three copies of "is the warmer on" existed: the machine, the
// Settings page's fetch-once cache, and the header quick-toggle's boot-seeded
// boolean — which is how the bench got a cup-warmer page frozen at a
// 20-minute-old temperature (audit I1, bench checklist 2b). ES modules are
// singletons and the router innerHTML-swaps pages without reloading modules,
// so this store IS shared between src/modules/app.js (header toggle) and
// src/settings/settings.js (Cup Warmer page): both render from it, every
// fetch/PUT result folds into it, and machine (re)connects invalidate it.
//
// Snapshot shape mirrors GET /machine/cupWarmer — { temperature,
// currentTemperature? } — or null meaning "not loaded / invalidated, refetch
// before trusting". Deliberately DOM-free so node:test covers it
// (test/cup-warmer.test.mjs).
let cupWarmerState = null;
const cupWarmerListeners = new Set();

/** Current snapshot ({ temperature, currentTemperature? }) or null when unloaded/stale. */
export function getCupWarmerState() {
    return cupWarmerState;
}

/** Replace the snapshot and notify subscribers (null = invalidate). */
export function setCupWarmerState(next) {
    cupWarmerState = next;
    for (const listener of cupWarmerListeners) {
        try { listener(cupWarmerState); } catch (e) { /* one bad subscriber must not starve the rest */ }
    }
}

/** Merge fields into the snapshot — e.g. a setpoint PUT keeps the last currentTemperature visible. */
export function patchCupWarmerState(patch) {
    setCupWarmerState({ ...(cupWarmerState || {}), ...patch });
}

/** Drop the snapshot on machine (re)connect so every reader refetches. */
export function invalidateCupWarmerState() {
    setCupWarmerState(null);
}

/** Subscribe to snapshot changes; returns an unsubscribe function. */
export function onCupWarmerStateChange(listener) {
    cupWarmerListeners.add(listener);
    return () => cupWarmerListeners.delete(listener);
}
