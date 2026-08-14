import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFirmwareCancellationError } from '../src/modules/firmware-progress.js';

function loadCancelHandler(apiCancel, button) {
    const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const body = source.match(/    window\.cancelFirmwareUpdate = async function\(\) \{[\s\S]*?\n    \};/)?.[0];
    assert.ok(body);
    const factory = new Function('document', 'getTranslation', 'cancelFirmwareUpdate', 'logger', 'ui', `
        let firmwareCancelRequested = false;
        const window = {};
        ${body}
        return { cancel: window.cancelFirmwareUpdate, requested: () => firmwareCancelRequested };
    `);
    return factory(
        { getElementById: () => button },
        value => value,
        apiCancel,
        { error() {} },
        { showToast() {} },
    );
}

test('a rejected cancel request restores retry state and clears cancel intent', async () => {
    const button = { disabled: false, textContent: 'Cancel' };
    const handler = loadCancelHandler(async () => { throw new Error('offline'); }, button);

    await handler.cancel();

    assert.equal(handler.requested(), false);
    assert.deepEqual(button, { disabled: false, textContent: 'Cancel' });
});

test('the terminal cancellation exception is recognized without cancel intent', () => {
    assert.equal(isFirmwareCancellationError(new Error('FirmwareUpdateCancelledException: cancelled')), true);
    assert.equal(isFirmwareCancellationError(new Error('CRC mismatch')), false);
});
