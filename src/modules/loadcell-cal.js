// Pure helpers for the Bengle load-cell calibration wizard.
//
// The wizard UI lives in src/settings/settings.js and drives reaprime's
// POST /api/v1/machine/scale/calibrate (two-point firmware cal: zero the
// empty platform, then latch the SAME known mass on the LEFT and RIGHT
// halves; the firmware solves both per-cell gains). This module holds the
// DOM-free logic — reference-mass clamping, the request-body wire shape,
// the abort 202-no-body policy, and the action-area state map — so the
// node:test suite can lock it in (see test/loadcell-cal.test.mjs and
// test/README.md).

export const CAL_WEIGHT_MIN_G = 1;
export const CAL_WEIGHT_MAX_G = 10000;
export const CAL_WEIGHT_DEFAULT_G = 500;

/**
 * Clamp a reference-mass entry to an integer 1–10000 g.
 * Accepts numbers or numeric strings (the numpad dispatches a change event
 * with a string value). Unparseable input returns null — callers keep the
 * previous mass rather than corrupting it.
 */
export function clampCalWeight(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(n)) return null;
    return Math.max(CAL_WEIGHT_MIN_G, Math.min(CAL_WEIGHT_MAX_G, Math.round(n)));
}

/**
 * Build the ScaleCalibrationRequest body. `grams` is attached only when it
 * is neither null nor undefined — 'zero' and 'abort' must not carry it.
 * @param {'zero'|'left'|'right'|'abort'} command
 * @param {number} [grams]
 */
export function buildCalibrateBody(command, grams) {
    const body = { command };
    if (grams != null) body.grams = grams;
    return body;
}

/**
 * Whether the calibrate response carries a JSON body.
 * zero/left/right -> 200 with a ScaleCalResult; abort -> 202 with NO body,
 * so calling response.json() on it would throw.
 */
export function calResponseHasBody(command) {
    return command !== 'abort';
}

/**
 * Resolve the wizard action area's state -> {status, statusText, label,
 * action, primary}. ONE button that swaps label/action in place, plus a
 * fixed-height status slot, so the card height stays constant and buttons
 * never jump (the errorLine/doneRow first cut was rejected for jumping):
 *   done  -> status '✓ Done',   button 'Next'  (primary)  -> next step
 *   busy  -> status busyLabel,  button 'Cancel' (secondary) -> abort
 *   error -> status the error,  button runLabel (primary)  -> retry the step
 *   idle  -> status blank,      button runLabel (primary)  -> run the step
 * `done` wins over `busy`/`error`;
 * a step that succeeded always offers Next.
 */
export function calActionState({ busy, error, done, runLabel, busyLabel }) {
    if (done) {
        return { status: 'done', statusText: '', label: 'Next', action: 'next', primary: true };
    }
    if (busy) {
        return { status: 'busy', statusText: busyLabel, label: 'Cancel', action: 'cancel', primary: false };
    }
    if (error) {
        return { status: 'error', statusText: error, label: runLabel, action: 'run', primary: true };
    }
    return { status: 'idle', statusText: '', label: runLabel, action: 'run', primary: true };
}
