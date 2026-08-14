import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const extract = (name, endMarker) => {
    const start = source.indexOf(`export function ${name}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end).replace('export ', '');
};

const countConnections = (name, state, endMarker) => {
    let connections = 0;
    const connect = new Function(
        'ReconnectingWebSocket',
        'WebSocket',
        'WS_PROTOCOL',
        'reaHostname',
        'REA_PORT',
        'logger',
        'isWakeLockEnabled',
        'enableWakeLock',
        `${state}\n${extract(name, endMarker)}\nreturn ${name};`,
    )(
        function ReconnectingWebSocket() {
            connections += 1;
            return { readyState: 0 };
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
        'ws:',
        'decaid',
        8080,
        { debug() {}, error() {}, info() {}, warn() {} },
        () => false,
        async () => {},
    );

    connect();
    connect();
    return connections;
};

test('shared WebSocket connectors reuse a socket while it is connecting', () => {
    assert.equal(countConnections(
        'connectDeviceWebSocket',
        `let deviceWebSocket = null;
        let lastDeviceData = null;
        let deviceLastErrorTimestamp = null;
        const deviceDataListeners = new Set();
        const deviceReconnectListeners = new Set();
        const deviceDisconnectListeners = new Set();
        const deviceErrorListeners = new Set();`,
        '/**\n * Send a command to the devices WebSocket channel',
    ), 1);
    assert.equal(countConnections(
        'connectDisplayWebSocket',
        `let displayWebSocket = null;
        let displayWebSocketReady = false;
        let lastDisplayState = null;
        const displayListeners = new Set();`,
        '/**\n * Send a command to the display WebSocket channel',
    ), 1);
    assert.equal(countConnections(
        'connectUpdateWebSocket',
        `let updateWebSocket = null;
        let updateWebSocketReady = false;`,
        '/**\n * Send a command to the app-update WebSocket channel.',
    ), 1);
});
