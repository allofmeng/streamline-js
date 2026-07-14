// Steam-mode resolvers — pure and DOM-free so the node:test suite can import
// them (see test/steam-mode.test.mjs and test/README.md). ui.js and
// settings.js consume these; keep browser globals out of this module.

// Machine-model-specific defaults for steam flow (ml/s). Resolved at boot via
// ui.js setSteamFlowPresetsFromMachineModel(). The midGroup/highGroup model
// strings ("Bengle 10A" / "Bengle 15A") are forward-looking — today the app
// serializes exactly "Bengle" — keep them with their comments.
export const STEAM_FLOW_PRESETS_BY_MODEL = {
    standard: [0.4, 0.5, 0.6, 0.8],  // DE1Pro, DE1XL, Bengle (default)
    midGroup: [0.5, 0.8, 1.0, 1.2],  // Bengle 10A, DE1 XXL
    highGroup: [0.8, 1.0, 1.2, 1.5], // Bengle 15A
};

/** Baseline steam-flow preset group for a machine-model string. */
export function resolveSteamFlowPresetsForModel(model) {
    const m = String(model || '').toLowerCase();
    if (m.includes('15a')) return STEAM_FLOW_PRESETS_BY_MODEL.highGroup;
    if (m.includes('10a') || m.includes('xxl')) return STEAM_FLOW_PRESETS_BY_MODEL.midGroup;
    return STEAM_FLOW_PRESETS_BY_MODEL.standard;
}

// Steam-stop mode is a skin-side concept: reaprime stores only the independent
// `stopAtTemperature` field (0 = off), not a mode enum. We derive 'temperature'
// from a non-zero milk target; 'time' vs 'off' (both stopAtTemperature = 0) is
// disambiguated by a skin-local preference. 'temperature' is never valid off a
// Bengle.
/**
 * Resolve the settings-page steam-stop mode.
 * @param {number} stopTemp  workflow.steamSettings.stopAtTemperature (0 = off)
 * @param {string|null} storedMode  skin-local preference ('off'|'time'|'temperature')
 * @param {boolean} isBengle  connected machine is a Bengle
 * @returns {'off'|'time'|'temperature'}
 */
export function resolveSteamStopMode(stopTemp, storedMode, isBengle) {
    if (stopTemp > 0) return isBengle ? 'temperature' : 'time';
    if (storedMode === 'off') return 'off';
    if (storedMode === 'time') return 'time';
    if (storedMode === 'temperature') return isBengle ? 'temperature' : 'time';
    return 'time';
}

// ── Milk-probe presence ──────────────────────────────────────────────────────
// Snapshot contract: milkTemperature is real °C; 0 (or an absent field) means
// no probe / no reading. A probe must not flicker out on a single 0 frame, so
// presence drops only after a sustained interval without a positive reading.

/** How long milkTemperature must stay 0/absent before the probe counts as gone. */
export const MILK_PROBE_ABSENT_AFTER_MS = 5000;

/**
 * Fold one snapshot milkTemperature reading into a probe-presence state.
 * Present from the first positive reading; stays present through brief 0
 * glitches; absent after MILK_PROBE_ABSENT_AFTER_MS without a positive
 * reading. Starts (and stays, if never positive) absent — never fake a probe.
 * @param {{present:boolean,lastPositiveMs:number|null}|null} prev  previous state
 * @param {*} tempC  snapshot milkTemperature (any type — non-finite = absent)
 * @param {number} nowMs  current epoch ms
 * @returns {{present:boolean,lastPositiveMs:number|null}}
 */
export function resolveMilkProbePresence(prev, tempC, nowMs) {
    if (typeof tempC === 'number' && isFinite(tempC) && tempC > 0) {
        return { present: true, lastPositiveMs: nowMs };
    }
    const lastPositiveMs = prev?.lastPositiveMs ?? null;
    return {
        present: lastPositiveMs !== null && (nowMs - lastPositiveMs) < MILK_PROBE_ABSENT_AFTER_MS,
        lastPositiveMs,
    };
}

/**
 * Gate a resolved steam-stop mode on probe presence: 'temperature' is only
 * offerable with a probe attached; without one it falls back to the
 * previously-set non-temperature mode ('time' or 'off'; anything else → 'time').
 * Non-temperature modes pass through untouched.
 * @param {'off'|'time'|'temperature'} mode  from resolveSteamStopMode
 * @param {boolean} probePresent
 * @param {string|null} fallbackMode  skin-local record of the last non-temperature mode
 * @returns {'off'|'time'|'temperature'}
 */
export function applyMilkProbeGate(mode, probePresent, fallbackMode) {
    if (mode !== 'temperature' || probePresent) return mode;
    return fallbackMode === 'off' ? 'off' : 'time';
}

/**
 * Resolve the MAIN-PAGE steam tile's display mode against milk availability
 * (Bengle machine + probe present) and the armed milk stop
 * (workflow stopAtTemperature > 0). Re-run whenever either input changes.
 *
 * With milk available the tile offers Milk|Flow: an armed stop pins Milk
 * ('temperature'); otherwise 'temperature' (just disarmed) and 'time' (not in
 * this pair) land on 'flow' — an un-armed stop never jumps back to Milk on its
 * own, so after a probe round-trip the mode stays on the fallback until the
 * user re-selects Milk. Without milk the tile offers Time|Flow: leaving
 * 'temperature' falls back to the user's recorded non-temperature stop mode —
 * 'off' shows the flow knob (no auto-stop → duration is meaningless), anything
 * else the duration knob ('time'); non-temperature modes pass through.
 * @param {'time'|'flow'|'temperature'} currentMode  the tile's current mode
 * @param {boolean} milkAvailable  Bengle with the milk probe present
 * @param {boolean} milkStopArmed  workflow stopAtTemperature > 0
 * @param {string|null} fallbackMode  skin-local record of the last non-temperature stop mode
 * @returns {'time'|'flow'|'temperature'}
 */
export function resolveSteamTileMode(currentMode, milkAvailable, milkStopArmed, fallbackMode) {
    if (milkAvailable) {
        if (milkStopArmed) return 'temperature';
        return (currentMode === 'temperature' || currentMode === 'time') ? 'flow' : currentMode;
    }
    if (currentMode === 'temperature') return fallbackMode === 'off' ? 'flow' : 'time';
    return currentMode;
}
