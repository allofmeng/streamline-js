// Check of the no-op guard and save routing in saveProfile() /
// src/modules/profile_editor.js (mirrored here — the module touches the DOM at
// import time). Two bugs this pins down:
//   1. A brand-new profile arrives as a stub record with id null, so treating
//      the record itself as the source made an untouched new profile look
//      "unchanged" — Save silently dropped it without ever POSTing.
//   2. The guard compared the editor's normalised copy against the raw source,
//      so any profile still carrying legacy fields read as an execution change
//      the instant it opened and forked itself on a no-op Save.
// Run: node test/profile-save-routing.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const deepCopy = o => JSON.parse(JSON.stringify(o));

function normalizeLegacySteps(profile) {
    for (const step of profile.steps ?? []) {
        if (step.pump === 'flow') delete step.pressure;
        else if (step.pump === 'pressure') delete step.flow;
        if (step.limiter && step.limiter.value === 0) step.limiter = null;
        if (step.exit && step.exit.type !== 'pressure' && step.exit.type !== 'flow') step.exit = null;
    }
    return profile;
}

const PRESENTATION_FIELDS = ['title', 'author', 'notes'];
function executionChanged(orig, edited) {
    const strip = p => {
        const c = { ...p };
        PRESENTATION_FIELDS.forEach(k => delete c[k]);
        return JSON.stringify(c);
    };
    return strip(orig) !== strip(edited);
}

// Returns what saveProfile would do: 'noop' | 'post-new' | 'fork-default'
// | 'overwrite' (hide + POST) | 'put-metadata'.
// `baseline` is _baselineProfileJson — the editor's copy as it stood on load.
// `imported` is _hasImportedInSession — a file was uploaded into this session.
function route(record, edited, baseline = null, imported = false) {
    const src = record?.id ? record : null;
    const sourceProfile = src?.profile ? normalizeLegacySteps(deepCopy(src.profile)) : null;
    const sourceProfileJson = sourceProfile ? JSON.stringify(sourceProfile) : null;
    const editedJson = JSON.stringify(edited);
    const unchanged = sourceProfileJson
        ? sourceProfileJson === editedJson
        : (!imported && editedJson === baseline);
    if (unchanged) return 'noop';

    const sourceTitle = (src?.profile?.title || '').trim();
    const titleChanged = sourceTitle && edited.title.trim() !== sourceTitle;
    const execChanged = !src || executionChanged(sourceProfile, edited);

    if (src?.isDefault && execChanged) return 'fork-default';
    if (!src || titleChanged) return 'post-new';
    if (execChanged) return 'overwrite';
    return 'put-metadata';
}

// A step shaped like the editor emits it, plus the legacy off-pump key the
// source record still carries.
const flowStep = extra => ({
    name: 'Preinfusion', pump: 'flow', flow: 2, temperature: 93, seconds: 10,
    exit: { type: 'pressure', condition: 'over', value: 4 },
    limiter: { value: 4, range: 0.6 }, ...extra,
});
const mkProfile = (title, steps) => ({ title, version: '2', author: '', notes: '', steps });

// The editor's view of a profile: what initializeProfileEditor built from it.
const asEdited = record => normalizeLegacySteps(deepCopy(record.profile));

// ── 1. New profile, untouched: blocked, and blocked by the baseline ─────────
// Not by the stub-as-source path — that one silently navigated away and lost
// the profile. Here the user stays on the editor and gets told to rename.
const stub = { id: null, profile: mkProfile('New Profile', [flowStep()]) };
const stubBaseline = JSON.stringify(asEdited(stub));
assert.strictEqual(route(stub, asEdited(stub), stubBaseline), 'noop',
    'saving the untouched Add Profile template must prompt, not create a stock "New Profile"');

// ── 2. New profile, edited but never renamed: a plain POST ──────────────────
const stubEdited = asEdited(stub);
stubEdited.steps[0].temperature = 95;
assert.strictEqual(route(stub, stubEdited, stubBaseline), 'post-new',
    'a new profile keeping its default title must not take the hide-then-POST overwrite path');

// Renaming alone is enough to get a new profile saved.
const stubRenamed = asEdited(stub);
stubRenamed.title = 'Morning blend';
assert.strictEqual(route(stub, stubRenamed, stubBaseline), 'post-new',
    'renaming the template is the minimum change that makes Save work');

// ── 2b. Uploaded file, saved verbatim: must save ────────────────────────────
// Upload Local File resets the baseline and passes no source record, so the
// template check has to be skipped or saving an upload as-is would be blocked.
const uploaded = mkProfile('Londinium', [flowStep({ pressure: 9 })]);
const uploadedBaseline = JSON.stringify(uploaded);
assert.strictEqual(route(null, uploaded, uploadedBaseline, true), 'post-new',
    'an uploaded profile saved verbatim must be created — saving it as-is is the point');

// ── 3. Legacy profile opened and saved untouched: no-op, no fork ─────────────
// The source carries `pressure` on a flow step; the editor's copy drops it.
const legacy = { id: 'abc', profile: mkProfile('Londinium', [flowStep({ pressure: 9 })]) };
assert.strictEqual(route(legacy, asEdited(legacy)), 'noop',
    'a legacy field the editor strips on load must not read as an execution change');

const legacyDefault = { id: 'def', isDefault: true, profile: deepCopy(legacy.profile) };
assert.strictEqual(route(legacyDefault, asEdited(legacyDefault)), 'noop',
    'opening a stock default and saving it untouched must not fork it');

// ── 4. Real edits still route as before ─────────────────────────────────────
const edited = asEdited(legacy);
edited.steps[0].flow = 3;
assert.strictEqual(route(legacy, edited), 'overwrite',
    'a real execution change on a user profile hides the old record and POSTs');

const renamed = asEdited(legacy);
renamed.title = 'Londinium v2';
assert.strictEqual(route(legacy, renamed), 'post-new',
    'renaming is the explicit save-as');

const renoted = asEdited(legacy);
renoted.notes = 'pulled 18g in';
assert.strictEqual(route(legacy, renoted), 'put-metadata',
    'a presentation-only change keeps the id');

const forked = asEdited(legacyDefault);
forked.steps[0].seconds = 12;
assert.strictEqual(route(legacyDefault, forked), 'fork-default',
    'editing a default forks it — PUT would be rejected');

const editorSource = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const overwriteStart = editorSource.indexOf('        } else if (execChanged) {');
const overwriteEnd = editorSource.indexOf('        } else {', overwriteStart + 1);
const overwriteBranch = editorSource.slice(overwriteStart, overwriteEnd);
const uploadIndex = overwriteBranch.indexOf('saved = await uploadProfileWithParent');
const hideIndex = overwriteBranch.indexOf("await updateProfileVisibility(src.id, 'hidden')");
assert.ok(uploadIndex >= 0 && hideIndex >= 0 && uploadIndex < hideIndex,
    'the replacement must exist before the visible predecessor is hidden');
const reactivateIndex = overwriteBranch.indexOf("saved = await updateProfileVisibility(saved.id, 'visible')");
assert.ok(reactivateIndex >= 0 && uploadIndex < reactivateIndex && reactivateIndex < hideIndex,
    'a deduplicated hidden replacement must be reactivated before the predecessor is hidden');

const reactivateBlock = overwriteBranch.match(/            if \(saved\.visibility !== 'visible'\) \{[\s\S]*?            \}/)?.[0];
assert.ok(reactivateBlock, 'the save path must handle a deduplicated hidden replacement');
const runReactivation = new Function('saved', 'updateProfileVisibility',
    `return (async () => { ${reactivateBlock} return saved; })();`);
const calls = [];
const deduplicated = { id: 'profile:a', visibility: 'hidden' };
const visibleReplacement = await runReactivation(deduplicated, async (id, visibility) => {
    calls.push([id, visibility]);
    return { ...deduplicated, visibility };
});
assert.strictEqual(visibleReplacement.visibility, 'visible',
    'a deduplicated hidden profile must be reactivated');
assert.deepStrictEqual(calls, [['profile:a', 'visible']],
    'reactivation must target the deduplicated replacement id');

console.log('profile-save-routing: all assertions passed');
