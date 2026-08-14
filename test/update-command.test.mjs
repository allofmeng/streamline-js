import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const apiStart = apiSource.indexOf('export function connectUpdateWebSocket');
const apiEnd = apiSource.indexOf('\n\n', apiSource.indexOf('\n}', apiSource.indexOf('export function sendUpdateCommand', apiStart)) + 2);
assert.notEqual(apiStart, -1);
assert.notEqual(apiEnd, -1);
const apiFunctions = apiSource.slice(apiStart, apiEnd).replaceAll('export ', '');

const loadApi = (socket) => new Function(
    'ReconnectingWebSocket',
    'WebSocket',
    'WS_PROTOCOL',
    'reaHostname',
    'REA_PORT',
    'logger',
    `let updateWebSocket = null;
    let updateWebSocketReady = false;
    ${apiFunctions}
    return { connectUpdateWebSocket, sendUpdateCommand };`,
)(
    function ReconnectingWebSocket() { return socket; },
    { OPEN: 1 },
    'ws:',
    'decaid',
    8080,
    { error() {}, info() {}, warn() {} },
);

test('the automatic update check waits for the socket to open', () => {
    let readyState = 0;
    let payload;
    const socket = {
        get readyState() { return readyState; },
        send(value) { payload = value; },
    };
    const { connectUpdateWebSocket, sendUpdateCommand } = loadApi(socket);
    const command = { command: 'check' };

    connectUpdateWebSocket(() => {}, () => sendUpdateCommand(command));
    assert.equal(payload, undefined);

    readyState = 1;
    socket.onopen();
    assert.equal(payload, JSON.stringify(command));
});

test('update commands reject an unavailable socket', () => {
    const api = loadApi({ readyState: 0 });
    api.connectUpdateWebSocket(() => {});
    assert.throws(
        () => api.sendUpdateCommand({ command: 'install' }),
        /Update WebSocket is not connected/,
    );
});

const settingsSource = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const settingsStart = settingsSource.indexOf('function initAppUpdateSection');
const settingsEnd = settingsSource.indexOf('\n\n// Render updates settings', settingsStart);
assert.notEqual(settingsStart, -1);
assert.notEqual(settingsEnd, -1);
const initSource = settingsSource.slice(settingsStart, settingsEnd);

test('update status flips when the check command goes out, not on a frame Decaid may skip', () => {
    const settingsCache = { appUpdateChecked: false, appUpdateState: null };
    const commands = [];
    const toasts = [];
    const window = {};
    let failSend = false;
    let onData;
    let onOpen;
    const connectUpdateWebSocket = (dataHandler, openHandler) => {
        onData = dataHandler;
        onOpen = openHandler;
    };
    const sendUpdateCommand = (command) => {
        if (failSend) throw new Error('Update WebSocket is not connected');
        commands.push(command);
    };
    const ui = { showToast: (...args) => toasts.push(args) };
    const document = { getElementById: () => null };
    const renderAppUpdateBlock = () => '';

    new Function(
        'window',
        'settingsCache',
        'sendUpdateCommand',
        'connectUpdateWebSocket',
        'ui',
        'document',
        'renderAppUpdateBlock',
        `${initSource}\ninitAppUpdateSection();`,
    )(window, settingsCache, sendUpdateCommand, connectUpdateWebSocket, ui, document, renderAppUpdateBlock);

    assert.deepEqual(commands, []);
    assert.equal(settingsCache.appUpdateChecked, false);

    onOpen();
    assert.deepEqual(commands, [{ command: 'check' }]);
    assert.equal(settingsCache.appUpdateChecked, true);

    // 'checking' is transient and a fast check can skip it entirely, going straight to a
    // terminal phase. The flag must already be set by then or the "Up to date" pill,
    // which is gated on it, would never render.
    onData({ phase: 'available' });
    assert.equal(settingsCache.appUpdateChecked, true);
    assert.deepEqual(settingsCache.appUpdateState, { phase: 'available' });

    // A send that never left must not claim a check happened.
    settingsCache.appUpdateChecked = false;
    failSend = true;
    window.checkAppUpdate();
    assert.equal(settingsCache.appUpdateChecked, false);
    toasts.length = 0;


    window.installAppUpdate();
    assert.deepEqual(toasts, [['Update WebSocket is not connected', 5000, 'error']]);
});
