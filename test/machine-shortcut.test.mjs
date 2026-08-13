import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldHandleMachineShortcut } from '../src/modules/machine-shortcut.js';

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

    for (const selector of ['a[href]', 'button', 'dialog', 'input', 'select', 'summary', 'textarea', '[contenteditable]', '[role]']) {
        const target = { closest: (query) => query.includes(selector) ? {} : null };
        assert.equal(shouldHandleMachineShortcut(keyboardEvent({ target }), true, false), false, selector);
    }
});
