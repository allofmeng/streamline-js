// The skin showed "disconnected" forever after a machine power-cycle.
//
// reaprime keeps /ws/v1/machine/snapshot bound to a dead De1 instance and never
// closes it, so the socket goes open-but-silent and ReconnectingWebSocket (which
// only retries on *close*) never heals. The surviving /ws/v1/devices feed is the
// authority, and it must be read EDGE-TRIGGERED: the USB device id is identical
// before and after a power-cycle, so id-diffing would never fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { machineFromDevicesPayload, createMachineLinkWatcher } from '../src/modules/machine-link.js';

// A USB machine id — derived from the controller's factory unique id, so it is
// identical across a power-cycle, which is the whole reason this is edge-triggered.
const MACHINE_ID = 'usb-2e8a-a-8549628789ABCDEF';

const devicesWsPayload = (devices, extra = {}) => ({
    timestamp: '2026-07-14T15:55:00.000Z',
    devices,
    scanning: false,
    ...extra,
});

const machine = (state, id = MACHINE_ID) => ({ name: 'DE1', id, state, type: 'machine' });
const scale = (state = 'connected') => ({ name: 'Felicita', id: 'ble-scale-1', state, type: 'scale' });

// --- machineFromDevicesPayload -------------------------------------------------

test('reads a connected machine out of the /ws/v1/devices payload', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([scale(), machine('connected')]));
    assert.deepEqual(link, { known: true, connected: true, deviceId: MACHINE_ID });
});

test('accepts the bare array shape returned by GET /api/v1/devices', () => {
    // The staleness probe (app.js resetDataTimeout) feeds it the REST response,
    // which is a bare array rather than a {devices: [...]} envelope.
    const link = machineFromDevicesPayload([machine('connected')]);
    assert.deepEqual(link, { known: true, connected: true, deviceId: MACHINE_ID });
});

test('a machine that is present but not connected is not a link', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([machine('disconnected')]));
    assert.deepEqual(link, { known: true, connected: false, deviceId: null });
});

test('a connected scale is not a machine', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([scale('connected')]));
    assert.equal(link.known, true);
    assert.equal(link.connected, false);
});

test('picks the first CONNECTED machine when several are listed', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([
        machine('disconnected', 'usb-ghost'),
        machine('connected', 'usb-real'),
        machine('connected', 'usb-other'),
    ]));
    assert.equal(link.deviceId, 'usb-real');
});

test('an empty device list is KNOWN-and-not-connected (the machine really is gone)', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([]));
    assert.deepEqual(link, { known: true, connected: false, deviceId: null });
});

test('a malformed payload is UNKNOWN — it must not be read as "disconnected"', () => {
    // Critical distinction: a partial frame tells us nothing. Treating it as a
    // disconnect would fire a spurious down/up pair and resync the sockets for no
    // reason on every junk frame.
    for (const bad of [null, undefined, {}, { devices: null }, { devices: 'nope' }, 42, 'x']) {
        const link = machineFromDevicesPayload(bad);
        assert.equal(link.known, false, `expected unknown for ${JSON.stringify(bad)}`);
        assert.equal(link.connected, false);
    }
});

test('tolerates null / malformed entries inside a valid device list', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([null, undefined, {}, machine('connected')]));
    assert.equal(link.connected, true);
    assert.equal(link.deviceId, MACHINE_ID);
});

test('a connected machine with no id still counts as connected', () => {
    const link = machineFromDevicesPayload(devicesWsPayload([{ type: 'machine', state: 'connected' }]));
    assert.deepEqual(link, { known: true, connected: true, deviceId: null });
});

// --- createMachineLinkWatcher: edge semantics ---------------------------------

function trackedWatcher() {
    const events = [];
    const watcher = createMachineLinkWatcher({
        onLinkUp: (id) => events.push({ type: 'up', id }),
        onLinkDown: () => events.push({ type: 'down' }),
    });
    return { watcher, events };
}

test('THE BUG: connected -> disconnected -> connected fires down then up, with the SAME id', () => {
    const { watcher, events } = trackedWatcher();

    // Baseline: the skin is running, machine connected, sockets bound.
    watcher.update(devicesWsPayload([machine('connected')]));
    assert.deepEqual(events, [], 'the first payload is a baseline, not an edge');
    assert.equal(watcher.isConnected(), true);

    // Ben pulls the power.
    watcher.update(devicesWsPayload([machine('disconnected')]));
    assert.deepEqual(events, [{ type: 'down' }]);
    assert.equal(watcher.isConnected(), false);

    // reaprime rescans and re-enumerates it — under a BYTE-IDENTICAL id.
    watcher.update(devicesWsPayload([machine('connected')]));
    assert.deepEqual(events, [{ type: 'down' }, { type: 'up', id: MACHINE_ID }]);
    assert.equal(watcher.isConnected(), true);
    assert.equal(watcher.getDeviceId(), MACHINE_ID);

    // The id never changed. An id-diffing fix would have fired nothing at all.
});

test('repeated identical payloads do not re-fire (the aggregator re-emits constantly)', () => {
    const { watcher, events } = trackedWatcher();

    watcher.update(devicesWsPayload([machine('disconnected')])); // baseline: down
    watcher.update(devicesWsPayload([machine('connected')]));    // edge: up
    assert.equal(events.length, 1);

    // Scale battery ticks, scanning flips, etc. — same machine state each time.
    for (let i = 0; i < 5; i++) {
        watcher.update(devicesWsPayload([scale(), machine('connected')], { scanning: i % 2 === 0 }));
    }
    assert.equal(events.length, 1, 'no edge, no event');

    for (let i = 0; i < 3; i++) {
        watcher.update(devicesWsPayload([machine('disconnected')]));
    }
    assert.deepEqual(events.map((e) => e.type), ['up', 'down'], 'the down edge fires exactly once');
});

test('a genuinely different machine id re-fires link-up (defensive)', () => {
    const { watcher, events } = trackedWatcher();

    watcher.update(devicesWsPayload([machine('connected', 'usb-a')])); // baseline
    watcher.update(devicesWsPayload([machine('connected', 'usb-b')]));

    assert.deepEqual(events, [{ type: 'up', id: 'usb-b' }]);
    assert.equal(watcher.getDeviceId(), 'usb-b');
});

test('boot with the machine absent: the machine appearing is an up edge', () => {
    const { watcher, events } = trackedWatcher();

    watcher.update(devicesWsPayload([]));                       // baseline: nothing there
    assert.deepEqual(events, []);

    watcher.update(devicesWsPayload([machine('connected')]));   // it turns up
    assert.deepEqual(events, [{ type: 'up', id: MACHINE_ID }]);
});

test('malformed frames are inert: no edge, no baseline, no state change', () => {
    const { watcher, events } = trackedWatcher();

    assert.equal(watcher.update({ nonsense: true }), false);
    assert.equal(watcher.hasBaseline(), false, 'junk must not establish a baseline');

    assert.equal(watcher.update(devicesWsPayload([machine('connected')])), true);
    assert.equal(watcher.hasBaseline(), true);

    // A junk frame arriving mid-stream must not look like a disconnect.
    watcher.update(null);
    watcher.update({ devices: 'garbage' });
    assert.deepEqual(events, []);
    assert.equal(watcher.isConnected(), true);
});

test('the watcher survives having no callbacks at all', () => {
    const watcher = createMachineLinkWatcher();
    watcher.update(devicesWsPayload([machine('connected')]));
    watcher.update(devicesWsPayload([]));
    assert.equal(watcher.isConnected(), false);
});

test('reset() drops the baseline so the next payload re-seeds without firing', () => {
    const { watcher, events } = trackedWatcher();

    watcher.update(devicesWsPayload([machine('connected')]));
    watcher.reset();
    assert.equal(watcher.hasBaseline(), false);

    watcher.update(devicesWsPayload([]));
    assert.deepEqual(events, [], 're-seeding is not an edge');
});
