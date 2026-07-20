import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    clampCalWeight,
    buildCalibrateBody,
    calResponseHasBody,
    calActionState,
    CAL_WEIGHT_MIN_G,
    CAL_WEIGHT_MAX_G,
    CAL_WEIGHT_DEFAULT_G,
} from '../src/modules/loadcell-cal.js';

// --- reference-mass clamp (wizard invariant: integer 1–10000 g) ------------

test('weight bounds are 1–10000 g with a 500 g default', () => {
    assert.equal(CAL_WEIGHT_MIN_G, 1);
    assert.equal(CAL_WEIGHT_MAX_G, 10000);
    assert.equal(CAL_WEIGHT_DEFAULT_G, 500);
});

test('clampCalWeight: in-range integers pass through', () => {
    assert.equal(clampCalWeight(500), 500);
    assert.equal(clampCalWeight(1), 1);
    assert.equal(clampCalWeight(10000), 10000);
});

test('clampCalWeight: rounds to whole grams', () => {
    assert.equal(clampCalWeight(500.4), 500);
    assert.equal(clampCalWeight(500.5), 501);
    assert.equal(clampCalWeight('499.9'), 500);
});

test('clampCalWeight: clamps out-of-range values', () => {
    assert.equal(clampCalWeight(0), 1);
    assert.equal(clampCalWeight(-5), 1);
    assert.equal(clampCalWeight(10001), 10000);
    assert.equal(clampCalWeight(99999), 10000);
});

test('clampCalWeight: numeric strings parse (numpad change events)', () => {
    assert.equal(clampCalWeight('750'), 750);
    assert.equal(clampCalWeight('750g'), 750); // parseFloat semantics
});

test('clampCalWeight: unparseable input returns null (caller keeps old mass)', () => {
    assert.equal(clampCalWeight(''), null);
    assert.equal(clampCalWeight('abc'), null);
    assert.equal(clampCalWeight(null), null);
    assert.equal(clampCalWeight(undefined), null);
    assert.equal(clampCalWeight(NaN), null);
});

// --- request-body wire shape ------------------------------------------------

test('buildCalibrateBody: zero and abort carry no grams key', () => {
    assert.deepEqual(buildCalibrateBody('zero'), { command: 'zero' });
    assert.deepEqual(buildCalibrateBody('abort'), { command: 'abort' });
    assert.equal('grams' in buildCalibrateBody('zero', undefined), false);
    assert.equal('grams' in buildCalibrateBody('zero', null), false);
});

test('buildCalibrateBody: left/right attach the reference mass', () => {
    assert.deepEqual(buildCalibrateBody('left', 500), { command: 'left', grams: 500 });
    assert.deepEqual(buildCalibrateBody('right', 500), { command: 'right', grams: 500 });
});

test('calResponseHasBody: abort is 202 with no body, everything else parses JSON', () => {
    assert.equal(calResponseHasBody('abort'), false);
    assert.equal(calResponseHasBody('zero'), true);
    assert.equal(calResponseHasBody('left'), true);
    assert.equal(calResponseHasBody('right'), true);
});

// --- action-area state map (stable no-jump card) -----------------------------

const base = { runLabel: 'Calibrate LEFT', busyLabel: 'Calibrating… (~15s)' };

test('calActionState: idle runs the step with the primary button', () => {
    const st = calActionState({ ...base, busy: false, error: '', done: false });
    assert.deepEqual(st, {
        status: 'idle', statusText: '', label: 'Calibrate LEFT', action: 'run', primary: true,
    });
});

test('calActionState: busy swaps the button to Cancel (abort escape hatch)', () => {
    const st = calActionState({ ...base, busy: true, error: '', done: false });
    assert.deepEqual(st, {
        status: 'busy', statusText: 'Calibrating… (~15s)', label: 'Cancel', action: 'cancel', primary: false,
    });
});

test('calActionState: error keeps the run button so the step can be retried', () => {
    const st = calActionState({ ...base, busy: false, error: 'firmware reported error', done: false });
    assert.deepEqual(st, {
        status: 'error', statusText: 'firmware reported error', label: 'Calibrate LEFT', action: 'run', primary: true,
    });
});

test('calActionState: done gates progression behind Next', () => {
    const st = calActionState({ ...base, busy: false, error: '', done: true });
    assert.deepEqual(st, {
        status: 'done', statusText: '', label: 'Next', action: 'next', primary: true,
    });
});

test('calActionState: done wins over busy and error (a passed step always offers Next)', () => {
    assert.equal(calActionState({ ...base, busy: true, error: '', done: true }).action, 'next');
    assert.equal(calActionState({ ...base, busy: false, error: 'stale', done: true }).action, 'next');
});
