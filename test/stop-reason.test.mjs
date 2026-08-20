// Shot stop-reason classification (src/modules/stop-reason.js).
//
// Reported bug: a shot ended by the profile running out of frames showed
// "Stopped by weight: <n>g". Two independent paths produced it — the
// gateway-mode reconstruction in handleData, and the shotState feed's
// 'machineEnded' branch. These lock both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyStopReason,
    isAutonomousWeightStop,
    canonicalStopReason,
    HIT_TOLERANCE,
    TIME_TOLERANCE,
    STOP_TARGET_WEIGHT,
    STOP_TARGET_VOLUME,
    STOP_PROFILE_ENDED,
    STOP_UNKNOWN,
} from '../src/modules/stop-reason.js';

// A 30 s profile with a 36 g target — the ordinary setup the bug needed.
const PROFILE = { profileSeconds: 30, targetWeight: 36, isScaleConnected: true };

// ── The reported bug ────────────────────────────────────────────────────────

test('a shot that runs the full profile is a TIME stop even at target weight', () => {
    // The weight target is also met, because a sane target yield is roughly what
    // the profile already pours. Time still wins: a weight stop would have cut
    // the shot short of 30 s.
    assert.equal(classifyStopReason({ ...PROFILE, totalS: 30.2, finalWeight: 36.4 }), STOP_PROFILE_ENDED);
    assert.equal(classifyStopReason({ ...PROFILE, totalS: 30.0, finalWeight: 36.0 }), STOP_PROFILE_ENDED);
});

test('a shot cut short at target weight is still a WEIGHT stop', () => {
    // 22 s of a 30 s profile — the profile did not end this one.
    assert.equal(classifyStopReason({ ...PROFILE, totalS: 22, finalWeight: 36.1 }), STOP_TARGET_WEIGHT);
});

// ── Ordering cannot misfire the other way ───────────────────────────────────

test('a profile whose steps exit early never reads as a time stop', () => {
    // Nominal 60 s of frames, pressure-exited at 25 s onto the weight target.
    assert.equal(
        classifyStopReason({ isScaleConnected: true, profileSeconds: 60, targetWeight: 36, totalS: 25, finalWeight: 36.2 }),
        STOP_TARGET_WEIGHT,
    );
});

test('a profile with no declared seconds falls through to weight', () => {
    assert.equal(
        classifyStopReason({ isScaleConnected: true, profileSeconds: 0, targetWeight: 36, totalS: 25, finalWeight: 36.2 }),
        STOP_TARGET_WEIGHT,
    );
});

// ── Tolerances ──────────────────────────────────────────────────────────────

test('the time tolerance is applied to the profile duration', () => {
    const at = 30 * TIME_TOLERANCE;
    assert.equal(classifyStopReason({ ...PROFILE, totalS: at, finalWeight: 0 }), STOP_PROFILE_ENDED);
    assert.equal(classifyStopReason({ ...PROFILE, totalS: at - 0.01, finalWeight: 0 }), STOP_UNKNOWN);
});

test('the weight tolerance is applied to the target yield', () => {
    const short = { ...PROFILE, profileSeconds: 60, totalS: 20 };
    assert.equal(classifyStopReason({ ...short, finalWeight: 36 * HIT_TOLERANCE }), STOP_TARGET_WEIGHT);
    assert.equal(classifyStopReason({ ...short, finalWeight: 36 * HIT_TOLERANCE - 0.01 }), STOP_UNKNOWN);
});

// ── Scale presence picks weight vs volume ───────────────────────────────────

test('a volume target with no weight target reports volume, scale or not', () => {
    // The common volumetric setup: a scale on the drip tray for the readout, but
    // the shot is stopped by volume. Gating on the scale alone used to report
    // this as the generic "Shot Stopped".
    const base = { profileSeconds: 60, totalS: 20, targetWeight: 0, targetVolume: 40, finalVolume: 41 };
    assert.equal(classifyStopReason({ ...base, isScaleConnected: true }), STOP_TARGET_VOLUME);
    assert.equal(classifyStopReason({ ...base, isScaleConnected: false }), STOP_TARGET_VOLUME);
});

test('volume stays suppressed when a weight target could explain the stop', () => {
    // Scale + weight target: weight is authoritative and a volume match
    // alongside it is coincidental, so do not claim volume.
    const base = { profileSeconds: 60, totalS: 20, targetWeight: 36, targetVolume: 40, finalVolume: 41 };
    assert.equal(classifyStopReason({ ...base, isScaleConnected: true, finalWeight: 20 }), STOP_UNKNOWN);
    // Weight actually reached — that is the answer, not volume.
    assert.equal(classifyStopReason({ ...base, isScaleConnected: true, finalWeight: 36.2 }), STOP_TARGET_WEIGHT);
    // No scale, so weight cannot explain anything: volume speaks.
    assert.equal(classifyStopReason({ ...base, isScaleConnected: false, finalWeight: 0 }), STOP_TARGET_VOLUME);
});

test('nothing matched reports unknown rather than guessing', () => {
    assert.equal(classifyStopReason({}), STOP_UNKNOWN);
    assert.equal(classifyStopReason({ totalS: 12, profileSeconds: 60, isScaleConnected: true, targetWeight: 36, finalWeight: 18 }), STOP_UNKNOWN);
});

test('a null final weight (no scale reading) never reads as a weight stop', () => {
    assert.equal(
        classifyStopReason({ isScaleConnected: true, profileSeconds: 60, totalS: 20, targetWeight: 36, finalWeight: null }),
        STOP_UNKNOWN,
    );
});

// ── machineEnded on a firmware-SAW machine ──────────────────────────────────

test('machineEnded counts as a weight stop only with evidence the yield was hit', () => {
    assert.equal(isAutonomousWeightStop(36.2, 36), true);
    assert.equal(isAutonomousWeightStop(36 * HIT_TOLERANCE, 36), true);
    // The bug: profile ran out at 21 g against a 36 g target, and the branch
    // still announced "Stopped by weight: 21.0g".
    assert.equal(isAutonomousWeightStop(21, 36), false);
});

test('machineEnded with no target or no reading is never a weight stop', () => {
    assert.equal(isAutonomousWeightStop(36.2, 0), false);
    assert.equal(isAutonomousWeightStop(NaN, 36), false);
    assert.equal(isAutonomousWeightStop(undefined, 36), false);
});

// ── Machine parity ──────────────────────────────────────────────────────────
// Two machines that poured the same shot must produce the same canonical
// reason. The only hardware-dependent wire reason is 'machineEnded': a Bengle
// reports its firmware stop-at-weight that way, while a plain DE1's weight stop
// comes back as 'targetWeight' from the app sequencer.

const BENGLE = { machineHasAutonomousSAW: true, isScaleConnected: true };
const DE1    = { machineHasAutonomousSAW: false, isScaleConnected: true };
const SHOT   = { targetWeight: 36, profileSeconds: 30 };

test('parity: a weight stop reads as targetWeight on both machines', () => {
    // Bengle: firmware SAW cut the shot at 22 s having reached the yield.
    const bengle = canonicalStopReason('machineEnded', { ...BENGLE, ...SHOT, weight: 36.2, totalS: 22 });
    // DE1: the app sequencer stopped it and said so outright.
    const de1 = canonicalStopReason('targetWeight', { ...DE1, ...SHOT, weight: 36.2, totalS: 22 });
    assert.equal(bengle, STOP_TARGET_WEIGHT);
    assert.equal(de1, STOP_TARGET_WEIGHT);
    assert.equal(bengle, de1);
});

test('parity: a time stop reads as profileEnded on both machines', () => {
    // Same shot, both machines: profile ran its full 30 s, yield never reached.
    const bengle = canonicalStopReason('machineEnded', { ...BENGLE, ...SHOT, weight: 21, totalS: 30.2 });
    const de1 = canonicalStopReason('machineEnded', { ...DE1, ...SHOT, weight: 21, totalS: 30.2 });
    assert.equal(bengle, STOP_PROFILE_ENDED);
    assert.equal(de1, STOP_PROFILE_ENDED);
    assert.equal(bengle, de1);
});

test('parity: the reported bug — a full-length shot near target weight', () => {
    // The shot that started this: ran the full profile AND landed near the
    // target yield. Neither machine may call it a weight stop.
    for (const machine of [BENGLE, DE1]) {
        assert.equal(
            canonicalStopReason('machineEnded', { ...machine, ...SHOT, weight: 35.9, totalS: 30.1 }),
            STOP_PROFILE_ENDED,
        );
    }
});

test('parity: every non-machineEnded reason passes through untouched', () => {
    for (const reason of ['targetWeight', 'targetVolume', 'apiStop', 'appStop', 'error',
                          'disconnected', 'stoppingBackstop', 'somethingNewerBuildsAdded']) {
        for (const machine of [BENGLE, DE1]) {
            assert.equal(canonicalStopReason(reason, { ...machine, ...SHOT, weight: 36.2, totalS: 30.2 }), reason);
        }
    }
});

test('an unattributable machineEnded stays machineEnded rather than guessing', () => {
    // Short shot, no yield reached, profile nowhere near its nominal length —
    // the machine ended it for a reason we cannot name.
    assert.equal(
        canonicalStopReason('machineEnded', { ...BENGLE, ...SHOT, weight: 8, totalS: 9 }),
        'machineEnded',
    );
});

test('a Bengle weight stop needs the scale to still be connected', () => {
    // scaleLost disables stop-at-weight for the rest of the shot (per the
    // shotState spec), so a machineEnded without a scale is not a weight stop.
    assert.equal(
        canonicalStopReason('machineEnded', { machineHasAutonomousSAW: true, isScaleConnected: false, ...SHOT, weight: 36.2, totalS: 30.2 }),
        STOP_PROFILE_ENDED,
    );
});

// ── Guards ──────────────────────────────────────────────────────────────────

test('a non-finite projectedWeight cannot become a weight stop', () => {
    // decision.data is freeform on the wire, so projectedWeight may not parse.
    // canonicalStopReason must not hand a NaN through as a yield hit.
    assert.equal(
        canonicalStopReason('machineEnded', { ...BENGLE, ...SHOT, weight: NaN, totalS: 22 }),
        'machineEnded',
    );
});
