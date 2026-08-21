import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Persistence of the user's main-page settings: the shared KV record that
// outranks a drifted workflow (milk stop, plus the resync rule every tile value
// shares), the after-boot drift check on incoming shotSettings frames, and the
// per-profile brew-temp override.
//
// api.js / app.js / profileManager.js can't be imported under node (browser
// globals), so the functions under test are lifted out of the source and run
// with their dependencies injected -- same trick as settings-write-cache.test.mjs.

function lift(module, patterns) {
    const source = readFileSync(new URL(`../src/modules/${module}`, import.meta.url), 'utf8');
    return patterns.map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `${module}: no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');
}

// ── Milk stop + the shared KV resync rule (api.js) ───────────────────────────
{
    const body = lift('api.js', [
        /export const MILK_STOP_LAST_VALUE_KEY = .*;/,
        /export async function resyncIfDrifted\(key, fetchedValue, pushFn\) \{[\s\S]*?\r?\n\}/,
        /export async function resyncMilkStopIfDrifted\(stopAtTemperature\) \{[\s\S]*?\r?\n\}/,
        /export async function setStopAtTemperature\(celsius\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (remembered) => {
        const kvWrites = [];
        const workflowWrites = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'updateWorkflow', 'getValueFromStore', 'openDB', 'getSetting',
            `${body}\nreturn { setStopAtTemperature, resyncMilkStopIfDrifted, resyncIfDrifted };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { kvWrites.push([key, value]); },
            async (patch) => { workflowWrites.push(patch); },
            async () => remembered,
            async () => {},
            async () => remembered,
        );
        return { api, kvWrites, workflowWrites };
    };

    test('an armed milk stop is remembered in KV before it reaches the machine', async () => {
        const { api, kvWrites, workflowWrites } = build(null);
        await api.setStopAtTemperature(60);
        assert.deepEqual(kvWrites, [['last-milk-stop', 60]]);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 60 } }]);
    });

    test('turning the stop off writes the machine but never the KV record', async () => {
        // 0 = off (user toggle, or a probe that vanished). Persisting it would erase
        // the temperature the user tuned.
        const { api, kvWrites, workflowWrites } = build(null);
        await api.setStopAtTemperature(0);
        assert.deepEqual(kvWrites, []);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 0 } }]);
    });

    test('a drifted armed stop is re-pushed from the KV record', async () => {
        const { api, kvWrites, workflowWrites } = build(60);
        await api.resyncMilkStopIfDrifted(55);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 60 } }]);
        assert.deepEqual(kvWrites, [['last-milk-stop', 60]]);
    });

    test('an agreeing armed stop is left alone', async () => {
        const { api, workflowWrites } = build(60);
        await api.resyncMilkStopIfDrifted(60);
        assert.deepEqual(workflowWrites, []);
    });

    test('a stop that is off is never re-armed by the remembered target', async () => {
        const { api, workflowWrites } = build(60);
        await api.resyncMilkStopIfDrifted(0);
        await api.resyncMilkStopIfDrifted(undefined);
        assert.deepEqual(workflowWrites, []);
    });

    test('a stored value above the API ceiling is clamped on the way out', async () => {
        // rest_v1.yml SteamSettings.stopAtTemperature documents range 0..80; the tile
        // used to allow 85, so an older KV record can still hold one.
        const { api, kvWrites, workflowWrites } = build(85);
        await api.resyncMilkStopIfDrifted(60);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 80 } }]);
        assert.deepEqual(kvWrites, [['last-milk-stop', 80]]);
    });

    test('a remembered value is pushed even when the workflow has no value at all', async () => {
        // The user's setting wins over an absent machine value -- a missing field is
        // the strongest reason to push what they asked for, not a reason to drop it.
        const pushed = [];
        const { api } = build(45);
        await api.resyncIfDrifted('last-anything', undefined, async (v) => { pushed.push(v); });
        await api.resyncIfDrifted('last-anything', null, async (v) => { pushed.push(v); });
        assert.deepEqual(pushed, [45, 45]);
    });

    test('the pushed value is returned so the caller can repaint its tile', async () => {
        // Pushing alone leaves the tile on the drifted workflow value. Steam flow,
        // the milk stop and the flush duration are in no websocket payload, so
        // nothing else would ever correct them.
        const { api } = build(45);
        assert.equal(await api.resyncIfDrifted('last-anything', 30, async () => {}), 45);
        assert.equal(await api.resyncMilkStopIfDrifted(55), 45);
    });

    test('an agreeing value returns nothing to repaint', async () => {
        const { api } = build(45);
        assert.equal(await api.resyncIfDrifted('last-anything', 45, async () => {}), null);
        assert.equal(await api.resyncMilkStopIfDrifted(45), null);
        // A disarmed stop never reaches the comparison at all.
        assert.equal(await api.resyncMilkStopIfDrifted(0), null);
    });

    test('with nothing remembered the machine value stands', async () => {
        const pushed = [];
        const { api } = build(null);
        await api.resyncIfDrifted('last-anything', 30, async (v) => { pushed.push(v); });
        await api.resyncIfDrifted('last-anything', undefined, async (v) => { pushed.push(v); });
        assert.deepEqual(pushed, []);
    });
}

// ── After-boot drift check on shotSettings frames (app.js) ───────────────────
{
    const body = lift('app.js', [
        /const SHOT_SETTINGS_KV_FIELDS = \[[\s\S]*?\r?\n\];/,
        /const lastSeenShotSettings = \{\};/,
        /function resyncDriftedShotSettings\(data\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = () => {
        const checked = [];
        const api = {
            STEAM_DURATION_LAST_VALUE_KEY: 'last-steam-duration',
            HOT_WATER_VOLUME_LAST_VALUE_KEY: 'last-hot-water-volume',
            HOT_WATER_TEMP_LAST_VALUE_KEY: 'last-hot-water-temp',
            setTargetSteamDuration: () => {},
            setTargetHotWaterVolume: () => {},
            setTargetHotWaterTemp: () => {},
            resyncIfDrifted: async (key, value) => { checked.push([key, value]); },
        };
        const fn = new Function('api', 'logger',
            `${body}\nreturn resyncDriftedShotSettings;`)(api, { warn() {} });
        return { fn, checked };
    };

    test('only the three KV-backed ShotSettings fields are checked', () => {
        const { fn, checked } = build();
        fn({ targetSteamDuration: 30, targetHotWaterVolume: 120, targetHotWaterTemp: 85, groupTemp: 92, targetShotVolume: 36 });
        assert.deepEqual(checked, [
            ['last-steam-duration', 30],
            ['last-hot-water-volume', 120],
            ['last-hot-water-temp', 85],
        ]);
    });

    test('a repeated frame is not re-checked', () => {
        // A machine that refuses a pushed value keeps sending the same number; without
        // this the check would fire on every snapshot forever.
        const { fn, checked } = build();
        const frame = { targetSteamDuration: 30 };
        fn(frame);
        fn({ ...frame });
        fn({ ...frame });
        assert.deepEqual(checked, [['last-steam-duration', 30]]);
    });

    test('a changed value is checked again', () => {
        const { fn, checked } = build();
        fn({ targetSteamDuration: 30 });
        fn({ targetSteamDuration: 45 });
        fn({ targetSteamDuration: 30 });
        assert.deepEqual(checked.map(([, v]) => v), [30, 45, 30]);
    });

    test('absent fields are skipped, zero is not', () => {
        const { fn, checked } = build();
        fn({ targetHotWaterVolume: 0 });
        fn({});
        assert.deepEqual(checked, [['last-hot-water-volume', 0]]);
    });
}

// ── Per-profile brew-temp override (profileManager.js) ───────────────────────
{
    const withSavedBrewTemp = new Function(
        `${lift('profileManager.js', [/export function withSavedBrewTemp\(profile, metadata\) \{[\s\S]*?\r?\n\}/])}
         return withSavedBrewTemp;`)();

    const profile = { title: 'Classic', steps: [{ temperature: 92, name: 'infuse' }, { temperature: 88, name: 'decline' }] };

    test('a saved brew temp is applied to every step', () => {
        const out = withSavedBrewTemp(profile, { brewTemperature: 94 });
        assert.deepEqual(out.steps.map(s => s.temperature), [94, 94]);
        assert.equal(out.title, 'Classic');
        assert.equal(out.steps[1].name, 'decline'); // other step fields survive
    });

    test('the cached record is never mutated', () => {
        withSavedBrewTemp(profile, { brewTemperature: 94 });
        assert.deepEqual(profile.steps.map(s => s.temperature), [92, 88]);
    });

    test('no saved override leaves the profile exactly as it was', () => {
        for (const meta of [undefined, null, {}, { brewTemperature: null }, { brewTemperature: 'hot' }, { brewTemperature: NaN }]) {
            assert.equal(withSavedBrewTemp(profile, meta), profile);
        }
    });

    test('a profile with no steps is returned untouched', () => {
        const stepless = { title: 'Odd' };
        assert.equal(withSavedBrewTemp(stepless, { brewTemperature: 94 }), stepless);
        assert.equal(withSavedBrewTemp(null, { brewTemperature: 94 }), null);
    });
}
