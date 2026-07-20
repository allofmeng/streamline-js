import { logger } from './logger.js';
import { openDB, getSetting, setSetting } from './idb.js';

const translations = {};
// lowercased key -> canonical CSV key, so lookups tolerate casing differences
// between the UI text and the sheet (e.g. "Force On" finds "force on").
const keyIndex = {};
export let supportedLanguages = [];
export let currentLanguage = 'en';

/**
 * Parses a CSV string into a usable translation object.
 * @param {string} csvText The CSV content.
 */
function parseCSV(csvText) {
    if (csvText.charCodeAt(0) === 0xFEFF) {
        csvText = csvText.substring(1);
    }
    const lines = csvText.trim().split(/\r?\n/);
    const headers = lines[0].split(',').map(h => h.trim());
    supportedLanguages = headers;

    // Initialize translation objects for each language
    headers.forEach(lang => {
        translations[lang] = {};
    });

    const splitRegex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        const values = line.split(splitRegex).map(val => {
            let value = val.trim();
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1).replace(/""/g, '"');
            }
            return value;
        });

        const key = values[0];
        if (key) {
            keyIndex[key.toLowerCase()] = key;
            headers.forEach((lang, index) => {
                if (values[index] !== undefined) {
                    const translation = values[index] || values[0] || key;
                    translations[lang][key] = translation;
                }
            });
        }
    }
    logger.info("Translations loaded for languages:", supportedLanguages);
}


/**
 * Fetches and loads the translation data.
 */
async function loadTranslations() {
    try {
        // no-cache: revalidate with the server every load so sheet edits apply on
        // refresh instead of sticking to a cached copy (the cause of "translation
        // exists in CSV but not applied"). 304 when unchanged, so it's cheap.
        const response = await fetch('src/ui/de1 gui translation - Sheet1.csv', { cache: 'no-cache' });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const csvText = await response.text();
        parseCSV(csvText);
    } catch (error) {
        console.error("Could not load or parse translation file:", error);
    }
}

/**
 * Translates all elements on the page with a `data-i18n-key` attribute.
 */
export function translatePage() {
    document.querySelectorAll('[data-i18n-key]').forEach(element => {
        const key = element.getAttribute('data-i18n-key');
        element.textContent = getTranslation(key);
    });
    fitAllText();
    fitTelemetry();
    // The header buttons are laid out with the custom Inter font; if it hasn't
    // finished loading yet the first fit measures against a fallback (or a
    // not-yet-sized box) and mis-shrinks. Re-fit once fonts are ready.
    if (document.fonts && document.fonts.status !== 'loaded') {
        document.fonts.ready.then(() => { fitAllText(); fitTelemetry(); });
    }
}

// Scale the machine-telemetry row down so long-language rows (e.g. German:
// "Mischwasser … Gewicht 65.0g") stay on ONE line instead of wrapping. The row
// is nowrap; we measure its natural one-line width and, if it exceeds the space
// available (which shrinks when the GHC column is shown), apply transform:scale.
let _telemetryObserved = false;
export function fitTelemetry() {
    const row = document.getElementById('telemetry-row');
    if (!row) return;
    row.style.transformOrigin = 'left center';
    row.style.transform = '';                    // reset so scrollWidth is the true 1-line width
    // Grandparent = the header band (full left-column width; shrinks when GHC shows).
    const band = row.parentElement && row.parentElement.parentElement;
    if (!band) return;
    const LEFT = 40, RESERVE = 24;               // row's left offset + gap before GHC/edge
    const avail = band.clientWidth - LEFT - RESERVE;
    const natural = row.scrollWidth;
    if (avail > 0 && natural > avail) {
        row.style.transform = `scale(${(avail / natural).toFixed(3)})`;
    }
    // Re-fit on any size change, delivered immediately once observing starts:
    //  - band: GHC column toggling / window resize (available width changes)
    //  - row:  content/font changes (Retry text appearing, first layout, Inter
    //          loading) — catches the initial clip before it's visible.
    // transform is visual-only, so it never changes either observed box -> no loop.
    if (!_telemetryObserved && typeof ResizeObserver !== 'undefined') {
        _telemetryObserved = true;
        const ro = new ResizeObserver(() => fitTelemetry());
        ro.observe(band);
        ro.observe(row);
    }
}

// Shrink text to fit fixed-size elements (e.g. header buttons) so long
// translations stay on one line without changing the box. Opt in with
// data-fit-text; the element must be whitespace-nowrap and have a fixed width.
let _fitObserver;
function fitAllText() {
    const els = document.querySelectorAll('[data-fit-text]');
    els.forEach(fitTextToWidth);
    // Re-fit when an element's size changes — crucially the 0 -> 165px jump when
    // #main-page returns from display:none (language was changed on the Settings
    // sub-page, so the header buttons were hidden and skipped the first fit).
    // Width is fixed, so setting font-size doesn't resize it -> no feedback loop.
    if (!_fitObserver && typeof ResizeObserver !== 'undefined') {
        _fitObserver = new ResizeObserver(entries => {
            for (const e of entries) fitTextToWidth(e.target);
        });
    }
    if (_fitObserver) els.forEach(el => _fitObserver.observe(el));
}

// Off-screen span that measures text using the page's REAL rendered fonts.
// A <canvas> 2D context silently falls back to a wider default when the custom
// font (Inter) isn't honored, which over-shrinks; a DOM span never does.
const _fitMeter = document.createElement('span');
_fitMeter.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;white-space:nowrap;visibility:hidden;pointer-events:none';
if (document.body) document.body.appendChild(_fitMeter);
else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(_fitMeter));

/**
 * Shrinks an element's font-size until its text fits its width (no overflow).
 * Resets to the CSS-defined size first so switching to a shorter language grows
 * it back. ponytail: 1px steps, min 8px — plenty precise for button labels.
 *
 * Exported for callers that swap a data-fit-text label at RUNTIME (the header
 * cup-warmer button becomes "Pre-warming", which is far longer than "Warmer" in
 * a fixed 150px box). The ResizeObserver above only fires on size changes, and
 * the box never changes size — so a text swap must re-fit explicitly.
 */
export function fitTextToWidth(el) {
    el.style.fontSize = '';
    // clientWidth excludes border; -8px inset so text clears the rounded corners.
    const avail = el.clientWidth - 8;
    // Not laid out yet (hidden/zero-width): leave the CSS size, a later fit
    // (fonts.ready / next translatePage) handles it. Never shrink to the floor here.
    if (avail <= 0) return;
    const cs = getComputedStyle(el);
    _fitMeter.style.fontFamily = cs.fontFamily;
    _fitMeter.style.fontWeight = cs.fontWeight;
    _fitMeter.style.fontStyle = cs.fontStyle;
    _fitMeter.style.letterSpacing = cs.letterSpacing;
    _fitMeter.textContent = el.textContent;
    let size = parseFloat(cs.fontSize);
    const measure = s => { _fitMeter.style.fontSize = s + 'px'; return _fitMeter.offsetWidth; };
    while (measure(size) > avail && size > 8) {
        size -= 1;
    }
    el.style.fontSize = size + 'px';
}

/**
 * Gets the translation for a given key in the current language.
 * @param {string} key The translation key.
 * @returns {string} The translated string, or the key if not found.
 */
export function getTranslation(key) {
    const table = translations[currentLanguage];
    if (table && table[key] !== undefined && table[key] !== '') return table[key];
    // Case-insensitive fallback: tolerate UI/CSV casing differences. For the
    // English/source column the value equals the key, so return the caller's
    // original casing; for other languages return the actual translation.
    const canon = keyIndex[key?.toLowerCase?.()];
    if (canon && table) {
        const val = table[canon];
        if (val) return val.toLowerCase() === key.toLowerCase() ? key : val;
    }
    return key;
}

/**
 * Gets the list of supported languages.
 * @returns {string[]}
 */
export function getSupportedLanguages() {
    return supportedLanguages;
}

/**
 * Gets the current language.
 * @returns {string}
 */
export function getCurrentLanguage() {
    return currentLanguage;
}


/**
 * Sets the current language and translates the page.
 * @param {string} lang The language code (e.g., 'en', 'fr').
 */
export function setLanguage(lang) {
    if (supportedLanguages.includes(lang)) {
        currentLanguage = lang;
        // Write to both — IDB survives WebView process kills on iOS, localStorage is sync fallback
        localStorage.setItem('language', lang);
        setSetting('language', lang).catch(() => {});
        logger.info(`Language set to: ${lang}`);
    } else {
        console.warn(`Language '${lang}' not supported. Defaulting to 'en'.`);
        currentLanguage = 'en';
    }
    translatePage();
    document.dispatchEvent(new CustomEvent('streamline:languagechange', { detail: { language: currentLanguage } }));
}

/**
 * Initializes the internationalization module.
 */
export async function initI18n() {
    await loadTranslations();

    // IDB is primary (survives WebView process kills on iOS/Android).
    // localStorage is fallback for first run or when IDB hasn't been written yet.
    let savedLang = null;
    try {
        await openDB();
        savedLang = await getSetting('language');
    } catch (_) {}
    if (!savedLang) {
        savedLang = localStorage.getItem('language');
    }

    const browserLang = navigator.language.split('-')[0];
    let initialLang = 'en';
    if (savedLang && supportedLanguages.includes(savedLang)) {
        initialLang = savedLang;
    } else if (supportedLanguages.includes(browserLang)) {
        initialLang = browserLang;
    }

    setLanguage(initialLang);
}
