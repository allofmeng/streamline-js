// Screensaver policy — who may command the machine, and who may only paint.
//
// One tap on the sleep button put the machine to sleep and then woke it
// again 46 ms later. The cause was a conflation of a UI action with a machine
// command: ui.deactivateScreensaver() hid the overlay AND sent
// setMachineState('idle'). The sleep button optimistically raised the
// screensaver before the machine had confirmed the sleep; the next (still stale)
// snapshot said "idle", so app.js's "the machine is awake, tidy the overlay away"
// branch called deactivateScreensaver() — and that teardown woke the machine.
//
// The rules this module encodes:
//
//   1. The screensaver is a pure function of the machine's CONFIRMED state. The
//      skin never raises it optimistically, so a stale frame can never "undo" it.
//   2. Nothing that is not a wake may emit a wake. Hiding an overlay, changing a
//      display setting, or receiving a snapshot must never send 'idle'. Only the
//      user tapping the screensaver, or the user pressing the sleep button while
//      the machine is asleep, may wake it from this skin.
//
// deriveScreensaverAction() therefore returns only 'show' | 'hide' | 'none' — it
// is structurally incapable of asking for a machine command. The two callers
// (app.js's snapshot handler and ui.js's sleep button) are the enforcement points.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

/** Machine states the policy cares about. Anything else counts as "awake". */
const SLEEPING = 'sleeping';

/**
 * What the screensaver overlay should do, given the machine's CONFIRMED state.
 *
 * Never returns a machine command — a snapshot arriving, or an overlay being
 * torn down, is not a user asking for anything.
 *
 * @returns {'show'|'hide'|'none'}
 */
export function deriveScreensaverAction({ machineState, screensaverActive, screensaverEnabled = true } = {}) {
    const asleep = String(machineState || '').toLowerCase() === SLEEPING;

    if (asleep) {
        // Only raise it if the user hasn't turned the feature off.
        return (screensaverEnabled && !screensaverActive) ? 'show' : 'none';
    }
    // Machine is awake. Take the overlay down if it is up — as a PAINT, not a command.
    return screensaverActive ? 'hide' : 'none';
}

/**
 * What the sleep button should do, given the machine's CONFIRMED state.
 *
 * `command` is the only machine command in this file, and it is only ever 'idle'
 * when the machine is genuinely asleep and the user pressed the button to wake
 * it — an explicit, user-initiated wake. Hiding the overlay is reported
 * separately (`hideScreensaver`) precisely so that hiding can never smuggle a
 * wake along with it.
 *
 * Note there is no "show the screensaver" outcome: the button does not raise the
 * overlay optimistically. app.js raises it when the machine CONFIRMS 'sleeping',
 * which is the 46 ms race closed at the source.
 *
 * @returns {{ command: 'idle'|'sleeping', hideScreensaver: boolean }}
 */
export function deriveSleepButtonAction({ machineState, screensaverActive = false } = {}) {
    const asleep = String(machineState || '').toLowerCase() === SLEEPING;

    if (asleep) {
        // Asleep -> the user wants it awake. One command, and take the overlay
        // down ourselves (the hide is a paint; the wake is this explicit command).
        return { command: 'idle', hideScreensaver: screensaverActive };
    }
    // Awake -> the user wants it asleep. No overlay work: app.js raises the
    // screensaver when the machine confirms it is sleeping.
    return { command: 'sleeping', hideScreensaver: false };
}
