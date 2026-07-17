// Close-before-open.
//
// app.js re-opens the machine-bound sockets after a power-cycle so reaprime
// re-binds them to the NEW De1 instance. connectWebSocket, connectShotSettingsWeb-
// Socket and the waterLevels socket did not close the old socket first (the
// waterLevels one did not even keep a handle), so a resync would have leaked a
// socket per power-cycle and double-delivered every frame — a doubled snapshot
// frame rate is the tell to watch for on the bench.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSocketSlot, silenceSocket } from '../src/modules/socket-slot.js';

// Stand-in for ReconnectingWebSocket, recording lifecycle order in a shared log.
function fakeSocketFactory(log, name) {
    return () => {
        const socket = {
            name,
            closed: false,
            onopen: () => log.push(`${name}:onopen-handler`),
            onmessage: () => log.push(`${name}:onmessage-handler`),
            onclose: () => log.push(`${name}:onclose-handler`),
            onerror: () => log.push(`${name}:onerror-handler`),
            close() {
                this.closed = true;
                log.push(`${name}:close`);
                // RWS dispatches to the instance handler on close. A discarded
                // socket must not be able to reach the app through it.
                this.onclose();
            },
        };
        log.push(`${name}:open`);
        return socket;
    };
}

test('the old socket is CLOSED BEFORE the new one is opened', () => {
    const log = [];
    const slot = createSocketSlot('machine snapshot');

    const first = slot.replace(fakeSocketFactory(log, 'a'));
    const second = slot.replace(fakeSocketFactory(log, 'b'));

    assert.deepEqual(
        log.filter((e) => e.endsWith(':open') || e.endsWith(':close')),
        ['a:open', 'a:close', 'b:open'],
        'close must precede the re-open, or the resync leaks a socket'
    );
    assert.equal(first.closed, true);
    assert.equal(second.closed, false);
    assert.equal(slot.current(), second);
});

test('a discarded socket cannot talk to the app on its way out', () => {
    // connectWebSocket's onclose paints "Disconnected". The close is OURS, not the
    // machine's, so a resync must not flash a spurious disconnect at the user.
    const log = [];
    const slot = createSocketSlot('machine snapshot');

    const first = slot.replace(fakeSocketFactory(log, 'a'));
    slot.replace(fakeSocketFactory(log, 'b'));

    assert.equal(
        log.some((e) => e.includes('handler')),
        false,
        'no handler on the discarded socket may fire'
    );

    // And the surviving no-ops must be callable: RWS calls self.onclose(event)
    // unconditionally, so nulling them out would throw instead.
    assert.equal(typeof first.onclose, 'function');
    assert.doesNotThrow(() => {
        first.onopen();
        first.onmessage({});
        first.onclose({});
        first.onerror(new Error('x'));
    });
});

test('the first open closes nothing', () => {
    const log = [];
    const slot = createSocketSlot('shot settings');

    assert.equal(slot.current(), null);
    const only = slot.replace(fakeSocketFactory(log, 'a'));

    assert.deepEqual(log, ['a:open']);
    assert.equal(slot.current(), only);
});

test('repeated resyncs keep exactly one live socket (no leak per power-cycle)', () => {
    const log = [];
    const slot = createSocketSlot('water level');
    const sockets = [];

    for (let i = 0; i < 4; i++) {
        sockets.push(slot.replace(fakeSocketFactory(log, `s${i}`)));
    }

    const live = sockets.filter((s) => !s.closed);
    assert.equal(live.length, 1, 'exactly one socket may be live after N resyncs');
    assert.equal(live[0], slot.current());
    assert.equal(log.filter((e) => e.endsWith(':close')).length, 3);
});

test('a socket that throws on close does not block the re-open', () => {
    // Being stuck with no live socket is the very bug we are fixing — a stubborn
    // close must never cost us the reconnect.
    const slot = createSocketSlot('machine snapshot');

    slot.replace(() => ({
        close() { throw new Error('already closing'); },
    }));

    let opened = null;
    assert.doesNotThrow(() => {
        opened = slot.replace(() => ({ name: 'fresh', close() {} }));
    });
    assert.equal(slot.current(), opened);
    assert.equal(opened.name, 'fresh');
});

test('silenceSocket is null-safe and replaces every handler with a no-op', () => {
    assert.equal(silenceSocket(null), null);
    assert.equal(silenceSocket(undefined), undefined);

    let fired = 0;
    const socket = {
        onopen: () => fired++,
        onmessage: () => fired++,
        onclose: () => fired++,
        onerror: () => fired++,
        onconnecting: () => fired++,
    };

    silenceSocket(socket);
    socket.onopen();
    socket.onmessage();
    socket.onclose();
    socket.onerror();
    socket.onconnecting();

    assert.equal(fired, 0);
});
