# Streamline test harness

Minimal `node:test` harness — **no dependencies, no DOM, no bundler**. Run it with:

```
npm test        # = node --test test/
```

## What belongs here

**Pure functions only.** This skin is a browser SPA; most modules (`api.js`,
`app.js`, `ui.js`, `chart.js`, …) touch `window` / `document` / `localStorage`
at import time or immediately after, so they cannot be imported into Node and
we do not try (no jsdom, ever). What we *do* test is the pure logic: parsing,
scaling/autoscale math, colour conversions, mode/label resolvers, version and
manifest invariants.

## The pattern to follow

1. **Put pure helpers in DOM-free modules** (or extract them into one). A
   module is testable iff importing it touches no browser global. Example:
   `src/modules/machine.js`. If the helper you want to test lives inside a
   DOM-coupled module, extract the pure part into its own module and import it
   from both places — do not import the DOM-coupled module here.
2. **Name test files `test/<topic>.test.mjs`.** The `.mjs` extension makes
   Node treat the test itself as an ES module; the sources under `src/` are
   declared ESM by `src/package.json` (`{"type": "module"}`) so they can be
   imported directly by relative path. (That marker file is inert for the
   browser and for the Tailwind build.)
3. **Use `node:test` + `node:assert/strict`** — see `version.test.mjs` for the
   shape. No test framework, no new devDependencies.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBengleModel } from '../src/modules/machine.js';

test('model gate is a case-insensitive substring match', () => {
    assert.equal(isBengleModel('Bengle 15A'), true);
});
```

Planned coverage as the Bengle pages land: chart expanded-view autoscale
(`niceCeil`, temp-band maths), LED 16-bit↔8-bit colour maps, steam-mode
resolvers, the Bengle model gate.
