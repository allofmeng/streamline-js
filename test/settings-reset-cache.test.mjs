import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const pick = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match);
    return match[0].replace('export ', '');
};
const cacheSource = [
    pick(/(?:const|let) de1SettingsCache = \{[\s\S]*?\r?\n\};/),
    pick(/(?:const|let) de1AdvancedSettingsCache = \{[\s\S]*?\r?\n\};/),
].join('\n');
const functionSource = [
    pick(/export async function getDe1Settings\(\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function getDe1AdvancedSettings\(\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function resetDe1Settings\(\) \{[\s\S]*?\r?\n\}/),
].join('\n');

test('resetting machine settings invalidates both read caches', async () => {
    let reset = false;
    const calls = [];
    const fetch = async (url, options = {}) => {
        calls.push([url, options.method || 'GET']);
        if (options.method === 'DELETE') reset = true;
        const advanced = url.endsWith('/advanced');
        return { ok: true, json: async () => ({ value: reset ? 'default' : advanced ? 'advanced-old' : 'old' }) };
    };
    const { getDe1Settings, getDe1AdvancedSettings, resetDe1Settings } = new Function(
        'fetch', 'logger', 'API_BASE_URL', 'firmwareFlashInFlight',
        `${cacheSource}\n${functionSource}\nreturn { getDe1Settings, getDe1AdvancedSettings, resetDe1Settings };`,
    )(fetch, { info() {}, error() {} }, 'http://decaid/api/v1', false);

    assert.equal((await getDe1Settings()).value, 'old');
    assert.equal((await getDe1AdvancedSettings()).value, 'advanced-old');
    await resetDe1Settings();
    assert.equal((await getDe1Settings()).value, 'default');
    assert.equal((await getDe1AdvancedSettings()).value, 'default');
    assert.deepEqual(calls.map(([, method]) => method), ['GET', 'GET', 'DELETE', 'GET', 'GET']);
});
