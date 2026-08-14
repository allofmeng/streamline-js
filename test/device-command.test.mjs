import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const match = source.match(/export function sendDeviceCommand\(command\) \{[\s\S]*?\r?\n\}/);
assert.ok(match);
const functionSource = match[0].replace('export ', '');

const loadSendDeviceCommand = (deviceWebSocket) => new Function(
    'deviceWebSocket',
    'WebSocket',
    'logger',
    `${functionSource}\nreturn sendDeviceCommand;`,
)(deviceWebSocket, { OPEN: 1 }, { error() {}, info() {} });

test('device commands reject an unavailable socket and send through an open socket', () => {
    const command = { command: 'scan', connect: true };
    assert.throws(
        () => loadSendDeviceCommand(null)(command),
        /Device WebSocket is not connected/,
    );

    let payload;
    loadSendDeviceCommand({
        readyState: 1,
        send: (value) => { payload = value; },
    })(command);
    assert.equal(payload, JSON.stringify(command));
});
