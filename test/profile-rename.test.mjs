import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/profileManager.js', import.meta.url), 'utf8');
const match = source.match(/export async function renameProfile\(profileId, newTitle\) \{[\s\S]*?\r?\n\}/);
assert.ok(match);

test('renaming an imported profile sends only the profile payload', async () => {
    const record = { id: 'imported', visibility: 'visible', profile: { title: 'Original', steps: [] } };
    const availableProfiles = { imported: JSON.parse(JSON.stringify(record)) };
    let saved;
    const renameProfile = new Function(
        'getProfiles', 'updateProfile', 'setSetting', 'logger', 'availableProfiles', 'PROFILES_CACHE_KEY',
        `${match[0].replace('export ', '')}\nreturn renameProfile;`,
    )(
        async () => [record],
        async (id, profile) => { saved = { id, profile }; },
        async () => {},
        { info() {}, error() {} },
        availableProfiles,
        'available-profiles-cache',
    );

    await renameProfile('imported', 'Original (1)');

    assert.equal(saved.id, 'imported');
    assert.deepEqual(saved.profile, { title: 'Original (1)', steps: [] });
    assert.equal(availableProfiles.imported.profile.title, 'Original (1)');
});
