import test from 'node:test';
import assert from 'node:assert/strict';
import {
    readTimeToReadyFrame,
    heatingSecondsLeft,
    TTR_STALE_MS,
    TTR_CAP_S,
} from '../src/modules/heating-countdown.js';

const NOW = 1_700_000_000_000;

test('a heating frame becomes an absolute deadline', () => {
    assert.deepEqual(
        readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW),
        { deadline: NOW + 42_000, at: NOW },
    );
});

test('non-heating and zero-remaining frames carry no estimate', () => {
    for (const frame of [
        { status: 'reached', remainingTimeMs: 0 },
        { status: 'heating', remainingTimeMs: 0 },
        { status: 'idle' },
        undefined,
    ]) {
        assert.equal(readTimeToReadyFrame(frame, NOW), null);
    }
});

test('countdown ticks down between ttr frames instead of freezing', () => {
    const est = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW);
    assert.equal(heatingSecondsLeft(est, NOW), 42);
    assert.equal(heatingSecondsLeft(est, NOW + 3_000), 39);
});

test('estimate is capped at 5 minutes and only moves once the real one drops under it', () => {
    // As the socket does it: a fresh frame roughly every second.
    const frameAt = (elapsedMs, remainingMs) =>
        heatingSecondsLeft(readTimeToReadyFrame({ status: 'heating', remainingTimeMs: remainingMs }, NOW + elapsedMs), NOW + elapsedMs);

    assert.equal(frameAt(0, 20 * 60_000), TTR_CAP_S);          // 20 min out -> 300s
    assert.equal(frameAt(60_000, 19 * 60_000), TTR_CAP_S);     // 19 min out -> still 300s
    assert.equal(frameAt(19 * 60_000, 60_000), 60);            // under the cap -> real value
});

test('a stale estimate is dropped rather than counted down', () => {
    const est = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW);
    assert.equal(heatingSecondsLeft(est, NOW + TTR_STALE_MS), 42 - TTR_STALE_MS / 1000);
    assert.equal(heatingSecondsLeft(est, NOW + TTR_STALE_MS + 1), 0);
});

test('no estimate, or one whose deadline has passed, reads as 0 (plain "Heating")', () => {
    assert.equal(heatingSecondsLeft(null, NOW), 0);
    const est = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 1_000 }, NOW);
    assert.equal(heatingSecondsLeft(est, NOW + 4_000), 0);
});
