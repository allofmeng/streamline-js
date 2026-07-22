// Expanded-chart autoscale maths (src/modules/chart-autoscale.js).
//
// These lock the hardware-validated band arithmetic: the top chart's damped
// Y-max (floor 12, 5% headroom, instant growth, eased shrink) and the
// temperature band of +5/−10 °C around every target seen this shot with a
// hard 105 °C axis ceiling. The +5/−10 constants are authoritative (an older
// comment claimed +/-10; the constants won).
// The band's optional 3rd input (Mix Temp) participates only in the
// never-clip widening — it never anchors the band and defaults to [].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EXP_TOP_FLOOR,
    EXP_TEMP_PAD_BELOW,
    EXP_TEMP_PAD_ABOVE,
    EXP_TEMP_MAX,
    niceCeil,
    computeExpandedTopYMax,
    computeExpandedTempRange,
} from '../src/modules/chart-autoscale.js';

test('band constants are the hardware-validated values', () => {
    assert.equal(EXP_TOP_FLOOR, 12);
    assert.equal(EXP_TEMP_PAD_BELOW, 10); // −10 °C below the coolest target
    assert.equal(EXP_TEMP_PAD_ABOVE, 5);  // +5 °C above the hottest target
    assert.equal(EXP_TEMP_MAX, 105);      // hard ceiling
});

// ── niceCeil ─────────────────────────────────────────────────────────────────

test('niceCeil: non-positive values collapse to 0', () => {
    assert.equal(niceCeil(0), 0);
    assert.equal(niceCeil(-3), 0);
});

test('niceCeil: steps of 2 up to and including 30', () => {
    assert.equal(niceCeil(0.1), 2);
    assert.equal(niceCeil(2), 2);
    assert.equal(niceCeil(12.6), 14);
    assert.equal(niceCeil(29.9), 30);
    assert.equal(niceCeil(30), 30); // boundary belongs to the 2-step band
});

test('niceCeil: steps of 5 above 30 up to and including 80', () => {
    assert.equal(niceCeil(30.1), 35);
    assert.equal(niceCeil(31), 35);
    assert.equal(niceCeil(76), 80);
    assert.equal(niceCeil(80), 80); // boundary belongs to the 5-step band
});

test('niceCeil: steps of 10 above 80', () => {
    assert.equal(niceCeil(80.1), 90);
    assert.equal(niceCeil(94), 100);
    assert.equal(niceCeil(101), 110);
});

// ── computeExpandedTopYMax ───────────────────────────────────────────────────

test('top Y-max: empty series sit on the floor of 12', () => {
    assert.equal(computeExpandedTopYMax([], EXP_TOP_FLOOR), 12);
    assert.equal(computeExpandedTopYMax([[], []], EXP_TOP_FLOOR), 12);
});

test('top Y-max: grows instantly to a nice ceil of peak + 5% headroom', () => {
    // peak 20 → 21 with headroom → niceCeil 22 (2-step band)
    assert.equal(computeExpandedTopYMax([[3, 20], [8]], 12), 22);
    // peak 11.5 → 12.075 → niceCeil 14: headroom alone can lift past the floor
    assert.equal(computeExpandedTopYMax([[11.5]], 12), 14);
    // peak 10 → 10.5 → niceCeil 12: stays on the floor
    assert.equal(computeExpandedTopYMax([[10]], 12), 12);
});

test('top Y-max: max is taken across ALL series, not per-series', () => {
    const series = [[2, 4], [9.9], [1], [0.5], [30]]; // gflow spikes to 30
    // 30 * 1.05 = 31.5 → niceCeil (5-step band) = 35
    assert.equal(computeExpandedTopYMax(series, 12), 35);
});

test('top Y-max: hysteresis — a drop of ≤2 does not shrink the axis', () => {
    // need = niceCeil(13 * 1.05) = 14; 14 is NOT < 16 - 2, so 16 holds
    assert.equal(computeExpandedTopYMax([[13]], 16), 16);
});

test('top Y-max: eases down at most 2 per call, settling 2 above the need', () => {
    // need = 12 from empty data; prev 22 → 20 → 18 → 16 → 14, then HOLDS at 14:
    // the hysteresis window (need must drop by >2) means the eased value settles
    // at need+2 and only a per-shot reset returns it to the floor exactly.
    let m = 22;
    const steps = [];
    for (let i = 0; i < 6; i++) { m = computeExpandedTopYMax([[]], m); steps.push(m); }
    assert.deepEqual(steps, [20, 18, 16, 14, 14, 14]);
    // ...the shrink step is prev−2, never straight to the need
    assert.equal(computeExpandedTopYMax([[]], 15), 13); // max(12, 15−2) = 13
});

test('top Y-max: never dips below the floor and does not mutate its inputs', () => {
    const ys = [[1, 2]];
    assert.equal(computeExpandedTopYMax(ys, 12), 12);
    assert.deepEqual(ys, [[1, 2]]);
});

// ── computeExpandedTempRange ─────────────────────────────────────────────────

test('temp band: single target → [target−10, target+5]', () => {
    assert.deepEqual(computeExpandedTempRange([80], []), [70, 85]);
});

test('temp band: widens to cover EVERY target seen this shot', () => {
    // target 80 then 70 → [70−10, 80+5]
    assert.deepEqual(computeExpandedTempRange([80, 70], []), [60, 85]);
});

test('temp band: no targets → anchors on the LAST group-temp sample', () => {
    // last sample 85 anchors the band; the earlier 92 only widens hi
    assert.deepEqual(computeExpandedTempRange([], [92, 85]), [75, 92]);
});

test('temp band: no data at all → default 90 anchor → [80, 95]', () => {
    assert.deepEqual(computeExpandedTempRange([], []), [80, 95]);
});

test('temp band: widens so live group-temp samples never clip', () => {
    assert.deepEqual(computeExpandedTempRange([80], [65, 100]), [65, 100]);
});

test('temp band: hard 105 °C ceiling caps the band', () => {
    // target 103 → raw band [93, 108] → hi capped to 105
    assert.deepEqual(computeExpandedTempRange([103], []), [93, 105]);
});

test('temp band: the 105 ceiling WINS over never-clip', () => {
    // a 120 °C sample would widen hi to 120, but the cap is applied after
    assert.deepEqual(computeExpandedTempRange([90], [120]), [80, 105]);
});

test('temp band: a ≥5 °C span survives when the cap squeezes the band', () => {
    // target 111 → lo 101, hi 116→105; lo > hi−5 → lo forced to 100
    assert.deepEqual(computeExpandedTempRange([111], []), [100, 105]);
});

test('temp band: bounds are floored/ceiled to integers', () => {
    // target 93.5 → [83.5, 98.5] → [83, 99]
    assert.deepEqual(computeExpandedTempRange([93.5], []), [83, 99]);
});

// ── Mix Temp (3rd input) — widens like the group line, never anchors ────────

test('temp band: mix samples widen the band like group samples', () => {
    // target 80 → [70, 85]; mix 63 pulls lo down
    assert.deepEqual(computeExpandedTempRange([80], [78], [63]), [63, 85]);
});

test('temp band: a hot mix sample widens hi', () => {
    assert.deepEqual(computeExpandedTempRange([80], [78], [99]), [70, 99]);
});

test('temp band: the 105 ceiling WINS over mix never-clip', () => {
    assert.deepEqual(computeExpandedTempRange([90], [], [120]), [80, 105]);
});

test('temp band: mix never ANCHORS the no-target fallback, it only widens', () => {
    // anchor = last group sample (85) → [75, 92] (92 widens hi); mix 90 is inside → unchanged
    assert.deepEqual(computeExpandedTempRange([], [92, 85], [90]), [75, 92]);
});

test('temp band: omitted mix argument keeps legacy behaviour', () => {
    assert.deepEqual(computeExpandedTempRange([80], [65, 100]), [65, 100]);
});

// ── Mix TARGET (4th input) — never-clip-only: shown, but it does NOT anchor ──
//
// Despite the name it is the DE1's servo SETPOINT, not a flat goal: it dives to
// ~37 °C to demand cold water on a hot-group shot. Anchoring on it would pad a
// further 10 °C below that and squash the group trace, so it only ever widens
// the band — visible always, never in charge. Only the GROUP target anchors.

test('temp band: the mix target does NOT anchor — no ±pad is built around it', () => {
    // If it anchored, targets {83, 90} → [73, 95]. It does not: the group target
    // owns the band ([73, 88]), and the mix target 90 merely widens hi to 90.
    assert.deepEqual(computeExpandedTempRange([83], [], [], [90]), [73, 90]);
});

test('temp band: a mix target far BELOW the group target widens, never anchors', () => {
    // The hot-group dive: mix setpoint 39.4 must be INSIDE the band but must not
    // drag it to an anchor of 39.4−10 = 29.4.
    const [lo, hi] = computeExpandedTempRange([83], [83.3], [83.7], [39.4, 90]);
    assert.deepEqual([lo, hi], [39, 90]);
    assert.ok(lo <= 39.4 && hi >= 39.4, 'the diving mix target stays visible');
    assert.ok(lo > 29.4, 'but the band is NOT anchored 10 °C below the dive');
});

test('temp band: a mix target alone does NOT anchor the no-group-target fallback', () => {
    // Anchor is the last group sample (88) → [78, 93]; the mix target 40 only
    // widens lo to 40. Anchoring on it would have given [30, 93].
    assert.deepEqual(computeExpandedTempRange([], [88], [], [40]), [40, 93]);
});

test('temp band: the ordinary live case is untouched by the mix target', () => {
    // group target 83, mix target 90, mix actual peaking at 101: the mix ACTUAL
    // already owns hi and the group target owns lo, so the mix target — which
    // sits inside the band — moves nothing. (Bench-verified snapshot values.)
    const withMixTarget = computeExpandedTempRange([83], [83.3], [101], [90]);
    assert.deepEqual(withMixTarget, [73, 101]);
    assert.deepEqual(withMixTarget, computeExpandedTempRange([83], [83.3], [101]));
});

test('temp band: the 105 ceiling WINS over mix-target never-clip', () => {
    // a 120 °C mix setpoint would widen hi to 120, but the cap is applied after
    assert.deepEqual(computeExpandedTempRange([90], [], [], [120]), [80, 105]);
    // below the ceiling it widens normally (102 < 105, so no cap)
    assert.deepEqual(computeExpandedTempRange([83], [], [], [102]), [73, 102]);
});

test('temp band: omitted mix-target argument keeps legacy behaviour', () => {
    assert.deepEqual(
        computeExpandedTempRange([80], [78], [63]),
        computeExpandedTempRange([80], [78], [63], []),
    );
    assert.deepEqual(computeExpandedTempRange([80], [78], [63]), [63, 85]);
});
