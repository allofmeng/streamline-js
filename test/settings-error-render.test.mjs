import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadRenderer() {
    const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const helpersStart = source.indexOf('function escapeHtml');
    const helpersEnd = source.indexOf('let screensaverImagesCache', helpersStart);
    const rendererStart = source.indexOf('function renderErrorState');
    const rendererEnd = source.indexOf('function updateSettingsContentArea', rendererStart);
    assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && rendererStart >= 0 && rendererEnd > rendererStart);

    return new Function(`
        ${source.slice(helpersStart, helpersEnd)}
        ${source.slice(rendererStart, rendererEnd)}
        return renderErrorState;
    `)();
}

test('settings errors render backend and translation values as text', () => {
    const render = loadRenderer();
    const title = '<svg onload=alert(1)>';
    const message = '<img src=x onerror=alert(1)>';
    const html = render(title, message);

    assert.doesNotMatch(html, /<(?:img|svg)/i);
    assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
