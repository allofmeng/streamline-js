import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBengleModel, isBengleMachine, setMachineModel, getMachineModel } from '../src/modules/machine.js';

test('isBengleModel: case-insensitive substring match on the model string', () => {
    assert.equal(isBengleModel('Bengle'), true);
    assert.equal(isBengleModel('Bengle 15A'), true);
    assert.equal(isBengleModel('bengle'), true);
    assert.equal(isBengleModel('DE1PRO'), false);
    assert.equal(isBengleModel('DE1XL'), false);
});

test('isBengleModel: null/undefined/empty/non-string are not Bengle', () => {
    assert.equal(isBengleModel(null), false);
    assert.equal(isBengleModel(undefined), false);
    assert.equal(isBengleModel(''), false);
    assert.equal(isBengleModel(0), false);
    assert.equal(isBengleModel({}), false);
});

test('shared gate tracks setMachineModel', () => {
    assert.equal(getMachineModel(), null);     // unknown at import
    assert.equal(isBengleMachine(), false);

    setMachineModel('Bengle');
    assert.equal(getMachineModel(), 'Bengle');
    assert.equal(isBengleMachine(), true);

    setMachineModel('DE1XXL');
    assert.equal(isBengleMachine(), false);

    setMachineModel(null);
    assert.equal(getMachineModel(), null);
    assert.equal(isBengleMachine(), false);
});
