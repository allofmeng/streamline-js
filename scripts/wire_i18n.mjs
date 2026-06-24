// One-shot: inject data-i18n-key into settings.js HTML headings/labels whose
// exact inner text already exists as a key in the translation CSV.
// Conservative: single-line <tag ...>TEXT</tag>, no nested tags, no existing
// data-i18n-key, no ${} interpolation. JS-built labels are left untouched.
import { readFileSync, writeFileSync } from 'node:fs';

const CSV = 'src/ui/de1 gui translation - Sheet1.csv';
const FILE = 'src/settings/settings.js';

// CSV col-1 keys (handles simple + quoted first field).
const keys = new Set();
for (const line of readFileSync(CSV, 'utf8').split('\n')) {
    if (!line) continue;
    let key;
    if (line[0] === '"') { const m = line.match(/^"((?:[^"]|"")*)"/); key = m && m[1].replace(/""/g, '"'); }
    else { key = line.split(',')[0]; }
    if (key) keys.add(key.trim());
}

// Units/symbols: present in the CSV but should not be force-translated as text
// (they're aria-hidden suffix labels, not prose). Skip to avoid odd CSV values.
const UNIT_DENY = new Set(['s','°C','°c','ml','mL','mm','ml/s','mL/s','min','hr','g','%','C','F','L']);

let src = readFileSync(FILE, 'utf8');
let count = 0;
const wired = [];

// <tag attrs>text</tag> on one line, closing tag matches opening (backref).
const re = /(<([a-zA-Z][\w-]*)\b[^<>]*?)>(\s*)([^<>]+?)(\s*)<\/\2>/g;
src = src.replace(re, (full, open, tag, lead, text, trail) => {
    if (open.includes('data-i18n-key')) return full;
    if (text.includes('${') || text.includes('<')) return full;
    const key = text.trim();
    if (!keys.has(key)) return full;
    if (UNIT_DENY.has(key)) return full;
    count++;
    wired.push(key);
    return `${open} data-i18n-key="${key}">${lead}${text}${trail}</${tag}>`;
});

writeFileSync(FILE, src);
console.log(`Injected data-i18n-key on ${count} elements.`);
console.log('Sample:', [...new Set(wired)].slice(0, 25).join(' | '));
