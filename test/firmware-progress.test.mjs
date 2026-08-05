import test from 'node:test';
import assert from 'node:assert/strict';
import {
    splitNdjson,
    normalizeFirmwareEvent,
    advanceFirmwareState,
    initialFirmwareState,
} from '../src/modules/firmware-progress.js';

/** Feed a stream of decoded chunks through framing + folding, as api.js does. */
function runStream(chunks) {
    let buffer = '';
    let state = initialFirmwareState;
    const seen = [];
    chunks.forEach((chunk, i) => {
        const atEnd = i === chunks.length - 1;
        const { events, rest } = splitNdjson(buffer, chunk, atEnd);
        buffer = rest;
        for (const event of events) {
            state = advanceFirmwareState(state, event);
            seen.push({ ...state });
        }
    });
    return { state, seen };
}

test('lines split across chunk boundaries are reassembled', () => {
    const { seen } = runStream([
        '{"event":"erasing"}\n{"event":"upl',
        'oading","progress":0.5}\n',
        '{"event":"done"}\n',
    ]);
    assert.deepEqual(seen.map(s => s.phase), ['erasing', 'uploading', 'done']);
    assert.deepEqual(seen.map(s => s.percent), [0, 50, 100]);
});

test('a final line without a trailing newline is still parsed', () => {
    const { state } = runStream(['{"event":"erasing"}\n{"event":"done"}']);
    assert.equal(state.phase, 'done');
});

test('blank and malformed lines are skipped, not thrown', () => {
    const { events } = splitNdjson('', '\n{"event":"erasing"}\n{oops\n\n', false);
    assert.deepEqual(events, [{ event: 'erasing' }]);
});

test('phase key is read defensively across spellings', () => {
    for (const event of [{ event: 'uploading' }, { phase: 'uploading' }, { status: 'uploading' }, { state: 'uploading' }]) {
        assert.equal(normalizeFirmwareEvent(event).phase, 'uploading');
    }
    assert.equal(normalizeFirmwareEvent({ event: 'something-else' }).phase, null);
    assert.equal(normalizeFirmwareEvent(null).phase, null);
});

test('the -1.0 error sentinel is not treated as a percentage', () => {
    assert.equal(normalizeFirmwareEvent({ event: 'error', progress: -1.0 }).progress, null);

    const state = advanceFirmwareState({ phase: 'uploading', percent: 98, error: null },
        { event: 'error', progress: -1.0, message: 'CRC mismatch' });
    assert.equal(state.phase, 'error');
    assert.equal(state.error, 'CRC mismatch');
    assert.equal(state.percent, 98); // held, not rewound to 0 or -100
});

test('percent holds through the silent verification phase', () => {
    // Last uploading event can report 1.0 before CRC verification even starts.
    const { seen, state } = runStream([
        '{"event":"erasing"}\n{"event":"uploading","progress":0.99}\n{"event":"uploading","progress":1.0}\n{"event":"done"}\n',
    ]);
    assert.deepEqual(seen.map(s => s.percent), [0, 99, 100, 100]);
    assert.equal(state.phase, 'done');
});

test('unrecognised events leave the state untouched', () => {
    const before = { phase: 'uploading', percent: 42, error: null };
    assert.deepEqual(advanceFirmwareState(before, { hello: 'world' }), before);
});
