import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APP_VERSION, SKIN_ID } from '../src/version.js';

const manifestPath = fileURLToPath(new URL('../skin-manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('skin id is "streamline.js" everywhere (reaprime keys the install dir on it)', () => {
    assert.equal(SKIN_ID, 'streamline.js');
    assert.equal(manifest.id, 'streamline.js');
});

test('baked APP_VERSION looks like a version string', () => {
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
});

test('manifest version looks like a version string', () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
});
