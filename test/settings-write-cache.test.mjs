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
    pick(/(?:const|let) reatsettingscache = \{[\s\S]*?\r?\n\};/),
    pick(/(?:const|let) de1SettingsCache = \{[\s\S]*?\r?\n\};/),
    pick(/(?:const|let) de1AdvancedSettingsCache = \{[\s\S]*?\r?\n\};/),
].join('\n');
const functionSource = [
    pick(/export async function getReaSettings\(\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function setReaSettings\(settings\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function getDe1Settings\(\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function setDe1Settings\(settings\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function getDe1AdvancedSettings\(\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function setDe1AdvancedSettings\(settings\) \{[\s\S]*?\r?\n\}/),
].join('\n');

test('successful settings writes invalidate their read caches', async () => {
    const values = new Map();
    const calls = [];
    const fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        calls.push([url, method]);
        if (method === 'POST') values.set(url, JSON.parse(options.body).value);
        return {
            ok: true,
            json: async () => ({ value: values.get(url) ?? 'old' }),
        };
    };
    const api = new Function(
        'fetch', 'logger', 'API_BASE_URL', 'AbortController', 'setTimeout', 'clearTimeout', 'firmwareFlashInFlight',
        `${cacheSource}\n${functionSource}\nreturn { getReaSettings, setReaSettings, getDe1Settings, setDe1Settings, getDe1AdvancedSettings, setDe1AdvancedSettings };`,
    )(fetch, { info() {}, error() {} }, 'http://decaid/api/v1', AbortController, setTimeout, clearTimeout, false);
    const pairs = [
        [api.getReaSettings, api.setReaSettings],
        [api.getDe1Settings, api.setDe1Settings],
        [api.getDe1AdvancedSettings, api.setDe1AdvancedSettings],
    ];

    for (const [get, set] of pairs) {
        assert.equal((await get()).value, 'old');
        await set({ value: 'new' });
        assert.equal((await get()).value, 'new');
    }
    assert.deepEqual(calls.map(([, method]) => method), ['GET', 'POST', 'GET', 'GET', 'POST', 'GET', 'GET', 'POST', 'GET']);
});

test('a write during a firmware flash still leaves the cache servable', async () => {
    // Invalidation expires the timestamp and keeps data, so getDe1Settings' mid-flash
    // guard can still answer without putting nine MMR reads down the flashing radio.
    const calls = [];
    const fetch = async (url, options = {}) => {
        calls.push(options.method || 'GET');
        return { ok: true, json: async () => ({ value: 'from-machine' }) };
    };
    const api = new Function(
        'fetch', 'logger', 'API_BASE_URL', 'AbortController', 'setTimeout', 'clearTimeout',
        `${cacheSource}\nlet firmwareFlashInFlight = false;\n${functionSource}\n`
        + `return { getDe1Settings, setDe1Settings, startFlash: () => { firmwareFlashInFlight = true; } };`,
    )(fetch, { info() {}, error() {} }, 'http://decaid/api/v1', AbortController, setTimeout, clearTimeout);

    await api.getDe1Settings();          // seeds the cache
    api.startFlash();
    await api.setDe1Settings({ value: 'x' });
    await api.getDe1Settings();          // must be served from cache, not refetched
    assert.deepEqual(calls, ['GET', 'POST']);
});
