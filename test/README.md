# Streamline test harness

Minimal `node:test` harness -- **no dependencies, no DOM, no bundler**. Run it:

```
npm test        # = node --test test/
```

## What belongs here

**Pure functions only.** This skin is a browser SPA; most modules (`api.js`,
`app.js`, `ui.js`, `chart.js`, ...) touch `window` / `document` / `localStorage`
at import time, so they cannot be imported into Node and we do not try (no
jsdom). What we *do* test is the pure logic: parsing, formatting, and the small
maths behind the widgets.

## The pattern to follow

1. **Put pure helpers in DOM-free modules.** A module is testable iff importing
   it touches no browser global. Example: `src/modules/time-picker-core.js`. If
   the helper lives inside a DOM-coupled module, extract the pure part into its
   own module and import it from both places -- do not import the DOM-coupled
   module here.
2. **Name test files `test/<topic>.test.mjs`.** The `.mjs` extension makes Node
   treat the test as an ES module; sources under `src/` are declared ESM by
   `src/package.json` (`{"type": "module"}`) so they import by relative path.
   That marker file is inert for the browser and the Tailwind build.
3. **Use `node:test` + `node:assert/strict`.** No test framework, no new
   devDependencies.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime24 } from '../src/modules/time-picker-core.js';

test('parseTime24 reads HH:MM', () => {
    assert.deepEqual(parseTime24('06:30'), { h24: 6, m: 30 });
});
```
