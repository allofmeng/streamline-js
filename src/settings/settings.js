import {  getReaSettings, getDe1Settings, getDe1AdvancedSettings, setReaSettings, setDe1Settings, setDe1AdvancedSettings, resetDe1Settings, setMachineState, connectScaleDevice, connectDeviceWebSocket, sendDeviceCommand, dimDisplay, restoreDisplay, currentMachineState, signalHeartbeat, MachineState, getDeviceWebSocket, initDeviceWebSocketWithCallback, saveScaleDeviceId, getScaleDeviceId, connectDisplayWebSocket, sendDisplayCommand, enableWakeLock, disableWakeLock, getPresenceSettings, setPresenceSettings, getPresenceSchedules, createPresenceSchedule, updatePresenceSchedule, deletePresenceSchedule, getAppInfo, getMachineInfo, getWorkflow, updateWorkflow, getAllSkins, getDefaultSkin, setDefaultSkin, updateSkins, stopWebuiServer, startWebuiServer, uploadFirmware, setWaterLevels, API_BASE_URL } from '../modules/api.js';
import * as ui from '../modules/ui.js';
import { initScaling } from '../modules/scaling.js';
import { getSupportedLanguages, getCurrentLanguage, setLanguage, translatePage } from '../modules/i18n.js';
import { loadPage } from '../modules/router.js'; // Singular and correctly formatted import
import { logger } from '../modules/logger.js';
import { openNotesModal } from '../modules/notes-modal.js';
import { openDB, getSetting, setSetting, addEmails, getAllEmails, getLatestEmailTimestamp } from '../modules/idb.js';
import { openModal, shouldUseNumpad, initializeNumpadModal } from '../modules/numpad-modal.js';

// Config for each numeric input that should get two-click numpad support
const SETTINGS_NUMPAD_CONFIGS = {
    flushTempInput:          { title: 'FLUSH TEMPERATURE',   unit: '°C',   min: 5,   max: 95,   fieldType: 'settings-flush-temp' },
    flushFlowInput:          { title: 'FLUSH FLOW',          unit: 'ml/s', min: 1,   max: 8,    fieldType: 'settings-flush-flow' },
    tankTempInput:           { title: 'TANK TEMPERATURE',    unit: '°C',   min: 10,  max: 40,   fieldType: 'settings-tank-temp' },
    waterAlertInput:         { title: 'WATER ALERT LEVEL',   unit: 'mm',   min: 0,   max: 30,   fieldType: 'settings-water-alert' },
    calibFanInput:           { title: 'FAN THRESHOLD',       unit: '%',    min: 0,   max: 100,  fieldType: 'settings-calib-fan' },
    steamCalibTempInput:     { title: 'STEAM TEMPERATURE',   unit: '°C',   min: 135, max: 170,  fieldType: 'settings-steam-calib-temp' },
    steamTempInput:          { title: 'STEAM TEMPERATURE',   unit: '°C',   min: 130, max: 170,  fieldType: 'settings-steam-temp' },
    steamDurationInput:      { title: 'STEAM DURATION',      unit: 'sec',  min: 10,  max: 120,  fieldType: 'settings-steam-duration' },
    steamFlowInput:          { title: 'STEAM FLOW',          unit: 'ml/s', min: 0.1, max: 2.5,  fieldType: 'settings-steam-flow' },
    hotWaterTempInput:       { title: 'HOT WATER TEMP',      unit: '°C',   min: 50,  max: 95,   fieldType: 'settings-hw-temp' },
    hotWaterVolumeInput:     { title: 'HOT WATER VOLUME',    unit: 'ml',   min: 10,  max: 500,  fieldType: 'settings-hw-volume' },
    hotWaterDurationInput:   { title: 'HOT WATER DURATION',  unit: 'sec',  min: 5,   max: 120,  fieldType: 'settings-hw-duration' },
    hotWaterFlowInput:       { title: 'HOT WATER FLOW',      unit: 'ml/s', min: 0.1, max: 8,    fieldType: 'settings-hw-flow' },
    heaterPh1FlowInput:      { title: 'HEATER PH1 FLOW',     unit: 'ml/s', min: 0,   max: 10,   fieldType: 'settings-heater-ph1' },
    heaterPh2FlowInput:      { title: 'HEATER PH2 FLOW',     unit: 'ml/s', min: 0,   max: 10,   fieldType: 'settings-heater-ph2' },
    weightFlowMultiplierInput: { title: 'WEIGHT FLOW MULT',  unit: '',     min: 0,   max: 5,    fieldType: 'settings-weight-mult' },
    volumeFlowMultiplierInput: { title: 'VOLUME FLOW MULT',  unit: '',     min: 0,   max: 5,    fieldType: 'settings-volume-mult' },
};

let _settingsNumpadSelected = null;
let _settingsNumpadTimer = null;

function attachSettingsNumpad() {
    if (!shouldUseNumpad()) return;
    initializeNumpadModal();

    Object.entries(SETTINGS_NUMPAD_CONFIGS).forEach(([id, config]) => {
        const input = document.getElementById(id);
        if (!input || input.dataset.settingsNumpadAttached) return;
        input.dataset.settingsNumpadAttached = 'true';
        input.readOnly = true;
        input.style.cursor = 'pointer';

        input.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (_settingsNumpadSelected === input) {
                // Second click — open numpad
                clearTimeout(_settingsNumpadTimer);
                _settingsNumpadSelected = null;
                input.style.outline = '';

                const currentVal = String(parseFloat(input.value) || config.min);
                const mockEl = {
                    value: currentVal,
                    getAttribute: () => currentVal,
                    dispatchEvent: () => {}
                };
                openModal(mockEl, {
                    fieldType: config.fieldType,
                    config,
                    onConfirm: (val) => {
                        const num = parseFloat(val);
                        if (!isNaN(num)) {
                            const clamped = Math.max(config.min, Math.min(config.max, num));
                            input.value = clamped;
                            input.dispatchEvent(new Event('change'));
                        }
                    }
                });
            } else {
                // First click — select / highlight
                if (_settingsNumpadSelected) {
                    _settingsNumpadSelected.style.outline = '';
                }
                clearTimeout(_settingsNumpadTimer);
                _settingsNumpadSelected = input;
                input.style.outline = '2px solid var(--mimoja-blue)';
                input.style.borderRadius = '4px';
                _settingsNumpadTimer = setTimeout(() => {
                    if (_settingsNumpadSelected === input) {
                        _settingsNumpadSelected = null;
                        input.style.outline = '';
                    }
                }, 2000);
            }
        });
    });
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let screensaverImagesCache = [];

// Enhanced cache for settings data with loading states
let settingsCache = {
    rea: null,
    de1: null,
    de1Advanced: null,
    workflow: null,
    reaLoading: false,
    de1Loading: false,
    de1AdvancedLoading: false,
    workflowLoading: false,
    reaError: null,
    de1Error: null,
    de1AdvancedError: null,
    workflowError: null,
    appInfo: null,
    appInfoLoading: false,
    appInfoError: null,
    machineInfo: null,
    machineInfoLoading: false,
    machineInfoError: null,
    skinInfo: null,
    skinInfoLoading: false,
    skinInfoError: null,
    allSkins: null,
    allSkinsLoading: false,
    allSkinsError: null,
    githubLatestVersion: null
};

let activeSettingsCategory = null; // New global variable to track the currently active category

let pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
function resetPendingChanges() { pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} }; }
function hasPendingChanges() {
    return Object.keys(pendingChanges.rea).length > 0 ||
        Object.keys(pendingChanges.de1).length > 0 ||
        Object.keys(pendingChanges.de1Advanced).length > 0 ||
        Object.keys(pendingChanges.workflow).length > 0;
}
async function flushPendingChanges() {
    const tasks = [];
    if (Object.keys(pendingChanges.rea).length) tasks.push(setReaSettings(pendingChanges.rea));
    if (Object.keys(pendingChanges.de1).length) tasks.push(setDe1Settings(pendingChanges.de1));
    if (Object.keys(pendingChanges.de1Advanced).length) tasks.push(setDe1AdvancedSettings(pendingChanges.de1Advanced));
    if (pendingChanges.workflow.steamSettings) tasks.push(updateWorkflow({ steamSettings: pendingChanges.workflow.steamSettings }));
    if (pendingChanges.workflow.hotWaterData) tasks.push(updateWorkflow({ hotWaterData: pendingChanges.workflow.hotWaterData }));
    if (tasks.length) await Promise.all(tasks);
    saveSettingsBackup();
    resetPendingChanges();
}

// Live device state cache from WebSocket
let deviceStateCache = {
    devices: [],
    scanning: false,
    initialized: false
};

// Render generic loading state
function renderLoadingState(title) {
    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden" role="status" aria-busy="true">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]">${title}</p>
            </div>
            <div class="text-[var(--text-primary)] p-4 text-[24px] text-center w-full">Loading settings...</div>
        </div>
    `;
}

function formatMachineExtra(extra) {
    if (!extra || typeof extra !== 'object') {
        return 'N/A';
    }

    const entries = Object.entries(extra);
    if (entries.length === 0) {
        return 'N/A';
    }

    return entries
        .map(([key, value]) => {
            const readableKey = key
                .replace(/([A-Z])/g, ' $1')
                .replace(/^./, (char) => char.toUpperCase());
            let readableValue;
            if (typeof value === 'boolean') {
                readableValue = value ? 'on' : 'off';
            } else {
                readableValue = String(value);
            }
            return `${readableKey} : ${readableValue}`;
        })
        .join(', ');
}

function formatBuildTimestamp(timestamp) {
    if (!timestamp) {
        return 'Unavailable';
    }

    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return timestamp;
    }

    return parsed.toLocaleString();
}

// Render generic error state
function renderErrorState(title, message) {
    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden" role="alert">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]">${title}</p>
            </div>
            <div class="text-red-500 p-4 text-[24px] text-center w-full">Failed to load settings: ${message}</div>
            <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold mx-auto mt-4" onclick="window.retryLoadSettings()">Retry</button>
        </div>
    `;
}

// Helper function to update the settings content area in the DOM
function updateSettingsContentArea(category) {
    const contentArea = document.getElementById('settings-content-area');
    if (contentArea) {
        contentArea.innerHTML = renderSettingsContent(category);
        translatePage();
        if (category === 'appearance') {
            setTimeout(() => {
                ui.initThemeToggle();
            }, 100);
        }
        if (category === 'plugins') {
            setTimeout(() => window.loadPluginList?.(), 0);
        }
        if (category === 'fontsize') {
            setTimeout(initFontSizeSettings, 0);
        }
        if (category === 'feedback') {
            setTimeout(() => window.updateDecentAccountUI?.(), 0);
        }
        if (category === 'talkdecent') {
            setTimeout(() => window.updateTalkToDecentUI?.(), 0);
        }
        setTimeout(attachSettingsNumpad, 0);
    }
}

// Define the tree structure for settings navigation
const settingsTree = {
    'quickadjustments': {
        name: 'Quick Adjustments',
        subcategories: [
            { id: 'flowmultiplier', name: 'Flow Multiplier', settingsCategory: 'flowmultiplier' },
            { id: 'steam', name: 'Steam', settingsCategory: 'steam' },
            { id: 'hotwater', name: 'Hot Water', settingsCategory: 'hotwater' },
            { id: 'watertank', name: 'Water Tank', settingsCategory: 'watertank' },
            { id: 'flush', name: 'Flush', settingsCategory: 'flush' }
        ]
    },
    'bluetooth': {
        name: 'Bluetooth',
        subcategories: [
            { id: 'ble_machine', name: '1. Machine', settingsCategory: 'ble_machine' },
            { id: 'ble_scale', name: '2. Scale', settingsCategory: 'ble_scale' }
        ]
    },
    'calibration': {
        name: 'Calibration',
        subcategories: [
            { id: 'defaultloadsettings', name: 'Default load settings', settingsCategory: 'calib_defaultload' },
            { id: 'refillkit',           name: 'Refill Kit',            settingsCategory: 'calib_refillkit' },
            { id: 'voltage',             name: 'Voltage',               settingsCategory: 'calib_voltage' },
            { id: 'fan',                 name: 'Fan',                   settingsCategory: 'calib_fan' },
            { id: 'steam',               name: 'Steam',                 settingsCategory: 'calib_steam' }
        ]
    },
    'machine': {
        name: 'Machine',
        subcategories: [
            { id: 'usbchargermode', name: 'USB Charger', settingsCategory: 'usbchargermode' },
            { id: 'machineinfo', name: 'Machine Information', settingsCategory: 'machineinfo' }
        ]
    },
    'maintenance': {
        name: 'Maintenance',
        subcategories: [
            { id: 'machinedescaling', name: 'Machine Descaling', settingsCategory: 'maint_descaling' },
            { id: 'transportmode',    name: 'Transport Mode',    settingsCategory: 'maint_airpurge' }
        ]
    },
    'skin': {
        name: 'Skin',
        subcategories: [
            { id: 'skin1', name: 'Theme & Updates', settingsCategory: 'appearance' }
        ]
    },
    'language': {
        name: 'Language',
        subcategories: [
            { id: 'selectlanguage', name: 'Select Language', settingsCategory: 'language' },
        ]
    },
    'extensions': {
        name: 'Extensions',
        subcategories: [
            { id: 'extention1', name: 'Visualizer', settingsCategory: 'extensions' },
            { id: 'extention2', name: 'Plugins', settingsCategory: 'plugins' }
        ]
    },
    'miscellaneous': {
        name: 'Miscellaneous',
        subcategories: [
            { id: 'reasettings', name: 'Decent.app Settings', settingsCategory: 'rea' },
            { id: 'brightness', name: 'Brightness', settingsCategory: 'brightness' },
            { id: 'wakelock', name: 'Wake Lock', settingsCategory: 'wakelock' },
            { id: 'presence', name: 'Presence Detection', settingsCategory: 'presence' },
            { id: 'fontsize', name: 'Display Size', settingsCategory: 'fontsize' },
            { id: 'resolution', name: 'Resolution', settingsCategory: 'resolution' },
            { id: 'screensaver', name: 'Screen Saver', settingsCategory: 'screensaver' },
            { id: 'machineadvancedsettings', name: 'Machine Advanced Settings', settingsCategory: 'de1advanced' },
            { id: 'keyboard-shortcuts', name: 'Keyboard Shortcuts', settingsCategory: 'keyboard_shortcuts' }
        ]
    },
    'updates': {
        name: 'Updates',
        subcategories: [
            { id: 'firmwareupdate', name: 'Firmware Update', settingsCategory: 'firmware' }
        ]
    },
    'usermanual': {
        name: 'User Manual',
        subcategories: [
            { id: 'talkdecent', name: 'Talk to Decent', settingsCategory: 'talkdecent' },
            { id: 'feedback', name: 'Send Feedback', settingsCategory: 'feedback' }
        ]
    }
};

// Cache for loading promise to prevent multiple simultaneous requests
let settingsLoadingPromise = null;

// Load all settings data
export async function loadSettings() {
    // If we're already loading, return the same promise
    if (settingsLoadingPromise) {
        return settingsLoadingPromise;
    }

    settingsLoadingPromise = _loadSettingsInternal();
    return settingsLoadingPromise;
}

// Internal function to actually load settings
async function _loadSettingsInternal() {
    try {
        await openDB();
    } catch (e) { /* non-fatal — IDB unavailable, fallback skipped */ }

    try {
        const [reaResult, de1Result, de1AdvancedResult, appInfoResult, workflowResult] = await Promise.allSettled([
            getReaSettings(),
            getDe1Settings(),
            getDe1AdvancedSettings(),
            getAppInfo(),
            getWorkflow()
        ]);

        const idbKeys = ['settings-rea', 'settings-de1', 'settings-de1Advanced', 'settings-appInfo', 'settings-workflow'];
        const results = [reaResult, de1Result, de1AdvancedResult, appInfoResult, workflowResult];
        const resolved = [];
        let usedCache = false;

        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled') {
                resolved.push(results[i].value);
                try { await setSetting(idbKeys[i], results[i].value); } catch (e) { /* non-fatal */ }
            } else {
                console.warn(`Settings fetch failed for ${idbKeys[i]}:`, results[i].reason);
                let cached = null;
                try { cached = await getSetting(idbKeys[i]); } catch (e) { /* non-fatal */ }
                resolved.push(cached);
                if (cached !== null) usedCache = true;
            }
        }

        const [reaSettings, de1Settings, de1AdvancedSettings, appInfoData, workflowData] = resolved;

        settingsCache.rea = reaSettings;
        settingsCache.de1 = de1Settings;
        settingsCache.de1Advanced = de1AdvancedSettings;
        settingsCache.appInfo = appInfoData;
        settingsCache.workflow = workflowData;

        if (usedCache) {
            ui.showToast('Some settings loaded from cache — connection issue', 4000, 'warning');
        }

        try {
            const stored = await getSetting('screensaverImages');
            if (Array.isArray(stored) && stored.length > 0) screensaverImagesCache = stored;
        } catch (e) { /* non-fatal */ }

        // Silently re-push any settings Rea may have lost (e.g. after a reset/reinstall)
        reconcileSettingsWithBackup();

        return { reaSettings, de1Settings, de1AdvancedSettings, appInfoData, workflowData };
    } catch (error) {
        console.error('Error loading settings:', error);
        ui.showToast('Failed to load settings', 5000, 'error');
        return { reaSettings: null, de1Settings: null, de1AdvancedSettings: null, workflowData: null };
    } finally {
        settingsLoadingPromise = null;
    }
}

// Helper function to check if settings are loaded
function areSettingsLoaded() {
    return settingsCache.rea !== null &&
           settingsCache.de1 !== null &&
           settingsCache.de1Advanced !== null;
}

// Update decent.app settings
export function updateReaSetting(key, value, rerender = true) {
    if (!settingsCache.rea) settingsCache.rea = {};
    settingsCache.rea[key] = value;
    pendingChanges.rea[key] = value;
    if (rerender && activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
}

// Update DE1 settings
export function updateDe1Setting(key, value) {
    if (!settingsCache.de1) settingsCache.de1 = {};
    settingsCache.de1[key] = value;
    pendingChanges.de1[key] = value;
    if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
}

// Update DE1 advanced settings
export function updateDe1AdvancedSetting(key, value) {
    if (!settingsCache.de1Advanced) settingsCache.de1Advanced = {};
    settingsCache.de1Advanced[key] = value;
    pendingChanges.de1Advanced[key] = value;
    if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
}

// Update steam settings via workflow API
export function updateSteamSetting(key, value) {
    if (!settingsCache.workflow) settingsCache.workflow = {};
    if (!settingsCache.workflow.steamSettings) settingsCache.workflow.steamSettings = {};
    settingsCache.workflow.steamSettings[key] = value;
    if (!pendingChanges.workflow.steamSettings) pendingChanges.workflow.steamSettings = { ...(settingsCache.workflow.steamSettings) };
    pendingChanges.workflow.steamSettings[key] = value;
}

// Update hot water settings via workflow API
export function updateHotWaterSetting(key, value) {
    if (!settingsCache.workflow) settingsCache.workflow = {};
    if (!settingsCache.workflow.hotWaterData) settingsCache.workflow.hotWaterData = {};
    settingsCache.workflow.hotWaterData[key] = value;
    if (!pendingChanges.workflow.hotWaterData) pendingChanges.workflow.hotWaterData = { ...(settingsCache.workflow.hotWaterData) };
    pendingChanges.workflow.hotWaterData[key] = value;
}


// ── Settings backup / reconcile ─────────────────────────────────────────────

async function preSeedFromIDB() {
    try {
        await openDB();
        const backup = await getSetting('settingsBackup');
        if (!backup?.ts || (Date.now() - backup.ts) > 30 * 24 * 60 * 60 * 1000) return false;
        if (backup.rea)         { settingsCache.rea         = backup.rea;         settingsCache.reaLoading         = false; }
        if (backup.de1)         { settingsCache.de1         = backup.de1;         settingsCache.de1Loading         = false; }
        if (backup.de1Advanced) { settingsCache.de1Advanced = backup.de1Advanced; settingsCache.de1AdvancedLoading = false; }
        if (backup.steamSettings || backup.hotWaterData) {
            settingsCache.workflow = settingsCache.workflow || {};
            if (backup.steamSettings) settingsCache.workflow.steamSettings = backup.steamSettings;
            if (backup.hotWaterData)  settingsCache.workflow.hotWaterData  = backup.hotWaterData;
        }
        return true;
    } catch (e) {
        console.warn('preSeedFromIDB failed:', e);
        return false;
    }
}

async function saveSettingsBackup() {
    try {
        await openDB();
        await setSetting('settingsBackup', {
            ts: Date.now(),
            rea:         settingsCache.rea         ? { ...settingsCache.rea }         : null,
            de1:         settingsCache.de1         ? { ...settingsCache.de1 }         : null,
            de1Advanced: settingsCache.de1Advanced ? { ...settingsCache.de1Advanced } : null,
            steamSettings: settingsCache.workflow?.steamSettings
                ? { ...settingsCache.workflow.steamSettings } : null,
            hotWaterData:  settingsCache.workflow?.hotWaterData
                ? { ...settingsCache.workflow.hotWaterData }  : null,
        });
    } catch (e) {
        console.warn('saveSettingsBackup failed:', e);
    }
}

// Returns keys where backup has a value that differs from current.
function diffSettings(backup, current) {
    const diff = {};
    for (const key of Object.keys(backup)) {
        if (backup[key] !== null && backup[key] !== undefined &&
            key in current && backup[key] !== current[key]) {
            diff[key] = backup[key];
        }
    }
    return diff;
}

export async function reconcileSettingsWithBackup() {
    try {
        await openDB();
        const backup = await getSetting('settingsBackup');
        // Skip if no backup, or backup is older than 30 days (avoid re-applying ancient data)
        if (!backup?.ts || (Date.now() - backup.ts) > 30 * 24 * 60 * 60 * 1000) return;

        const restored = [];

        if (backup.rea && settingsCache.rea) {
            const diff = diffSettings(backup.rea, settingsCache.rea);
            if (Object.keys(diff).length) {
                await setReaSettings(diff);
                Object.assign(settingsCache.rea, diff);
                restored.push('app settings');
            }
        }
        if (backup.de1 && settingsCache.de1) {
            const diff = diffSettings(backup.de1, settingsCache.de1);
            if (Object.keys(diff).length) {
                await setDe1Settings(diff);
                Object.assign(settingsCache.de1, diff);
                restored.push('DE1 settings');
            }
        }
        if (backup.de1Advanced && settingsCache.de1Advanced) {
            const diff = diffSettings(backup.de1Advanced, settingsCache.de1Advanced);
            if (Object.keys(diff).length) {
                await setDe1AdvancedSettings(diff);
                Object.assign(settingsCache.de1Advanced, diff);
                restored.push('advanced settings');
            }
        }
        if (backup.steamSettings && settingsCache.workflow?.steamSettings) {
            const diff = diffSettings(backup.steamSettings, settingsCache.workflow.steamSettings);
            if (Object.keys(diff).length) {
                const merged = { ...settingsCache.workflow.steamSettings, ...diff };
                await updateWorkflow({ steamSettings: merged });
                settingsCache.workflow.steamSettings = merged;
                restored.push('steam settings');
            }
        }
        if (backup.hotWaterData && settingsCache.workflow?.hotWaterData) {
            const diff = diffSettings(backup.hotWaterData, settingsCache.workflow.hotWaterData);
            if (Object.keys(diff).length) {
                const merged = { ...settingsCache.workflow.hotWaterData, ...diff };
                await updateWorkflow({ hotWaterData: merged });
                settingsCache.workflow.hotWaterData = merged;
                restored.push('hot water settings');
            }
        }

        if (restored.length) {
            ui.showToast(`Settings restored from backup: ${restored.join(', ')}`, 6000, 'info');
        }
    } catch (e) {
        console.warn('reconcileSettingsWithBackup failed:', e);
    }
}

// ── Render settings content based on selected category
export function renderSettingsContent(category) {
    // Determine loading state for the specific category
    let isLoading = false;
    let error = null;

    switch(category) {
        case 'rea':
        case 'quickadjustments':
        case 'flowmultiplier':
            isLoading = settingsCache.reaLoading;
            error = settingsCache.reaError;
            break;
        case 'de1':
        case 'fanthreshold':
        case 'watertank':
        case 'flush':
        case 'steam':
        case 'hotwater':
        case 'calib_fan':
            isLoading = settingsCache.de1Loading;
            error = settingsCache.de1Error;
            break;
        case 'usbchargermode':
            isLoading = settingsCache.de1Loading || settingsCache.reaLoading;
            error = settingsCache.de1Error || settingsCache.reaError;
            break;
        case 'machineinfo':
            isLoading = settingsCache.machineInfoLoading;
            error = settingsCache.machineInfoError;
            break;
        case 'de1advanced':
        case 'calib_refillkit':
        case 'calib_voltage':
            isLoading = settingsCache.de1AdvancedLoading;
            error = settingsCache.de1AdvancedError;
            break;
        default:
            // For categories that don't require specific settings, check if any settings are loading
            isLoading = settingsCache.reaLoading || settingsCache.de1Loading || settingsCache.de1AdvancedLoading;
            break;
    }

    // Show loading state if the required settings are still loading
    if (isLoading) {
        return renderLoadingState(getCategoryTitle(category));
    }

    // Show error state if there was an error loading the required settings
    if (error && (
        category === 'rea' ||
        category === 'quickadjustments' ||
        category === 'flowmultiplier' ||
        category === 'de1' ||
        category === 'fanthreshold' ||
        category === 'usbchargermode' ||
        category === 'watertank' ||
        category === 'flush' ||
        category === 'steam' ||
        category === 'hotwater' ||
        category === 'de1advanced' ||
        category === 'calib_fan' ||
        category === 'calib_refillkit' ||
        category === 'calib_voltage'
    )) {
        return renderErrorState(getCategoryTitle(category), error);
    }

    // Render actual content once settings are loaded
    switch(category) {
        case 'rea':
            return renderReaSettingsForm(settingsCache.rea);
        case 'quickadjustments':
        case 'flowmultiplier':
            return renderFlowMultiplierSettings(settingsCache.rea);
        case 'steam':
            return renderSteamSettings();
        case 'hotwater':
            return renderHotWaterSettings();
        case 'watertank':
            return renderWaterTankSettings();
        case 'flush':
            return renderFlushSettingsForm(settingsCache.de1);
        case 'ble_scale':
            return renderBluetoothScaleSettings(settingsCache.rea);
        case 'ble_machine':
            return renderBluetoothMachineSettings();
        case 'calib_fan':
            return renderCalibFanSettings(settingsCache.de1);
        case 'calib_defaultload':
            return renderCalibDefaultLoadSettings();
        case 'calib_refillkit':
            return renderCalibRefillKitSettings();
        case 'calib_voltage':
            return renderCalibVoltageSettings();
        case 'calib_steam':
            return renderCalibSteamSettings();
        case 'maint_descaling':
            return renderMainDescalingSettings();
        case 'maint_airpurge':
            return renderMainAirPurgeSettings();
        case 'skin':
        case 'appearance':
            return renderSkinSettings();
        case 'language':
        case 'selectlanguage':
            return renderLanguageSettings();
        case 'plugins':
            return renderPluginManagerSettings();
        case 'extensions':
        case 'extention1':
        case 'extention2':
            return renderExtensionsSettings();
        case 'screensaver':
            return renderScreenSaverSettings();
        case 'brightness':
            return renderBrightnessSettings();
        case 'wakelock':
            return renderWakeLockSettings();
        case 'presence':
            return renderPresenceSettings();
        case 'unitssettings':
            return renderUnitsSettings();
        case 'fontsize':
            return renderFontSizeSettings();
        case 'resolution':
            return renderResolutionSettings();
        case 'machineadvancedsettings':
        case 'misc':
        case 'miscellaneous':
            return renderMiscellaneousSettings();
        case 'firmware':
        case 'firmwareupdate':
            return renderFirmwareUpdateSettings();
        case 'feedback':
            return renderFeedbackSettings();
        case 'talkdecent':
            return renderTalkToDecentSettings();
        case 'usermanual':
        case 'onlinehelp':
        case 'tutorials':
        case 'help':
            console.log("rendering user manual ");
            return renderUserManualSettings();
        case 'de1':
        case 'fanthreshold':
            return renderFanThresholdSettings(settingsCache.de1);
        case 'usbchargermode':
            return renderUsbChargerModeSettings(settingsCache.de1);
        case 'machineinfo':
            return renderMachineInformationSettings();
        case 'de1advanced':
            return renderDe1AdvancedSettingsForm(settingsCache.de1Advanced);
        case 'hot water':
            return renderHotWaterSettings(settingsCache.de1);
        case 'keyboard_shortcuts':
            return renderKeyboardShortcutsSettings();
        default:
            return renderGeneralSettings();
    }
}

// Render Flow Multiplier settings
export function renderFlowMultiplierSettings(settings) {
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Flow Multiplier Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load flow multiplier settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Flow Multiplier Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p id="weight-flow-multiplier-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Weight Flow Multiplier
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="weight-flow-mult-minus" aria-label="Decrease weight flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWeightFlowMultiplier(-0.1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="decimal" id="weightFlowMultiplierInput" aria-labelledby="weight-flow-multiplier-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.weightFlowMultiplier !== undefined ? settings.weightFlowMultiplier : 1.0}"
                                   step="0.1" min="0" max="5"
                                   onchange="window.updateReaSetting('weightFlowMultiplier', parseFloat(this.value))">
                        </div>
                        <button id="weight-flow-mult-plus" aria-label="Increase weight flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWeightFlowMultiplier(0.1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Multiplier for projected weight calculation. Higher values stop shots earlier.<br>
                        <span class="text-[20px] opacity-60">Range: 0 – 5</span>
                    </p>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px] mt-[30px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p id="volume-flow-multiplier-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Volume Flow Multiplier
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="volume-flow-mult-minus" aria-label="Decrease volume flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustVolumeFlowMultiplier(-0.05);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="decimal" id="volumeFlowMultiplierInput" aria-labelledby="volume-flow-multiplier-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.volumeFlowMultiplier !== undefined ? settings.volumeFlowMultiplier : 0.3}"
                                   step="0.05" min="0" max="2"
                                   onchange="window.updateReaSetting('volumeFlowMultiplier', parseFloat(this.value))">
                            <span class="ml-2 text-nowrap" aria-hidden="true">s</span>
                        </div>
                        <button id="volume-flow-mult-plus" aria-label="Increase volume flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustVolumeFlowMultiplier(0.05);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Look-ahead time for projected volume calculation. Accounts for system lag.<br>
                        <span class="text-[20px] opacity-60">Range: 0 – 2 s</span>
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render REA settings form matching design
export function renderReaSettingsForm(settings) {
    if (!settings) {
        return `
            <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                    <p class="leading-[1.2]">Application Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load decent.app settings</div>
            </div>
        `;
    }

    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]">decent.app Application Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex flex-col items-start relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px] mb-[20px]">
                            <p id="gateway-mode-label" class="leading-[1.2]">Gateway Mode</p>
                        </div>
                        <div class="flex items-center justify-between w-full max-w-[885px]" role="group" aria-labelledby="gateway-mode-label">
                            <button class="h-[120px] w-[295px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[30px] flex items-center justify-center cursor-pointer transition-colors duration-200
                                ${settings.gatewayMode === 'disabled' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                                aria-pressed="${settings.gatewayMode === 'disabled'}"
                                onclick="window.updateReaSetting('gatewayMode', 'disabled')">
                                Disabled
                            </button>
                            <button class="h-[120px] w-[295px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[30px] flex items-center justify-center cursor-pointer transition-colors duration-200
                                ${settings.gatewayMode === 'tracking' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                                aria-pressed="${settings.gatewayMode === 'tracking'}"
                                onclick="window.updateReaSetting('gatewayMode', 'tracking')">
                                Tracking
                            </button>
                            <button class="h-[120px] w-[295px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[30px] flex items-center justify-center cursor-pointer transition-colors duration-200
                                ${settings.gatewayMode === 'full' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                                aria-pressed="${settings.gatewayMode === 'full'}"
                                onclick="window.updateReaSetting('gatewayMode', 'full')">
                                Full
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words">
                        Controls how the gateway monitors and controls the espresso machine
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p id="log-level-label" class="leading-[1.2]">Log Level</p>
                        </div>
                        <select id="logLevelSelect" aria-labelledby="log-level-label" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]"
                                onchange="window.updateReaSetting('logLevel', this.value)">
                            <option value="ALL" ${settings.logLevel === 'ALL' ? 'selected' : ''}>ALL</option>
                            <option value="FINEST" ${settings.logLevel === 'FINEST' ? 'selected' : ''}>FINEST</option>
                            <option value="FINER" ${settings.logLevel === 'FINER' ? 'selected' : ''}>FINER</option>
                            <option value="FINE" ${settings.logLevel === 'FINE' ? 'selected' : ''}>FINE</option>
                            <option value="CONFIG" ${settings.logLevel === 'CONFIG' ? 'selected' : ''}>CONFIG</option>
                            <option value="INFO" ${settings.logLevel === 'INFO' ? 'selected' : ''}>INFO</option>
                            <option value="WARNING" ${settings.logLevel === 'WARNING' ? 'selected' : ''}>WARNING</option>
                            <option value="SEVERE" ${settings.logLevel === 'SEVERE' ? 'selected' : ''}>SEVERE</option>
                            <option value="SHOUT" ${settings.logLevel === 'SHOUT' ? 'selected' : ''}>SHOUT</option>
                            <option value="OFF" ${settings.logLevel === 'OFF' ? 'selected' : ''}>OFF</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words">
                        Sets the verbosity of application logging output
                    </p>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Automatic Update Checks</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]"
                                onchange="window.updateReaSetting('automaticUpdateCheck', this.value === 'true')">
                            <option value="true" ${settings.automaticUpdateCheck !== false ? 'selected' : ''}>Enabled</option>
                            <option value="false" ${settings.automaticUpdateCheck === false ? 'selected' : ''}>Disabled</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words pr-[270px]">
                        Check for app updates every 12 hours automatically
                    </p>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Scale Power Management</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]"
                                onchange="window.updateReaSetting('scalePowerMode', this.value)">
                            <option value="disabled" ${(settings.scalePowerMode || 'disabled') === 'disabled' ? 'selected' : ''}>Disabled</option>
                            <option value="displayOff" ${settings.scalePowerMode === 'displayOff' ? 'selected' : ''}>Display Off</option>
                            <option value="disconnect" ${settings.scalePowerMode === 'disconnect' ? 'selected' : ''}>Disconnect</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words pr-[270px]">
                        Controls automatic scale power management when the machine sleeps. Display Off turns off the scale display. Disconnect disconnects the scale completely.
                    </p>
                </div>
            </div>

            ${settings.webUiPath ? `
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[20px] items-start relative w-full max-w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Web UI Path</p>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal text-[20px] text-[var(--text-secondary)] break-all">${settings.webUiPath}</p>
                </div>
            </div>
            ` : ''}

        </div>
    `;
}

// Render Flush settings form
export function renderFlushSettingsForm(settings) {
    console.log("rendering flush settings form with settings: ", settings);
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Flush Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load flush settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Flush Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p id="flush-temp-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Flush Temperature
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="flush-temp-minus" aria-label="Decrease flush temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushTemp(-5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="flushTempInput" aria-labelledby="flush-temp-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.flushTemp !== undefined ? settings.flushTemp : ''}"
                                   step="5" min="5" max="95"
                                   onchange="window.updateDe1Setting('flushTemp', parseFloat(this.value))">
                            <span class="ml-2" aria-hidden="true">°C</span>
                        </div>
                        <button id="flush-temp-plus" aria-label="Increase flush temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushTemp(5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Temperature for flush cycles
                    </p>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px] mt-[30px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p id="flush-flow-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Flush Flow
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="flush-flow-minus" aria-label="Decrease flush flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushFlow(-1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="flushFlowInput" aria-labelledby="flush-flow-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.flushFlow !== undefined ? settings.flushFlow : ''}"
                                   step="1" min="1" max="8"
                                   onchange="window.updateDe1Setting('flushFlow', parseFloat(this.value))">
                            <span class="ml-2 text-nowrap" aria-hidden="true">ml/s</span>
                        </div>
                        <button id="flush-flow-plus" aria-label="Increase flush flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushFlow(1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Flow rate for flush cycles
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render Fan Threshold settings
export function renderFanThresholdSettings(settings) {
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Fan Threshold</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load DE1 settings</div>
            </div>
        `;
    }

    const fanVal = settings.fan !== undefined ? settings.fan : 40;
    const pct = Math.round(Math.max(0, Math.min(100, fanVal)));

    return `
        <div class="content-stretch flex flex-col gap-[48px] items-start relative w-full">

            <!-- Page title -->
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Fan Threshold</p>
            </div>

            <!-- Central stepper card -->
            <div class="w-full bg-[var(--box-color)] border-2 border-[var(--profile-button-outline-color)] rounded-[24px] p-[40px] flex flex-col items-center gap-[32px]">

                <!-- Label row -->
                <div class="flex items-center gap-[10px]">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-[#385a92]">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
                    </svg>
                    <span class="text-[#385a92] text-[24px] font-bold tracking-wide uppercase">Fan Activation Temperature</span>
                </div>

                <!-- Stepper controls -->
                <div class="flex items-center gap-[24px]">
                    <button id="fan-decrement"
                            onclick="window.stepFanThreshold(-1)"
                            class="w-[88px] h-[88px] rounded-full border-2 border-[#385a92] bg-[var(--box-color)] text-[#385a92] text-[40px] font-bold flex items-center justify-center active:bg-[#385a92] active:text-white transition-colors select-none"
                            aria-label="Decrease fan threshold">
                        −
                    </button>

                    <div class="flex flex-col items-center gap-[4px]">
                        <div class="flex items-end gap-[6px]">
                            <span id="fan-display" class="text-[var(--text-primary)] font-bold leading-none"
                                  style="font-size: 96px; font-family: 'Inter', monospace; letter-spacing: -2px;">${pct}</span>
                            <span class="text-[#385a92] text-[36px] font-bold mb-[12px]">°C</span>
                        </div>
                        <input type="hidden" id="fanThresholdInput" value="${pct}">
                    </div>

                    <button id="fan-increment"
                            onclick="window.stepFanThreshold(1)"
                            class="w-[88px] h-[88px] rounded-full border-2 border-[#385a92] bg-[var(--box-color)] text-[#385a92] text-[40px] font-bold flex items-center justify-center active:bg-[#385a92] active:text-white transition-colors select-none"
                            aria-label="Increase fan threshold">
                        +
                    </button>
                </div>

                <!-- Range track -->
                <div class="w-full flex flex-col gap-[8px]">
                    <div class="w-full h-[8px] rounded-full bg-[var(--profile-button-outline-color)] overflow-hidden">
                        <div id="fan-track-fill"
                             class="h-full rounded-full bg-[#385a92] transition-all duration-150"
                             style="width: ${pct}%"></div>
                    </div>
                    <div class="flex justify-between text-[18px] text-[var(--text-primary)] opacity-50">
                        <span>0°C</span>
                        <span>Range: 0 – 100°C</span>
                        <span>100°C</span>
                    </div>
                </div>
            </div>

            <!-- Description -->
            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.5] text-[var(--text-primary)] text-[24px] w-full">
                The fan activates when the machine's internal temperature exceeds this threshold.
                Lower values run the fan more often; higher values keep it quieter during operation.
            </p>
        </div>
    `;
}

// Render USB Charger settings — combines USB charger toggle + Smart Charging controls
export function renderUsbChargerModeSettings(settings) {
    const reaSettings = settingsCache.rea;
    if (!settings || !reaSettings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">USB Charger</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load settings</div>
            </div>
        `;
    }

    const chargingMode = reaSettings.chargingMode || 'disabled';
    const nightModeEnabled = reaSettings.nightModeEnabled || false;
    const sleepTime = reaSettings.nightModeSleepTime ?? 1320;
    const morningTime = reaSettings.nightModeMorningTime ?? 420;
    const chargingState = reaSettings.chargingState;

    const phaseLabels = {
        inactive: 'Inactive',
        normal: 'Normal',
        hovering: 'Hovering',
        chargingToMax: 'Charging to Max',
        sleeping: 'Sleeping'
    };

    const nightModeSection = chargingMode !== 'disabled' ? `
        <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

        <div class="content-stretch flex flex-col items-start relative w-full">
            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Night Mode</p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" id="night-mode-toggle"
                               class="sr-only peer"
                               ${nightModeEnabled ? 'checked' : ''}
                               onchange="handleNightModeToggle(this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                    Charge conservatively overnight between a sleep time and a morning time
                </p>
            </div>
        </div>

        ${nightModeEnabled ? `
        <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

        <div class="content-stretch flex flex-col items-start relative w-full">
            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Sleep Time</p>
                    </div>
                    <input type="time"
                           id="night-mode-sleep-time"
                           class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[200px] text-[var(--text-primary)] text-[26px] font-bold text-center"
                           value="${minutesToTimeString(sleepTime)}"
                           onchange="handleNightModeTimeChange('sleep', this.value)">
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                    Time to start night charging mode (e.g. 22:00)
                </p>
            </div>
        </div>

        <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

        <div class="content-stretch flex flex-col items-start relative w-full">
            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Morning Time</p>
                    </div>
                    <input type="time"
                           id="night-mode-morning-time"
                           class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[200px] text-[var(--text-primary)] text-[26px] font-bold text-center"
                           value="${minutesToTimeString(morningTime)}"
                           onchange="handleNightModeTimeChange('morning', this.value)">
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                    Time to end night charging mode (e.g. 07:00)
                </p>
            </div>
        </div>
        ` : ''}
    ` : '';

    const statusSection = chargingState ? `
        <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

        <div class="content-stretch flex flex-col items-start relative w-full">
            <div class="content-stretch flex flex-col gap-[20px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]">Charging Status</p>
                </div>
                <div class="grid grid-cols-2 gap-x-8 gap-y-4 w-full text-[22px] text-[var(--text-primary)]">
                    <span class="font-semibold">Battery</span>
                    <span>${chargingState.batteryPercent ?? '--'}%${chargingState.isEmergency ? ' (emergency)' : ''}</span>
                    <span class="font-semibold">Phase</span>
                    <span>${phaseLabels[chargingState.currentPhase] || chargingState.currentPhase || '--'}</span>
                    <span class="font-semibold">USB Charger</span>
                    <span>${chargingState.usbChargerOn ? 'On' : 'Off'}</span>
                </div>
            </div>
        </div>
    ` : '';

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">

            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">USB Charger</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="flex items-center justify-between w-full">
                <div class="flex flex-col gap-[8px]">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">USB Charger Mode</p>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px]">
                        Controls whether the USB port provides power for charging devices
                    </p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="usbChargerModeToggle"
                           class="sr-only peer"
                           ${settings.usb ? 'checked' : ''}
                           onchange="window.updateDe1Setting('usb', this.checked ? 'enable' : 'disable')">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Charging Mode</p>
                    </div>
                    <div class="grid grid-cols-2 gap-[16px] w-full">
                        ${[
                            { value: 'disabled',         label: 'Charge to 100%',   sub: 'no battery management' },
                            { value: 'highAvailability', label: 'Charge to 95%',    sub: 'slightly better battery life' },
                            { value: 'balanced',         label: 'Charge up to 80%', sub: 'better battery life' },
                            { value: 'longevity',        label: 'Charge up to 55%', sub: 'best battery life' }
                        ].map(({ value, label, sub }) => {
                            const active = chargingMode === value;
                            return `<button
                                onclick="handleSmartChargingModeChange('${value}')"
                                aria-pressed="${active}"
                                class="flex flex-col items-start justify-center gap-[6px] px-[24px] py-[20px] rounded-[14px] border-2 transition-colors duration-150 cursor-pointer text-left
                                    ${active
                                        ? 'bg-[#385a92] border-[#385a92] text-white'
                                        : 'bg-[var(--box-color)] border-[var(--profile-button-outline-color)] text-[var(--text-primary)]'}">
                                <span class="font-['Inter:Bold',sans-serif] font-bold text-[26px] leading-tight">${label}</span>
                                <span class="font-['Inter:Regular',sans-serif] text-[19px] leading-snug opacity-80">${sub}</span>
                            </button>`;
                        }).join('')}
                    </div>
                </div>
            </div>

            ${nightModeSection}

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Dim the screen when low battery</p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="low-battery-brightness-limit-toggle"
                                   class="sr-only peer"
                                   ${reaSettings.lowBatteryBrightnessLimit ? 'checked' : ''}
                                   onchange="window.updateReaSetting('lowBatteryBrightnessLimit', this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                       
                    </p>
                </div>
            </div>

            ${statusSection}
        </div>
    `;
}

// Render DE1 Advanced settings form
export function renderDe1AdvancedSettingsForm(settings) {
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Machine Advanced Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load DE1 advanced settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Machine Advanced Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Heater Phase 1 Flow</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease heater phase 1 flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh1Flow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="heaterPh1FlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${settings.heaterPh1Flow !== undefined ? settings.heaterPh1Flow : ''}"
                                       step="0.1" min="0" max="10"
                                       onchange="window.updateDe1AdvancedSetting('heaterPh1Flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase heater phase 1 flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh1Flow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Flow rate during heater phase 1 &nbsp;<span class="text-[20px] opacity-60">Range: 0 – 10 ml/s</span>
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Heater Phase 2 Flow</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease heater phase 2 flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh2Flow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="heaterPh2FlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${settings.heaterPh2Flow !== undefined ? settings.heaterPh2Flow : ''}"
                                       step="0.1" min="0" max="10"
                                       onchange="window.updateDe1AdvancedSetting('heaterPh2Flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase heater phase 2 flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh2Flow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Flow rate during heater phase 2 &nbsp;<span class="text-[20px] opacity-60">Range: 0 – 10 ml/s</span>
                    </p>
                </div>
            </div>
        </div>
    `;
}


// Render user manual settings
export function renderUserManualSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">User Manual</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Online Help</p>
                        </div>
                        <a href="https://decentespresso.com/support/submit" target="_blank" class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            Visit
                        </a>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Get support and submit tickets for assistance
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Tutorials</p>
                        </div>
                        <a href="https://decentespresso.com/doc/quickstart/" target="_blank" class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            View
                        </a>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Learn how to get started with your espresso machine
                    </p>
                </div>
            </div>
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Start writing your own skin.</p>
                        </div>
                        <a href="https://github.com/tadelv/reaprime/blob/main/doc/Skins.md#skinsmd" target="_blank" class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            View
                        </a>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Learn how to use Decent.app to create custom skins and more.
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderTalkToDecentSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[48px] items-start relative w-full">

            <!-- Header -->
            <div class="flex flex-col gap-[8px] w-full">
                <div class="flex items-center gap-[16px]">
                    <div class="w-[48px] h-[48px] rounded-full bg-[#385a92] flex items-center justify-center flex-shrink-0">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z" fill="white"/>
                        </svg>
                    </div>
                    <div>
                        <p class="text-[36px] font-semibold text-[var(--text-primary)] leading-[1.1]">Talk to Decent</p>
                        <p class="text-[20px] text-[var(--low-contrast-white)] leading-[1.3]">Direct line to the Decent support team</p>
                    </div>
                </div>
            </div>

            <!-- Not logged in state -->
            <div id="talkdecent-logged-out" class="w-full">
                <div class="flex flex-col gap-[24px] p-[36px] rounded-[20px] border-2 border-dashed border-[var(--profile-button-outline-color)] bg-[var(--box-color)] items-center text-center">
                    <div class="w-[64px] h-[64px] rounded-full bg-[var(--button-grey)] flex items-center justify-center">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 12C14.7614 12 17 9.76142 17 7C17 4.23858 14.7614 2 12 2C9.23858 2 7 4.23858 7 7C7 9.76142 9.23858 12 12 12Z" fill="currentColor" class="text-[var(--low-contrast-white)]"/>
                            <path d="M12 14C7.58172 14 4 17.5817 4 22H20C20 17.5817 16.4183 14 12 14Z" fill="currentColor" class="text-[var(--low-contrast-white)]"/>
                        </svg>
                    </div>
                    <div class="flex flex-col gap-[8px]">
                        <p class="text-[26px] font-bold text-[var(--text-primary)]">No Decent account linked</p>
                        <p class="text-[22px] text-[var(--low-contrast-white)] max-w-[500px] leading-[1.4]">
                            Link your Decent account in the Decent app to send messages to support.
                        </p>
                    </div>
                </div>
            </div>

            <!-- Logged in / compose state -->
            <div id="talkdecent-logged-in" class="hidden w-full flex flex-col gap-[36px]">

                <!-- Account badge -->
                <div class="flex items-center p-[20px] rounded-[14px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] gap-[14px]">
                    <div class="w-[40px] h-[40px] rounded-full bg-[#385a92] flex items-center justify-center text-white text-[18px] font-bold">D</div>
                    <div>
                        <p class="text-[20px] font-semibold text-[var(--text-primary)]">Decent account linked</p>
                        <p class="text-[18px] text-[var(--low-contrast-white)]" id="talkdecent-account-serial"></p>
                    </div>
                </div>

                <!-- Chat thread -->
                <div class="flex flex-col gap-[12px] w-full">
                    <div class="flex items-center justify-between">
                        <p class="text-[22px] font-bold text-[#385a92]">Conversation History</p>
                        <button id="talkdecent-refresh-btn"
                                onclick="window.talkDecentRefresh()"
                                class="h-[38px] px-[20px] rounded-[38px] bg-[var(--button-grey)] text-[var(--text-primary)] text-[18px] flex items-center gap-[8px] transition-opacity hover:opacity-80 disabled:opacity-40">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M1 4V10H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M3.51 15a9 9 0 1 0 .49-4.17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            Refresh
                        </button>
                    </div>
                    <div id="talkdecent-thread-messages"
                         class="flex flex-col gap-[14px] max-h-[480px] overflow-y-auto p-[20px] bg-[var(--box-color)] rounded-[16px] border border-[var(--profile-button-outline-color)]">
                        <p class="text-center text-[18px] text-[var(--low-contrast-white)] py-[16px]">Loading messages…</p>
                    </div>
                    <p id="talkdecent-thread-status" class="text-[18px] text-[var(--low-contrast-white)] text-center hidden"></p>
                </div>

                <!-- New message compose -->
                <div class="flex flex-col gap-[24px] w-full">
                    <p class="text-[22px] font-bold text-[#385a92]">New Message</p>
                    <input id="talkdecent-subject" type="hidden" value="">
                    <textarea id="talkdecent-message" class="hidden"></textarea>
                    <div id="talkdecent-compose-preview"
                         onclick="window.openTalkDecentMessageEditor()"
                         class="cursor-pointer rounded-[14px] p-[20px] bg-[var(--box-color)] border-2 border-[#385a92] w-full min-h-[90px] select-none transition-colors hover:border-blue-400">
                        <p class="text-[20px] text-[var(--low-contrast-white)]">Tap to compose a message…</p>
                    </div>
                    <!-- Attach machine info toggle -->
                    <div class="flex items-center justify-between p-[20px] rounded-[12px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)]">
                        <div class="flex flex-col gap-[4px]">
                            <p class="text-[22px] font-bold text-[#385a92]">Attach Machine Info</p>
                            <p class="text-[20px] text-[var(--low-contrast-white)]">Appends machine model, firmware version, and serial number</p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="talkdecent-attach-machine" checked class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    <div class="flex items-center gap-[20px]">
                        <button id="talkdecent-send-btn"
                                onclick="window.sendDecentMessage()"
                                class="h-[64px] px-[48px] rounded-[64px] bg-[#385a92] text-white text-[24px] font-bold transition-opacity hover:opacity-90">
                            Send Message
                        </button>
                        <span id="talkdecent-send-status" class="text-[22px] leading-[1.4]"></span>
                    </div>
                </div>
            </div>

        </div>
    `;
}

// Render Feedback / bug report page

export function renderFeedbackSettings() {
    const categories = [
        { value: 'bug',      label: 'Bug Report',       sub: 'Something isn\'t working' },
        { value: 'feature',  label: 'Feature Request',  sub: 'Suggest an improvement'   },
        { value: 'question', label: 'General Feedback', sub: 'Share thoughts or ideas'  },
    ];

    const categoryCards = categories.map(({ value, label, sub }) => `
        <button data-feedback-card="${value}"
                aria-pressed="${value === 'bug'}"
                onclick="window.selectFeedbackCategory('${value}')"
                class="flex flex-col items-start gap-[4px] p-[14px] rounded-[12px] border-2 transition-colors
                       ${value === 'bug'
                           ? 'bg-[#385a92] border-[#385a92] text-white'
                           : 'bg-[var(--box-color)] border-[var(--profile-button-outline-color)] text-[var(--text-primary)]'}">
            <span class="text-[20px] font-bold leading-tight">${label}</span>
            <span class="text-[16px] opacity-75 leading-tight">${sub}</span>
        </button>
    `).join('');

    return `
        <div class="content-stretch flex flex-col gap-[24px] items-start relative w-full">
            <p class="font-semibold text-[var(--text-primary)] text-[32px] w-full text-center">Send Feedback</p>

            <!-- Decent Account -->
            <div id="decent-account-section" class="flex flex-col gap-[12px] w-full p-[18px] rounded-[12px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)]">
                <p class="font-bold text-[#385a92] text-[22px]">Decent Account</p>

                <div id="decent-logged-out">
                    <p class="text-[19px] text-[var(--low-contrast-white)]">Link your Decent account in the Decent app to tag feedback with your account.</p>
                </div>

                <div id="decent-logged-in" class="hidden">
                    <p class="text-[20px] text-[var(--text-primary)]">Decent account linked</p>
                    <p id="decent-account-serial" class="text-[18px] text-[var(--low-contrast-white)] mt-[4px]"></p>
                </div>
            </div>

            <!-- Category -->
            <div class="flex flex-col gap-[10px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]">Category</p>
                <input type="hidden" id="feedback-category" value="bug">
                <div class="grid grid-cols-3 gap-[10px] w-full">
                    ${categoryCards}
                </div>
            </div>

            <!-- Title -->
            <div class="flex flex-col gap-[8px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]">Title</p>
                <input type="text" id="feedback-title"
                       class="bg-[var(--box-color)] border-2 border-[#385a92] h-[54px] rounded-[54px] w-full text-[var(--text-primary)] text-[22px] px-[24px]"
                       placeholder="Short summary of your feedback…">
            </div>

            <!-- Contact email (optional) -->
            <div class="flex flex-col gap-[8px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]">Contact Email <span class="text-[19px] font-normal opacity-60">(optional)</span></p>
                <input type="email" id="feedback-email"
                       class="bg-[var(--box-color)] border-2 border-[#385a92] h-[54px] rounded-[54px] w-full text-[var(--text-primary)] text-[22px] px-[24px]"
                       placeholder="your@email.com">
            </div>

            <!-- Description -->
            <div class="flex flex-col gap-[8px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]">Description</p>
                <textarea id="feedback-description" class="hidden"></textarea>
                <div id="feedback-description-preview"
                     onclick="window.openFeedbackDescriptionEditor()"
                     class="cursor-pointer bg-[var(--box-color)] border-2 border-[#385a92] rounded-[14px] w-full min-h-[110px] text-[21px] p-[18px] whitespace-pre-wrap select-none text-[var(--low-contrast-white)]">
                    Tap to write description…
                </div>
            </div>

            <!-- System info toggle -->
            <div class="flex items-center justify-between w-full">
                <div class="flex flex-col gap-[4px]">
                    <p class="font-bold text-[#385a92] text-[22px]">Attach System Info</p>
                    <p class="text-[var(--text-primary)] text-[19px]">Appends app version and machine firmware to the report</p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="feedback-attach-sysinfo" checked class="sr-only peer">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <!-- Submit -->
            <div class="flex flex-col gap-[12px] w-full">
                <button id="feedback-submit-btn"
                        onclick="window.submitFeedback()"
                        class="bg-[#385a92] h-[54px] px-[40px] rounded-[54px] text-white text-[22px] font-bold self-start">
                    Submit
                </button>
                <div id="feedback-status" class="text-[22px] leading-[1.4]"></div>
            </div>
        </div>
    `;
}

// Render Screen Saver settings
export function renderScreenSaverSettings() {
    const enabled = localStorage.getItem('screensaverEnabled') !== 'false';
    const hasCustom = screensaverImagesCache.length > 0;

    const thumbnails = screensaverImagesCache.map((src, i) => `
        <div class="relative w-[120px] h-[80px] rounded-[10px] overflow-hidden flex-shrink-0">
            <img src="${src}" class="w-full h-full object-cover" alt="Screensaver ${i + 1}">
        </div>
    `).join('');

    const imageSection = hasCustom ? `
        <div class="flex flex-wrap gap-[12px]">${thumbnails}</div>
        <div class="flex items-center gap-[16px]">
            <button class="bg-[#385a92] h-[62px] px-[36px] rounded-[72px] text-white text-[22px] font-bold"
                    onclick="document.getElementById('screensaver-file-input').click()">
                Add Images
            </button>
            <button class="bg-[var(--box-color)] border-2 border-[#385a92] h-[62px] px-[36px] rounded-[72px] text-[#385a92] text-[22px] font-bold"
                    onclick="window.clearScreensaverImages()">
                Clear All
            </button>
        </div>
        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full">
            ${screensaverImagesCache.length} image${screensaverImagesCache.length !== 1 ? 's' : ''} selected${screensaverImagesCache.length > 1 ? ' — cycles every 10s' : ''}
        </p>
    ` : `
        <div class="flex items-center gap-[16px]">
            <button class="bg-[#385a92] h-[62px] px-[36px] rounded-[72px] text-white text-[22px] font-bold"
                    onclick="document.getElementById('screensaver-file-input').click()">
                Choose Images
            </button>
        </div>
        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full">
            No custom images — using default. Select images from your device.
        </p>
    `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Screen Saver</p>
            </div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Enable Screen Saver</p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" class="sr-only peer"
                               ${enabled ? 'checked' : ''}
                               onchange="window.setScreensaverEnabled(this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                    Show screen saver when the machine sleeps
                </p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]">Images</p>
                </div>
                ${imageSection}
            </div>

            <input type="file" id="screensaver-file-input" class="hidden" multiple accept="image/*"
                   onchange="window.addScreensaverFiles(this.files)">
        </div>
    `;
}

// Render Brightness settings
export function renderBrightnessSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[80px] items-start relative w-full px-[60px] py-[80px]">
            <div class="content-stretch flex items-center justify-between relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px]">
                    <p class="leading-[1.2]">Screen Brightness</p>
                </div>
                
            </div>

            <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
                <div class="h-[41.92px] relative w-full">
                    <div class="flex items-center justify-between w-full">
                        <input type="range" id="brightness-slider" min="0" max="100" value="75" class="brightness-slider flex-grow" onchange="handleBrightnessChange(this.value)">
                    </div>
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[32px] w-full">
                    Adjust screen brightness level
                </p>
            </div>
        </div>
    `;
}

// Render Wake Lock settings
export function renderWakeLockSettings() {
    const wakeLockEnabled = localStorage.getItem('wakeLockEnabled') === 'true';

    return `
        <div class="space-y-6 px-[60px] py-[80px]">
            <div>
                <h2 class="text-[28px] font-bold text-[var(--text-primary)] mb-4">Wake Lock Settings</h2>
                <p class="text-[var(--text-primary)] text-[20px] mb-6 opacity-75">
                    Control screen wake-lock to prevent the display from sleeping during operation.
                </p>
            </div>

            <div class="bg-[var(--wakelock-card-bg)] rounded-lg p-6">
                <div class="flex items-center justify-between">
                    <div>
                        <label class="text-[24px] font-semibold text-[var(--wakelock-card-text)]">Enable Wake Lock</label>
                        <p class="text-[18px] text-[var(--wakelock-card-text)] opacity-75 mt-1">
                            Keep the screen on while the app is active
                        </p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" id="wake-lock-toggle" class="sr-only peer"
                               ${wakeLockEnabled ? 'checked' : ''}
                               onchange="handleWakeLockToggle(this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
            </div>

            <div class="text-[18px] text-[var(--text-primary)] opacity-75 mt-4">
                <p><strong>Note:</strong> Wake-lock automatically releases when the WebSocket disconnects.</p>
            </div>
        </div>
    `;
}

// Render Presence Detection settings (async — populates container after fetch)
export function renderPresenceSettings() {
    // Return a loading placeholder synchronously, then populate async
    loadPresenceSettingsAsync();
    return `
        <div id="presence-settings-container">
            <div class="flex items-center justify-center p-8">
                <span class="loading loading-spinner loading-lg"></span>
                <span class="ml-4 text-[20px] text-[var(--text-secondary)]">Loading presence settings...</span>
            </div>
        </div>
    `;
}

// Helper function to format days of week
function formatDaysOfWeek(days) {
    if (!days || days.length === 0) return 'Every day';
    // ISO 8601: 1=Monday, 7=Sunday
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days.map(d => dayNames[d - 1]).join(', ');
}

function formatKeepAwakeDuration(minutes) {
    if (!minutes || minutes < 1) return '';
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} min`;
    if (hrs > 0) return `${hrs} hr`;
    return `${mins} min`;
}

// Async loader for presence settings content
async function loadPresenceSettingsAsync() {
    // Small delay to ensure the placeholder DOM is rendered first
    await new Promise(resolve => setTimeout(resolve, 50));

    const container = document.getElementById('presence-settings-container');
    if (!container) return;

    try {
        const settings = await getPresenceSettings();
        const schedules = settings.schedules || [];
        const schedulesHtml = schedules.map(schedule => {
            const keepAwakeLabel = schedule.keepAwakeFor ? formatKeepAwakeDuration(schedule.keepAwakeFor) : '';
            return `
            <div class="bg-[var(--presence-card-alt-bg)] rounded-lg p-4 flex items-center justify-between" data-schedule-id="${schedule.id}">
                <div class="flex-grow">
                    <div class="text-[22px] font-semibold text-[var(--presence-card-text)]">
                        ${schedule.time} - ${formatDaysOfWeek(schedule.daysOfWeek)}
                        ${keepAwakeLabel ? `<span class="text-[18px] opacity-75 ml-2">(${keepAwakeLabel})</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" class="sr-only peer"
                               ${schedule.enabled ? 'checked' : ''}
                               onchange="handleScheduleToggle('${schedule.id}', this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                    <button class="btn btn-sm btn-error" onclick="handleDeleteSchedule('${schedule.id}')">
                        Delete
                    </button>
                </div>
            </div>
        `}).join('');

        container.innerHTML = `
            <div class="space-y-6 px-[60px] py-[80px]">
                <div>
                    <h2 class="text-[28px] font-bold text-[var(--text-primary)] mb-4">Presence Detection</h2>
                    <p class="text-[var(--text-primary)] text-[20px] mb-6 opacity-75">
                        Automatically manage machine sleep/wake based on user presence and schedules.
                    </p>
                </div>

                <div class="bg-[var(--presence-card-bg)] rounded-lg p-6">
                    <div class="flex items-center justify-between mb-6">
                        <div>
                            <label class="text-[24px] font-semibold text-[var(--presence-card-text)]">Enable Presence Detection</label>
                            <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-1">
                                Track user presence to automatically sleep the machine
                            </p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="presence-enabled-toggle" class="sr-only peer"
                                   ${settings.userPresenceEnabled ? 'checked' : ''}
                                   onchange="handlePresenceToggle(this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>

                    <div class="mt-6">
                        <label class="text-[22px] font-semibold text-[var(--presence-card-text)] block mb-3">
                            Sleep Timeout (minutes)
                        </label>
                        <input type="number"
                               id="sleep-timeout-input"
                               class="input input-bordered w-full max-w-xs text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]"
                               value="${settings.sleepTimeoutMinutes || 30}"
                               min="1"
                               max="120"
                               oninput="this.value = Math.max(1, Math.min(120, this.value))"
                               onchange="handleSleepTimeoutChange(this.value)">
                        <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-2">
                            Minutes of inactivity before auto-sleep
                        </p>
                    </div>
                </div>

                <div class="bg-[var(--presence-card-bg)] rounded-lg p-6">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[24px] font-semibold text-[var(--presence-card-text)]">Wake Schedules</h3>
                        <button class="btn btn-primary" onclick="handleAddSchedule()">
                            Add Schedule
                        </button>
                    </div>

                    <div class="space-y-3">
                        ${schedules.length > 0 ? schedulesHtml : '<p class="text-[var(--presence-card-text)] opacity-75 text-[18px]">No schedules configured</p>'}
                    </div>
                </div>

                <dialog id="add-schedule-modal" class="modal">
                    <div class="modal-box bg-[var(--presence-card-bg)] max-w-2xl">
                        <h3 class="font-bold text-[24px] text-[var(--presence-card-text)] mb-4">Add Schedule</h3>

                        <div class="space-y-4">
                            <div>
                                <label class="text-[20px] text-[var(--presence-card-text)] block mb-2">Wake Time</label>
                                <input type="time" id="schedule-time-input" class="input input-bordered w-full text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]">
                            </div>

                            <div>
                                <label class="text-[20px] text-[var(--presence-card-text)] block mb-2">Days of Week</label>
                                <div class="flex gap-2 flex-wrap">
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="1" class="checkbox checkbox-primary mr-1"> Mon</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="2" class="checkbox checkbox-primary mr-1"> Tue</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="3" class="checkbox checkbox-primary mr-1"> Wed</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="4" class="checkbox checkbox-primary mr-1"> Thu</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="5" class="checkbox checkbox-primary mr-1"> Fri</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="6" class="checkbox checkbox-primary mr-1"> Sat</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="7" class="checkbox checkbox-primary mr-1"> Sun</label>
                                </div>
                            </div>

                            <div>
                                <label class="text-[20px] text-[var(--presence-card-text)] block mb-2">Keep Awake For</label>
                                <div class="flex items-center gap-3">
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="keep-awake-hours-input" class="input input-bordered w-20 text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]"
                                               min="0" max="12" placeholder="0" value="0"
                                               oninput="this.value = Math.max(0, Math.min(12, this.value)); if (this.value == 12) { document.getElementById('keep-awake-mins-input').value = 0; } if (this.value > 12) { ui.showToast('Maximum 12 hours', 3000, 'error'); }">
                                        <span class="text-[var(--presence-card-text)]">hr</span>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="keep-awake-mins-input" class="input input-bordered w-20 text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]"
                                               min="0" max="59" placeholder="0" value="0"
                                               oninput="this.value = Math.max(0, Math.min(59, this.value))">
                                        <span class="text-[var(--presence-card-text)]">min</span>
                                    </div>
                                </div>
                                <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-1">
                                    Duration to keep machine awake after schedule fires. Max 12 hours.
                                </p>
                            </div>
                        </div>

                        <div class="modal-action">
                            <button class="btn" onclick="document.getElementById('add-schedule-modal').close()">Cancel</button>
                            <button class="btn btn-primary" onclick="handleSaveSchedule()">Save</button>
                        </div>
                    </div>
                </dialog>
            </div>
        `;
    } catch (error) {
        console.error('Error rendering presence settings:', error);
        container.innerHTML = `<div class="text-error text-[20px]">Failed to load presence settings</div>`;
    }
}

// Render App Version settings
export function renderAppVersionSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">App Version</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">App Version</p>
                        </div>
                        <div class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            1.0.0
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Current application version
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render miscellaneous settings (legacy - for backward compatibility)
export function renderUnitsSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Units Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Measurement Units</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>Metric</option>
                            <option>Imperial</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Select measurement units used throughout the application
                    </p>
                </div>
            </div>
        </div>
    `;
}

const UI_ZOOM_MAP = { 'Small': '0.85', 'Medium': '1.0', 'Large': '1.15', 'Extra Large': '1.3' };

function getUiZoomLabel() {
    const stored = localStorage.getItem('uiZoom') || '1.0';
    return Object.entries(UI_ZOOM_MAP).find(([, v]) => v === stored)?.[0] ?? 'Medium';
}

export function renderFontSizeSettings() {
    const current = getUiZoomLabel();
    const options = Object.keys(UI_ZOOM_MAP).map(label =>
        `<option${label === current ? ' selected' : ''}>${label}</option>`
    ).join('');
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Display Size</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Display Size</p>
                        </div>
                        <select id="text-size-select" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[220px] text-white text-[24px] p-2">
                            ${options}
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Adjust the display size for better readability. Changes apply after saving.
                    </p>
                </div>
            </div>
        </div>
    `;
}

function initFontSizeSettings() {
    const select = document.getElementById('text-size-select');
    if (!select) return;
    select.addEventListener('change', (e) => {
        const multiplier = UI_ZOOM_MAP[e.target.value] ?? '1.0';
        localStorage.setItem('uiZoom', multiplier);
    });
}

export function renderResolutionSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Resolution</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Display Resolution</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>1920x1200</option>
                            <option>1280x800</option>
                            <option>1024x768</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set the display resolution
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderMiscellaneousSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Miscellaneous Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Screen Saver</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>Enabled</option>
                            <option>Disabled</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Enable or disable screen saver functionality
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Brightness</p>
                        </div>
                        <input type="range" id="brightness-slider" min="0" max="100" value="75" class="brightness-slider w-[200px]" onchange="handleBrightnessChange(this.value)">
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Adjust screen brightness level
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">App Version</p>
                        </div>
                        <div class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            1.0.0
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Current application version
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Units Settings</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>Metric</option>
                            <option>Imperial</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Select measurement units for the application
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Display Size</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>Small</option>
                            <option>Medium</option>
                            <option>Large</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Adjust the display size for better readability
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Resolution</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>1920x1200</option>
                            <option>1280x800</option>
                            <option>1024x768</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set the display resolution
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Smart Charging</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>Enabled</option>
                            <option>Disabled</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Enable smart charging for connected devices
                    </p>
                </div>
            </div>
        </div>
    `;
}


// Helper: convert minutes-since-midnight to HH:MM string
function minutesToTimeString(minutes) {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
}

// Helper: convert HH:MM string to minutes-since-midnight
function timeStringToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

// Render Steam settings
export function renderSteamSettings() {
    if (!settingsCache.de1 && !settingsCache.workflow) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Steam Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load settings</div>
            </div>
        `;
    }

    const steamSettings = settingsCache.workflow?.steamSettings || {};
    const targetTemp = steamSettings.targetTemperature || 150;
    const duration = steamSettings.duration || 60;
    const flow = steamSettings.flow || 0.9;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Steam Settings</p>
            </div>

            <!-- Steam Temperature -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Target Temperature</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease steam temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamTemp(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${targetTemp}" step="1" min="130" max="170"
                                       onchange="window.updateSteamSetting('targetTemperature', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">°C</span>
                            </div>
                            <button aria-label="Increase steam temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamTemp(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Steam temperature setting &nbsp;<span class="text-[20px] opacity-60">Range: 130 – 170 °C</span>
                    </p>
                </div>
            </div>

            <!-- Steam Duration -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Duration</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease steam duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamDuration(-5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamDurationInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${duration}" step="5" min="10" max="120"
                                       onchange="window.updateSteamSetting('duration', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">s</span>
                            </div>
                            <button aria-label="Increase steam duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamDuration(5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Steam duration &nbsp;<span class="text-[20px] opacity-60">Range: 10 – 120 s</span>
                    </p>
                </div>
            </div>

            <!-- Steam Flow -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Flow</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease steam flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamFlow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="steamFlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${flow.toFixed(1)}" step="0.1" min="0.1" max="2.5"
                                       onchange="window.updateSteamSetting('flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase steam flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamFlow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Steam flow rate &nbsp;<span class="text-[20px] opacity-60">Range: 0.1 – 2.5 ml/s</span>
                    </p>
                </div>
            </div>

            <!-- Steam Purge Mode -->
            ${settingsCache.de1 ? `
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Steam Purge Mode</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2"
                                onchange="window.updateDe1Setting('steamPurgeMode', this.value)">
                            <option value="0" ${settingsCache.de1.steamPurgeMode === 0 ? 'selected' : ''}>Normal</option>
                            <option value="1" ${settingsCache.de1.steamPurgeMode === 1 ? 'selected' : ''}>Two Tap Stop</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set the steam purge mode for the machine
                    </p>
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

// Render Hot Water settings
export function renderHotWaterSettings() {
    if (!settingsCache.de1 && !settingsCache.workflow) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Hot Water Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load settings</div>
            </div>
        `;
    }

    const hotWaterData = settingsCache.workflow?.hotWaterData || {};
    const targetTemp = hotWaterData.targetTemperature || 75;
    const volume = hotWaterData.volume || 50;
    const duration = hotWaterData.duration || 30;
    const flow = hotWaterData.flow || 2.5;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Hot Water Settings</p>
            </div>

            <!-- Hot Water Temperature -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Target Temperature</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterTemp(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="hotWaterTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${targetTemp}" step="1" min="50" max="95"
                                       onchange="window.updateHotWaterSetting('targetTemperature', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">°C</span>
                            </div>
                            <button aria-label="Increase hot water temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterTemp(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Hot water temperature &nbsp;<span class="text-[20px] opacity-60">Range: 50 – 95 °C</span>
                    </p>
                </div>
            </div>

            <!-- Hot Water Volume -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Volume</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water volume" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterVolume(-10);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="hotWaterVolumeInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${volume}" step="10" min="10" max="500"
                                       onchange="window.updateHotWaterSetting('volume', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml</span>
                            </div>
                            <button aria-label="Increase hot water volume" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterVolume(10);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Hot water volume &nbsp;<span class="text-[20px] opacity-60">Range: 10 – 500 ml</span>
                    </p>
                </div>
            </div>

            <!-- Hot Water Duration -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Duration</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterDuration(-5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="hotWaterDurationInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${duration}" step="5" min="5" max="120"
                                       onchange="window.updateHotWaterSetting('duration', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">s</span>
                            </div>
                            <button aria-label="Increase hot water duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterDuration(5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Hot water duration &nbsp;<span class="text-[20px] opacity-60">Range: 5 – 120 s</span>
                    </p>
                </div>
            </div>

            <!-- Hot Water Flow -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Flow</p>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterFlow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="hotWaterFlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${flow.toFixed(1)}" step="0.1" min="0.1" max="8"
                                       onchange="window.updateHotWaterSetting('flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase hot water flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterFlow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Hot water flow rate &nbsp;<span class="text-[20px] opacity-60">Range: 0.1 – 8.0 ml/s</span>
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render Water Tank settings
export function renderWaterTankSettings() {
    if (!settingsCache.de1) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">Water Tank Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load DE1 settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Water Tank Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col gap-[30px] items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Tank Temperature
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="tank-temp-minus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustTankTemp(-1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="tankTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settingsCache.de1.tankTemp !== undefined ? settingsCache.de1.tankTemp : 25}"
                                   step="1" min="10" max="40"
                                   onchange="window.updateDe1Setting('tankTemp', parseInt(this.value))">
                            <span class="ml-2 text-nowrap">°C</span>
                        </div>
                        <button id="tank-temp-plus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustTankTemp(1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Set the water tank temperature (10-40°C)
                    </p>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Water Alert Level
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="water-alert-minus" aria-label="Decrease water alert level" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWaterAlert(-5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="waterAlertInput" aria-label="Water alert level" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${getWaterAlertLevel()}"
                                   step="5" min="0" max="30"
                                   onchange="window.commitWaterAlert(parseInt(this.value))">
                            <span class="ml-2 text-nowrap">mm</span>
                        </div>
                        <button id="water-alert-plus" aria-label="Increase water alert level" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWaterAlert(5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Alert when tank water level drops below this height (0, 5, 10, 15, 20, 25, 30 mm)
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Allowed refill levels (mm) — coarse 5mm steps from 0 to 30.
const WATER_ALERT_LEVELS = [0, 5, 10, 15, 20, 25, 30];

function snapWaterAlertLevel(value) {
    if (isNaN(value)) return 15;
    const clamped = Math.max(0, Math.min(30, value));
    return WATER_ALERT_LEVELS.reduce((best, v) =>
        Math.abs(v - clamped) < Math.abs(best - clamped) ? v : best,
    WATER_ALERT_LEVELS[0]);
}

// Read persisted water alert refill level (mm). Default 15mm.
function getWaterAlertLevel() {
    const stored = parseInt(localStorage.getItem('waterRefillLevel'), 10);
    return WATER_ALERT_LEVELS.includes(stored) ? stored : 15;
}

// Render quick adjustments settings
export function renderQuickAdjustmentsSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Quick Adjustments</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Flow Multiplier</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="1.0" step="0.1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Adjust the flow multiplier for shot timing
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Steam</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="120" step="1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set steam temperature
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Water</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="80" step="1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set water temperature
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Limit</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="30" step="1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set brewing time limit
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render calibration settings with additional subcategories
export function renderCalibFanSettings(settings) {
    const fanValue = settings?.fan !== undefined ? settings.fan : 40;
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Fan Threshold Settings</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Fan Threshold
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="calib-fan-minus" aria-label="Decrease fan threshold"
                                class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFanThreshold(-1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="calibFanInput"
                                   class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${fanValue}" step="1" min="0" max="100"
                                   onchange="window.updateDe1Setting('fan', parseInt(this.value))">
                            <span class="ml-2 text-nowrap">°C</span>
                        </div>
                        <button id="calib-fan-plus" aria-label="Increase fan threshold"
                                class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFanThreshold(1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Temperature threshold at which the fan turns on (0–100°C)
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderCalibDefaultLoadSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Default Load Settings</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Reset to Defaults</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.resetDe1Settings()">
                            Reset
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Restores fan threshold, heater idle temp, heater phase flows, phase 2 timeout, refill kit mode, flow multiplier, and steam purge to factory defaults.
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderCalibRefillKitSettings() {
    const current = settingsCache.de1Advanced?.refillKitSetting ?? -1;
    const options = [
        { label: 'Auto',      value: 2 },
        { label: 'Force On',  value: 1 },
        { label: 'Force Off', value: 0 },
    ];
    const buttons = options.map(o => {
        const active = current === o.value;
        return `<button class="h-[72px] px-[36px] rounded-[72px] text-[24px] font-bold ${active ? 'bg-[#385a92] text-white' : 'bg-[var(--box-color)] border-2 border-[#385a92] text-[#385a92]'}"
                        onclick="window.updateDe1AdvancedSetting('refillKitSetting', ${o.value})">${o.label}</button>`;
    }).join('');
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Refill Kit</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Refill Kit Mode</p>
                        </div>
                        <div class="flex items-center gap-[12px]">${buttons}</div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Auto lets the machine decide. Force On keeps the refill kit always active. Force Off disables it.
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderCalibVoltageSettings() {
    const raw = settingsCache.de1Advanced?.heaterVoltage ?? -1;
    const current = raw > 1000 ? raw - 1000 : raw;
    const options = [
        { label: '110V', value: 120 },
        { label: '220V', value: 230 },
    ];
    const buttons = options.map(o => {
        const active = current === o.value;
        return `<button class="h-[72px] px-[48px] rounded-[72px] text-[24px] font-bold ${active ? 'bg-[#385a92] text-white' : 'bg-[var(--box-color)] border-2 border-[#385a92] text-[#385a92]'}"
                        onclick="window.updateHeaterVoltage(${o.value})">${o.label}</button>`;
    }).join('');
    const unsetNote = current === -1 ? `<p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full">No voltage set yet — select your mains voltage.</p>` : '';
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Voltage</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Mains Voltage</p>
                        </div>
                        <div class="flex items-center gap-[12px]">${buttons}</div>
                    </div>
                    ${unsetNote}
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set to match your local mains voltage. Incorrect setting may affect heater performance.
                    </p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full">
                        Restart the machine after changing voltage for the setting to take effect.
                    </p>
                </div>
            </div>
        </div>
    `;
}


export function renderCalibSteamSettings() {
    const targetTemp = settingsCache.workflow?.steamSettings?.targetTemperature ?? 155;
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Steam Temperature</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]">
                            Steam Temperature
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="steam-temp-minus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustSteamCalibTemp(-1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamCalibTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${targetTemp}"
                                   step="1" min="135" max="170"
                                   onchange="window.updateSteamSetting('targetTemperature', parseInt(this.value))">
                            <span class="ml-2 text-nowrap">°C</span>
                        </div>
                        <button id="steam-temp-plus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustSteamCalibTemp(1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Set steam temperature (135-170°C)
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderMainDescalingSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Machine Descaling</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Machine Descaling</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.startDescaling()">
                            Start
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Run a descaling cycle to remove mineral buildup
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderMainAirPurgeSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Transport Mode</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Transport Mode</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.startAirPurge()">
                            Start
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full pr-[220px]">
                        Purges remaining water from the group head. Run before packing the machine to prevent leaks during transport.
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render skin settings
export function renderSkinSettings() {
    const activeSkin = settingsCache.skinInfo;
    const allSkins = settingsCache.allSkins || [];
    const activeSkinId = activeSkin?.id || '';

    const skinsTable = allSkins.length > 0 ? `
        <table class="w-full text-[20px] text-[var(--text-primary)] border-collapse">
            <thead>
                <tr class="border-b border-[#c9c9c9] text-[#385a92] font-['Inter:Bold',sans-serif] font-bold">
                    <th class="text-left py-3 pr-4">Name</th>
                    <th class="text-left py-3 pr-4">Version</th>
                    <th class="text-left py-3 pr-4">Type</th>
                    <th class="text-left py-3">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${allSkins.map(s => `
                <tr class="border-b border-[#c9c9c9]">
                    <td class="py-3 pr-4 font-['Inter:Regular',sans-serif]">${s.name}${s.id === activeSkinId ? ' <span class="text-[#385a92] font-bold">(active)</span>' : ''}</td>
                    <td class="py-3 pr-4 font-['Inter:Regular',sans-serif] text-[var(--text-secondary)]">${s.version || 'N/A'}</td>
                    <td class="py-3 pr-4 font-['Inter:Regular',sans-serif] text-[var(--text-secondary)]">${s.isBundled ? 'Bundled' : 'Installed'}</td>
                    <td class="py-3">
                        ${s.id !== activeSkinId ? `<button class="bg-[#385a92] h-[44px] rounded-[10px] px-4 text-white text-[18px] font-bold" onclick="window.setActiveSkin('${s.id}')">Set Active</button>` : '<span class="text-[var(--text-secondary)]">—</span>'}
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>
    ` : `<p class="text-[var(--text-secondary)] text-[22px]">No skins available</p>`;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Skin Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Theme</p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="theme-toggle" class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full pr-[220px]">
                        Toggle between light and dark themes
                    </p>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col gap-[24px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]">Active Skin</p>
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[22px] w-full">
                    Tap a skin to make it active. The page will reload to apply.
                </p>
                <div class="grid grid-cols-2 gap-[14px] w-full">
                    ${(allSkins.length > 0 ? allSkins : (activeSkin ? [activeSkin] : [])).map(s => {
                        const isActive = s.id === activeSkinId;
                        const ghVersion = settingsCache.githubLatestVersion;
                        const isLatest = ghVersion && s.version && s.version === ghVersion;
                        const versionKnown = !!ghVersion;
                        return `
                        <button
                            onclick="${isActive ? '' : `window.setActiveSkin('${s.id}')`}"
                            aria-pressed="${isActive}"
                            ${isActive ? 'disabled' : ''}
                            class="relative flex flex-col items-start justify-between gap-[10px] px-[22px] py-[18px] rounded-[14px] border-2 text-left transition-colors duration-150
                                ${isActive
                                    ? 'bg-[#385a92] border-[#385a92] text-white cursor-default'
                                    : 'bg-[var(--box-color)] border-[var(--profile-button-outline-color)] text-[var(--text-primary)] cursor-pointer hover:border-[#385a92]'}">
                            <div class="flex items-start justify-between w-full gap-2">
                                <span class="font-['Inter:Bold',sans-serif] font-bold text-[24px] leading-tight">${s.name}</span>
                                ${isActive ? `<span class="text-[14px] font-bold tracking-widest uppercase px-[10px] py-[4px] rounded-full bg-white bg-opacity-20 text-white shrink-0">Active</span>` : ''}
                            </div>
                            <div class="flex items-center gap-[10px]">
                                ${s.version ? `<span class="text-[17px] font-['Inter:Regular',sans-serif] opacity-80">v${s.version}</span>` : ''}
                                ${s.isBundled && /streamline/i.test(s.name) && versionKnown ? (isLatest
                                    ? `<span class="text-[13px] font-semibold px-[8px] py-[2px] rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-[#0ca581]/15 text-[#0ca581]'}">Latest</span>`
                                    : `<span class="text-[13px] font-semibold px-[8px] py-[2px] rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-[#da515e]/15 text-[#da515e]'}">Update available</span>`)
                                : ''}
                                <span class="text-[14px] font-['Inter:Regular',sans-serif] opacity-60 uppercase tracking-wider">${s.isBundled ? 'Bundled' : 'Installed'}</span>
                            </div>
                        </button>`;
                    }).join('')}
                </div>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Check for Updates</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.updateSkin()">
                            Update
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full pr-[220px]">
                        Check for and install the latest skin update
                    </p>
                </div>
            </div>

        </div>
    `;
}

// Render language settings with additional subcategories
export function renderLanguageSettings() {
    setTimeout(() => {
        const switcher = document.getElementById('language-switcher');
        if (!switcher) return;

        const supported = getSupportedLanguages();
        const current = getCurrentLanguage();

        switcher.innerHTML = '';
        supported.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            try {
                option.textContent = new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
            } catch {
                option.textContent = lang;
            }
            if (lang === current) {
                option.selected = true;
            }
            switcher.appendChild(option);
        });

        switcher.addEventListener('change', (event) => {
            setLanguage(event.target.value);
        });
    }, 0);

    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]">Language Settings</p>
            </div>
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Display Language</p>
                        </div>
                        <select id="language-switcher" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]">
                            <option>Loading...</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words">
                        Choose the language for the application interface.
                    </p>
                </div>
            </div>


    `;
}

// Render plugin manager — lists all installed plugins with enable/disable toggles
export function renderPluginManagerSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Plugins</p>
            </div>

            <div id="plugin-list-container" class="flex flex-col gap-[0px] w-full">
                <div class="flex items-center justify-center w-full py-[40px]">
                    <span class="loading loading-spinner loading-lg text-[#385a92]"></span>
                </div>
            </div>
        </div>
    `;
}

// Render extensions settings
export function renderExtensionsSettings() {
    // Return the HTML template
    const template = `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Extensions Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Visualizer</p>
                             <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Upload shots to visualizer.coffee
                    </p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="visualizer-enabled" class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>

                    <div class="justify-between grid-cols-4 mt-2 w-full">
                        <div id="visualizer-form-container" class="w-full mt-6">
                            <div class="grid grid-cols-4">
                                <div class="col-span-3 flex flex-col gap-6">
                                    <div class="flex flex-col gap-2">
                                        <label for="visualizer-username" class="text-[var(--text-primary)] text-[24px]">Username:</label>
                                        <input type="text" id="visualizer-username" class="w-full max-w-[500px] p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]" placeholder="Enter your Visualizer username">
                                    </div>
                                    <div class="flex flex-col gap-2">
                                        <label for="visualizer-password" class="text-[var(--text-primary)] text-[24px]">Password:</label>
                                        <input type="password" id="visualizer-password" class="w-full max-w-[500px] p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]" placeholder="Enter your Visualizer password">
                                    </div>
                                    <div class="flex items-center gap-4">
                                        <label for="visualizer-auto-upload" class="text-[var(--text-primary)] text-[24px]">Auto-upload shots to Visualizer</label>
                                        <input type="checkbox" id="visualizer-auto-upload" class="w-8 h-8">
                                    </div>
                                    <div class="flex items-center gap-4">
                                        <label for="visualizer-min-duration" class="text-[var(--text-primary)] text-[24px]">Minimum Shot Duration (seconds):</label>
                                        <input type="number" id="visualizer-min-duration" class="w-24 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]" min="1" value="5">
                                    </div>
                                </div>
                                <div class="col-span-1 col-end-5 flex justify-end">
                                    <button id="save-visualizer-credentials" class=" w-[150px] h-[50px] pt-3 pb-[15px] border border-solid border-[var(--mimoja-blue)] text-[var(--profile-button-text-color)] rounded-[22.5px]">
                                        Save Credentials
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    </div>

                   

                    
                </div>
            </div>

            
        </div>
    `;

    // After returning the template, set up the event listeners
    setTimeout(setupVisualizerEventListeners, 0);

    return template;
}

// Function to set up event listeners for the Visualizer settings
function setupVisualizerEventListeners() {
    const saveButton = document.getElementById('save-visualizer-credentials');
    const usernameInput = document.getElementById('visualizer-username');
    const passwordInput = document.getElementById('visualizer-password');
    const autoUploadCheckbox = document.getElementById('visualizer-auto-upload');
    const minDurationInput = document.getElementById('visualizer-min-duration');
    const statusDiv = document.getElementById('visualizer-status');
    const formContainer = document.getElementById('visualizer-form-container');
    const enabledToggle = document.getElementById('visualizer-enabled');

    if (!saveButton) {
        console.warn('Save button for Visualizer credentials not found');
        return;
    }

    // Load existing settings when the form loads
    loadVisualizerSettings();

    // Initially hide the form if auto-upload is disabled
    if (autoUploadCheckbox && formContainer) {
        if (!autoUploadCheckbox.checked) {
            formContainer.style.display = 'none';
        }
    }

    // Sync the enabled toggle with auto-upload checkbox
    if (enabledToggle && autoUploadCheckbox) {
        enabledToggle.checked = autoUploadCheckbox.checked;
        
        enabledToggle.addEventListener('change', async function() {
            const isEnabled = this.checked;
            
            // Sync with auto-upload checkbox
            autoUploadCheckbox.checked = isEnabled;
            
            // Toggle form visibility
            formContainer.style.display = isEnabled ? 'block' : 'none';
            
            // Save the AutoUpload state to plugin
            try {
                const { setPluginSettings } = await import('../modules/api.js');
                const pluginId = 'visualizer.reaplugin';
                
                await setPluginSettings(pluginId, { AutoUpload: isEnabled });
                localStorage.setItem('visualizerAutoUpload', isEnabled.toString());
                ui.showToast(`Visualizer ${isEnabled ? 'enabled' : 'disabled'}`, 1500, 'success');
            } catch (error) {
                console.error('Failed to save Visualizer state:', error);
                ui.showToast('Failed to update Visualizer state', 2000, 'error');
            }
        });
    }

    // Auto-upload checkbox also controls form visibility and syncs with toggle
    if (autoUploadCheckbox) {
        autoUploadCheckbox.addEventListener('change', async function() {
            const isAutoUpload = this.checked;
            
            // Sync with enabled toggle
            if (enabledToggle) {
                enabledToggle.checked = isAutoUpload;
            }
            
            // Toggle form visibility
            if (formContainer) {
                formContainer.style.display = isAutoUpload ? 'block' : 'none';
            }
            
            // Save the AutoUpload state to plugin
            try {
                const { setPluginSettings } = await import('../modules/api.js');
                const pluginId = 'visualizer.reaplugin';
                
                await setPluginSettings(pluginId, { AutoUpload: isAutoUpload });
                localStorage.setItem('visualizerAutoUpload', isAutoUpload.toString());
            } catch (error) {
                console.error('Failed to save Visualizer auto-upload state:', error);
            }
        });
    }

    // Add click handler for the save button
    saveButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value; // Don't trim password as spaces might be valid

        if (!username || !password) {
            ui.showToast('Please enter both username and password', 1500, 'error');
            return;
        }

        try {
            // Import verifyVisualizerCredentials from api.js
            const { verifyVisualizerCredentials } = await import('../modules/api.js');

            const isValid = await verifyVisualizerCredentials(username, password);

            if (!isValid) {
                ui.showToast('Visualizer log-in failed, check credentials', 900, 'error');
                return; // Stop here if credentials are bad
            }

            ui.showToast('Visualizer log-in success', 900, 'success');

            // If credentials are valid, proceed to save to plugin
            const autoUpload = autoUploadCheckbox.checked;
            const minDuration = parseInt(minDurationInput.value, 10) || 5;

            // 1. Save UI-only settings to localStorage
            localStorage.setItem('visualizerAutoUpload', autoUpload.toString());

            // 2. Prepare and save plugin settings - use correct field names expected by visualizer plugin manifest
            const { setPluginSettings } = await import('../modules/api.js');
            const pluginId = 'visualizer.reaplugin';

            const settingsPayload = {
                Username: username,
                Password: password,
                AutoUpload: autoUpload,
                LengthThreshold: minDuration
            };

            try {
                await setPluginSettings(pluginId, settingsPayload);
                ui.showToast('Visualizer settings saved successfully', 3000, 'success');
            } catch (error) {
                console.error('Failed to save visualizer plugin settings:', error);
                ui.showToast(`Failed to save to decent.app plugin: ${error.message}`, 3000, 'error');
            }
        } catch (error) {
            console.error('Error during credential validation:', error);
            ui.showToast(`Error validating credentials: ${error.message}`, 3000, 'error');
        }
    });
}

// Function to load existing Visualizer settings
async function loadVisualizerSettings() {
    try {
        const { getPluginSettings } = await import('../modules/api.js');
        const pluginId = 'visualizer.reaplugin';

        const savedSettings = await getPluginSettings(pluginId);

        const usernameInput = document.getElementById('visualizer-username');
        const passwordInput = document.getElementById('visualizer-password');
        const autoUploadCheckbox = document.getElementById('visualizer-auto-upload');
        const minDurationInput = document.getElementById('visualizer-min-duration');
        const formContainer = document.getElementById('visualizer-form-container');
        const enabledToggle = document.getElementById('visualizer-enabled');

        if (savedSettings && savedSettings.Username) {
            usernameInput.value = savedSettings.Username;
        } else {
            usernameInput.value = '';
        }

        // Always clear the password field for security
        passwordInput.value = '';

        const autoUploadValue = typeof savedSettings.AutoUpload !== 'undefined' ? savedSettings.AutoUpload : true;
        autoUploadCheckbox.checked = !!autoUploadValue;

        // Sync toggle with auto-upload
        if (enabledToggle) {
            enabledToggle.checked = !!autoUploadValue;
        }

        // Visualizer plugin uses 'Length' not 'LengthThreshold'
        if (typeof savedSettings.Length !== 'undefined') {
            minDurationInput.value = parseInt(savedSettings.Length, 10) || 5;
        }

        // Set form visibility based on the autoUpload state
        if (formContainer) {
            formContainer.style.display = autoUploadValue ? 'block' : 'none';
        }
    } catch (error) {
        console.error('Failed to load Visualizer settings:', error);
        ui.showToast('Could not load Visualizer plugin settings', 3000, 'error');
    }
}

export function renderMachineInformationSettings() {
    const machineInfo = settingsCache.machineInfo;

    const extraRows = (machineInfo?.extra && typeof machineInfo.extra === 'object')
        ? Object.entries(machineInfo.extra).map(([key, value]) => {
            const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            const val = typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : String(value);
            return `
            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">${label}</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${val}</span>
            </div>`;
        }).join('')
        : '';

    const body = machineInfo ? `
        <div class="rounded-[10px] border border-[#c9c9c9] p-6 bg-[var(--box-color)] flex flex-col gap-0">

            <div class="flex items-center justify-between py-[16px]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">Device Model</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.model}</span>
            </div>

            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">Firmware Version</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.version}</span>
            </div>

            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">Serial Number</span>
                <div class="flex items-center gap-3">
                    <button onclick="navigator.clipboard.writeText('${machineInfo.serialNumber}').then(()=>{ this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy',1500); })"
                            class="text-[18px] font-semibold text-[#385a92] px-3 py-1 rounded-[8px] border border-[#385a92] hover:bg-[#385a92] hover:text-white transition-colors">
                        Copy
                    </button>
                    <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.serialNumber}</span>
                </div>
            </div>

            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">Group Head Controller</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.GHC ? 'Enabled' : 'Disabled'}</span>
            </div>

            ${extraRows}
        </div>
    ` : `
        <div class="rounded-[10px] border border-[#c9c9c9] p-6 bg-[var(--box-color)]">
            <p class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">Fetching machine info...</p>
        </div>
    `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Machine Information</p>
            </div>
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="w-full flex flex-col gap-4">
                ${body}
            </div>
        </div>
    `;
}

export function renderFirmwareUpdateSettings() {
    const appInfo = settingsCache.appInfo;
    const appInfoDetails = appInfo ? `
                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]">Version</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.version} (${appInfo.buildNumber})</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">Full: ${appInfo.fullVersion}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">${formatBuildTimestamp(appInfo.buildTime)}</p>
                    </div>
                    <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]">Source</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.branch}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">Commit: ${appInfo.commitShort}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">App Store: ${appInfo.appStore ? 'Yes' : 'No'}</p>
                    </div>
                </div>
            ` : `
                <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                    <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]">Update info</p>
                    <p class="text-[24px] font-['Inter:Regular',sans-serif]">Fetching build metadata...</p>
                </div>
            `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Firmware Update</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">DE1 Firmware File</p>
                            <p id="firmware-filename" class="font-['Inter:Regular',sans-serif] font-normal text-[20px] text-[var(--text-secondary)] mt-1">No file selected</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="document.getElementById('firmware-file-input').click()">
                            Select File
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full pr-[220px]">
                        Select a firmware file to upload to the machine. The machine will restart automatically once the update is complete.
                    </p>
                </div>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">Upload</p>
                        </div>
                        <button id="firmware-upload-btn" class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled onclick="window.uploadFirmware()">
                            Upload
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full pr-[220px]">
                        This may take several minutes. Do not power off the machine during the update.
                    </p>
                </div>
            </div>

            <input type="file" id="firmware-file-input" class="hidden" accept=".bin,.fw,.dfu"
                   onchange="window.onFirmwareFileSelected(this)">

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="w-full flex flex-col gap-4">
                <div class="flex flex-col gap-4">
                    <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]">Decent.app Information</p>
                    ${appInfoDetails}
                </div>
            </div>
        </div>
    `;
}

// Render updates settings
export function renderUpdatesSettings() {
    const appInfo = settingsCache.appInfo;
    const infoAvailable = !!appInfo;
    const appInfoDetails = infoAvailable ? `
                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]">Version</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.version} (${appInfo.buildNumber})</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">Full: ${appInfo.fullVersion}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">${formatBuildTimestamp(appInfo.buildTime)}</p>
                    </div>
                    <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]">Source</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.branch}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">Commit: ${appInfo.commitShort}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">App Store: ${appInfo.appStore ? 'Yes' : 'No'}</p>
                    </div>
                </div>
            ` : `
                <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                    <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]">Update info</p>
                    <p class="text-[24px] font-['Inter:Regular',sans-serif]">Fetching build metadata...</p>
                </div>
            `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Updates Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full space-y-10">
                <div class="flex flex-col gap-[30px] w-full">
                    <div class="flex flex-col gap-3">
                        <div class="flex items-center justify-between">
                            <div class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]">Firmware Update</div>
                            <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"Check></button>
                        </div>
                        <p class="text-[24px] text-[var(--text-primary)]">Check for firmware updates</p>
                    </div>

                    <div class="flex flex-col gap-3">
                        <div class="flex items-center justify-between">
                            <div class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]">App Update</div>
                            <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold">Check</button>
                        </div>
                        <p class="text-[24px] text-[var(--text-primary)]">Check for application updates</p>
                    </div>
                </div>

                <div class="w-full flex flex-col gap-4">
                    <div class="flex flex-col gap-4">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]">Decent.app Information</p>
                        ${appInfoDetails}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Render general settings
export function renderGeneralSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">General Settings</p>
            </div>

            <div class="text-[24px] text-[var(--text-primary)] p-4">
                Select a category from the navigation panel to view and edit settings.
            </div>
        </div>
    `;
}

// Render subcategories for a selected main category
export function renderSubcategories(mainCategoryKey) {
    const category = settingsTree[mainCategoryKey];
    if (!category || !category.subcategories || category.subcategories.length === 0) {
        return `<div class="p-4 text-center text-gray-500">No sub-categories.</div>`;
    }

    let subcategoryItems = '';
    category.subcategories.forEach((subcat) => {
        const prefixMatch = subcat.name.match(/^(\d+\.\s*)/);
        const prefix = prefixMatch ? prefixMatch[1] : '';
        const label = prefix ? subcat.name.slice(prefix.length) : subcat.name;
        subcategoryItems += `
            <li>
                <button class="settings-subnav-btn w-full text-left px-4 py-3 rounded-lg text-[24px] text-[#959595] hover:text-white hover:bg-[#2c4a7a] flex items-center"
                        data-category="${subcat.settingsCategory}">
                    ${prefix}<span data-i18n-key="${label}">${label}</span>
                </button>
            </li>
        `;
    });

    return `<ul class="space-y-1">${subcategoryItems}</ul>`;
}


function initResizableSubNav() {
    const separator = document.getElementById('sub-categories-separator');
    const mainCategoriesPanel = document.getElementById('main-categories-panel');
    const subCategoriesPanel = document.getElementById('sub-categories-panel');

    if (!separator || !mainCategoriesPanel || !subCategoriesPanel) {
        console.warn('Resizable sub-navigation elements not found.');
        return;
    }

    let isDragging = false;

    function thickenSeparator() {
        separator.classList.remove('w-px');
        separator.classList.add('w-2');
    }

    function restoreSeparator() {
        separator.classList.remove('w-2');
        separator.classList.add('w-px');
    }

    function beginDrag(clientX) {
        isDragging = true;
        thickenSeparator();
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const startX = clientX;
        const startMainWidth = mainCategoriesPanel.offsetWidth;

        function applyDelta(cx) {
            if (!isDragging) return;
            const dx = cx - startX;
            const newMainWidth = startMainWidth + dx;
            const containerWidth = separator.parentElement.offsetWidth;
            if (newMainWidth > 150 && newMainWidth < containerWidth - 150) {
                mainCategoriesPanel.style.width = `${newMainWidth}px`;
            }
        }

        function onMouseMove(e) { applyDelta(e.clientX); }
        function onTouchMove(e) {
            if (e.touches[0]) {
                applyDelta(e.touches[0].clientX);
                e.preventDefault(); // block scroll while dragging
            }
        }

        function stopDrag() {
            isDragging = false;
            restoreSeparator();
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', stopDrag);
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', stopDrag);
            document.removeEventListener('touchcancel', stopDrag);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('touchcancel', stopDrag);
    }

    separator.addEventListener('mousedown', (e) => beginDrag(e.clientX));
    separator.addEventListener('touchstart', (e) => {
        if (e.touches[0]) beginDrag(e.touches[0].clientX);
    }, { passive: true });
}


// Cache for loading promises to prevent multiple simultaneous requests
let settingsLoadingPromises = {};

// Preload all settings in the background
export async function preloadSettings() {
    // If we're already preloading, return the existing promise
    if (settingsLoadingPromises.preload) {
        return settingsLoadingPromises.preload;
    }

    settingsLoadingPromises.preload = _preloadSettingsInternal();
    return settingsLoadingPromises.preload;
}

// Internal function to preload all settings
async function _preloadSettingsInternal() {
    try {
        await openDB();
        // Only show "Loading" state if we have no stale IDB data to display
        if (!settingsCache.rea)         settingsCache.reaLoading         = true;
        if (!settingsCache.de1)         settingsCache.de1Loading         = true;
        if (!settingsCache.de1Advanced) settingsCache.de1AdvancedLoading = true;
        settingsCache.appInfoLoading = true;

        // Reset error flags
        settingsCache.reaError = null;
        settingsCache.de1Error = null;
        settingsCache.de1AdvancedError = null;
        settingsCache.appInfoError = null;

        // Fetch all settings in parallel using Promise.allSettled to handle individual failures
        const [reaSettingsResult, de1SettingsResult, de1AdvancedSettingsResult, appInfoResult, machineInfoResult, skinInfoResult, allSkinsResult, workflowResult, githubReleaseResult] = await Promise.allSettled([
            getReaSettings(),
            getDe1Settings(),
            getDe1AdvancedSettings(),
            getAppInfo(),
            getMachineInfo(),
            getDefaultSkin(),
            getAllSkins(),
            getWorkflow(),
            fetch('https://api.github.com/repos/allofmeng/streamline_project/releases/latest', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
        ]);

        // Process results and handle errors appropriately
        let reaSettings = null;
        let de1Settings = null;
        let de1AdvancedSettings = null;
        let appInfo = null;
        let machineInfo = null;

        let usedCache = false;

        // Handle REA settings result — fall back to IDB on any failure
        if (reaSettingsResult.status === 'fulfilled') {
            reaSettings = reaSettingsResult.value;
            try { await setSetting('settings-rea', reaSettings); } catch(e) { /* non-fatal */ }
        } else {
            console.error('Error loading decent.app settings:', reaSettingsResult.reason);
            settingsCache.reaError = reaSettingsResult.reason?.message;
            try { reaSettings = await getSetting('settings-rea'); } catch(e) { /* non-fatal */ }
            if (reaSettings) usedCache = true;
        }

        // Handle DE1 settings result — fall back to IDB on any failure
        if (de1SettingsResult.status === 'fulfilled') {
            de1Settings = de1SettingsResult.value;
            try { await setSetting('settings-de1', de1Settings); } catch(e) { /* non-fatal */ }
        } else {
            console.error('Error loading DE1 settings:', de1SettingsResult.reason);
            settingsCache.de1Error = de1SettingsResult.reason?.message;
            try { de1Settings = await getSetting('settings-de1'); } catch(e) { /* non-fatal */ }
            if (de1Settings) usedCache = true;
        }

        // Handle DE1 advanced settings result — fall back to IDB on any failure
        if (de1AdvancedSettingsResult.status === 'fulfilled') {
            de1AdvancedSettings = de1AdvancedSettingsResult.value;
            try { await setSetting('settings-de1Advanced', de1AdvancedSettings); } catch(e) { /* non-fatal */ }
        } else {
            console.error('Error loading DE1 advanced settings:', de1AdvancedSettingsResult.reason);
            settingsCache.de1AdvancedError = de1AdvancedSettingsResult.reason?.message;
            try { de1AdvancedSettings = await getSetting('settings-de1Advanced'); } catch(e) { /* non-fatal */ }
            if (de1AdvancedSettings) usedCache = true;
        }

        // All critical settings failed and no IDB cache — show retry UI, auto-retry in background
        if (!reaSettings && !de1Settings && !de1AdvancedSettings) {
            const contentArea = document.getElementById('settings-content-area');
            if (contentArea) {
                contentArea.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full gap-[40px] p-8">
                        <p class="text-[var(--text-primary)] text-[30px] font-bold text-center">Unable to reach De1</p>
                        <p class="text-[var(--text-primary)] text-[24px] text-center opacity-60">Retrying automatically every 3 seconds...</p>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.retryLoadSettings()">Retry Now</button>
                    </div>`;
            }
            ui.showToast('Unable to reach De1. Retrying...', 3000, 'warning');
            setTimeout(() => {
                preloadSettings().then(() => {
                    if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
                });
            }, 3000);
            return { reaSettings: null, de1Settings: null, de1AdvancedSettings: null, appInfo: null, machineInfo: null };
        }

        if (usedCache) {
            ui.showToast('Some settings loaded from cache — showing last known values', 4000, 'warning');
        }

        // Handle App Info result
        if (appInfoResult.status === 'fulfilled') {
            appInfo = appInfoResult.value;
        } else {
            console.error('Error loading app info:', appInfoResult.reason);
            settingsCache.appInfoError = appInfoResult.reason?.message || 'Failed to load update information';
        }

        // Handle Machine Info result
        if (machineInfoResult.status === 'fulfilled') {
            machineInfo = machineInfoResult.value;
        } else {
            console.error('Error loading machine info:', machineInfoResult.reason);
            settingsCache.machineInfoError = machineInfoResult.reason?.message || 'Failed to load machine details';
        }

        // Handle Skin Info result
        if (skinInfoResult.status === 'fulfilled') {
            settingsCache.skinInfo = skinInfoResult.value;
        } else {
            console.error('Error loading skin info:', skinInfoResult.reason);
            settingsCache.skinInfoError = skinInfoResult.reason?.message || 'Failed to load skin info';
        }

        // Handle All Skins result
        if (allSkinsResult.status === 'fulfilled') {
            settingsCache.allSkins = allSkinsResult.value;
        } else {
            console.error('Error loading all skins:', allSkinsResult.reason);
            settingsCache.allSkinsError = allSkinsResult.reason?.message || 'Failed to load skins';
        }

        // Handle GitHub latest release result
        if (githubReleaseResult.status === 'fulfilled' && githubReleaseResult.value?.tag_name) {
            settingsCache.githubLatestVersion = githubReleaseResult.value.tag_name.replace(/^v/, '');
        } else {
            console.warn('Could not fetch GitHub latest release:', githubReleaseResult.reason);
        }

        // Handle Workflow result
        if (workflowResult.status === 'fulfilled') {
            settingsCache.workflow = workflowResult.value;
        } else {
            console.error('Error loading workflow data:', workflowResult.reason);
        }

        // Update cache with results
        settingsCache.rea = reaSettings;
        settingsCache.de1 = de1Settings;
        settingsCache.de1Advanced = de1AdvancedSettings;
        settingsCache.appInfo = appInfo;
        settingsCache.machineInfo = machineInfo;

        // Update loading flags
        settingsCache.reaLoading = false;
        settingsCache.de1Loading = false;
        settingsCache.de1AdvancedLoading = false;
        settingsCache.appInfoLoading = false;
        settingsCache.machineInfoLoading = false;
        settingsCache.skinInfoLoading = false;

        return { reaSettings, de1Settings, de1AdvancedSettings, appInfo, machineInfo };
    } catch (error) {
        console.error('Error during settings preload:', error);
        ui.showToast('Failed to preload settings', 5000, 'error');

        // Ensure loading flags are reset even in case of error
        settingsCache.reaLoading = false;
        settingsCache.de1Loading = false;
        settingsCache.de1AdvancedLoading = false;

        return { reaSettings: null, de1Settings: null, de1AdvancedSettings: null };
    } finally {
        // Clear the preload promise after completion
        delete settingsLoadingPromises.preload;
    }
}


// Helper function to get title for a category
function getCategoryTitle(category) {
    switch(category) {
        case 'rea': return 'decent.app Application Settings';
        case 'quickadjustments': return 'Quick Adjustments';
        case 'flowmultiplier': return 'Flow Multiplier Settings';
        case 'steam': return 'Steam Settings';
        case 'hotwater': return 'Hot Water Settings';
        case 'watertank': return 'Water Tank Settings';
        case 'flush': return 'Flush Settings';
        case 'de1': return 'DE1 Settings';
        case 'fanthreshold': return 'Fan Threshold Settings';
        case 'usbchargermode': return 'USB Charger Settings';
        case 'machineinfo': return 'Machine Information';
        case 'de1advanced': return 'Machine Advanced Settings';
        default: return 'Settings';
    }
}

// Initialize the settings page
export async function initializeSettings() {
    resetPendingChanges();
    // Pre-seed cache from IDB backup for instant render, then fetch from network in background
    await preSeedFromIDB();
    preloadSettings().then(() => {
        if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
    });

    // Initialize WebSocket for live device state updates
    initDeviceWebSocket();

    // Initialize WebSocket for live display state updates
    initDisplayWebSocket();

    // Set up event listeners
    const cancelBtn = document.getElementById('cancel-settings-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            resetPendingChanges();
            loadPage('index.html');
        });
    }

    const saveBtn = document.getElementById('save-settings-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const visualizerAutoUpload = document.getElementById('visualizer-auto-upload');
            if (visualizerAutoUpload) {
                localStorage.setItem('visualizerAutoUpload', visualizerAutoUpload.checked.toString());
            }
            try {
                await flushPendingChanges();
            } catch (error) {
                console.error('Error saving settings:', error);
                ui.showToast(`Failed to save settings: ${error.message}`, 5000, 'error');
                return;
            }
            ui.showToast('decent.app settings updated', 3000, 'success');
            loadPage('index.html');
        });
    }

    initResizableSubNav();

    // Set up main category navigation
    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            // Handle active state for main categories
            document.querySelectorAll('.settings-nav-btn').forEach(b => {
                b.classList.remove('text-white', 'bg-[#2c4a7a]');
                b.classList.add('text-[#959595]'); // Explicitly re-add default color
            });
            this.classList.remove('text-[#959595]'); // Explicitly remove default color
            this.classList.add('text-white', 'bg-[#2c4a7a]');

            const mainCategoryKey = this.id.replace(/-btn$/, '').replace(/-/g, '');

            // Render subcategories
            const subCategoriesPanel = document.getElementById('sub-categories-panel');
            if (subCategoriesPanel) {
                subCategoriesPanel.innerHTML = renderSubcategories(mainCategoryKey);

                // Add event listeners to the new subcategory buttons
                subCategoriesPanel.querySelectorAll('.settings-subnav-btn').forEach(subBtn => {
                    subBtn.addEventListener('click', function(e) {
                        e.preventDefault(); // Prevent any default behavior that might cause page reload
                        e.stopPropagation(); // Stop event from bubbling up

                        // Handle active state for subcategories
                        subCategoriesPanel.querySelectorAll('.settings-subnav-btn').forEach(sb => {
                             sb.classList.remove('text-white', 'bg-[#2c4a7a]');
                             sb.classList.add('text-[#959595]');
                        });
                        this.classList.remove('text-[#959595]');
                        this.classList.add('text-white', 'bg-[#2c4a7a]');

                        const settingsCategory = this.dataset.category;
                        activeSettingsCategory = settingsCategory; // Set the active category
                        updateSettingsContentArea(settingsCategory); // Use the new helper function
                    });
                });
            }

            // After rendering subcategories, attempt to click the first one if it exists
            const firstSubCategoryBtn = subCategoriesPanel?.querySelector('.settings-subnav-btn');
            if (firstSubCategoryBtn) {
                firstSubCategoryBtn.click();
            } else {
                // If no subcategories, clear the content area and set activeSettingsCategory to null
                const contentArea = document.getElementById('settings-content-area');
                if (contentArea) {
                    contentArea.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-center p-8">
                        <p class="text-[var(--text-primary)] text-[28px]">Select a sub-category from the menu</p>
                    </div>`;
                    activeSettingsCategory = null;
                }
            }
        });
    });

    // Initial load of settings content: Simulate a click on the first main category button
    const firstMainCategoryBtn = document.querySelector('.settings-nav-btn');
    if (firstMainCategoryBtn) {
        firstMainCategoryBtn.click();
    } else {
        // Fallback if no main category buttons are found
        const contentArea = document.getElementById('settings-content-area');
        if (contentArea) {
             contentArea.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-center p-8">
                 <p class="text-[var(--text-primary)] text-[28px]">No settings categories found.</p>
             </div>`;
             activeSettingsCategory = null;
        }
    }

    // Set up search functionality
    setupSettingsSearch();

    // Apply translations to the settings page
    setLanguage(getCurrentLanguage());

    // Re-translate settings content whenever language changes
    document.addEventListener('streamline:languagechange', () => {
        translatePage();
        if (activeSettingsCategory) {
            updateSettingsContentArea(activeSettingsCategory);
        }
    });

    // Expose update functions to global scope for inline event handlers
    window.updateReaSetting = updateReaSetting;
    window.updateDe1Setting = updateDe1Setting;
    window.updateDe1AdvancedSetting = updateDe1AdvancedSetting;
    window.setScreensaverEnabled = function(enabled) {
        localStorage.setItem('screensaverEnabled', enabled ? 'true' : 'false');
        ui.showToast(`Screen saver ${enabled ? 'enabled' : 'disabled'}`, 2000, 'success');
    };

    window.addScreensaverFiles = async function(files) {
        if (!files || files.length === 0) return;
        const readFile = f => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(f);
        });
        try {
            const newImages = await Promise.all(Array.from(files).map(readFile));
            screensaverImagesCache = [...screensaverImagesCache, ...newImages];
            await openDB();
            await setSetting('screensaverImages', screensaverImagesCache);
            ui.setScreensaverImages(screensaverImagesCache);
            ui.showToast(`${newImages.length} image${newImages.length !== 1 ? 's' : ''} added`, 2000, 'success');
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        } catch (e) {
            ui.showToast('Failed to save images', 3000, 'error');
        }
    };

    window.clearScreensaverImages = async function() {
        try {
            screensaverImagesCache = [];
            await openDB();
            await setSetting('screensaverImages', []);
            ui.setScreensaverImages([]);
            ui.showToast('Custom images cleared', 2000, 'success');
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        } catch (e) {
            ui.showToast('Failed to clear images', 3000, 'error');
        }
    };
    window.updateHeaterVoltage = async function(value) {
        await window.updateDe1AdvancedSetting('heaterVoltage', value);
        ui.showToast('Restart the machine for the voltage change to take effect', 6000, 'warning');
    };
    window.resetDe1Settings = async function() {
        try {
            await resetDe1Settings();
            settingsCache.de1Advanced = await getDe1AdvancedSettings();
            settingsCache.de1 = await getDe1Settings();
            ui.showToast('Machine settings reset to defaults', 3000, 'success');
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        } catch (error) {
            ui.showToast(`Failed to reset settings: ${error.message}`, 5000, 'error');
        }
    };

    // Plugin manager
    window.loadPluginList = async function() {
        const container = document.getElementById('plugin-list-container');
        if (!container) return;
        try {
            const { getPlugins } = await import('../modules/api.js');
            const plugins = await getPlugins();
            if (!plugins || plugins.length === 0) {
                container.innerHTML = `<p class="text-[24px] text-[var(--text-primary)] opacity-60">No plugins installed.</p>`;
                return;
            }
            container.innerHTML = plugins.map((p, i) => `
                ${i > 0 ? '<div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>' : ''}
                <div class="flex items-center justify-between w-full py-[30px] gap-[24px]">
                    <div class="flex flex-col gap-[8px] flex-1 min-w-0">
                        <div class="flex items-center gap-[12px]">
                            <span class="font-bold text-[#385a92] text-[28px] leading-tight">${p.name || p.id}</span>
                            <span class="text-[20px] text-[var(--text-primary)] opacity-50">v${p.version || '?'}</span>
                        </div>
                        ${p.description ? `<p class="text-[22px] text-[var(--text-primary)] leading-[1.4] opacity-75">${p.description}</p>` : ''}
                        <span class="text-[18px] text-[var(--text-primary)] opacity-40 font-mono">${p.id}</span>
                    </div>
                    <div class="flex flex-col items-center gap-[6px] flex-shrink-0">
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="plugin-toggle-${CSS.escape(p.id)}"
                                   class="sr-only peer"
                                   ${p.loaded ? 'checked' : ''}
                                   onchange="window.togglePlugin('${p.id}', this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                        <span class="text-[18px] text-[var(--text-primary)] opacity-60">${p.loaded ? 'Enabled' : 'Disabled'}</span>
                    </div>
                </div>
            `).join('');
        } catch (err) {
            logger.error('Failed to load plugins:', err);
            container.innerHTML = `<p class="text-[22px] text-red-500">Failed to load plugins: ${err.message}</p>`;
        }
    };

    window.togglePlugin = async function(pluginId, enable) {
        const toggle = document.getElementById(`plugin-toggle-${CSS.escape(pluginId)}`);
        const label  = toggle?.nextElementSibling;
        if (toggle) toggle.disabled = true;
        try {
            const { enablePlugin, disablePlugin } = await import('../modules/api.js');
            if (enable) {
                await enablePlugin(pluginId);
            } else {
                await disablePlugin(pluginId);
            }
            if (label) label.textContent = enable ? 'Enabled' : 'Disabled';
            ui.showToast(`Plugin ${enable ? 'enabled' : 'disabled'}`, 2500, 'success');
        } catch (err) {
            logger.error('Failed to toggle plugin:', err);
            ui.showToast(`Failed: ${err.message}`, 4000, 'error');
            // Revert toggle on failure
            if (toggle) toggle.checked = !enable;
            if (label) label.textContent = enable ? 'Disabled' : 'Enabled';
        } finally {
            if (toggle) toggle.disabled = false;
        }
    };

    window.updateTalkToDecentUI = async function() {
        const loggedOut = document.getElementById('talkdecent-logged-out');
        const loggedIn  = document.getElementById('talkdecent-logged-in');
        if (!loggedOut || !loggedIn) return;
        try {
            const res = await fetch(`${API_BASE_URL}/account/decent`);
            const { loggedIn: linked } = await res.json();
            if (linked) {
                loggedOut.classList.add('hidden');
                loggedIn.classList.remove('hidden');
                const token    = window.__REA_PROXY_TOKEN__;
                const serialEl = document.getElementById('talkdecent-account-serial');
                if (token && serialEl) {
                    try {
                        const snRes = await fetch(`${API_BASE_URL}/account/proxy/support/api/sn`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const snText = (await snRes.text()).trim();
                        const serial = snText.split(/[\r\n]/)[0].trim();
                        serialEl.textContent = serial ? `Serial: ${serial}` : '';
                    } catch (_) {
                        serialEl.textContent = '';
                    }
                }
                window.talkDecentFetchEmails();
            } else {
                loggedIn.classList.add('hidden');
                loggedOut.classList.remove('hidden');
            }
        } catch (_) {
            loggedIn.classList.add('hidden');
            loggedOut.classList.remove('hidden');
        }
    };

    function updateTalkDecentComposePreview(subject, body) {
        const tile = document.getElementById('talkdecent-compose-preview');
        if (!tile) return;
        if (!subject && !body) {
            tile.innerHTML = '<p class="text-[20px] text-[var(--low-contrast-white)]">Tap to compose a message…</p>';
            return;
        }
        let html = '';
        if (subject) html += `<p class="text-[19px] font-semibold text-[var(--text-primary)] leading-tight mb-[6px]">${escapeHtml(subject)}</p>`;
        if (body) {
            const snippet = body.length > 120 ? body.substring(0, 120) + '…' : body;
            html += `<p class="text-[18px] text-[var(--low-contrast-white)] leading-snug whitespace-pre-wrap">${escapeHtml(snippet)}</p>`;
        }
        tile.innerHTML = html;
    }

    window.openTalkDecentMessageEditor = function() {
        const currentSubject = document.getElementById('talkdecent-subject')?.value || '';
        const currentBody    = document.getElementById('talkdecent-message')?.value || '';
        openNotesModal(currentBody, ({ subject, body }) => {
            const subjectEl = document.getElementById('talkdecent-subject');
            const bodyEl    = document.getElementById('talkdecent-message');
            if (subjectEl) subjectEl.value = subject || '';
            if (bodyEl)    bodyEl.value    = body    || '';
            updateTalkDecentComposePreview(subject, body);
        }, {
            title: 'New Message',
            subject: currentSubject,
            subjectPlaceholder: 'What can we help you with?',
        });
    };

    window.sendDecentMessage = async function() {
        const subject   = (document.getElementById('talkdecent-subject')?.value || '').trim();
        const message   = (document.getElementById('talkdecent-message')?.value || '').trim();
        const statusEl  = document.getElementById('talkdecent-send-status');
        const sendBtn   = document.getElementById('talkdecent-send-btn');
        const token     = window.__REA_PROXY_TOKEN__;

        if (!subject) {
            if (statusEl) statusEl.innerHTML = '<span class="text-red-500">Please enter a subject.</span>';
            return;
        }
        if (!message) {
            if (statusEl) statusEl.innerHTML = '<span class="text-red-500">Please enter a message.</span>';
            return;
        }
        if (!token) {
            if (statusEl) statusEl.innerHTML = '<span class="text-red-500">No proxy token available.</span>';
            return;
        }

        if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
        if (statusEl) statusEl.innerHTML = '';

        const attachMachine = document.getElementById('talkdecent-attach-machine')?.checked;

        try {
            let body = message;
            const machineInfo = settingsCache.machineInfo;
            const appInfo     = settingsCache.appInfo;
            if (attachMachine && (machineInfo || appInfo)) {
                body += '\n\n---\n**Machine Info**';
                if (machineInfo?.model)        body += `\n- Model: ${machineInfo.model}`;
                if (machineInfo?.version)      body += `\n- Firmware: ${machineInfo.version}`;
                if (machineInfo?.serialNumber) body += `\n- Serial: ${machineInfo.serialNumber}`;
                if (appInfo?.version)          body += `\n- App version: ${appInfo.version}`;
            }
            const params = new URLSearchParams({ subject, body });
            const res = await fetch(
                `${API_BASE_URL}/account/proxy/support/api/email?${params.toString()}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            const text = (await res.text()).trim();
            if (!res.ok || text === '0') throw new Error('Message could not be delivered. Check your connection.');

            if (statusEl) statusEl.innerHTML = `
                <span class="text-green-600 font-bold text-[22px]">Message sent!</span>
                <span class="text-[20px] text-[var(--low-contrast-white)] ml-[8px]">Decent support will reply to your email.</span>`;
            document.getElementById('talkdecent-subject').value = '';
            document.getElementById('talkdecent-message').value = '';
            updateTalkDecentComposePreview('', '');
            window.talkDecentFetchEmails();
        } catch (err) {
            if (statusEl) statusEl.innerHTML = `<span class="text-red-500 text-[22px]">Error: ${err.message}</span>`;
        } finally {
            if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send Message'; }
        }
    };

    window.talkDecentRefresh = async function() {
        await window.talkDecentFetchEmails();
    };

    window.talkDecentFetchEmails = async function() {
        const token = window.__REA_PROXY_TOKEN__;
        if (!token) {
            await window.talkDecentRenderThread();
            return;
        }

        const statusEl   = document.getElementById('talkdecent-thread-status');
        const refreshBtn = document.getElementById('talkdecent-refresh-btn');
        if (refreshBtn) refreshBtn.disabled = true;

        try {
            const since = await getLatestEmailTimestamp();
            const url = new URL(`${API_BASE_URL}/account/proxy/support/api/emails`);
            if (since) url.searchParams.set('since', String(since));

            const res = await fetch(url.toString(), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const text = await res.text();
            if (!res.ok || text.trim() === '0') throw new Error(`Failed to load messages`);

            const sanitized = text.replace(/"(\w+)":\s*,/g, '"$1": null,');
            const newEmails = JSON.parse(sanitized);
            if (Array.isArray(newEmails) && newEmails.length > 0) {
                await addEmails(newEmails);
            }
            await window.talkDecentRenderThread();
            if (statusEl) { statusEl.textContent = ''; statusEl.classList.add('hidden'); }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = `Could not load messages: ${err.message}`;
                statusEl.classList.remove('hidden');
            }
            await window.talkDecentRenderThread();
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    };

    window.talkDecentRenderThread = async function() {
        const container = document.getElementById('talkdecent-thread-messages');
        if (!container) return;

        let emails;
        try {
            emails = await getAllEmails();
        } catch (_) {
            emails = [];
        }

        if (!emails.length) {
            container.innerHTML = '<p class="text-center text-[18px] text-[var(--low-contrast-white)] py-[24px]">No messages yet. Send one below to start!</p>';
            return;
        }

        container.innerHTML = emails.map(msg => {
            const isDecent = msg.from_user && String(msg.from_user).trim();
            const date = msg.now
                ? new Date(msg.now * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';
            const bodyText = escapeHtml(msg.body || msg.message || msg.subject || '');
            const subjectText = msg.subject ? escapeHtml(msg.subject) : '';

            if (isDecent) {
                const name = String(msg.from_user).trim();
                const avatarUrl = `https://decentespresso.com/img/cartoon_${encodeURIComponent(name)}_small.png`;
                return `
                    <div class="flex gap-[12px] items-start">
                        <img src="${avatarUrl}"
                             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                             class="w-[40px] h-[40px] rounded-full flex-shrink-0 object-cover"
                             alt="${escapeHtml(name)}">
                        <div style="display:none" class="w-[40px] h-[40px] rounded-full bg-[#385a92] flex-shrink-0 items-center justify-center text-white text-[16px] font-bold">${escapeHtml(name[0].toUpperCase())}</div>
                        <div class="flex flex-col gap-[4px] max-w-[80%]">
                            <div class="flex items-center gap-[8px] flex-wrap">
                                <span class="text-[16px] font-semibold text-[#385a92]">${escapeHtml(name)}</span>
                                ${msg.automsg ? '<span class="text-[12px] px-[6px] py-[1px] rounded-full bg-[var(--button-grey)] text-[var(--low-contrast-white)]">auto</span>' : ''}
                                <span class="text-[14px] text-[var(--low-contrast-white)] opacity-60">${date}</span>
                            </div>
                            <div class="bg-[var(--bg-color,white)] border border-[var(--profile-button-outline-color)] rounded-[16px] rounded-tl-[4px] overflow-hidden">
                                ${subjectText ? `<div class="px-[16px] pt-[10px] pb-[8px] border-b border-[var(--profile-button-outline-color)]"><p class="text-[15px] font-semibold text-[var(--low-contrast-white)]">${subjectText}</p></div>` : ''}
                                <div class="px-[16px] py-[12px] text-[19px] text-[var(--text-primary)] whitespace-pre-wrap leading-[1.5]">${bodyText}</div>
                            </div>
                        </div>
                    </div>`;
            } else {
                return `
                    <div class="flex gap-[12px] items-start justify-end">
                        <div class="flex flex-col gap-[4px] max-w-[80%] items-end">
                            <span class="text-[14px] text-[var(--low-contrast-white)] opacity-60">${date}</span>
                            <div class="bg-[#385a92] rounded-[16px] rounded-tr-[4px] overflow-hidden">
                                ${subjectText ? `<div class="px-[16px] pt-[10px] pb-[8px] border-b border-white/20"><p class="text-[15px] font-semibold text-white/70">${subjectText}</p></div>` : ''}
                                <div class="px-[16px] py-[12px] text-[19px] text-white whitespace-pre-wrap leading-[1.5]">${bodyText}</div>
                            </div>
                        </div>
                    </div>`;
            }
        }).join('');

        container.scrollTop = container.scrollHeight;
    };

    window.updateDecentAccountUI = async function() {
        const loggedOut = document.getElementById('decent-logged-out');
        const loggedIn  = document.getElementById('decent-logged-in');
        if (!loggedOut || !loggedIn) return;
        try {
            const res = await fetch(`${API_BASE_URL}/account/decent`);
            const { loggedIn: linked } = await res.json();
            if (linked) {
                loggedOut.classList.add('hidden');
                loggedIn.classList.remove('hidden');
                const token    = window.__REA_PROXY_TOKEN__;
                const serialEl = document.getElementById('decent-account-serial');
                if (token && serialEl) {
                    try {
                        const snRes = await fetch(`${API_BASE_URL}/account/proxy/support/api/sn`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const snText = (await snRes.text()).trim();
                        const serial = snText.split(/[\r\n]/)[0].trim();
                        serialEl.textContent = serial ? `Serial: ${serial}` : '';
                    } catch (_) {
                        serialEl.textContent = '';
                    }
                }
            } else {
                loggedIn.classList.add('hidden');
                loggedOut.classList.remove('hidden');
            }
        } catch (_) {
            loggedIn.classList.add('hidden');
            loggedOut.classList.remove('hidden');
        }
    };

    window.openFeedbackDescriptionEditor = function() {
        const hiddenTA = document.getElementById('feedback-description');
        const currentText = hiddenTA ? hiddenTA.value : '';
        openNotesModal(currentText, (text) => {
            const ta = document.getElementById('feedback-description');
            if (ta) ta.value = text;
            const preview = document.getElementById('feedback-description-preview');
            if (!preview) return;
            if (text) {
                preview.textContent = text;
                preview.style.color = 'var(--text-primary)';
            } else {
                preview.textContent = 'Tap to write description…';
                preview.style.color = 'var(--low-contrast-white)';
            }
        });
    };

    window.selectFeedbackCategory = function(value) {
        document.getElementById('feedback-category').value = value;
        document.querySelectorAll('[data-feedback-card]').forEach(btn => {
            const active = btn.dataset.feedbackCard === value;
            btn.setAttribute('aria-pressed', active);
            btn.classList.toggle('bg-[#385a92]', active);
            btn.classList.toggle('border-[#385a92]', active);
            btn.classList.toggle('text-white', active);
            btn.classList.toggle('bg-[var(--box-color)]', !active);
            btn.classList.toggle('border-[var(--profile-button-outline-color)]', !active);
            btn.classList.toggle('text-[var(--text-primary)]', !active);
        });
    };

    function xorEncode(str, key) {
        let out = '';
        for (let i = 0; i < str.length; i++)
            out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        return btoa(out);
    }

    window.submitFeedback = async function() {
        const category  = document.getElementById('feedback-category')?.value || 'bug';
        const title     = (document.getElementById('feedback-title')?.value || '').trim();
        const desc      = (document.getElementById('feedback-description')?.value || '').trim();
        const email     = (document.getElementById('feedback-email')?.value || '').trim();
        const attachSys = document.getElementById('feedback-attach-sysinfo')?.checked;
        const statusEl  = document.getElementById('feedback-status');
        const submitBtn = document.getElementById('feedback-submit-btn');

        if (!title) {
            statusEl.innerHTML = '<span class="text-red-500">Please enter a title.</span>';
            return;
        }

        let fullDesc = `**${title}**\n\n${desc}`;
        const ENCODE_KEY = 'itisadecentcupofcoffee';
        if (email) fullDesc += `\n\n---\n**Contact:** \`${xorEncode(email, ENCODE_KEY)}\``;

        const proxyToken = window.__REA_PROXY_TOKEN__;
        if (proxyToken) {
            try {
                const accountRes = await fetch(`${API_BASE_URL}/account/decent`);
                const { loggedIn: linked } = await accountRes.json();
                if (linked) {
                    const snRes = await fetch(`${API_BASE_URL}/account/proxy/support/api/sn`, {
                        headers: { 'Authorization': `Bearer ${proxyToken}` }
                    });
                    const snText = (await snRes.text()).trim();
                    const serial = snText.split(/[\r\n]/)[0].trim();
                    if (serial) fullDesc += `\n\n---\n**Serial:** ${serial}`;
                }
            } catch (_) {}
        }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }
        statusEl.innerHTML = '';

        try {
            const { submitFeedback: submitToREA } = await import('../modules/api.js');
            const data = await submitToREA({
                description: fullDesc,
                type: category,
                includeLogs: attachSys,
                includeSystemInfo: attachSys,
            });
            statusEl.innerHTML = `
                <span class="text-green-600 font-bold text-[24px]">Submitted!</span>
                ${data.issueUrl ? `<a href="${data.issueUrl}" target="_blank"
                   class="ml-3 text-[#385a92] underline text-[22px]">View issue</a>` : ''}`;
            document.getElementById('feedback-title').value = '';
            document.getElementById('feedback-description').value = '';
            const preview = document.getElementById('feedback-description-preview');
            if (preview) {
                preview.textContent = 'Tap to write description…';
                preview.style.color = 'var(--low-contrast-white)';
            }
        } catch (err) {
            logger.error('Feedback submit error:', err);
            statusEl.innerHTML = `<span class="text-red-500 text-[22px]">Error: ${err.message}</span>`;
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
        }
    };

    window.startDescaling = async function() {
        if (!confirm('Start descaling cycle? The machine will run the descaling program. Make sure the descaling solution is prepared.')) return;
        try {
            await setMachineState('descaling');
            ui.showToast('Descaling cycle started', 3000, 'success');
        } catch (error) {
            logger.error('Error starting descaling:', error);
            ui.showToast(`Failed to start descaling: ${error.message}`, 5000, 'error');
        }
    };

    window.startAirPurge = async function() {
        if (!confirm('Start air purge? The machine will run the air purge cycle.')) return;
        try {
            await setMachineState('airPurge');
            ui.showToast('Air purge started', 3000, 'success');
        } catch (error) {
            logger.error('Error starting air purge:', error);
            ui.showToast(`Failed to start air purge: ${error.message}`, 5000, 'error');
        }
    };

    window.onFirmwareFileSelected = function(input) {
        const file = input.files[0];
        const label = document.getElementById('firmware-filename');
        const uploadBtn = document.getElementById('firmware-upload-btn');
        if (file) {
            if (label) label.textContent = file.name;
            if (uploadBtn) uploadBtn.disabled = false;
        } else {
            if (label) label.textContent = 'No file selected';
            if (uploadBtn) uploadBtn.disabled = true;
        }
    };

    window.uploadFirmware = async function() {
        const input = document.getElementById('firmware-file-input');
        const file = input?.files[0];
        if (!file) return;

        const uploadBtn = document.getElementById('firmware-upload-btn');
        if (uploadBtn) {
            uploadBtn.disabled = true;
            uploadBtn.textContent = 'Uploading...';
        }

        try {
            ui.showToast('Uploading firmware — this may take several minutes...', 10000, 'info');
            await uploadFirmware(file);
            ui.showToast('Firmware uploaded successfully. Restart the machine to apply.', 8000, 'success');
        } catch (error) {
            logger.error('Error uploading firmware:', error);
            ui.showToast(`Firmware upload failed: ${error.message}`, 5000, 'error');
            if (uploadBtn) {
                uploadBtn.disabled = false;
                uploadBtn.textContent = 'Upload';
            }
        }
    };

    window.setActiveSkin = async function(skinId) {
        if (!skinId) return;
        try {
            ui.showToast('Switching skin...', 0, 'info');
            await setDefaultSkin(skinId);
            await stopWebuiServer();
            await startWebuiServer();
            ui.showToast('Skin applied. Refresh the page to load the new skin.', 0, 'success');
            // Show a persistent refresh banner
            const existing = document.getElementById('skin-refresh-banner');
            if (!existing) {
                const banner = document.createElement('div');
                banner.id = 'skin-refresh-banner';
                banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:20000;background:#385a92;color:white;display:flex;align-items:center;justify-content:center;gap:24px;padding:20px 32px;font-size:24px;font-family:Inter,sans-serif;';
                banner.innerHTML = `
                    <span>Skin changed — refresh the page to apply.</span>
                    <button onclick="location.reload()" style="background:white;color:#385a92;border:none;border-radius:40px;padding:10px 32px;font-size:22px;font-weight:bold;cursor:pointer;">Refresh Now</button>
                    <button onclick="document.getElementById('skin-refresh-banner').remove()" style="background:transparent;color:white;border:2px solid white;border-radius:40px;padding:10px 32px;font-size:22px;cursor:pointer;">Later</button>
                `;
                document.body.appendChild(banner);
            }
        } catch (error) {
            logger.error('Error setting active skin:', error);
            ui.showToast(`Failed to switch skin: ${error.message}`, 5000, 'error');
        }
    };

    window.updateSkin = async function() {
        try {
            const beforeVersion = settingsCache.appInfo?.version;
            ui.showToast('Checking for skin updates...', 3000, 'info');
            await updateSkins();
            const updatedInfo = await getAppInfo();
            if (beforeVersion && updatedInfo?.version === beforeVersion) {
                ui.showToast(`You're already on the latest version (${beforeVersion}).`, 4000, 'info');
            } else {
                ui.showToast('Skin updated successfully. Reloading...', 2000, 'success');
                setTimeout(() => window.location.reload(), 2000);
            }
        } catch (error) {
            logger.error('Error updating skin:', error);
            ui.showToast(`Failed to update skin: ${error.message}`, 5000, 'error');
        }
    };
    window.updateSteamSetting = updateSteamSetting;
    window.updateHotWaterSetting = updateHotWaterSetting;
    window.flashPlusMinusButton = ui.flashPlusMinusButton;
    window.retryLoadSettings = () => {
        preloadSettings().then(() => {
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        });
    };

    // Expose flush adjustment functions to global scope
    window.adjustFlushTemp = function(change) {
        const input = document.getElementById('flushTempInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            // Ensure value stays within bounds (5 to 95 degrees)
            newValue = Math.max(5, Math.min(95, newValue));
            input.value = newValue.toFixed(1);
            // Trigger the onchange event to update the setting
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustFlushFlow = function(change) {
        const input = document.getElementById('flushFlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            // Ensure value stays within bounds (1 to 8 ml/s)
            newValue = Math.max(1, Math.min(8, newValue));
            input.value = newValue.toFixed(1);
            // Trigger the onchange event to update the setting
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustWeightFlowMultiplier = function(change) {
        const input = document.getElementById('weightFlowMultiplierInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, Math.min(5, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustVolumeFlowMultiplier = function(change) {
        const input = document.getElementById('volumeFlowMultiplierInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, Math.min(2, newValue));
            input.value = newValue.toFixed(2);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterFlow = function(change) {
        const input = document.getElementById('hotWaterFlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0.1, Math.min(8, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterTemp = function(change) {
        const input = document.getElementById('hotWaterTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(50, Math.min(95, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterVolume = function(change) {
        const input = document.getElementById('hotWaterVolumeInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(10, Math.min(500, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterDuration = function(change) {
        const input = document.getElementById('hotWaterDurationInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(5, Math.min(120, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHeaterPh1Flow = function(change) {
        const input = document.getElementById('heaterPh1FlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, Math.min(10, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHeaterPh2Flow = function(change) {
        const input = document.getElementById('heaterPh2FlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, Math.min(10, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustTankTemp = function(change) {
        const input = document.getElementById('tankTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(10, Math.min(40, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    let _waterAlertDebounce = null;
    window.commitWaterAlert = function(value) {
        const snapped = snapWaterAlertLevel(value);
        const input = document.getElementById('waterAlertInput');
        if (input && parseInt(input.value, 10) !== snapped) {
            input.value = snapped;
        }
        localStorage.setItem('waterRefillLevel', String(snapped));
        clearTimeout(_waterAlertDebounce);
        _waterAlertDebounce = setTimeout(async () => {
            try {
                await setWaterLevels(snapped);
                logger.info(`Water refill level set to ${snapped}mm`);
            } catch (err) {
                logger.error('Failed to set water refill level:', err);
                ui.showToast('Failed to update water alert level', 4000, 'error');
            }
        }, 400);
    };

    window.adjustWaterAlert = function(change) {
        const input = document.getElementById('waterAlertInput');
        if (input) {
            const current = parseInt(input.value, 10) || 0;
            const idx = WATER_ALERT_LEVELS.indexOf(snapWaterAlertLevel(current));
            const dir = change > 0 ? 1 : -1;
            const nextIdx = Math.max(0, Math.min(WATER_ALERT_LEVELS.length - 1, idx + dir));
            input.value = WATER_ALERT_LEVELS[nextIdx];
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustFanThreshold = function(change) {
        const input = document.getElementById('calibFanInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(0, Math.min(100, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.stepFanThreshold = function(change) {
        const input = document.getElementById('fanThresholdInput');
        const display = document.getElementById('fan-display');
        const fill = document.getElementById('fan-track-fill');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(0, Math.min(100, newValue));
            input.value = newValue;
            if (display) display.textContent = newValue;
            if (fill) fill.style.width = newValue + '%';
            window.updateDe1Setting('fan', newValue);
        }
    };

    window.adjustSteamCalibTemp = function(change) {
        const input = document.getElementById('steamCalibTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(135, Math.min(170, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustSteamTemp = function(change) {
        const input = document.getElementById('steamTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(130, Math.min(170, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustSteamDuration = function(change) {
        const input = document.getElementById('steamDurationInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(10, Math.min(120, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustSteamFlow = function(change) {
        const input = document.getElementById('steamFlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0.1, Math.min(2.5, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    const mainSeparator = document.getElementById('separator');
    const leftPanel     = document.getElementById('left-panel');
    const rightPanel    = document.getElementById('right-panel');

    if (mainSeparator && leftPanel && rightPanel) {
        let isDragging = false;

        function thicken() {
            mainSeparator.classList.remove('w-px');
            mainSeparator.classList.add('w-2');
        }
        function restore() {
            mainSeparator.classList.remove('w-2');
            mainSeparator.classList.add('w-px');
        }

        function beginDrag(clientX) {
            isDragging = true;
            thicken();
            document.body.style.cursor    = 'col-resize';
            document.body.style.userSelect = 'none';

            const startX         = clientX;
            const startLeftWidth = leftPanel.offsetWidth;

            function applyDelta(cx) {
                if (!isDragging) return;
                const dx           = cx - startX;
                const newLeftWidth = startLeftWidth + dx;
                if (newLeftWidth > 200 && newLeftWidth < 1600) {
                    leftPanel.style.width = `${newLeftWidth}px`;
                }
            }

            function onMouseMove(e) { applyDelta(e.clientX); }
            function onTouchMove(e) {
                if (e.touches[0]) {
                    applyDelta(e.touches[0].clientX);
                    e.preventDefault();
                }
            }

            function stopDrag() {
                isDragging = false;
                restore();
                document.body.style.cursor     = '';
                document.body.style.userSelect  = '';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup',   stopDrag);
                document.removeEventListener('touchmove', onTouchMove);
                document.removeEventListener('touchend',  stopDrag);
                document.removeEventListener('touchcancel', stopDrag);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup',   stopDrag);
            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend',  stopDrag);
            document.addEventListener('touchcancel', stopDrag);
        }

        mainSeparator.addEventListener('mousedown', (e) => beginDrag(e.clientX));
        mainSeparator.addEventListener('touchstart', (e) => {
            if (e.touches[0]) beginDrag(e.touches[0].clientX);
        }, { passive: true });
    }
}

// Set up search functionality for settings
function setupSettingsSearch() {
    const searchInput = document.getElementById('settings-search');
    if (!searchInput) {
        console.warn('Settings search input not found');
        return;
    }

    // Store original navigation structure
    const originalMainCategories = {};
    Object.keys(settingsTree).forEach(key => {
        originalMainCategories[key] = { ...settingsTree[key] };
    });

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();

        if (searchTerm === '') {
            // If search is empty, restore original navigation
            restoreOriginalNavigation();
            return;
        }

        // Filter categories based on search term
        const filteredCategories = {};
        
        Object.entries(settingsTree).forEach(([key, category]) => {
            // Check if main category name matches
            const mainCategoryMatches = category.name.toLowerCase().includes(searchTerm);
            
            // Filter subcategories that match
            const matchingSubcategories = category.subcategories.filter(subcat => 
                subcat.name.toLowerCase().includes(searchTerm) || 
                subcat.id.toLowerCase().includes(searchTerm)
            );

            // Include the category if either main name matches or any subcategory matches
            if (mainCategoryMatches || matchingSubcategories.length > 0) {
                filteredCategories[key] = {
                    name: category.name,
                    subcategories: matchingSubcategories.length > 0 ? matchingSubcategories : category.subcategories
                };
            }
        });

        // Update the navigation with filtered results
        updateNavigationWithResults(filteredCategories, searchTerm);
    });
}

// Restore original navigation when search is cleared
function restoreOriginalNavigation() {
    const mainCategoriesPanel = document.getElementById('main-categories-panel');
    if (!mainCategoriesPanel) return;

    // Clear and rebuild the main categories panel
    const navUl = mainCategoriesPanel.querySelector('nav ul');
    if (navUl) {
        navUl.innerHTML = '';
        
        Object.entries(settingsTree).forEach(([key, category]) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.id = `${key}-btn`;
            btn.className = 'settings-nav-btn w-full text-left px-4 py-3 rounded-lg text-[24px] text-[#959595] hover:text-white hover:bg-[#2c4a7a] flex items-center';
            btn.innerHTML = `<span>${category.name}</span>`;
            
            navUl.appendChild(li);
            li.appendChild(btn);
        });
    }

    // Reattach event listeners to the restored buttons
    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
        // Remove any existing listeners to avoid duplicates
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        newBtn.addEventListener('click', function() {
            // Handle active state for main categories
            document.querySelectorAll('.settings-nav-btn').forEach(b => {
                b.classList.remove('text-white', 'bg-[#2c4a7a]');
                b.classList.add('text-[#959595]'); // Explicitly re-add default color
            });
            this.classList.remove('text-[#959595]'); // Explicitly remove default color
            this.classList.add('text-white', 'bg-[#2c4a7a]');

            const mainCategoryKey = this.id.replace(/-btn$/, '').replace(/-/g, '');

            // Render subcategories
            const subCategoriesPanel = document.getElementById('sub-categories-panel');
            if (subCategoriesPanel) {
                subCategoriesPanel.innerHTML = renderSubcategories(mainCategoryKey);

                // Add event listeners to the new subcategory buttons
                subCategoriesPanel.querySelectorAll('.settings-subnav-btn').forEach(subBtn => {
                    subBtn.addEventListener('click', function(e) {
                        e.preventDefault(); // Prevent any default behavior that might cause page reload
                        e.stopPropagation(); // Stop event from bubbling up

                        // Handle active state for subcategories
                        subCategoriesPanel.querySelectorAll('.settings-subnav-btn').forEach(sb => {
                             sb.classList.remove('text-white', 'bg-[#2c4a7a]');
                             sb.classList.add('text-[#959595]');
                        });
                        this.classList.remove('text-[#959595]');
                        this.classList.add('text-white', 'bg-[#2c4a7a]');

                        const settingsCategory = this.dataset.category;
                        activeSettingsCategory = settingsCategory; // Set the active category
                        updateSettingsContentArea(settingsCategory); // Use the new helper function
                    });
                });
            }

            // After rendering subcategories, attempt to click the first one if it exists
            const firstSubCategoryBtn = subCategoriesPanel?.querySelector('.settings-subnav-btn');
            if (firstSubCategoryBtn) {
                firstSubCategoryBtn.click();
            } else {
                // If no subcategories, clear the content area and set activeSettingsCategory to null
                const contentArea = document.getElementById('settings-content-area');
                if (contentArea) {
                    contentArea.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-center p-8">
                        <p class="text-[var(--text-primary)] text-[28px]">Select a sub-category from the menu</p>
                    </div>`;
                    activeSettingsCategory = null;
                }
            }
        });
    });

    // Clear the subcategories panel when restoring original navigation
    const subCategoriesPanel = document.getElementById('sub-categories-panel');
    if (subCategoriesPanel) {
        subCategoriesPanel.innerHTML = '';
    }
}

// Update navigation with search results
function updateNavigationWithResults(filteredCategories, searchTerm) {
    const mainCategoriesPanel = document.getElementById('main-categories-panel');
    if (!mainCategoriesPanel) return;

    // Clear and rebuild the main categories panel with filtered results
    const navUl = mainCategoriesPanel.querySelector('nav ul');
    if (navUl) {
        navUl.innerHTML = '';
        
        const allKeys = Object.keys(settingsTree);
        Object.entries(filteredCategories).forEach(([key, category]) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.id = `${key}-btn`;
            btn.className = 'settings-nav-btn w-full text-left px-4 py-3 rounded-lg text-[24px] text-[#959595] hover:text-white hover:bg-[#2c4a7a] flex items-center';

            const number = allKeys.indexOf(key) + 1;
            const highlightedName = highlightMatch(category.name, searchTerm);
            btn.innerHTML = `${number}. <span>${highlightedName}</span>`;

            navUl.appendChild(li);
            li.appendChild(btn);
        });
    }

    // Attach event listeners to the filtered buttons
    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
        // Remove any existing listeners to avoid duplicates
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', function() {
            // Handle active state for main categories
            document.querySelectorAll('.settings-nav-btn').forEach(b => {
                b.classList.remove('text-white', 'bg-[#2c4a7a]');
                b.classList.add('text-[#959595]');
            });
            this.classList.remove('text-[#959595]');
            this.classList.add('text-white', 'bg-[#2c4a7a]');

            const mainCategoryKey = this.id.replace(/-btn$/, '').replace(/-/g, '');
            const category = settingsTree[mainCategoryKey];

            // Render all subcategories for the selected main category
            const subCategoriesPanel = document.getElementById('sub-categories-panel');
            if (subCategoriesPanel) {
                subCategoriesPanel.innerHTML = renderSubcategories(mainCategoryKey);

                subCategoriesPanel.querySelectorAll('.settings-subnav-btn').forEach(subBtn => {
                    subBtn.addEventListener('click', function(e) {
                        e.preventDefault();
                        e.stopPropagation();

                        subCategoriesPanel.querySelectorAll('.settings-subnav-btn').forEach(sb => {
                             sb.classList.remove('text-white', 'bg-[#2c4a7a]');
                             sb.classList.add('text-[#959595]');
                        });
                        this.classList.remove('text-[#959595]');
                        this.classList.add('text-white', 'bg-[#2c4a7a]');

                        const settingsCategory = this.dataset.category;
                        activeSettingsCategory = settingsCategory;
                        updateSettingsContentArea(settingsCategory);
                    });
                });
            }

            // If main category name didn't match the search, the user got here via a
            // subcategory match — jump directly to the first matching subcategory.
            // Otherwise fall back to the first subcategory in the list.
            const subBtns = [...(subCategoriesPanel?.querySelectorAll('.settings-subnav-btn') || [])];
            const mainMatches = category && category.name.toLowerCase().includes(searchTerm);
            const targetSubBtn = (!mainMatches && searchTerm)
                ? (subBtns.find(sb => sb.textContent.toLowerCase().includes(searchTerm)) || subBtns[0])
                : subBtns[0];

            if (targetSubBtn) {
                targetSubBtn.click();
            } else {
                const contentArea = document.getElementById('settings-content-area');
                if (contentArea) {
                    contentArea.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-center p-8">
                        <p class="text-[var(--text-primary)] text-[28px]">Select a sub-category from the menu</p>
                    </div>`;
                    activeSettingsCategory = null;
                }
            }
        });
    });

    // Auto-click the first result so subcategories appear without a manual click
    const firstBtn = navUl?.querySelector('.settings-nav-btn');
    if (firstBtn) firstBtn.click();
}

// Render filtered subcategories based on search term
function renderFilteredSubcategories(mainCategoryKey, searchTerm) {
    const category = settingsTree[mainCategoryKey];
    if (!category || !category.subcategories || category.subcategories.length === 0) {
        return `<div class="p-4 text-center text-gray-500">No sub-categories.</div>`;
    }

    // Filter subcategories that match the search term
    const matchingSubcategories = category.subcategories.filter(subcat => 
        subcat.name.toLowerCase().includes(searchTerm) || 
        subcat.id.toLowerCase().includes(searchTerm)
    );

    if (matchingSubcategories.length === 0) {
        return `<div class="p-4 text-center text-gray-500">No matching subcategories.</div>`;
    }

    let subcategoryItems = '';
    matchingSubcategories.forEach((subcat) => {
        // Highlight matching text in the subcategory name
        const highlightedName = highlightMatch(subcat.name, searchTerm);
        
        subcategoryItems += `
            <li>
                <button class="settings-subnav-btn w-full text-left px-4 py-3 rounded-lg text-[24px] text-[#959595] hover:text-white hover:bg-[#2c4a7a] flex items-center"
                        data-category="${subcat.settingsCategory}">
                    <span>${highlightedName}</span>
                </button>
            </li>
        `;
    });

    return `<ul class="space-y-1">${subcategoryItems}</ul>`;
}

// Highlight matching text within a string
function highlightMatch(text, searchTerm) {
    if (!searchTerm) return text;

    const regex = new RegExp(`(${searchTerm})`, 'gi');
    return text.replace(regex, '<mark class="bg-yellow-300 text-black">$1</mark>');
}

/**
 * Initialize WebSocket connection for live device state updates
 * Should be called once when the settings page loads
 */
export function initDeviceWebSocket() {
    if (deviceStateCache.initialized) {
        logger.info('Device WebSocket already initialized');
        return;
    }

    connectDeviceWebSocket(
        // onData callback - update cache and re-render device lists in real-time
        (data) => {
            logger.debug('Device WebSocket data received:', data);
            deviceStateCache.devices = data.devices || [];
            deviceStateCache.scanning = data.scanning || false;
            deviceStateCache.initialized = true;

            // Always re-render device lists when new data arrives
            // This ensures live updates whenever device state changes
            renderDeviceListFromCache();
        },
        // onReconnect callback
        () => {
            logger.info('Device WebSocket reconnected');
            // Re-render to show updated connection states
            renderDeviceListFromCache();
        },
        // onDisconnect callback
        () => {
            logger.warn('Device WebSocket disconnected');
        }
    );

    deviceStateCache.initialized = true;
    logger.info('Device WebSocket initialized');
}

/**
 * Initialize display WebSocket connection
 */
export function initDisplayWebSocket() {
    connectDisplayWebSocket((data) => {
        logger.debug('Display state received:', data);

        // Update brightness slider if it exists
        const brightnessSlider = document.querySelector('input[type="range"][onchange*="handleBrightnessChange"]');
        if (brightnessSlider && data.brightness !== undefined) {
            brightnessSlider.value = data.brightness;
        }

        // Update wake-lock toggle if it exists
        const wakeLockToggle = document.getElementById('wake-lock-toggle');
        if (wakeLockToggle && data.wakeLockEnabled !== undefined) {
            wakeLockToggle.checked = data.wakeLockEnabled;
            localStorage.setItem('wakeLockEnabled', data.wakeLockEnabled.toString());
        }
    });

    logger.info('Display WebSocket initialized');
}

/**
 * Render device lists from WebSocket cache
 */
window.renderDeviceListFromCache = function() { renderDeviceListFromCache(); };

function renderDeviceListFromCache() {
    const machines = deviceStateCache.devices.filter(device =>
        device.type === 'machine' ||
        (device.name && (device.name.toLowerCase().includes('de1') ||
                        device.name.toLowerCase().includes('espresso')))
    );

    const scales = deviceStateCache.devices.filter(device =>
        device.type === 'scale' ||
        (device.name && (device.name.toLowerCase().includes('scale') ||
                        device.name.toLowerCase().includes('weight')))
    );

    renderDeviceList('bluetooth-machine-devices-container', machines, 'Machine',
        settingsCache.rea?.preferredMachineId || '', 'preferredMachineId');
    renderDeviceList('bluetooth-scale-devices-container', scales, 'Scale',
        settingsCache.rea?.preferredScaleId || '', 'preferredScaleId');
}

// Bluetooth Functions

// Function to scan for available devices and populate the dropdowns
window.scanAndConnectEspresso = async function() {
    try {
        ui.showToast('Scanning for espresso machines...', 2000, 'info');

        // Use WebSocket to trigger scan
        sendDeviceCommand({ command: 'scan', connect: false });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');

    } catch (error) {
        console.error('Error scanning for espresso machines:', error);
        ui.showToast(`Error scanning for devices: ${error.message}`, 5000, 'error');
    }
};

// Function to scan for scales and connect
window.scanAndConnectScale = async function() {
    try {
        ui.showToast('Scanning for weighing scales...', 2000, 'info');

        // Use WebSocket to trigger scan
        sendDeviceCommand({ command: 'scan', connect: false });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');

    } catch (error) {
        console.error('Error scanning for scales:', error);
        ui.showToast(`Error scanning for devices: ${error.message}`, 5000, 'error');
    }
};

window.handleBrightnessChange = async function(value) {
    try {
        const brightnessValue = parseInt(value);
        const slider = document.getElementById('brightness-slider');

        // Update slider visual fill
        if (slider) {
            const percentage = (brightnessValue / 100) * 100;
            slider.style.background = `linear-gradient(to right, #385a92 0%, #385a92 ${percentage}%, #e8e8e8 ${percentage}%, #e8e8e8 100%)`;
        }

        sendDisplayCommand({
            command: 'setBrightness',
            brightness: brightnessValue
        });
    } catch (error) {
        console.error('Error adjusting brightness:', error);
    }
};

window.handleBrightnessAutoToggle = async function(isEnabled) {
    try {
        const slider = document.getElementById('brightness-slider');
        if (slider) {
            slider.disabled = isEnabled;
            slider.style.opacity = isEnabled ? '0.5' : '1';
            slider.style.cursor = isEnabled ? 'not-allowed' : 'pointer';
        }

        if (isEnabled) {
            logger.info('Auto brightness enabled');
            // You can add logic here to request auto brightness from the display WebSocket
        } else {
            logger.info('Auto brightness disabled');
        }
    } catch (error) {
        console.error('Error toggling auto brightness:', error);
    }
};

// Wake Lock handlers
window.handleWakeLockToggle = async function(enabled) {
    try {
        if (enabled) {
            await enableWakeLock();
            localStorage.setItem('wakeLockEnabled', 'true');
            ui.showToast('Wake lock enabled', 3000, 'success');
        } else {
            await disableWakeLock();
            localStorage.setItem('wakeLockEnabled', 'false');
            ui.showToast('Wake lock disabled', 3000, 'success');
        }
    } catch (error) {
        console.error('Error toggling wake lock:', error);
        ui.showToast('Failed to toggle wake lock', 5000, 'error');
    }
};

// Presence Detection handlers
window.handlePresenceToggle = async function(enabled) {
    try {
        await setPresenceSettings({ userPresenceEnabled: enabled });
        ui.showToast(`Presence detection ${enabled ? 'enabled' : 'disabled'}`, 3000, 'success');
    } catch (error) {
        console.error('Error toggling presence detection:', error);
        ui.showToast('Failed to update presence detection', 5000, 'error');
    }
};

window.handleSleepTimeoutChange = async function(minutes) {
    try {
        const value = parseInt(minutes, 10);
        if (value < 1 || value > 120) {
            ui.showToast('Sleep timeout must be between 1 and 120 minutes', 5000, 'error');
            return;
        }
        await setPresenceSettings({ sleepTimeoutMinutes: value });
        ui.showToast('Sleep timeout updated', 3000, 'success');
    } catch (error) {
        console.error('Error updating sleep timeout:', error);
        ui.showToast('Failed to update sleep timeout', 5000, 'error');
    }
};

window.handleAddSchedule = function() {
    document.getElementById('add-schedule-modal').showModal();
};

window.handleSaveSchedule = async function() {
    try {
        const timeInput = document.getElementById('schedule-time-input').value;
        if (!timeInput) {
            ui.showToast('Please select a time', 3000, 'error');
            return;
        }

        const checkboxes = document.querySelectorAll('#add-schedule-modal input[type="checkbox"]:checked');
        const daysOfWeek = Array.from(checkboxes).map(cb => parseInt(cb.value, 10));

        const hours = parseInt(document.getElementById('keep-awake-hours-input').value, 10) || 0;
        const mins = parseInt(document.getElementById('keep-awake-mins-input').value, 10) || 0;

        if (hours > 12) {
            ui.showToast('Keep awake duration cannot exceed 12 hours (720 minutes)', 5000, 'error');
            return;
        }

        const keepAwakeFor = (hours * 60) + mins;

        const schedule = {
            time: timeInput,
            daysOfWeek: daysOfWeek,
            enabled: true
        };

        if (keepAwakeFor >= 1 && keepAwakeFor <= 720) {
            schedule.keepAwakeFor = keepAwakeFor;
        }

        await createPresenceSchedule(schedule);
        ui.showToast('Schedule created', 3000, 'success');

        // Clear form inputs
        document.getElementById('schedule-time-input').value = '';
        document.getElementById('keep-awake-hours-input').value = '0';
        document.getElementById('keep-awake-mins-input').value = '0';
        document.querySelectorAll('#add-schedule-modal input[type="checkbox"]').forEach(cb => cb.checked = false);

        document.getElementById('add-schedule-modal').close();
        updateSettingsContentArea('presence');
    } catch (error) {
        console.error('Error creating schedule:', error);
        ui.showToast('Failed to create schedule', 5000, 'error');
    }
};

window.handleScheduleToggle = async function(scheduleId, enabled) {
    try {
        await updatePresenceSchedule(scheduleId, { enabled });
        ui.showToast(`Schedule ${enabled ? 'enabled' : 'disabled'}`, 3000, 'success');
        // No need to reload entire view - the toggle state is already updated in the DOM
    } catch (error) {
        console.error('Error toggling schedule:', error);
        ui.showToast('Failed to update schedule', 5000, 'error');
        // On error, revert the toggle in the UI
        const toggle = document.querySelector(`input[onchange*="${scheduleId}"]`);
        if (toggle) toggle.checked = !enabled;
    }
};

window.handleDeleteSchedule = async function(scheduleId) {
    if (!confirm('Are you sure you want to delete this schedule?')) return;

    try {
        await deletePresenceSchedule(scheduleId);
        ui.showToast('Schedule deleted', 3000, 'success');
        updateSettingsContentArea('presence');
    } catch (error) {
        console.error('Error deleting schedule:', error);
        ui.showToast('Failed to delete schedule', 5000, 'error');
    }
};

window.handleMachineStateChange = async function(newState) {
    try {
        if (newState === MachineState.SLEEPING) {
            dimDisplay();
        } else if (newState === MachineState.IDLE) {
            restoreDisplay();
        }
    } catch (error) {
        console.error('Error auto-adjusting display based on machine state:', error);
    }
};

// Render Bluetooth Machine settings
export function renderBluetoothMachineSettings() {
    setTimeout(() => { renderDeviceListFromCache(); }, 0);

    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">

            <!-- Header -->
            <div class="flex justify-between items-center w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px]">
                    <p class="leading-[1.2]">Espresso Machine</p>
                </div>
                <button id="scan-machine-btn"
                        class="border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border w-[139px] text-[24px] transition-colors duration-200 hover:bg-[var(--mimoja-blue)] hover:text-white"
                        onclick="window.scanForMachines()">
                    Scan
                </button>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <!-- Connected Device -->
            <div class="flex flex-col gap-[20px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]">Connected Device</p>
                </div>
                <div id="bluetooth-machine-devices-container" class="w-full">
                    <!-- Machine devices will be populated dynamically via WebSocket -->
                </div>
            </div>

        </div>
    `;
}

// Render Bluetooth Scale settings
export function renderBluetoothScaleSettings(settings) {
    // Render devices from WebSocket cache on initial render
    setTimeout(() => {
        renderDeviceListFromCache();
    }, 0);

    const scalePowerMode = settings?.scalePowerMode ?? 'disabled';
    const blockOnNoScale = settings?.blockOnNoScale ?? false;

    return `
        <div class="flex flex-col gap-[32px] items-start relative w-full max-w-full overflow-x-hidden">

            <!-- Header -->
            <div class="flex justify-between items-center w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px]">
                    <p class="leading-[1.2]">Scale</p>
                </div>
                <button id="scan-scale-btn"
                        class="border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border w-[139px] text-[24px] transition-colors duration-200 hover:bg-[var(--mimoja-blue)] hover:text-white"
                        onclick="window.scanForScales()">
                    Scan
                </button>
            </div>

            <hr class="border-t border-[#c9c9c9] w-full" />

            <!-- Connected Device -->
            <div class="flex flex-col gap-[16px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]">Connected Device</p>
                </div>
                <div id="bluetooth-scale-devices-container" class="w-full">
                    <!-- Scale devices will be populated dynamically via WebSocket -->
                </div>
            </div>

            <hr class="border-t border-[#c9c9c9] w-full" />

            <!-- Scale Power Mode -->
            <div class="flex flex-col gap-[16px] items-start relative w-full">
                <div class="flex flex-col gap-[8px] items-start relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p id="scale-power-management-label" class="leading-[1.2]">Scale Power Mode</p>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words">
                        Controls scale behaviour when machine sleeps.
                    </p>
                </div>
                <div class="flex items-center gap-[8px]" role="group" aria-labelledby="scale-power-management-label">
                    <button class="h-[100px] w-[280px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200
                        ${scalePowerMode === 'disabled' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                        aria-pressed="${scalePowerMode === 'disabled'}"
                        onclick="window.updateReaSetting('scalePowerMode', 'disabled')">
                        Nothing
                    </button>
                    <button class="h-[100px] w-[280px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200
                        ${scalePowerMode === 'displayOff' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                        aria-pressed="${scalePowerMode === 'displayOff'}"
                        onclick="window.updateReaSetting('scalePowerMode', 'displayOff')">
                        Display Off
                    </button>
                    <button class="h-[100px] w-[280px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200
                        ${scalePowerMode === 'disconnect' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                        aria-pressed="${scalePowerMode === 'disconnect'}"
                        onclick="window.updateReaSetting('scalePowerMode', 'disconnect')">
                        Disconnect
                    </button>
                </div>
            </div>

            <hr class="border-t border-[#c9c9c9] w-full" />

            <!-- Block Shot on No Scale -->
            <div class="flex items-center justify-between w-full">
                <div class="flex flex-col gap-[8px]">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Scale Required</p>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px]">
                        Prevent shots from starting when no scale is connected.
                    </p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="block-on-no-scale-toggle" class="sr-only peer" ${blockOnNoScale ? 'checked' : ''} onchange="window.updateReaSetting('blockOnNoScale', this.checked, false)">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

        </div>
    `;
}

// Function to render all available devices with individual connection controls
async function renderAllDevices() {
    try {
     

        // Get all available devices
        // const devices = await getDevices();
            const devices = await scanForDevices();
        // Separate devices into machines and scales
        const machines = devices.filter(device => 
            device.name && (device.name.toLowerCase().includes('decent') || 
                           device.name.toLowerCase().includes('espresso') || 
                           device.type === 'espresso')
        );
        
        const scales = devices.filter(device => 
            device.name && (device.name.toLowerCase().includes('scale') || 
                           device.name.toLowerCase().includes('weight') || 
                           device.type === 'scale')
        );

        // Render devices in their respective containers
        renderDeviceList('bluetooth-machine-devices-container', machines, 'Machine');
        renderDeviceList('bluetooth-scale-devices-container', scales, 'Scale');
        
        // Also render to the general container if we're on the main bluetooth page
        const generalContainer = document.getElementById('bluetooth-devices-container');
        if (generalContainer) {
            if (machines.length > 0 || scales.length > 0) {
                let allDevicesHTML = '';
                if (machines.length > 0) {
                    allDevicesHTML += '<div class="mb-8">';
                    allDevicesHTML += '<h3 class="text-[30px] text-[var(--text-primary)] mb-4">Espresso Machines</h3>';
                    allDevicesHTML += renderSingleDeviceList(machines);
                    allDevicesHTML += '</div>';
                }
                
                if (scales.length > 0) {
                    allDevicesHTML += '<div class="mb-8">';
                    allDevicesHTML += '<h3 class="text-[30px] text-[var(--text-primary)] mb-4">Weighing Scales</h3>';
                    allDevicesHTML += renderSingleDeviceList(scales);
                    allDevicesHTML += '</div>';
                }
                
                generalContainer.innerHTML = allDevicesHTML;
            } else {
                generalContainer.innerHTML = '<p class="text-[24px] text-[var(--text-primary)]">No Bluetooth devices found. Make sure your devices are powered on and in pairing mode.</p>';
            }
        }

        // statusDiv.innerHTML = `<p>Found ${devices.length} device(s). ${machines.length} machine(s), ${scales.length} scale(s).</p>`;
    } catch (error) {
        console.error('Error scanning for devices:', error);
  
    }
}

// Helper function to render a list of devices of a specific type
function renderDeviceList(containerId, devices, type, preferredId = '', settingKey = '') {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (devices.length > 0) {
        container.innerHTML = renderSingleDeviceList(devices, preferredId, settingKey, type);
    } else {
        container.innerHTML = `
            <div class="flex items-center gap-[16px] w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[18px] px-[28px] py-[24px] opacity-60">
                <div class="w-[14px] h-[14px] rounded-full bg-[var(--profile-button-outline-color)] flex-shrink-0"></div>
                <p class="text-[24px] text-[var(--text-primary)]">No ${type.toLowerCase()} found — tap Scan to search for nearby devices.</p>
            </div>`;
    }
}

// Helper function to render a single list of devices with connection controls
function renderBatteryBadge(level) {
    const pct  = Math.round(level);
    const color = pct <= 20 ? '#ef4444' : pct <= 50 ? '#eab308' : '#22c55e';
    const fill  = Math.round((pct / 100) * 20);
    return `<div class="flex items-center gap-[6px] mt-[4px]">
        <svg width="26" height="14" viewBox="0 0 26 14" fill="none">
            <rect x="0.5" y="0.5" width="22" height="13" rx="2.5" stroke="${color}" stroke-width="1.2"/>
            <rect x="23" y="4" width="3" height="6" rx="1" fill="${color}"/>
            <rect x="2" y="2" width="${fill}" height="10" rx="1.5" fill="${color}"/>
        </svg>
        <span class="text-[18px] font-mono" style="color:${color}">${pct}%</span>
    </div>`;
}

function renderSingleDeviceList(devices, preferredId = '', settingKey = '', type = '') {
    // Null/empty check - return empty string if no devices
    if (!devices || !Array.isArray(devices) || devices.length === 0) {
        return '';
    }

    let deviceItems = '';

    devices.forEach(device => {
        if (!device || !device.name) return;

        const isConnected = device.state === 'connected';
        const isPreferred = preferredId && device.id === preferredId;
        const buttonText = isConnected ? 'Disconnect' : 'Connect';
        const buttonAction = isConnected ? 'disconnect' : 'connect';
        const safeId = (device.id || '').replace(/'/g, "\\'");
        const safeSettingKey = settingKey.replace(/'/g, "\\'");

        deviceItems += `
            <div class="flex items-center justify-between w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[18px] px-[28px] py-[24px] mb-[16px]">
                <div class="flex items-center gap-[16px] flex-1 min-w-0">
                    <!-- Status dot -->
                    <div class="relative flex-shrink-0">
                        <div class="w-[14px] h-[14px] rounded-full ${isConnected ? 'bg-green-500' : 'bg-[var(--profile-button-outline-color)]'}"></div>
                        ${isConnected ? '<div class="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-40"></div>' : ''}
                    </div>
                    <div class="flex flex-col gap-[4px] min-w-0">
                        <span class="text-[26px] font-bold text-[var(--text-primary)] truncate leading-tight">${device.name}</span>
                        <span class="text-[18px] text-[var(--text-primary)] opacity-40 font-mono truncate">${device.id || 'N/A'}</span>
                    </div>
                </div>
                <div class="flex items-center gap-[20px] flex-shrink-0 ml-[24px]">
                    ${(() => {
                        if (type === 'Scale' && isConnected) {
                            const batt = window.getLatestScaleBattery?.();
                            return batt !== null && batt !== undefined ? renderBatteryBadge(batt) : '';
                        }
                        return '';
                    })()}
                    ${settingKey ? `
                    <div class="flex flex-col items-center gap-[4px]">
                        <span class="text-[16px] text-[var(--text-primary)] opacity-50">Preferred</span>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[72px] h-[36px]">
                            <input type="checkbox" class="sr-only peer"
                                   ${isPreferred ? 'checked' : ''}
                                   onchange="window.setPreferredDevice('${safeSettingKey}', '${safeId}', this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[4px] -translate-y-1/2 peer-checked:translate-x-[36px] size-[28px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    ` : ''}
                    <span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full ${isConnected ? 'bg-green-500/15 text-green-600' : 'bg-[var(--profile-button-outline-color)]/30 text-[var(--text-primary)] opacity-50'}">
                        ${isConnected ? 'Connected' : 'Available'}
                    </span>
                    <button class="${isConnected ? 'border-2 border-[#385a92] text-[#385a92] hover:bg-[#385a92] hover:text-white' : 'bg-[#385a92] text-white hover:bg-[#2c4a7a]'} h-[62px] px-[32px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200"
                            onclick="window.handleDeviceConnection('${device.id}', '${buttonAction}')">
                        ${buttonText}
                    </button>
                </div>
            </div>
        `;
    });

    return deviceItems;
}




// Function to handle connecting or disconnecting a device
window.handleDeviceConnection = async function(deviceId, action) {
    if (action === 'connect') {
        try {
            sendDeviceCommand({ command: 'connect', deviceId });
            ui.showToast(`Connected to device ${deviceId}`, 3000, 'success');
            // Device list will update automatically via WebSocket onData callback
        } catch (error) {
            console.error('Error connecting to device:', error);
            ui.showToast(`Failed to connect: ${error.message}`, 5000, 'error');
        }
    } else if (action === 'disconnect') {
        try {
            sendDeviceCommand({ command: 'disconnect', deviceId });
            ui.showToast(`Disconnected from device ${deviceId}`, 3000, 'info');
            // Device list will update automatically via WebSocket onData callback
        } catch (error) {
            console.error('Error disconnecting from device:', error);
            ui.showToast(`Failed to disconnect: ${error.message}`, 5000, 'error');
        }
    }
};


// Set or clear the preferred device for a given setting key
window.setPreferredDevice = async function(settingKey, deviceId, isOn) {
    const value = isOn ? deviceId : null;
    try {
        await window.updateReaSetting(settingKey, value);
        // Re-render device lists so only one row shows as preferred
        renderDeviceListFromCache();
    } catch (error) {
        console.error('Error setting preferred device:', error);
        ui.showToast(`Failed to update preferred device: ${error.message}`, 5000, 'error');
    }
};

// Function to scan for machines specifically
window.scanForMachines = async function() {
    try {
        ui.showToast('Scanning for machines...', 2500, 'info');

        // Use WebSocket to trigger scan - results will appear via deviceStateCache
        sendDeviceCommand({ command: 'scan' });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');
    } catch (error) {
        console.error('Error scanning for machines:', error);
        ui.showToast(`Error scanning for machines: ${error.message}`, 5000, 'error');
    }
};

// Function to scan for scales specifically
window.scanForScales = async function() {
    try {
        ui.showToast('Scanning for scales...', 2000, 'info');

        // Use WebSocket to trigger scan - results will appear via deviceStateCache
        sendDeviceCommand({ command: 'scan' });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');
    } catch (error) {
        console.error('Error scanning for scales:', error);
        ui.showToast(`Error scanning for scales: ${error.message}`, 5000, 'error');
    }
};

// Smart Charging handlers
window.handleSmartChargingModeChange = async function(mode) {
    await updateReaSetting('chargingMode', mode);
};

// ── Keyboard Shortcuts Settings ──────────────────────────────────────────────

const KEYBOARD_ACTIONS = [
    { label: 'Espresso',    state: 'espresso',  defaultKey: 'e' },
    { label: 'Hot Water',   state: 'hotWater',  defaultKey: 'w' },
    { label: 'Steam',       state: 'steam',     defaultKey: 's' },
    { label: 'Flush',       state: 'flush',     defaultKey: 'f' },
    { label: 'Idle / Stop', state: 'idle',      defaultKey: ' ' },
    { label: 'Sleep',       state: 'sleeping',  defaultKey: 'p' },
];

function getKeyBindings() {
    try { return JSON.parse(localStorage.getItem('keyboardBindings') || '{}'); }
    catch { return {}; }
}

function keyDisplayName(key) {
    return key === ' ' ? 'Space' : key.toUpperCase();
}

export function renderKeyboardShortcutsSettings() {
    const saved = getKeyBindings();
    const rows = KEYBOARD_ACTIONS.map(({ label, state, defaultKey }) => {
        const currentKey = saved[state] ?? defaultKey;
        return `
            <div class="content-stretch flex items-center justify-between relative w-full py-[10px] border-b border-[var(--box-color)]">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[28px]">
                    <p class="leading-[1.2]">${label}</p>
                </div>
                <div class="flex items-center gap-[20px]">
                    <span id="kb-current-${state}" class="font-['Inter:Regular',sans-serif] font-normal text-[var(--text-primary)] text-[24px] w-[80px] text-center">${keyDisplayName(currentKey)}</span>
                    <button id="kb-btn-${state}" onclick="window.startKeyRebind('${state}')"
                        class="bg-[#385a92] rounded-[10px] px-[20px] h-[52px] text-white text-[22px] font-bold min-w-[140px]">
                        Rebind
                    </button>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">Keyboard Shortcuts</p>
            </div>
            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[22px] w-full">
                Click <strong>Rebind</strong> next to an action, then press any key to assign it.
            </p>
            <div class="content-stretch flex flex-col items-start relative w-full">
                ${rows}
            </div>
            <button onclick="window.resetKeyboardBindings()"
                class="border border-[#385a92] rounded-[10px] px-[30px] h-[52px] text-[#385a92] text-[22px] font-bold">
                Reset to Defaults
            </button>
        </div>`;
}

window.startKeyRebind = function(stateValue) {
    const btn = document.getElementById(`kb-btn-${stateValue}`);
    if (!btn) return;

    btn.textContent = 'Press a key…';
    btn.disabled = true;

    function onKey(e) {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', onKey, true);

        btn.disabled = false;

        if (e.key === 'Escape') {
            btn.textContent = 'Rebind';
            return;
        }

        const newKey = e.key;
        const saved = getKeyBindings();

        // conflict check — is this key already used by another action?
        const conflict = KEYBOARD_ACTIONS.find(({ state, defaultKey }) => {
            if (state === stateValue) return false;
            const currentKey = saved[state] ?? defaultKey;
            return currentKey === newKey;
        });

        if (conflict) {
            btn.textContent = 'Rebind';
            ui.showToast(`Key "${keyDisplayName(newKey)}" already used by ${conflict.label}`, 4000, 'error');
            return;
        }

        saved[stateValue] = newKey;
        localStorage.setItem('keyboardBindings', JSON.stringify(saved));

        const display = document.getElementById(`kb-current-${stateValue}`);
        if (display) display.textContent = keyDisplayName(newKey);
        btn.textContent = 'Rebind';

        ui.showToast('Keyboard shortcut saved', 3000, 'success');
    }

    document.addEventListener('keydown', onKey, true);
};

window.resetKeyboardBindings = function() {
    localStorage.removeItem('keyboardBindings');
    updateSettingsContentArea('keyboard_shortcuts');
    ui.showToast('Keyboard shortcuts reset to defaults', 3000, 'success');
};

window.handleNightModeToggle = async function(enabled) {
    await updateReaSetting('nightModeEnabled', enabled);
};

window.handleNightModeTimeChange = async function(type, timeStr) {
    const minutes = timeStringToMinutes(timeStr);
    if (type === 'sleep') {
        await updateReaSetting('nightModeSleepTime', minutes);
    } else {
        await updateReaSetting('nightModeMorningTime', minutes);
    }
};

// Initialize Bluetooth settings when the page loads
document.addEventListener('DOMContentLoaded', function() {
    // Set up a global function to refresh the device list
    window.refreshBluetoothDevices = renderAllDevices;
});

// Call the render function when the module functions are accessed
setTimeout(() => {
    if (document.getElementById('bluetooth-devices-container') ||
        document.getElementById('bluetooth-machine-devices-container') ||
        document.getElementById('bluetooth-scale-devices-container')) {
        renderAllDevices();
    }
}, 100);