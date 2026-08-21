import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The Plugins settings page links each plugin to its own web UI. Decaid routes
// /api/v1/plugins/<id>/<endpoint> from the manifest's api declarations, so a link
// is only real when the manifest declares an http endpoint named "ui" -- anything
// else 404s. settings.js can't be imported under node (browser globals), so the
// function is lifted out of the source, as in settings-sync.test.mjs.

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
const match = source.match(/function pluginUiUrl\(plugin\) \{[\s\S]*?\r?\n {4}\}/);
assert.ok(match, 'pluginUiUrl not found in settings.js');
const pluginUiUrl = new Function('API_BASE_URL', `${match[0]}\nreturn pluginUiUrl;`)('http://x:8080/api/v1');

test('a plugin declaring a ui endpoint gets a link to it', () => {
    assert.equal(
        pluginUiUrl({ id: 'settings.reaplugin', api: [{ id: 'ui', type: 'http', data: {} }] }),
        'http://x:8080/api/v1/plugins/settings.reaplugin/ui',
    );
});

test('the link is built off the configured bridge host, not a literal localhost', () => {
    const url = pluginUiUrl({ id: 'dye2.reaplugin', api: [{ id: 'ui', type: 'http' }] });
    assert.ok(url.startsWith('http://x:8080/api/v1/'));
});

test('a plugin with no ui endpoint gets no link', () => {
    // dye2 declares a dozen http endpoints, none of them "ui" -- linking to one
    // of those would open a fragment, and guessing /ui would 404.
    const dye2ish = { id: 'dye2.reaplugin', api: [{ id: 'dashboard', type: 'http' }, { id: 'grinders', type: 'http' }] };
    assert.equal(pluginUiUrl(dye2ish), null);
    assert.equal(pluginUiUrl({ id: 'bare.reaplugin' }), null);
    assert.equal(pluginUiUrl(null), null);
});

test('a websocket endpoint named ui is not a web page', () => {
    const wsOnly = { id: 'time-to-ready.reaplugin', api: [{ id: 'ui', type: 'websocket' }] };
    assert.equal(pluginUiUrl(wsOnly), null);
});

test('an id needing escaping stays intact in the path', () => {
    // Decaid's id rule permits characters that are not URL-safe; the path segment
    // is encoded so the link still points at the plugin it names.
    const url = pluginUiUrl({ id: "odd id.reaplugin", api: [{ id: 'ui', type: 'http' }] });
    assert.equal(url, 'http://x:8080/api/v1/plugins/odd%20id.reaplugin/ui');
});
