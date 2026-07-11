// Shared machine-model gate.
//
// Bengle detection is by model string: GET /api/v1/machine/info reports
// model "Bengle" for Bengle hardware (firmware v13Model >= 128). There is no
// serialized isBengle flag and no capability endpoint the skin consults, so
// the model string is the signal — the same convention the steam-preset
// resolver in ui.js already uses for group-head sizing.
//
// Boot order matters: app.js calls setMachineModel() BEFORE the first
// ui.updateSteamDisplay() so Bengle-gated steam UI (e.g. an armed milk stop
// mode persisted in the workflow) restores correctly on boot. Keep it that
// way when adding new boot steps.
//
// This module is deliberately DOM-free so the node:test suite can import it
// (see test/machine.test.mjs and test/README.md).

/** True when a machine-model string identifies a Bengle. */
export function isBengleModel(model) {
    return String(model || '').toLowerCase().includes('bengle');
}

let machineModel = null;

/** Record the connected machine's model string (null/undefined = unknown). */
export function setMachineModel(model) {
    machineModel = (model === undefined || model === null) ? null : String(model);
}

/** The last model string recorded, or null when unknown. */
export function getMachineModel() {
    return machineModel;
}

/** True when the connected machine is a Bengle. Gates all Bengle-only UI. */
export function isBengleMachine() {
    return isBengleModel(machineModel);
}
