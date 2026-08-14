import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldHandleMachineShortcut } from '../src/modules/machine-shortcut.js';

// Exact-token match: substring matching would make '[role="spinbutton"]' answer to 'button'.
const matchesToken = (query, selector) =>
    query.split(',').map((part) => part.trim()).includes(selector);

const keyboardEvent = (overrides = {}) => ({
    defaultPrevented: false,
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target: { closest: () => null },
    ...overrides,
});

test('machine shortcuts only handle unmodified main-page keystrokes away from controls', () => {
    assert.equal(shouldHandleMachineShortcut(keyboardEvent(), true, false), true);
    assert.equal(shouldHandleMachineShortcut(keyboardEvent(), false, false), false);
    assert.equal(shouldHandleMachineShortcut(keyboardEvent(), true, true), false);

    for (const property of ['defaultPrevented', 'repeat', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
        assert.equal(
            shouldHandleMachineShortcut(keyboardEvent({ [property]: true }), true, false),
            false,
            property
        );
    }

    for (const selector of ['dialog', 'input', 'select', 'textarea', '[contenteditable]',
        '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]', '[role="spinbutton"]']) {
        const target = { closest: (query) => matchesToken(query, selector) ? {} : null };
        assert.equal(shouldHandleMachineShortcut(keyboardEvent({ target }), true, false), false, selector);
    }
});

test('shortcuts survive focus on non-text controls', () => {
    // A tapped button keeps focus and every main-page element sits inside <main role="main">.
    // Matching either would leave w/f/e permanently dead, so neither may block.
    for (const selector of ['button', 'a[href]', 'summary', '[role="main"]', '[role="gridcell"]']) {
        const target = { closest: (query) => matchesToken(query, selector) ? {} : null };
        assert.equal(shouldHandleMachineShortcut(keyboardEvent({ target }), true, false), true, selector);
    }
});
