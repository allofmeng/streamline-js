// Historical GFlow sourcing (src/modules/historical-gflow.js).
//
// A record from a machine that reports its own gravimetric flow persists it on every
// machine frame (machine.weightFlow); the scale frames carry the app's own
// weight-derivative (scale.weightFlow), a DIFFERENT smoothing pipeline.
// plotHistoricalShot must plot the machine series when the record has one
// (post-shot repaint then matches the live trace exactly) and fall back to
// the scale chain only for records without one. These tests lock the
// discriminator and the fallback resolver's exact numerics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    hasMachineGFlow,
    createScaleFlowResolver,
} from '../src/modules/historical-gflow.js';

const SMOOTHING_FACTOR = 0.1; // mirrors chart.js

// -- hasMachineGFlow: the discriminator ------------------------------------

test('discriminator: non-array / empty inputs carry no machine flow', () => {
    assert.equal(hasMachineGFlow(undefined), false);
    assert.equal(hasMachineGFlow(null), false);
    assert.equal(hasMachineGFlow([]), false);
});

test('discriminator: any nonzero machine.weightFlow marks the record machine-sourced', () => {
    const measurements = [
        { scale: { weight: 1 } },                        // scale-only frame
        { machine: { weightFlow: 0 } },                  // pre-pour zero
        { machine: { weightFlow: 2.5 }, scale: {} },     // pouring
    ];
    assert.equal(hasMachineGFlow(measurements), true);
});

test('discriminator: negative firmware samples still count as nonzero', () => {
    assert.equal(hasMachineGFlow([{ machine: { weightFlow: -0.12 } }]), true);
});

test('discriminator: a plain DE1 record (constant 0.0 field) is NOT machine-sourced', () => {
    // The 0xA00D parse never sets weightFlow, so a DE1 record serializes
    // it as constant 0.0 — presence alone must not flip the source.
    const measurements = Array.from({ length: 50 }, () => ({
        machine: { weightFlow: 0.0 },
        scale: { weight: 10, weightFlow: 1.5 },
    }));
    assert.equal(hasMachineGFlow(measurements), false);
});

test('discriminator: missing machine frames or non-number values are ignored', () => {
    assert.equal(hasMachineGFlow([{ scale: { weightFlow: 3 } }]), false);
    assert.equal(hasMachineGFlow([{ machine: {} }]), false);
    assert.equal(hasMachineGFlow([{ machine: { weightFlow: '2.5' } }]), false);
    assert.equal(hasMachineGFlow([{ machine: { weightFlow: null } }]), false);
});

// ── createScaleFlowResolver: the legacy fallback chain ───────────────────────

test('resolver: stored server weightFlow is used verbatim, including 0', () => {
    const resolve = createScaleFlowResolver(SMOOTHING_FACTOR);
    assert.equal(resolve({ weight: 5, weightFlow: 1.25 }, 1.0), 1.25);
    assert.equal(resolve({ weight: 6, weightFlow: 0 }, 1.5), 0); // 0 is a value, not "missing"
});

test('resolver: legacy record (no weightFlow) starts at 0 then EMA-smooths deltas', () => {
    const resolve = createScaleFlowResolver(SMOOTHING_FACTOR);
    // First sample: no previous point → 0
    assert.equal(resolve({ weight: 10 }, 1.0), 0);
    // Second: raw = (12-10)/1 = 2 → EMA = 0.1*2 + 0.9*0 = 0.2
    assert.ok(Math.abs(resolve({ weight: 12 }, 2.0) - 0.2) < 1e-12);
    // Third: raw = (15-12)/1 = 3 → EMA = 0.1*3 + 0.9*0.2 = 0.48
    assert.ok(Math.abs(resolve({ weight: 15 }, 3.0) - 0.48) < 1e-12);
});

test('resolver: a stored weightFlow seeds the EMA for later fallback samples', () => {
    const resolve = createScaleFlowResolver(SMOOTHING_FACTOR);
    assert.equal(resolve({ weight: 10, weightFlow: 4.0 }, 1.0), 4.0);
    // Next frame lacks weightFlow: raw = (11-10)/1 = 1 → 0.1*1 + 0.9*4.0 = 3.7
    assert.ok(Math.abs(resolve({ weight: 11 }, 2.0) - 3.7) < 1e-12);
});

test('resolver: non-advancing time yields 0 instead of a divide-by-zero spike', () => {
    const resolve = createScaleFlowResolver(SMOOTHING_FACTOR);
    resolve({ weight: 10 }, 1.0);
    assert.equal(resolve({ weight: 20 }, 1.0), 0); // same timestamp
    assert.equal(resolve({ weight: 30 }, 0.5), 0); // time went backwards
});

test('resolver: instances are independent (one per plotted record)', () => {
    const a = createScaleFlowResolver(SMOOTHING_FACTOR);
    const b = createScaleFlowResolver(SMOOTHING_FACTOR);
    a({ weight: 10 }, 1.0);
    a({ weight: 20 }, 2.0);
    // b has seen nothing: its first sample must still be the 0 warm-up
    assert.equal(b({ weight: 50 }, 3.0), 0);
});

// ── Real recorded data: the repo's 2025-09 fixture is a legacy record ────────

test('fixture: pre-GFlow shot record falls back to the scale chain', async () => {
    const url = new URL('../shots/2025-09-12T16:04:38.049213.json', import.meta.url);
    const shot = JSON.parse(await readFile(url, 'utf8'));
    // No machine frame carries weightFlow → scale-sourced fallback
    assert.equal(hasMachineGFlow(shot.measurements), false);
    // Its scale frames DO carry server weightFlow → resolver passes it through
    const frame = shot.measurements.find(m => m.scale?.weightFlow !== undefined);
    const resolve = createScaleFlowResolver(SMOOTHING_FACTOR);
    assert.equal(resolve(frame.scale, 1.0), frame.scale.weightFlow);
});
