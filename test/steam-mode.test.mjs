import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    STEAM_FLOW_PRESETS_BY_MODEL,
    resolveSteamFlowPresetsForModel,
    resolveSteamStopMode,
    MILK_PROBE_ABSENT_AFTER_MS,
    resolveMilkProbePresence,
    applyMilkProbeGate,
    resolveSteamTileMode,
    milkTelemetryText,
} from '../src/modules/steam-mode.js';

// ── resolveSteamFlowPresetsForModel ─────────────────────────────────────────

test('unknown/null/empty models resolve to the standard preset group', () => {
    assert.equal(resolveSteamFlowPresetsForModel(null), STEAM_FLOW_PRESETS_BY_MODEL.standard);
    assert.equal(resolveSteamFlowPresetsForModel(undefined), STEAM_FLOW_PRESETS_BY_MODEL.standard);
    assert.equal(resolveSteamFlowPresetsForModel(''), STEAM_FLOW_PRESETS_BY_MODEL.standard);
    assert.equal(resolveSteamFlowPresetsForModel('DE1Pro'), STEAM_FLOW_PRESETS_BY_MODEL.standard);
});

test('plain "Bengle" (what the app serializes today) is the standard group', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle'), STEAM_FLOW_PRESETS_BY_MODEL.standard);
});

test('15A models resolve to the high group (forward-looking)', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle 15A'), STEAM_FLOW_PRESETS_BY_MODEL.highGroup);
    assert.equal(resolveSteamFlowPresetsForModel('bengle 15a'), STEAM_FLOW_PRESETS_BY_MODEL.highGroup);
});

test('10A and XXL models resolve to the mid group', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle 10A'), STEAM_FLOW_PRESETS_BY_MODEL.midGroup);
    assert.equal(resolveSteamFlowPresetsForModel('DE1XXL'), STEAM_FLOW_PRESETS_BY_MODEL.midGroup);
});

test('15A wins over 10A/XXL when both substrings appear', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle 15A XXL'), STEAM_FLOW_PRESETS_BY_MODEL.highGroup);
});

test('preset groups have four ascending values each', () => {
    for (const group of Object.values(STEAM_FLOW_PRESETS_BY_MODEL)) {
        assert.equal(group.length, 4);
        for (let i = 1; i < group.length; i++) assert.ok(group[i] > group[i - 1]);
    }
});

// ── resolveSteamStopMode ────────────────────────────────────────────────────
// Server field stopAtTemperature (0 = off) wins; 'time' vs 'off' comes from the
// skin-local stored preference; 'temperature' is never valid off a Bengle.

test('armed target (stopTemp > 0) forces temperature mode on a Bengle', () => {
    assert.equal(resolveSteamStopMode(65, null, true), 'temperature');
    assert.equal(resolveSteamStopMode(30, 'off', true), 'temperature');
});

test('armed target degrades to time mode on a non-Bengle', () => {
    assert.equal(resolveSteamStopMode(65, null, false), 'time');
    assert.equal(resolveSteamStopMode(65, 'off', false), 'time');
});

test('disarmed + stored preference resolves off/time as stored', () => {
    assert.equal(resolveSteamStopMode(0, 'off', true), 'off');
    assert.equal(resolveSteamStopMode(0, 'off', false), 'off');
    assert.equal(resolveSteamStopMode(0, 'time', true), 'time');
    assert.equal(resolveSteamStopMode(0, 'time', false), 'time');
});

test('stored temperature preference only holds on a Bengle', () => {
    assert.equal(resolveSteamStopMode(0, 'temperature', true), 'temperature');
    assert.equal(resolveSteamStopMode(0, 'temperature', false), 'time');
});

test('no/unknown stored preference defaults to time', () => {
    assert.equal(resolveSteamStopMode(0, null, true), 'time');
    assert.equal(resolveSteamStopMode(0, undefined, false), 'time');
    assert.equal(resolveSteamStopMode(0, 'bogus', true), 'time');
});

// ── resolveMilkProbePresence ────────────────────────────────────────────────
// Snapshot milkTemperature contract: 0 / absent = no probe or no reading.
// Present from the first positive reading; brief 0-glitches don't drop it;
// a sustained absence does. Never fake a probe that was never seen.

test('probe starts (and stays) absent while readings are 0/absent/garbage', () => {
    let s = resolveMilkProbePresence(null, 0, 1000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, undefined, 2000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, NaN, 3000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, 'hot', 4000);
    assert.deepEqual(s, { present: false, lastPositiveMs: null });
});

test('a positive reading makes the probe present immediately', () => {
    const s = resolveMilkProbePresence(null, 22.5, 1000);
    assert.deepEqual(s, { present: true, lastPositiveMs: 1000 });
});

test('brief 0-glitches inside the window keep the probe present', () => {
    let s = resolveMilkProbePresence(null, 60.1, 1000);
    s = resolveMilkProbePresence(s, 0, 1000 + MILK_PROBE_ABSENT_AFTER_MS - 1);
    assert.equal(s.present, true);
    assert.equal(s.lastPositiveMs, 1000); // glitches don't refresh the window
});

test('a sustained absence drops the probe after the window elapses', () => {
    let s = resolveMilkProbePresence(null, 60.1, 1000);
    s = resolveMilkProbePresence(s, 0, 1000 + MILK_PROBE_ABSENT_AFTER_MS);
    assert.equal(s.present, false);
});

test('a fresh positive reading revives an absent probe', () => {
    let s = resolveMilkProbePresence(null, 60, 1000);
    s = resolveMilkProbePresence(s, 0, 1000 + MILK_PROBE_ABSENT_AFTER_MS + 5000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, 21.0, 50000);
    assert.deepEqual(s, { present: true, lastPositiveMs: 50000 });
});

// ── applyMilkProbeGate ──────────────────────────────────────────────────────
// 'temperature' is only offerable with a probe; without one it falls back to
// the previously-set non-temperature mode. Other modes pass through untouched.

test('gate: temperature with a probe passes through', () => {
    assert.equal(applyMilkProbeGate('temperature', true, 'off'), 'temperature');
});

test('gate: temperature without a probe falls back to the stored mode', () => {
    assert.equal(applyMilkProbeGate('temperature', false, 'off'), 'off');
    assert.equal(applyMilkProbeGate('temperature', false, 'time'), 'time');
});

test('gate: missing/unknown fallback defaults to time', () => {
    assert.equal(applyMilkProbeGate('temperature', false, null), 'time');
    assert.equal(applyMilkProbeGate('temperature', false, 'temperature'), 'time');
    assert.equal(applyMilkProbeGate('temperature', false, 'bogus'), 'time');
});

test('gate: non-temperature modes are untouched regardless of the probe', () => {
    assert.equal(applyMilkProbeGate('time', false, 'off'), 'time');
    assert.equal(applyMilkProbeGate('off', true, 'time'), 'off');
});

// ── resolveSteamTileMode ────────────────────────────────────────────────────
// The MAIN-PAGE steam tile's display mode, re-resolved on probe-presence and
// armed-milk-stop changes. Milk ('temperature') is only reachable while it's
// usable (Bengle + probe); a probe loss lands the tile on the recorded
// Time/Off fallback, and probe return does not jump back to Milk on its own.

test('tile: an armed milk stop with milk available pins Milk mode', () => {
    // Boot restore: the workflow kept an armed stop and the probe reports in.
    assert.equal(resolveSteamTileMode('flow', true, true, 'time'), 'temperature');
    assert.equal(resolveSteamTileMode('time', true, true, null), 'temperature');
    assert.equal(resolveSteamTileMode('temperature', true, true, 'off'), 'temperature');
});

test('tile: with milk available but un-armed, the pair is Milk|Flow and nothing auto-arms', () => {
    // Probe returned after a loss (the loss un-armed the stop): the tile does
    // NOT jump back to Milk — the user has to re-select it.
    assert.equal(resolveSteamTileMode('temperature', true, false, 'time'), 'flow');
    // 'time' is not in the Milk|Flow pair — it lands on the flow knob.
    assert.equal(resolveSteamTileMode('time', true, false, 'time'), 'flow');
    assert.equal(resolveSteamTileMode('flow', true, false, 'off'), 'flow');
});

test('tile: probe loss in Milk mode falls back to the recorded Time/Off mode', () => {
    // Same record the settings page falls back to (streamline.steamStopModeFallback):
    // 'time' → the duration knob; 'off' → the flow knob (no auto-stop, duration
    // is meaningless); missing/unknown → 'time'.
    assert.equal(resolveSteamTileMode('temperature', false, false, 'time'), 'time');
    assert.equal(resolveSteamTileMode('temperature', false, false, 'off'), 'flow');
    assert.equal(resolveSteamTileMode('temperature', false, false, null), 'time');
    // An armed value arriving with no probe stays gated off the display too.
    assert.equal(resolveSteamTileMode('temperature', false, true, 'time'), 'time');
});

test('tile: without milk, non-Milk modes pass through untouched', () => {
    assert.equal(resolveSteamTileMode('time', false, false, 'off'), 'time');
    assert.equal(resolveSteamTileMode('flow', false, false, 'time'), 'flow');
    // …even when the workflow still reports an armed stop (boot with no probe).
    assert.equal(resolveSteamTileMode('flow', false, true, 'time'), 'flow');
});

// ── milkTelemetryText ───────────────────────────────────────────────────────
// Top-telemetry-row Milk field (after Weight): a string only while the probe
// is present AND has a usable reading; null = hide the field entirely.

test('milk telemetry: present probe with a positive reading formats to 0.1°c', () => {
    assert.equal(milkTelemetryText(true, 43.25), '43.3°c');
    assert.equal(milkTelemetryText(true, 4), '4.0°c');
});

test('milk telemetry: absent probe hides the field regardless of the reading', () => {
    assert.equal(milkTelemetryText(false, 43.2), null);
    assert.equal(milkTelemetryText(false, 0), null);
});

test('milk telemetry: unusable readings hide the field — never a fake value or dashes', () => {
    assert.equal(milkTelemetryText(true, 0), null);       // snapshot contract: 0 = no reading
    assert.equal(milkTelemetryText(true, -1), null);
    assert.equal(milkTelemetryText(true, NaN), null);
    assert.equal(milkTelemetryText(true, Infinity), null);
    assert.equal(milkTelemetryText(true, undefined), null);
    assert.equal(milkTelemetryText(true, '60'), null);
});
