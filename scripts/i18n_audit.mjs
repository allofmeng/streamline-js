// Deep audit: every user-facing string in settings.js vs the CSV (case-insensitive).
// Reports matches not yet wired, and genuine no-translation strings.
import { readFileSync } from 'node:fs';

const CSV = 'src/ui/de1 gui translation - Sheet1.csv';
const FILE = 'src/settings/settings.js';

// CSV col-1 keys, lowercased -> canonical.
const ci = new Map();
for (const line of readFileSync(CSV, 'utf8').split('\n')) {
    if (!line) continue;
    let key;
    if (line[0] === '"') { const m = line.match(/^"((?:[^"]|"")*)"/); key = m && m[1].replace(/""/g, '"'); }
    else { key = line.split(',')[0]; }
    if (key) { key = key.trim(); if (key) ci.set(key.toLowerCase(), key); }
}

const src = readFileSync(FILE, 'utf8');
const UNIT = new Set(['s','°c','°C','ml','ml/s','mm','min','hr','g','%','c','f','l','mL']);

// Collect candidate strings: HTML inner text + JS string literals in label/title/name/sub/return.
const cands = new Map(); // text -> {html:bool, js:bool}
const add = (t, kind) => { t = t.trim(); if (!t) return; const e = cands.get(t) || {}; e[kind] = true; cands.set(t, e); };

for (const m of src.matchAll(/>([^<>{}][^<>]*?)</g)) add(m[1], 'html');
for (const m of src.matchAll(/(?:label|title|name|sub)\s*:\s*'([^']+)'/g)) add(m[1], 'js');
for (const m of src.matchAll(/return\s+'([^']+)'/g)) add(m[1], 'js');

const wiredKeys = new Set([...src.matchAll(/data-i18n-key="([^"]+)"/g)].map(m => m[1]));

const apply = [], already = [], missing = [];
for (const [text, kind] of cands) {
    if (/\$\{|^\d|^[\d.]+$/.test(text)) continue;          // dynamic / numeric
    if (UNIT.has(text.toLowerCase())) continue;
    const canon = ci.get(text.toLowerCase());
    if (!canon) { if (/[a-z]/i.test(text) && text.length > 1) missing.push(text); continue; }
    if (wiredKeys.has(canon)) { already.push(`${text}  ->  ${canon}`); continue; }
    apply.push(`${kind.html?'H':' '}${kind.js?'J':' '}  ${text}  ->  ${canon}`);
}

console.log(`\n### HAS CSV TRANSLATION, NOT YET APPLIED (${apply.length}) ###`);
console.log(apply.sort().join('\n'));
console.log(`\n### NO CSV TRANSLATION (${missing.length}) ### (sample)`);
console.log([...new Set(missing)].sort().slice(0, 40).join('\n'));
