import { logger } from './logger.js';
import { openDB, getSetting, setSetting } from './idb.js';

const translations = {};
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
        const response = await fetch('src/ui/de1 gui translation - Sheet1.csv');
        
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
}

/**
 * Gets the translation for a given key in the current language.
 * @param {string} key The translation key.
 * @returns {string} The translated string, or the key if not found.
 */
export function getTranslation(key) {
    return translations[currentLanguage]?.[key] || key;
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
