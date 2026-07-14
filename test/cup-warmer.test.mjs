import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isCupWarmerOn,
    readCupWarmerTarget,
    clampCupWarmerTarget,
    formatCurrentMatTemp,
    getCupWarmerState,
    setCupWarmerState,
    patchCupWarmerState,
    invalidateCupWarmerState,
    onCupWarmerStateChange,
    CUP_WARMER_TARGET_KEY,
} from '../src/modules/cup-warmer.js';

test('localStorage keys are stable (renaming orphans persisted targets)', () => {
    assert.equal(CUP_WARMER_TARGET_KEY, 'streamline.cupWarmerTarget');
});

test('isCupWarmerOn: temperature > 0 is the only "on" signal', () => {
    assert.equal(isCupWarmerOn(70), true);
    assert.equal(isCupWarmerOn(0.5), true);
    assert.equal(isCupWarmerOn(0), false);
    assert.equal(isCupWarmerOn(-1), false);
    assert.equal(isCupWarmerOn(null), false);      // GET failed / no data
    assert.equal(isCupWarmerOn(undefined), false); // field absent
});

test('readCupWarmerTarget: in-range stored values pass through', () => {
    assert.equal(readCupWarmerTarget('30'), 30);
    assert.equal(readCupWarmerTarget('55'), 55);
    assert.equal(readCupWarmerTarget('80'), 80);
});

test('readCupWarmerTarget: unset/invalid/out-of-range snap to the 70 °C default', () => {
    assert.equal(readCupWarmerTarget(null), 70);      // key never set
    assert.equal(readCupWarmerTarget(''), 70);
    assert.equal(readCupWarmerTarget('abc'), 70);
    assert.equal(readCupWarmerTarget('0'), 70);       // 0 is "off" on the wire, not a target
    assert.equal(readCupWarmerTarget('29'), 70);      // read path snaps, it does not clamp
    assert.equal(readCupWarmerTarget('81'), 70);
});

test('clampCupWarmerTarget: typed values clamp into 30–80, NaN/0 fall to 70', () => {
    assert.equal(clampCupWarmerTarget(55), 55);
    assert.equal(clampCupWarmerTarget(55.4), 55);   // whole °C
    assert.equal(clampCupWarmerTarget(10), 30);
    assert.equal(clampCupWarmerTarget(100), 80);
    assert.equal(clampCupWarmerTarget(NaN), 70);
    assert.equal(clampCupWarmerTarget(0), 70);      // 0 means "off", never a target
});

test('formatCurrentMatTemp: numbers render with one decimal', () => {
    assert.equal(formatCurrentMatTemp(36.54), '36.5');
    assert.equal(formatCurrentMatTemp(21), '21.0');
    assert.equal(formatCurrentMatTemp(79.96), '80.0');
});

test('formatCurrentMatTemp: null, absent, and junk all mean "no reading"', () => {
    assert.equal(formatCurrentMatTemp(null), null);      // app says: no valid reading
    assert.equal(formatCurrentMatTemp(undefined), null); // field absent (older reaprime)
    assert.equal(formatCurrentMatTemp('36.5'), null);    // defensive: wrong type
    assert.equal(formatCurrentMatTemp(NaN), null);
    assert.equal(formatCurrentMatTemp(Infinity), null);
});

// ── Shared state store (the single app-side copy — audit I1 / checklist 2b) ──
// Module state is shared across these tests; they run in file order and each
// re-establishes the store state it needs.

test('shared state: starts unloaded (null) — readers must fetch before trusting', () => {
    assert.equal(getCupWarmerState(), null);
});

test('setCupWarmerState replaces the snapshot and notifies subscribers', () => {
    const seen = [];
    const unsubscribe = onCupWarmerStateChange((s) => seen.push(s));
    setCupWarmerState({ temperature: 45, currentTemperature: 41.0 });
    assert.deepEqual(getCupWarmerState(), { temperature: 45, currentTemperature: 41.0 });
    assert.deepEqual(seen, [{ temperature: 45, currentTemperature: 41.0 }]);
    unsubscribe();
});

test('patchCupWarmerState merges — a setpoint PUT keeps the live reading visible', () => {
    setCupWarmerState({ temperature: 45, currentTemperature: 63.0 });
    patchCupWarmerState({ temperature: 50 });
    assert.deepEqual(getCupWarmerState(), { temperature: 50, currentTemperature: 63.0 });
});

test('patchCupWarmerState onto null builds a fresh snapshot instead of throwing', () => {
    invalidateCupWarmerState();
    patchCupWarmerState({ temperature: 70 });
    assert.deepEqual(getCupWarmerState(), { temperature: 70 });
});

test('invalidateCupWarmerState drops to null and notifies (machine reconnect path)', () => {
    setCupWarmerState({ temperature: 45 });
    const seen = [];
    const unsubscribe = onCupWarmerStateChange((s) => seen.push(s));
    invalidateCupWarmerState();
    assert.equal(getCupWarmerState(), null);
    assert.deepEqual(seen, [null]);
    assert.equal(isCupWarmerOn(getCupWarmerState()?.temperature), false); // invalidated renders as "off"
    unsubscribe();
});

test('unsubscribing stops notifications', () => {
    const seen = [];
    const unsubscribe = onCupWarmerStateChange((s) => seen.push(s));
    setCupWarmerState({ temperature: 30 });
    unsubscribe();
    setCupWarmerState({ temperature: 80 });
    assert.equal(seen.length, 1);
});

test('a throwing subscriber does not starve later subscribers', () => {
    const seen = [];
    const unsubBad = onCupWarmerStateChange(() => { throw new Error('bad subscriber'); });
    const unsubGood = onCupWarmerStateChange((s) => seen.push(s));
    setCupWarmerState({ temperature: 55 });
    assert.deepEqual(seen, [{ temperature: 55 }]);
    unsubBad();
    unsubGood();
});
