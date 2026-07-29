// Check of assignProfile()'s "did this actually assign?" decision in
// src/modules/profileManager.js (mirrored here — the module touches the DOM at
// import time). That return value is what gates the green success toast in
// profile_selector.js, so getting it wrong shows "Assigned!" over an error.
// Run: node test/assign-favorite.test.mjs
import assert from 'node:assert';

const FAV_COUNT = 5;

// Returns { result, rejectedBy } — result mirrors the 'assigned' | 'rejected' |
// 'unchanged' string the real function returns; rejectedBy is the slot that
// caused an early return, if any.
function assignProfile(favoriteAssignments, buttonIndex, profileKey) {
    if (buttonIndex < 0 || buttonIndex >= FAV_COUNT) return { result: 'unchanged', rejectedBy: null };

    // Any existing assignment rejects — the pressed button included.
    if (profileKey) {
        for (let i = 0; i < FAV_COUNT; i++) {
            if (favoriteAssignments[i] === profileKey) {
                return { result: 'rejected', rejectedBy: i };   // error toast, no assignment
            }
        }
    }

    favoriteAssignments[buttonIndex] = profileKey;
    return { result: 'assigned', rejectedBy: null };
}

// Callers must compare against 'assigned' explicitly: every one of these strings
// is truthy, so a bare `if (result)` would show a success toast on rejection --
// exactly the bug this whole change is about.
const showsSuccessToast = result => result === 'assigned';
const suppressesProfileSet = result => result === 'rejected';

// The reported bug: profile already on favourite 1, user long-presses favourite 3.
// assignProfile rejects and shows its own error toast -> must NOT report success.
{
    const favs = { 0: 'espresso', 1: null, 2: null, 3: null, 4: null };
    const r = assignProfile(favs, 2, 'espresso');
    assert.strictEqual(r.result, 'rejected', 'already-assigned profile must be rejected');
    assert.strictEqual(showsSuccessToast(r.result), false, 'rejection must not show a success toast');
    assert.strictEqual(suppressesProfileSet(r.result), true, "rejection must suppress the 'Profile Set' toast");
    assert.strictEqual(r.rejectedBy, 0, 'should report which slot holds it');
    assert.strictEqual(favs[2], null, 'rejected assign must not mutate the target slot');
}

// Pressing the button the profile is ALREADY on must report it too, naming that
// same button — staying silent there reads as "nothing happened".
{
    const favs = { 0: 'espresso', 1: null, 2: null, 3: null, 4: null };
    const r = assignProfile(favs, 0, 'espresso');
    assert.strictEqual(r.result, 'rejected', 'same-button re-assign must be reported, not silent');
    assert.strictEqual(r.rejectedBy, 0, 'must name the button that already holds it');
    assert.strictEqual(showsSuccessToast(r.result), false, 'must not show a success toast');
    assert.strictEqual(favs[0], 'espresso', 'slot keeps its profile');
}

// The real-world case: profile on favourite 5, user long-presses assign-fav-btn-4
// (which IS favourite 5). Must name favourite 5, not fall through silently.
{
    const favs = { 0: 'filter', 1: null, 2: null, 3: null, 4: 'ewan' };
    const r = assignProfile(favs, 4, 'ewan');
    assert.strictEqual(r.result, 'rejected');
    assert.strictEqual(r.rejectedBy + 1, 5, 'message must say favourite 5');
}

// A genuinely new assignment is the only case that reports success.
{
    const favs = { 0: 'espresso', 1: null, 2: null, 3: null, 4: null };
    const r = assignProfile(favs, 1, 'filter');
    assert.strictEqual(showsSuccessToast(r.result), true, 'new assignment must report success');
    assert.strictEqual(favs[1], 'filter');
}

// Overwriting an occupied slot with a different profile is also a real assignment.
{
    const favs = { 0: 'espresso', 1: 'filter', 2: null, 3: null, 4: null };
    const r = assignProfile(favs, 1, 'turbo');
    assert.strictEqual(showsSuccessToast(r.result), true, 'replacing a slot is a real assignment');
    assert.strictEqual(favs[1], 'turbo');
}

// Clearing a slot (null key) skips the rejection scan — a null key must never be
// treated as "already assigned" just because other slots are empty.
{
    const favs = { 0: 'espresso', 1: null, 2: null, 3: null, 4: null };
    assert.strictEqual(assignProfile(favs, 0, null).result, 'assigned', 'clearing a slot is allowed');
    assert.strictEqual(favs[0], null, 'slot cleared');
}

// Out-of-range index must never report success.
for (const bad of [-1, FAV_COUNT, 99]) {
    const favs = { 0: null, 1: null, 2: null, 3: null, 4: null };
    assert.strictEqual(showsSuccessToast(assignProfile(favs, bad, 'espresso').result), false, `index ${bad} must not assign`);
}

console.log('ok — assign favourite success reporting');
