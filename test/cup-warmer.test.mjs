import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isCupWarmerOn,
    readCupWarmerTarget,
    clampCupWarmerTarget,
    clampPrewarmMinutes,
    resolvePrewarm,
    hasEnabledWakeSchedule,
    prewarmWarnings,
    prewarmShapeSignature,
    formatCurrentMatTemp,
    getCupWarmerState,
    setCupWarmerState,
    patchCupWarmerState,
    invalidateCupWarmerState,
    onCupWarmerStateChange,
    CUP_WARMER_TARGET_KEY,
    PREWARM_DEFAULT_MINUTES,
    PREWARM_MIN_MINUTES,
    PREWARM_MAX_MINUTES,
} from '../src/modules/cup-warmer.js';

test('localStorage key is stable (renaming orphans persisted targets)', () => {
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

// ── Scheduled pre-warm (firmware-owned) ─────────────────────────────────────

test('pre-warm bounds match the firmware register (MatPreheatLeadMin 0–120, default 30)', () => {
    assert.equal(PREWARM_DEFAULT_MINUTES, 30);
    assert.equal(PREWARM_MIN_MINUTES, 5);    // UI floor; the wire itself accepts 0
    assert.equal(PREWARM_MAX_MINUTES, 120);
});

test('clampPrewarmMinutes: clamps into 5–120, NaN/0 fall to 30', () => {
    assert.equal(clampPrewarmMinutes(45), 45);
    assert.equal(clampPrewarmMinutes(3), 5);
    assert.equal(clampPrewarmMinutes(500), 120);
    assert.equal(clampPrewarmMinutes(NaN), 30);
    assert.equal(clampPrewarmMinutes(0), 30);
});

test('resolvePrewarm: a supported machine reports its own settings', () => {
    assert.deepEqual(
        resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: 45, prewarmActive: false }),
        { supported: true, enabled: true, leadMinutes: 45, active: false },
    );
    assert.deepEqual(
        resolvePrewarm({ prewarmEnabled: false, prewarmLeadMinutes: 30, prewarmActive: false }),
        { supported: true, enabled: false, leadMinutes: 30, active: false },
    );
});

test('resolvePrewarm: null/absent fields mean UNAVAILABLE, never "off"', () => {
    // Firmware without the registers (the bench build 95): the app reports null.
    const old = resolvePrewarm({ temperature: 70, prewarmEnabled: null, prewarmLeadMinutes: null, prewarmActive: null });
    assert.equal(old.supported, false);
    assert.equal(old.enabled, false); // forced false — but the UI disables the control, so it is never read as truth
    assert.equal(old.active, false);

    // Older reaprime: the fields are ABSENT entirely. Same verdict.
    const absent = resolvePrewarm({ temperature: 70 });
    assert.equal(absent.supported, false);

    // No snapshot at all must not throw.
    assert.equal(resolvePrewarm(null).supported, false);
    assert.equal(resolvePrewarm(undefined).supported, false);
});

test('resolvePrewarm: a machine-side lead of 0 is shown, not snapped up to the 5 min UI floor', () => {
    // 0 is a legal MatPreheatLeadMin ("no lead"). Displaying 5 — or the 30 min
    // default — would be inventing a setting the machine does not hold.
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: 0 }).leadMinutes, 0);
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: 120 }).leadMinutes, 120);
    // Only a genuinely unknown/invalid lead falls back to the firmware default.
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: null }).leadMinutes, 30);
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: 999 }).leadMinutes, 30);
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: -1 }).leadMinutes, 30);
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmLeadMinutes: NaN }).leadMinutes, 30);
});

test('resolvePrewarm: active is only ever TRUE when the firmware says so', () => {
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmActive: true }).active, true);
    assert.equal(resolvePrewarm({ prewarmEnabled: true, prewarmActive: false }).active, false);
    // null (no register) must never be fabricated into a "pre-warming" label.
    assert.equal(resolvePrewarm({ prewarmEnabled: null, prewarmActive: null }).active, false);
});

test('hasEnabledWakeSchedule: an UNKNOWN list is not an empty one', () => {
    // null = not fetched yet / fetch failed. Warning callers must stay quiet.
    assert.equal(hasEnabledWakeSchedule(null), null);
    assert.equal(hasEnabledWakeSchedule(undefined), null);
    // [] = genuinely no wake windows.
    assert.equal(hasEnabledWakeSchedule([]), false);
    assert.equal(hasEnabledWakeSchedule([{ enabled: true }]), true);
    // `enabled` defaults to true when omitted (REST spec).
    assert.equal(hasEnabledWakeSchedule([{ time: '07:00' }]), true);
    // A list of only DISABLED windows is as dead as an empty one.
    assert.equal(hasEnabledWakeSchedule([{ enabled: false }, { enabled: false }]), false);
    assert.equal(hasEnabledWakeSchedule([{ enabled: false }, { enabled: true }]), true);
});

test('prewarmWarnings: an enabled pre-warm with no wake window is a silent no-op — say so', () => {
    const prewarm = { supported: true, enabled: true, leadMinutes: 30, active: false };
    assert.deepEqual(prewarmWarnings({ prewarm, temperature: 70, schedules: [] }), ['noSchedule']);
    assert.deepEqual(
        prewarmWarnings({ prewarm, temperature: 70, schedules: [{ enabled: false }] }),
        ['noSchedule'],
    );
    // A configured window: nothing to warn about.
    assert.deepEqual(prewarmWarnings({ prewarm, temperature: 70, schedules: [{ enabled: true }] }), []);
});

test('prewarmWarnings: the firmware gate also needs MatSetPoint > 0', () => {
    const prewarm = { supported: true, enabled: true, leadMinutes: 30, active: false };
    // Warmer off (setpoint 0): the mat never runs, pre-warm or not.
    assert.deepEqual(
        prewarmWarnings({ prewarm, temperature: 0, schedules: [{ enabled: true }] }),
        ['noSetpoint'],
    );
    // Both broken at once — both named.
    assert.deepEqual(
        prewarmWarnings({ prewarm, temperature: 0, schedules: [] }),
        ['noSetpoint', 'noSchedule'],
    );
});

test('prewarmWarnings: never cry wolf — no warning when there is nothing to warn about', () => {
    const on = { supported: true, enabled: true, leadMinutes: 30, active: false };
    // Schedule list unknown (not fetched / fetch failed): stay quiet.
    assert.deepEqual(prewarmWarnings({ prewarm: on, temperature: 70, schedules: null }), []);
    // Pre-warm switched OFF: an empty schedule is not the user's problem.
    const off = { supported: true, enabled: false, leadMinutes: 30, active: false };
    assert.deepEqual(prewarmWarnings({ prewarm: off, temperature: 0, schedules: [] }), []);
    // Firmware without pre-warm: the block already says "unsupported"; do not pile on.
    const unsupported = { supported: false, enabled: false, leadMinutes: 30, active: false };
    assert.deepEqual(prewarmWarnings({ prewarm: unsupported, temperature: 0, schedules: [] }), []);
});

test('prewarmShapeSignature: tracks the blocks, ignores the lead value', () => {
    const base = { supported: true, enabled: true, leadMinutes: 30, active: false };
    // A lead edit must NOT trigger a repaint — that would clobber the stepper
    // the user is typing in.
    assert.equal(
        prewarmShapeSignature({ ...base, leadMinutes: 45 }),
        prewarmShapeSignature(base),
    );
    // The firmware starting a scheduled pre-warm adds a block — repaint.
    assert.notEqual(prewarmShapeSignature({ ...base, active: true }), prewarmShapeSignature(base));
    // Toggling, and support appearing after a firmware update — repaint.
    assert.notEqual(prewarmShapeSignature({ ...base, enabled: false }), prewarmShapeSignature(base));
    assert.notEqual(
        prewarmShapeSignature({ ...base, supported: false }),
        prewarmShapeSignature(base),
    );
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
