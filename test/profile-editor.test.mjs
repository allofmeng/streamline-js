import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// profile_editor.js pulls in browser-only modules, so lift the function out of
// the source the same way the other editor tests do.
const source = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8');
const match = source.match(/export function pushChannel\([\s\S]*?\r?\n\}/);
assert.ok(match, 'pushChannel not found in profile_editor.js');
const pushChannel = new Function(`${match[0].replace('export ', '')}\nreturn pushChannel;`)();

function channel(steps) {
    const x = [], y = [];
    let prev = 0;
    let t = 0;
    for (const s of steps) {
        pushChannel(x, y, t, t + s.dur, prev, s.target, s.transition);
        prev = s.target;
        t += s.dur;
    }
    return { x, y };
}

test('smooth ramps from zero on the opening step', () => {
    const smooth = channel([{ dur: 10, target: 6, transition: 'smooth' }]);
    const fast   = channel([{ dur: 10, target: 6, transition: 'fast' }]);
    // The bug: both plotted as a flat line at 6 because smooth emitted no
    // opening point and step 1 has no earlier point to slope up from.
    assert.deepEqual(smooth.y, [0, 6]);
    assert.deepEqual(fast.y,   [6, 6]);
    assert.notDeepEqual(smooth.y, fast.y);
});

test('smooth ramps from the previous step target, fast jumps', () => {
    const steps = (transition) => [
        { dur: 10, target: 3, transition: 'fast' },
        { dur: 20, target: 9, transition },
    ];
    assert.deepEqual(channel(steps('smooth')).y, [3, 3, 3, 9]);
    assert.deepEqual(channel(steps('fast')).y,   [3, 3, 9, 9]);
});

test('the ramp spans the whole frame, not a capped fraction of it', () => {
    const { x } = channel([{ dur: 30, target: 8, transition: 'smooth' }]);
    assert.deepEqual(x, [0, 30]);
});

test('x and y stay equal length on every path', () => {
    for (const transition of ['smooth', 'fast', undefined]) {
        const { x, y } = channel([{ dur: 5, target: 2, transition }, { dur: 5, target: 2, transition }]);
        assert.equal(x.length, y.length);
    }
});

// ── readExitDef ─────────────────────────────────────────────────────────────
const exitMatch = source.match(/function readExitDef\(step\) \{[\s\S]*?\r?\n\}/);
assert.ok(exitMatch, 'readExitDef not found in profile_editor.js');
const readExitDef = new Function(`${exitMatch[0]}\nreturn readExitDef;`)();

test('a step with no exit reads as off, not as a 0-bar pressure exit', () => {
    assert.deepEqual(readExitDef({}), { type: 'off', condition: 'over', value: 0 });
    assert.deepEqual(readExitDef({ exit: null }), { type: 'off', condition: 'over', value: 0 });
});

test('legacy and UI-only exit types collapse to off', () => {
    // api.js:934 drops anything that is not pressure/flow at the write boundary,
    // so the editor must not present those as live exits either.
    for (const type of ['off', 'weight', 'time', 'bogus']) {
        assert.equal(readExitDef({ exit: { type, condition: 'under', value: 5 } }).type, 'off');
    }
});

test('a real exit is passed through, with defaults filled in', () => {
    assert.deepEqual(
        readExitDef({ exit: { type: 'flow', condition: 'under', value: 2 } }),
        { type: 'flow', condition: 'under', value: 2 },
    );
    assert.deepEqual(
        readExitDef({ exit: { type: 'pressure' } }),
        { type: 'pressure', condition: 'over', value: 0 },
    );
});

test('off is reachable and leavable in the type cycle', () => {
    const types = source.match(/const EXIT_TYPES\s*=\s*\[([^\]]*)\]/)[1]
        .split(',').map((t) => t.trim().replace(/'/g, ''));
    assert.ok(types.includes('off'), 'off must stay in the cycle so an exit can be cleared');
    // Both tabs cycle with the same modulo step, so every type is reachable.
    const seen = new Set();
    let i = types.indexOf('off');
    for (let n = 0; n < types.length; n++) { i = (i + 1) % types.length; seen.add(types[i]); }
    assert.equal(seen.size, types.length);
});

// ── Exit-off round trip ─────────────────────────────────────────────────────
// Reported bug: set "Exit if" to Off, save, reopen — the step came back reading
// "Pressure is over 0.0 bar". Trace the whole path the profile actually takes.
const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const sanMatch = apiSource.match(/function sanitizeProfileForRea\(profileData\) \{[\s\S]*?\n\}/);
assert.ok(sanMatch, 'sanitizeProfileForRea not found in api.js');
const sanitizeProfileForRea = new Function(`${sanMatch[0]}\nreturn sanitizeProfileForRea;`)();

const normMatch = source.match(/function normalizeLegacySteps\(profile\) \{[\s\S]*?\n\}\n/);
assert.ok(normMatch, 'normalizeLegacySteps not found in profile_editor.js');
const normalizeLegacySteps = new Function(`${normMatch[0]}\nreturn normalizeLegacySteps;`)();

test('an exit turned off stays off across save and reload', () => {
    // What the editor holds after tapping the Exit type toggle round to Off.
    const edited = { steps: [{ pump: 'flow', flow: 6, exit: { type: 'off', condition: 'over', value: 0 } }] };

    // Save: the write boundary drops any non-pressure/flow exit.
    const saved = sanitizeProfileForRea(edited);
    assert.equal(saved.steps[0].exit, null);

    // Reload: what comes back off the wire, through the legacy coercion.
    const reloaded = normalizeLegacySteps(JSON.parse(JSON.stringify(saved)));

    // Render: this is where the bug lived — a falsy exit used to fall through to
    // a { pressure, over, 0 } default and display as a live pressure exit.
    assert.deepEqual(readExitDef(reloaded.steps[0]), { type: 'off', condition: 'over', value: 0 });
});

test('a server that omits the exit key entirely also reads as off', () => {
    assert.equal(readExitDef(normalizeLegacySteps({ steps: [{ pump: 'flow', flow: 6 }] }).steps[0]).type, 'off');
});

test('a real exit still survives the same round trip', () => {
    const edited = { steps: [{ pump: 'pressure', pressure: 9, exit: { type: 'flow', condition: 'under', value: 2 } }] };
    const reloaded = normalizeLegacySteps(JSON.parse(JSON.stringify(sanitizeProfileForRea(edited))));
    assert.deepEqual(readExitDef(reloaded.steps[0]), { type: 'flow', condition: 'under', value: 2 });
});
