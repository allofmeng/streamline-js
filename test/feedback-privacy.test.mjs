import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('feedback discloses public submission and sends no contact identifiers', () => {
    const renderStart = source.indexOf('export function renderFeedbackSettings');
    const renderEnd = source.indexOf('// Render Screen Saver settings', renderStart);
    const renderSource = source.slice(renderStart, renderEnd).replace('export ', '');
    const render = new Function(`${renderSource}\nreturn renderFeedbackSettings;`)();
    const html = render();

    assert.match(html, /public GitHub issue/);
    assert.match(html, /application logs \(private Gist\)/);
    assert.doesNotMatch(html, /feedback-email|Contact Email|Decent Account/);

    const submitStart = source.indexOf('window.submitFeedback = async function');
    const submitEnd = source.indexOf('window.startDescaling', submitStart);
    const submitSource = source.slice(submitStart, submitEnd);

    assert.doesNotMatch(source, /xorEncode|itisadecentcupofcoffee/);
    assert.doesNotMatch(submitSource, /feedback-email|account\/proxy\/support\/api\/sn|\*\*Serial:|\*\*Contact:/);
});
