import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadHarness(dependencies) {
    const source = readFileSync(new URL('../src/modules/profile_selector.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('let isConfirmingProfile = false;');
    const end = source.indexOf('function handleCancel', start);
    assert.ok(start >= 0 && end > start);

    return new Function('dependencies', `
        const {
            availableProfiles, logger, alert, showToast, sessionStorage,
            assignProfile, getTranslation, updateWorkflow, setActiveProfile,
            applyWorkflowToMainPageUI, loadPage
        } = dependencies;
        let selectedProfileKey = null;
        const FAV_COUNT = 5;
        ${source.slice(start, end)}
        return {
            handleConfirm,
            select(profileKey) { selectedProfileKey = profileKey; }
        };
    `)(dependencies);
}

test('profile confirmation pins its selection and rejects overlap', async () => {
    let resolveFirst;
    const firstWorkflow = new Promise(resolve => { resolveFirst = resolve; });
    let updateTitles = [];
    let activeKeys = [];
    let appliedTitles = [];
    let navigationCount = 0;
    let alertCount = 0;

    const availableProfiles = Object.freeze({
        a: Object.freeze({ profile: Object.freeze({ title: 'A', target_weight: '36', dose_weight: 18 }) }),
        b: Object.freeze({ profile: Object.freeze({ title: 'B', target_weight: '40', dose_weight: 20 }) })
    });
    const harness = loadHarness({
        availableProfiles,
        logger: { info() {}, error() {} },
        alert() { alertCount += 1; },
        showToast() {},
        sessionStorage: { getItem: () => null, removeItem() {} },
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow(workflow) {
            updateTitles = [...updateTitles, workflow.profile.title];
            return updateTitles.length === 1 ? firstWorkflow : Promise.resolve(workflow);
        },
        setActiveProfile(profileKey) {
            activeKeys = [...activeKeys, profileKey];
        },
        applyWorkflowToMainPageUI(workflow) { appliedTitles = [...appliedTitles, workflow.profile.title]; },
        loadPage() { navigationCount += 1; }
    });

    harness.select('a');
    const firstConfirmation = harness.handleConfirm();
    harness.select('b');
    await harness.handleConfirm();

    assert.deepEqual(updateTitles, ['A']);

    resolveFirst({ profile: { title: 'A' } });
    await firstConfirmation;

    assert.deepEqual(activeKeys, ['a']);
    assert.deepEqual(appliedTitles, ['A']);
    assert.equal(navigationCount, 1);

    await harness.handleConfirm();

    assert.deepEqual(updateTitles, ['A', 'B']);
    assert.deepEqual(activeKeys, ['a', 'b']);
    assert.deepEqual(appliedTitles, ['A', 'B']);
    assert.equal(navigationCount, 2);
    assert.equal(alertCount, 0);
});
