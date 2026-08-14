import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/idb.js', import.meta.url), 'utf8');
const pick = (name) => {
    const match = source.match(new RegExp(`export function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}`));
    assert.ok(match);
    return match[0].replace('export ', '');
};

test('single IndexedDB writes settle only when their transaction settles', async () => {
    let transaction;
    let request;
    const db = {
        transaction() {
            request = {};
            const store = { put: () => request, delete: () => request, clear: () => request };
            transaction = { error: new Error('commit failed'), objectStore: () => store };
            return transaction;
        },
    };
    const functions = new Function(
        'db', 'logger', 'SETTINGS_STORE_NAME', 'SHOTS_STORE_NAME',
        `${['setSetting', 'addShot', 'deleteShot', 'clearShots'].map(pick).join('\n')}\nreturn { setSetting, addShot, deleteShot, clearShots };`,
    )(db, { info() {}, error() {} }, 'settings', 'shots');

    const operations = [
        () => functions.setSetting('theme', 'dark'),
        () => functions.addShot({ id: 'shot' }),
        () => functions.deleteShot('shot'),
        () => functions.clearShots(),
    ];
    for (const operate of operations) {
        let settled = false;
        const promise = operate().finally(() => { settled = true; });
        request.onsuccess?.({ target: request });
        await Promise.resolve();
        assert.equal(settled, false);
        transaction.oncomplete();
        await promise;
    }

    const aborted = functions.setSetting('theme', 'light');
    request.onsuccess?.({ target: request });
    assert.equal(typeof transaction.onabort, 'function');
    transaction.onabort({ target: transaction });
    await assert.rejects(aborted, (error) => error === 'Error setting key "theme"');
});
