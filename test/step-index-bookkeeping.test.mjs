// Check of removeStepAt()/insertStepAfter()/moveStep() in src/modules/profile_editor.js
// (mirrored here — the module touches the DOM at import time). Both the grid and
// text tabs used to splice profile.steps directly, which left
// profile.target_volume_count_start pointing at whichever step had shifted into
// the old position — so "preinfusion ends after step 3" silently came to mean a
// different step, or an index past the end of the array.
// Run: node test/step-index-bookkeeping.test.mjs
import assert from 'node:assert';

// target_volume_count_start is a 1-based step index; 0 means "None".
function removeStepAt(p, index) {
    p.steps.splice(index, 1);
    const start = p.target_volume_count_start || 0;
    if (start === index + 1) p.target_volume_count_start = index;
    else if (start > index + 1) p.target_volume_count_start = start - 1;
}

function insertStepAfter(p, index) {
    p.steps.splice(index + 1, 0, { name: 'New Step' });
    const start = p.target_volume_count_start || 0;
    if (start > index + 1) p.target_volume_count_start = start + 1;
}

const mk = (names, start) => ({ steps: names.map(n => ({ name: n })), target_volume_count_start: start });
// Name of the step the marker points at, null for None, 'DANGLING' if off the end.
const marked = p => p.target_volume_count_start === 0
    ? null
    : (p.steps[p.target_volume_count_start - 1]?.name ?? 'DANGLING');

// The marker names a step, not a position: editing steps around it must not move it.
let p = mk(['a', 'b', 'c', 'd'], 3);
removeStepAt(p, 0);
assert.strictEqual(marked(p), 'c', 'deleting an earlier step must not repoint the marker');

p = mk(['a', 'b', 'c', 'd'], 2);
removeStepAt(p, 3);
assert.strictEqual(marked(p), 'b', 'deleting a later step must leave the marker alone');

p = mk(['a', 'b', 'c'], 3);
insertStepAfter(p, 0);
assert.strictEqual(marked(p), 'c', 'inserting before the marker must not repoint it');

p = mk(['a', 'b', 'c'], 1);
insertStepAfter(p, 1);
assert.strictEqual(marked(p), 'a', 'inserting after the marker must leave it alone');

// Deleting the marked step itself: fall back to the step before it.
p = mk(['a', 'b', 'c'], 2);
removeStepAt(p, 1);
assert.strictEqual(marked(p), 'a', 'deleting the marked step falls back to its predecessor');

p = mk(['a', 'b'], 1);
removeStepAt(p, 0);
assert.strictEqual(marked(p), null, 'deleting the marked first step yields None');

// The marker must never point past the end — that is what rendered a blank
// selection in the Settings dropdown.
p = mk(['a', 'b'], 2);
removeStepAt(p, 1);
assert.ok(p.target_volume_count_start <= p.steps.length, 'marker must stay within the array');
assert.notStrictEqual(marked(p), 'DANGLING');

// None survives both operations.
p = mk(['a', 'b'], 0);
insertStepAfter(p, 0);
assert.strictEqual(p.target_volume_count_start, 0, 'None stays None on insert');
removeStepAt(p, 0);
assert.strictEqual(p.target_volume_count_start, 0, 'None stays None on delete');

// Sanity: confirm the bare splice really did repoint the marker, so this test
// fails loudly if the fixup is ever dropped again.
const naive = mk(['a', 'b', 'c', 'd'], 3);
naive.steps.splice(0, 1);
assert.strictEqual(naive.steps[naive.target_volume_count_start - 1].name, 'd',
    'sanity: an unfixed splice repoints the marker from c to d');

// ─── moveStep() ─────────────────────────────────────────────────────────────
// Same marker concern, third mutator. Unlike the two above this one is read
// straight out of the module rather than mirrored here: slicing the source text
// keeps it honest (a mirror silently passes once the real function changes)
// while still never importing the DOM-touching module.
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8');
const MOVE_SRC = SRC.slice(SRC.indexOf('function moveStep(from, to)'),
                           SRC.indexOf('\n}', SRC.indexOf('function moveStep(from, to)')) + 2);
assert.ok(MOVE_SRC.includes('target_volume_count_start'), 'moveStep source located');
const bindMove = (editorState) => new Function('editorState', MOVE_SRC + '\nreturn moveStep;')(editorState);

const move = (names, start, from, to) => {
    const editorState = { profile: mk(names, start) };
    const ok = bindMove(editorState)(from, to);
    return { ok, p: editorState.profile, order: editorState.profile.steps.map(s => s.name).join('') };
};

// Ordering
assert.strictEqual(move(['a','b','c','d'], 0, 0, 1).order, 'bacd', 'move right by one');
assert.strictEqual(move(['a','b','c','d'], 0, 3, 0).order, 'dabc', 'move last to front');
assert.strictEqual(move(['a','b','c','d'], 0, 1, 3).order, 'acdb', 'move to end');

// Bounds are refused and leave the array untouched
for (const [from, to, why] of [[0, -1, 'past start'], [3, 4, 'past end'], [2, 2, 'no-op']]) {
    const r = move(['a','b','c','d'], 0, from, to);
    assert.strictEqual(r.ok, false, `refuses ${why}`);
    assert.strictEqual(r.order, 'abcd', `refused move (${why}) leaves order intact`);
}

// Exhaustive: after ANY legal move the marker still names the same step, and no
// step is lost or duplicated.
for (let n = 2; n <= 6; n++) {
    const names = ['a','b','c','d','e','f'].slice(0, n);
    for (let start = 0; start <= n; start++) {
        for (let from = 0; from < n; from++) {
            for (let to = 0; to < n; to++) {
                if (from === to) continue;
                const before = start === 0 ? null : names[start - 1];
                const r = move(names, start, from, to);
                assert.strictEqual(marked(r.p), before,
                    `n=${n} start=${start} ${from}->${to}: marker slipped to ${marked(r.p)} (order ${r.order})`);
                assert.strictEqual(new Set(r.order).size, n, `n=${n} ${from}->${to}: steps lost or duplicated`);
            }
        }
    }
}

// Sanity: a bare reorder without the fixup really does repoint the marker.
const naiveMove = mk(['a','b','c','d'], 3);
const [lifted] = naiveMove.steps.splice(0, 1);
naiveMove.steps.splice(2, 0, lifted);
assert.strictEqual(naiveMove.steps[naiveMove.target_volume_count_start - 1].name, 'a',
    'sanity: an unfixed reorder repoints the marker from c to a');

console.log('step-index bookkeeping: all checks passed');
