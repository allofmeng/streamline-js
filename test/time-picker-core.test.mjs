import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTime24,
    formatTime24,
    to12h,
    to24h,
    snapMinute,
    hourHandAngle,
    minuteHandAngle,
} from '../src/modules/time-picker-core.js';

test('parseTime24 parses valid HH:MM', () => {
    assert.deepEqual(parseTime24('06:30'), { h24: 6, m: 30 });
    assert.deepEqual(parseTime24('00:00'), { h24: 0, m: 0 });
    assert.deepEqual(parseTime24('23:59'), { h24: 23, m: 59 });
    assert.deepEqual(parseTime24('9:05'), { h24: 9, m: 5 });
});

test('parseTime24 falls back on empty / garbage / out-of-range', () => {
    assert.deepEqual(parseTime24(''), { h24: 7, m: 0 });
    assert.deepEqual(parseTime24('nope'), { h24: 7, m: 0 });
    assert.deepEqual(parseTime24('24:00'), { h24: 7, m: 0 });
    assert.deepEqual(parseTime24('12:60'), { h24: 7, m: 0 });
    assert.deepEqual(parseTime24(null), { h24: 7, m: 0 });
    assert.deepEqual(parseTime24(undefined), { h24: 7, m: 0 });
});

test('parseTime24 honours a caller fallback', () => {
    assert.deepEqual(parseTime24('', { h24: 8, m: 15 }), { h24: 8, m: 15 });
});

test('formatTime24 zero-pads and clamps', () => {
    assert.equal(formatTime24(6, 30), '06:30');
    assert.equal(formatTime24(0, 0), '00:00');
    assert.equal(formatTime24(23, 59), '23:59');
    assert.equal(formatTime24(99, 99), '23:59'); // clamped
});

test('to12h anchors', () => {
    assert.deepEqual(to12h(0), { h12: 12, ampm: 'AM' });
    assert.deepEqual(to12h(11), { h12: 11, ampm: 'AM' });
    assert.deepEqual(to12h(12), { h12: 12, ampm: 'PM' });
    assert.deepEqual(to12h(13), { h12: 1, ampm: 'PM' });
    assert.deepEqual(to12h(23), { h12: 11, ampm: 'PM' });
});

test('to24h inverts to12h across the whole day', () => {
    for (let h = 0; h < 24; h++) {
        const { h12, ampm } = to12h(h);
        assert.equal(to24h(h12, ampm), h, `hour ${h} did not round-trip`);
    }
});

test('parse -> to12h -> to24h -> format is a full round-trip', () => {
    for (const s of ['00:00', '07:00', '09:05', '12:00', '13:30', '23:59']) {
        const { h24, m } = parseTime24(s);
        const { h12, ampm } = to12h(h24);
        assert.equal(formatTime24(to24h(h12, ampm), m), s, `${s} did not round-trip`);
    }
});

test('snapMinute snaps to the nearest 5 and wraps 60 to 0', () => {
    assert.equal(snapMinute(0), 0);
    assert.equal(snapMinute(2), 0);
    assert.equal(snapMinute(3), 5);
    assert.equal(snapMinute(37), 35);
    assert.equal(snapMinute(58), 0); // 60 -> 0
});

test('hand angles anchor at the cardinal clock points', () => {
    assert.equal(hourHandAngle(12), -90); // straight up
    assert.equal(hourHandAngle(3), 0); // right
    assert.equal(hourHandAngle(6), 90); // down
    assert.equal(hourHandAngle(9), 180); // left
    assert.equal(minuteHandAngle(0), -90);
    assert.equal(minuteHandAngle(15), 0);
    assert.equal(minuteHandAngle(30), 90);
    assert.equal(minuteHandAngle(45), 180);
});
