import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    celsiusToFahrenheit,
    fahrenheitToCelsius,
    formatTemp,
    fromDisplayTemp,
    displayStepToCelsius,
    boundToDisplay,
} from '../src/modules/units.js';

test('celsiusToFahrenheit: known reference points', () => {
    assert.equal(celsiusToFahrenheit(0), 32);
    assert.equal(celsiusToFahrenheit(100), 212);
    assert.equal(celsiusToFahrenheit(-40), -40);
});

test('fahrenheitToCelsius: inverts celsiusToFahrenheit', () => {
    for (const c of [0, 20, 93.5, 100, -40]) {
        assert.ok(Math.abs(fahrenheitToCelsius(celsiusToFahrenheit(c)) - c) < 1e-9);
    }
});

test('formatTemp: defaults to Celsius with the configured precision', () => {
    assert.equal(formatTemp(93.25, 1), '93.3°c');
    assert.equal(formatTemp(93.25, 0), '93°c');
});

test('formatTemp: non-finite input renders a placeholder, never a fake reading', () => {
    assert.equal(formatTemp(NaN), '-');
    assert.equal(formatTemp(undefined), '-');
    assert.equal(formatTemp(Infinity), '-');
});

// fromDisplayTemp / displayStepToCelsius / boundToDisplay all branch on the
// current unit preference, which lives behind setTempUnit() (touches
// localStorage/document — unavailable in this DOM-free harness). Only the
// default Celsius identity branch is exercisable here; the Fahrenheit branch
// is covered indirectly via celsiusToFahrenheit/fahrenheitToCelsius above,
// which every branch delegates to.

test('fromDisplayTemp: Celsius default is the identity function', () => {
    assert.equal(fromDisplayTemp(93), 93);
    assert.equal(fromDisplayTemp(0), 0);
});

test('displayStepToCelsius: Celsius default passes the step through unchanged', () => {
    assert.equal(displayStepToCelsius(1), 1);
    assert.equal(displayStepToCelsius(5), 5);
});

test('boundToDisplay: Celsius default rounds to the nearest whole degree', () => {
    assert.equal(boundToDisplay(93), 93);
    assert.equal(boundToDisplay(93.4), 93);
    assert.equal(boundToDisplay(93.5), 94);
});
