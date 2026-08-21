import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { workflowTileValues, changedTileValues } from '../src/modules/workflow-watch.js';

// The dashboard learns about a workflow changed elsewhere (Decaid's UI, another
// skin, a DYE2 page) only by re-reading GET /workflow -- there is no workflow
// websocket and no revision to poll. These two functions decide what that re-read
// is allowed to repaint, so the rules that matter are: a field the user is
// mid-edit reads as unchanged (their value has not reached the server yet), and
// the first read after boot repaints nothing.

const workflow = ({ steam = {}, ...over } = {}) => ({
    profile: { title: 'Londonium', steps: [{ temperature: 89 }] },
    context: { grinderSetting: '21', targetDoseWeight: 18, targetYield: 36 },
    steamSettings: { duration: 45, flow: 0.8, stopAtTemperature: 0, ...steam },
    hotWaterData: { volume: 50, targetTemperature: 80 },
    rinseData: { duration: 5 },
    ...over,
});

test('every main-page tile value is read off the workflow', () => {
    assert.deepEqual(workflowTileValues(workflow()), {
        profileTitle: 'Londonium',
        grind: '21',
        dose: 18,
        yield: 36,
        brewTemp: 89,
        steamDuration: 45,
        steamFlow: 0.8,
        milkStop: 0,
        hotWaterVolume: 50,
        hotWaterTemp: 80,
        flush: 5,
    });
});

test('legacy doseData/grinderData fill in when context is absent', () => {
    const values = workflowTileValues({
        doseData: { doseIn: 20, drinkOut: 40 },
        grinderData: { setting: '15' },
    });
    assert.equal(values.dose, 20);
    assert.equal(values.yield, 40);
    assert.equal(values.grind, '15');
});

test('a missing workflow yields nothing rather than throwing', () => {
    assert.deepEqual(workflowTileValues(null), {});
});

test('the first read after boot repaints nothing', () => {
    // Boot already painted from this document; treating it as a change would
    // repaint every tile on the first poll.
    assert.deepEqual(changedTileValues(null, workflowTileValues(workflow())), {});
});

test('only the fields that actually moved are reported', () => {
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({ steam: { duration: 30 } }));
    assert.deepEqual(changedTileValues(before, after), { steamDuration: 30 });
});

test('an unchanged document reports no changes', () => {
    const before = workflowTileValues(workflow());
    assert.deepEqual(changedTileValues(before, workflowTileValues(workflow())), {});
});

test('a reformatted grind setting is not a change', () => {
    // The workflow stores grind as a string and writers format it differently
    // ("21" from one client, "21.00" from setTargetGrind).
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({ context: { grinderSetting: '21.00' } }));
    assert.deepEqual(changedTileValues(before, after), {});
});

test('a field that vanished is not reported -- there is nothing to paint', () => {
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({ rinseData: undefined }));
    assert.equal('flush' in changedTileValues(before, after), false);
});

test('a milk stop turned off elsewhere is reported, 0 being a real value', () => {
    const before = workflowTileValues(workflow({ steam: { stopAtTemperature: 60 } }));
    const after = workflowTileValues(workflow({ steam: { stopAtTemperature: 0 } }));
    assert.deepEqual(changedTileValues(before, after), { milkStop: 0 });
});

test('a profile switch shows up as a title change', () => {
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({
        profile: { title: 'Blooming espresso', steps: [{ temperature: 92 }] },
    }));
    const changed = changedTileValues(before, after);
    assert.equal(changed.profileTitle, 'Blooming espresso');
    assert.equal(changed.brewTemp, 92);
});


// ── The refresh itself (app.js) ──────────────────────────────────────────────
// app.js can't be imported under node (browser globals), so refreshWorkflowTiles
// is lifted out of the source and run with its dependencies injected.
{
    const source = readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8');
    const match = source.match(/async function refreshWorkflowTiles\(\) \{[\s\S]*?\r?\n\}/);
    if (!match) throw new Error('refreshWorkflowTiles not found in app.js');

    const build = ({ baseline, workflow, msSinceEdit = 60_000, subPage = false } = {}) => {
        const calls = { painted: [], reloads: 0, fetches: 0 };
        const refresh = new Function(
            'isSubPage', 'ui', 'getWorkflow', 'logger', 'loadInitialData',
            'workflowTileValues', 'changedTileValues',
            'WORKFLOW_REFRESH_MIN_GAP_MS', 'WORKFLOW_EDIT_GUARD_MS', 'WORKFLOW_TILE_PAINTERS',
            'seed', 'calls',
            `let lastWorkflowTiles = seed;
             let lastWorkflowRefreshAt = 0;
             ${match[0]}
             return refreshWorkflowTiles;`
        )(
            () => subPage,
            { msSinceTileInteraction: () => msSinceEdit },
            async () => { calls.fetches++; return workflow; },
            { info() {}, warn() {} },
            async () => { calls.reloads++; },
            workflowTileValues,
            changedTileValues,
            2000,
            5000,
            new Proxy({}, { get: (_t, key) => (value) => calls.painted.push([key, value]) }),
            baseline,
            calls,
        );
        return { refresh, calls };
    };

    const base = () => ({
        profile: { title: 'Londonium', steps: [{ temperature: 89 }] },
        context: { grinderSetting: '21', targetDoseWeight: 18, targetYield: 36 },
        steamSettings: { duration: 45, flow: 0.8, stopAtTemperature: 0 },
        hotWaterData: { volume: 50, targetTemperature: 80 },
        rinseData: { duration: 5 },
    });

    test('a tile touched moments ago blocks the refresh entirely', async () => {
        // The push is debounced a second, so an earlier press can already be on the
        // server while a later one is pending: repainting would reassign the value
        // that pending push is about to send, and the newest keypress is lost.
        const moved = base();
        moved.steamSettings.flow = 0.4;
        const { refresh, calls } = build({
            baseline: workflowTileValues(base()),
            workflow: moved,
            msSinceEdit: 800,
        });

        await refresh();
        assert.equal(calls.fetches, 0);
        assert.deepEqual(calls.painted, []);
    });

    test('the blocked change is still picked up once editing stops', async () => {
        const moved = base();
        moved.steamSettings.flow = 0.4;
        const { refresh, calls } = build({
            baseline: workflowTileValues(base()),
            workflow: moved,
            msSinceEdit: 30_000,
        });

        await refresh();
        assert.deepEqual(calls.painted, [['steamFlow', 0.4]]);
    });

    test('only the moved tile is painted, never the whole document', async () => {
        const moved = base();
        moved.hotWaterData.volume = 100;
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: moved });

        await refresh();
        assert.deepEqual(calls.painted, [['hotWaterVolume', 100]]);
    });

    test('a profile switch reloads instead of painting tiles piecemeal', async () => {
        // The chart's step tracking, the active-profile record and the favourite
        // highlight all follow the profile; only loadInitialData moves all of them.
        const moved = base();
        moved.profile = { title: 'Blooming espresso', steps: [{ temperature: 92 }] };
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: moved });

        await refresh();
        assert.equal(calls.reloads, 1);
        assert.deepEqual(calls.painted, []);
    });

    test('nothing happens on a sub-page, where the tiles are not mounted', async () => {
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: base(), subPage: true });
        await refresh();
        assert.equal(calls.fetches, 0);
    });

    test('an unchanged workflow paints nothing', async () => {
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: base() });
        await refresh();
        assert.equal(calls.fetches, 1);
        assert.deepEqual(calls.painted, []);
    });
}
