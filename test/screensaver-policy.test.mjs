// One tap on the sleep button slept the machine and woke it 46 ms later.
//
// PUT /machine/state/sleeping  15:53:55.035
// PUT /machine/state/idle      15:53:55.081   <- the screensaver's teardown
//
// The teardown (deactivateScreensaver) emitted setMachineState('idle') as part of
// hiding the overlay. The sleep button raised the overlay optimistically; the next
// snapshot still said 'idle'; app.js's "the machine is awake, tidy the overlay
// away" branch tore it down — and the teardown woke the machine.
//
// These tests pin the invariant that makes that impossible: the screensaver action
// derived from a machine snapshot is PAINT-ONLY, and a hide never carries a wake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveScreensaverAction, deriveSleepButtonAction } from '../src/modules/screensaver-policy.js';

// --- deriveScreensaverAction: a snapshot may paint, never command ---------------

test('the derived screensaver action is paint-only — "show" | "hide" | "none", never a command', () => {
    const states = ['idle', 'sleeping', 'espresso', 'steam', 'hotWater', 'heating', 'error', '', null, undefined];
    const allowed = new Set(['show', 'hide', 'none']);

    for (const machineState of states) {
        for (const screensaverActive of [true, false]) {
            for (const screensaverEnabled of [true, false]) {
                const action = deriveScreensaverAction({ machineState, screensaverActive, screensaverEnabled });
                assert.ok(allowed.has(action), `${machineState}/${screensaverActive}/${screensaverEnabled} -> ${action}`);
                // The point of the whole fix: no reachable input produces a wake.
                assert.notEqual(action, 'idle');
                assert.notEqual(action, 'wake');
            }
        }
    }
});

test('machine confirms SLEEPING with the overlay down -> show it', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false }), 'show');
});

test('machine confirms SLEEPING with the overlay already up -> do nothing', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: true }), 'none');
});

test('screensaver setting off: a sleeping machine does NOT raise the overlay', () => {
    assert.equal(
        deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false, screensaverEnabled: false }),
        'none'
    );
});

test('THE BUG: an awake machine with the overlay up -> HIDE (a paint), not a wake', () => {
    // This is the exact branch that fired 46 ms after the sleep press, when the
    // stale snapshot still reported 'idle' and the overlay was optimistically up.
    // It must resolve to a hide — and hiding, in ui.js, sends nothing.
    assert.equal(deriveScreensaverAction({ machineState: 'idle', screensaverActive: true }), 'hide');
});

test('an awake machine with the overlay already down -> do nothing', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'idle', screensaverActive: false }), 'none');
});

test('state matching is case-insensitive and null-safe', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'SLEEPING', screensaverActive: false }), 'show');
    assert.equal(deriveScreensaverAction({ machineState: null, screensaverActive: true }), 'hide');
    assert.equal(deriveScreensaverAction(), 'none');
});

// --- deriveSleepButtonAction ---------------------------------------------------

test('sleep button on an AWAKE machine: sends "sleeping", and nothing else', () => {
    const action = deriveSleepButtonAction({ machineState: 'idle', screensaverActive: false });
    assert.deepEqual(action, { command: 'sleeping', hideScreensaver: false });
});

test('THE RACE: the sleep button does NOT raise the screensaver optimistically', () => {
    // The old handler called activateScreensaver() right after PUT sleeping. That
    // opened the 46 ms window in which a stale 'idle' snapshot could tear the
    // overlay back down (and, back then, wake the machine). The screensaver now has
    // exactly one source of truth: the machine's CONFIRMED state, applied in app.js.
    const action = deriveSleepButtonAction({ machineState: 'idle', screensaverActive: false });
    assert.equal(action.command, 'sleeping');
    assert.ok(!('showScreensaver' in action), 'the button has no optimistic-show outcome at all');
});

test('sleep button on a SLEEPING machine: one wake, and the overlay comes down', () => {
    const action = deriveSleepButtonAction({ machineState: 'sleeping', screensaverActive: true });
    assert.deepEqual(action, { command: 'idle', hideScreensaver: true });
});

test('sleep button on a SLEEPING machine with no overlay up: still exactly one wake', () => {
    // Previously this path sent 'idle' twice — once itself, once via
    // deactivateScreensaver()'s baked-in wake.
    const action = deriveSleepButtonAction({ machineState: 'sleeping', screensaverActive: false });
    assert.deepEqual(action, { command: 'idle', hideScreensaver: false });
});

test('INVARIANT: a hide is never accompanied by a wake unless the machine is ASLEEP', () => {
    // "Nothing that is not a wake may emit a wake". The only input that
    // may yield command 'idle' is a machine that is genuinely sleeping — i.e. the
    // user pressing the button to wake it. Any awake state must yield 'sleeping',
    // no matter what the overlay is doing.
    for (const machineState of ['idle', 'espresso', 'steam', 'hotWater', 'heating', 'ready', '', null, undefined]) {
        for (const screensaverActive of [true, false]) {
            const action = deriveSleepButtonAction({ machineState, screensaverActive });
            assert.equal(action.command, 'sleeping', `state ${machineState} must never derive a wake`);
        }
    }

    for (const screensaverActive of [true, false]) {
        const action = deriveSleepButtonAction({ machineState: 'sleeping', screensaverActive });
        assert.equal(action.command, 'idle');
    }
});

test('sleep button derivation is pure — repeated calls give the same answer', () => {
    // The in-flight guard in ui.js is what stops a double-tap re-deriving against a
    // stale state; the derivation itself must not carry hidden state.
    const input = { machineState: 'idle', screensaverActive: false };
    assert.deepEqual(deriveSleepButtonAction(input), deriveSleepButtonAction(input));
    assert.deepEqual(deriveSleepButtonAction(input), { command: 'sleeping', hideScreensaver: false });
});
