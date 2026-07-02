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
    // Shrink text to fit fixed-size elements (e.g. header buttons) so long
    // translations stay on one line without changing the box. Opt in with
    // data-fit-text; the element must be whitespace-nowrap and have a fixed width.
    document.querySelectorAll('[data-fit-text]').forEach(fitTextToWidth);
}

// Shared canvas for text measurement — reliable even for centered flex items,
// where scrollWidth wrongly reports ~clientWidth and the shrink never triggers.
const _fitCanvas = document.createElement('canvas');
const _fitCtx = _fitCanvas.getContext('2d');

/**
 * Shrinks an element's font-size until its text fits its width (no overflow).
 * Resets to the CSS-defined size first so switching to a shorter language grows
 * it back. ponytail: 1px steps, min 8px — plenty precise for button labels.
 */
function fitTextToWidth(el) {
    el.style.fontSize = '';
    const cs = getComputedStyle(el);
    // clientWidth excludes border; -8px inset so text clears the rounded corners
    const avail = el.clientWidth - 8;
    const text = el.textContent;
    let size = parseFloat(cs.fontSize);
    const measure = s => {
        _fitCtx.font = `${cs.fontWeight} ${s}px ${cs.fontFamily}`;
        return _fitCtx.measureText(text).width;
    };
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
