import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
const match = source.match(/function highlightMatch\(text, searchTerm\) \{[\s\S]*?\r?\n\}/);
assert.ok(match);
const highlightMatch = new Function(`${match[0]}\nreturn highlightMatch;`)();

test('settings search highlights punctuation literally', () => {
    const cases = [
        ['Group (temperature)', '('],
        ['Value [raw]', '['],
        ['Path C:\\data', '\\'],
        ['Version 1.2', '.'],
    ];

    for (const [text, term] of cases) {
        const expected = text.replace(term, `<mark class="bg-yellow-300 text-black">${term}</mark>`);
        assert.equal(highlightMatch(text, term), expected);
    }
});
