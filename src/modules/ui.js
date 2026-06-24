import { getProfile, getWorkflow, updateWorkflow, setMachineState, setTargetHotWaterVolume, setTargetHotWaterTemp, setTargetHotWaterDuration, setDe1Settings, setTargetSteamFlow, setTargetSteamDuration, MachineState, reaHostname, setPluginSettings, getPlugins, getPluginSettings, verifyVisualizerCredentials } from './api.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { shouldUseNumpad, openModal as openNumpadModal } from './numpad-modal.js';
import { openContextMenu } from './context-menu.js';
import { logger } from './logger.js';
import * as chart from './chart.js';
import { getSupportedLanguages, getCurrentLanguage, setLanguage, getTranslation } from './i18n.js';
import { getTotalTime as getShotTotalTime } from './shotData.js';


function initLanguageSwitcher() {
    const switcher = document.getElementById('language-switcher');
    if (!switcher) return;

    const supportedLanguages = getSupportedLanguages();
    const currentLanguage = getCurrentLanguage();

    // Populate the dropdown
    switcher.innerHTML = ''; // Clear existing options
    supportedLanguages.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang;
        option.textContent = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
        if (lang === currentLanguage) {
            option.selected = true;
        }
        switcher.appendChild(option);
    });

    // Add event listener
    switcher.addEventListener('change', (event) => {
        setLanguage(event.target.value);
    });
}

export function formatStateForDisplay(state) {
    if (!state) return '';
    if (state === MachineState.FW_UPGRADE) return 'FW Upgrade';
    const withSpaces = state.replace(/([A-Z])/g, ' ');
    return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

export function formatTimeAbbreviated(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) {
        return '--s';
    }
    return `${Math.round(seconds)}s`;
}

let currentHotWaterVolume = 0;
let currentHotWaterTemp = 0;
let hotWaterMode = 'volume'; // 'volume' or 'temperature'
let hotWaterTempPresets = [75, 80, 85, 92];
let hotWaterVolPresets = [50, 100, 150, 200];
const DEFAULT_HOT_WATER_TEMP_PRESETS = [75, 80, 85, 92];
const DEFAULT_HOT_WATER_VOL_PRESETS = [50, 100, 150, 200];

let currentSteamDuration = 0;
let currentSteamFlow = 1.5;
let steamMode = 'time'; // 'time' or 'flow'
let steamTimePresets = [15, 30, 45, 60];
let steamFlowPresets = [0.5, 1.0, 1.5, 2.0];
const DEFAULT_STEAM_TIME_PRESETS = [15, 30, 45, 60];
// Machine-model-specific defaults for steam flow (ml/s). Resolved at boot via setSteamFlowPresetsFromMachineModel().
const STEAM_FLOW_PRESETS_BY_MODEL = {
    standard: [0.4, 0.5, 0.6, 0.8],  // DE1Pro, DE1XL, Bengle (default)
    midGroup: [0.5, 0.8, 1.0, 1.2],  // Bengle 10A, DE1 XXL
    highGroup: [0.8, 1.0, 1.2, 1.5], // Bengle 15A
};
let DEFAULT_STEAM_FLOW_PRESETS = [...STEAM_FLOW_PRESETS_BY_MODEL.standard];
const STEAM_FLOW_PRESETS_KEY = 'steam-flow-presets-user';
const STEAM_FLOW_PRESET_INDEX_KEY = 'steam-flow-preset-selected-index';
const STEAM_FLOW_PRESETS_MODEL_KEY = 'steam-flow-presets-model';
let selectedSteamFlowPresetIndex = 1; // default = second leftmost
let steamApiDebounce = null;
let hotWaterApiDebounce = null;
const API_DEBOUNCE_MS = 1000;

let grindStep = 0.1;

export function flashPlusMinusButton(button) {
    // Add the flash animation class
    button.classList.add('flash-animation');

    // Remove the class after the animation duration (280ms as defined in CSS)
    // This allows the button to revert to its original styling
    setTimeout(() => {
        button.classList.remove('flash-animation');
    }, 280);
}

function updateDoseValue(type, newValue) {
    const doseInEl = document.getElementById('dose-in-value');
    const drinkOutEl = document.getElementById('drink-out-value');
    const currentDoseIn = doseInEl ? parseFloat(doseInEl.textContent) : 0;
    const currentDoseOut = drinkOutEl ? parseFloat(drinkOutEl.textContent) : 0;

    const payload = {
        context: {
            targetDoseWeight: type === 'in' ? parseFloat(newValue) : currentDoseIn,
            targetYield: type === 'out' ? parseFloat(newValue) : currentDoseOut
        }
    };

    updateWorkflow(payload).then(() => {
        logger.debug(`Dose ${type} value updated via workflow:`, newValue);
        if (type === 'in') {
            window.app?.saveContextToActiveProfile?.({ targetDoseWeight: parseFloat(newValue) });
        } else {
            window.app?.saveContextToActiveProfile?.({ targetYield: parseFloat(newValue) });
        }
    }).catch(error => {
        logger.error(`Failed to update dose ${type} value via workflow:`, error);
    });
}

export function updateDoseAndDrinkOutValue(newDoseIn, newDrinkOut) {
    const payload = {
        context: {
            targetDoseWeight: newDoseIn,
            targetYield: newDrinkOut
        }
    };

    updateWorkflow(payload).then(() => {
        logger.debug(`Dose In and Drink Out values updated via workflow: ${newDoseIn}g : ${newDrinkOut}g`);
    }).catch(error => {
        logger.error(`Failed to update dose in and drink out values via workflow:`, error);
    });
}

export function updateDrinkOutPresetsDisplay(doseIn, drinkOut) {
    const doseInEl = document.getElementById('dose-in-value');
    const drinkOutEl = document.getElementById('drink-out-value');
    const ratioEl = document.getElementById('drink-ratio-value');

    if (doseInEl) {
        doseInEl.textContent = `${doseIn}g`;
    }
    if (drinkOutEl) {
        drinkOutEl.textContent = `${drinkOut}g`;
    }

    if (doseInEl && drinkOutEl && ratioEl) {
        if (!isNaN(doseIn) && !isNaN(drinkOut) && doseIn > 0) {
            const ratio = drinkOut / doseIn;
            ratioEl.textContent = `(1:${ratio.toFixed(1)})`;
        } else {
            ratioEl.textContent = '(1:--)';
        }
    }

    const target = `${doseIn}:${drinkOut}`;
    syncPresetHighlight(document.getElementById('drink-out-presets'), t => t === target);
}

export function updateTemperatureValue(newValue) {
    getWorkflow().then(workflow => {
        if (workflow && workflow.profile && workflow.profile.steps) {
            // Update temperature on ALL steps as number (not string)
            workflow.profile.steps.forEach(step => {
                step.temperature = parseFloat(newValue);
            });
            
            // Partial update via workflow - only send profile field
            updateWorkflow({ profile: workflow.profile }).then(() => {
                logger.debug('Temperature updated via workflow:', newValue);
            }).catch(error => {
                logger.error('Failed to update temperature via workflow:', error);
            });
        }
    });
}

export function updateGrindValue(newValue) {
    const workflowUpdate = {
        context: {
            grinderSetting: parseFloat(newValue).toFixed(2)
        }
    };
    updateWorkflow(workflowUpdate).then(() => {
        logger.debug('Grind value updated successfully:', newValue);
    }).catch(error => {
        logger.error('Failed to update grind value:', error);
    });
    window.app?.saveGrindToActiveProfile?.(parseFloat(newValue).toFixed(2));
}

export function updateFlushValue(newValue) {
    // Conform to expected rinseData schema:
    // {
    //   rinseData: {
    //     targetTemperature: number,
    //     duration: number,
    //     flow: number
    //   }
    // }
    const duration = parseFloat(newValue);

    const workflowUpdate = {
        rinseData: {
            // For now, use sensible defaults for targetTemperature and flow.
            // These can be wired to UI controls later if needed.
            duration: isNaN(duration) ? 0 : duration,
        }
    };

    updateWorkflow(workflowUpdate).then(() => {
        logger.debug('Rinse value updated successfully:', workflowUpdate.rinseData);
    }).catch(error => {
        logger.error('Failed to update rinse value:', error);
    });
}

export function updateDrinkRatio() {
    const doseInEl = document.getElementById('dose-in-value');
    const drinkOutEl = document.getElementById('drink-out-value');
    const ratioEl = document.getElementById('drink-ratio-value');

    if (doseInEl && drinkOutEl && ratioEl) {
        const doseIn = parseFloat(doseInEl.textContent);
        const drinkOut = parseFloat(drinkOutEl.textContent);

        if (!isNaN(doseIn) && !isNaN(drinkOut) && doseIn > 0) {
            const ratio = drinkOut / doseIn;
            ratioEl.textContent = `(1:${ratio.toFixed(1)})`;
        } else {
            ratioEl.textContent = '(1:--)';
        }
    }
}

function makeEditable(element, onCommit) {
    // Skip on mobile/tablet - numpad modal handles input
    if (shouldUseNumpad()) return;
    
    element.addEventListener('click', () => {
        if (element.parentNode.querySelector('input')) return;

        let isProcessed = false;
        const currentValue = parseFloat(element.textContent);
        const input = document.createElement('input');
        input.type = 'number';
        input.value = currentValue;
        // Increased text size and made the input area bigger
        input.className = 'text-[19px] font-bold text-center w-18 bg-transparent absolute border-2 border-[var(--mimoja-blue)] rounded-lg';
        input.name = element.id; // Recommended for accessibility and autofill
        input.setAttribute('aria-label', element.getAttribute('data-i18n-key') || element.id);

        // Position the input field exactly where the original element is.
        // Use getBoundingClientRect so CSS transforms (translate-x/y on the span,
        // scale on the #scaled-content container) are accounted for.
        const elementRect = element.getBoundingClientRect();
        const parentRect = element.parentNode.getBoundingClientRect();

        // Derive the container scale so we can convert viewport px → design-space px.
        const scaledContent = document.getElementById('scaled-content');
        const scale = (scaledContent && scaledContent.offsetWidth > 0)
            ? scaledContent.getBoundingClientRect().width / scaledContent.offsetWidth
            : 1;

        const relLeft = (elementRect.left - parentRect.left) / scale;
        const relTop  = (elementRect.top  - parentRect.top)  / scale;

        input.style.position = 'absolute';
        input.style.left   = (relLeft - 5) + 'px';
        input.style.top    = (relTop  - 5) + 'px';
        input.style.width  = (elementRect.width  / scale + 20) + 'px';
        input.style.height = (elementRect.height / scale + 20) + 'px';
        input.style.display = 'flex';
        input.style.alignItems = 'center';
        input.style.justifyContent = 'center';
        input.style.textAlign = 'center';
        input.style.zIndex = '10'; // Ensure input appears above other elements
       // Remove default outline

        // Hide the original element but keep its space reserved
        element.style.visibility = 'hidden';

        // Insert the input into the same parent container
        element.parentNode.appendChild(input);
        input.focus();
        input.select();

        const processChange = (shouldCommit) => {
            if (isProcessed) return;
            isProcessed = true;

            if (shouldCommit) {
                const newValue = parseFloat(input.value);
                if (!isNaN(newValue) && newValue >= 0) {
                    onCommit(newValue);
                }
            }

            // Restore the original element
            element.style.visibility = '';

            input.remove();
        };

        input.addEventListener('blur', () => processChange(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') processChange(true);
            if (e.key === 'Escape') processChange(false);
        });
    });
}

export function updateHotWaterDisplay(data) {
    const volEl = document.getElementById('hot-water-vol-value');
    const tempEl = document.getElementById('hot-water-temp-value');
    const modeTempEl = document.getElementById('hot-water-mode-temp');
    const modeVolEl = document.getElementById('hot-water-mode-vol');
    if (!volEl || !tempEl || !modeTempEl || !modeVolEl) return;
    if (data.targetHotWaterVolume !== undefined) {
        currentHotWaterVolume = data.targetHotWaterVolume;
    }
    if (data.targetHotWaterTemp !== undefined) {
        currentHotWaterTemp = data.targetHotWaterTemp;
    }

    volEl.textContent = `${currentHotWaterVolume}ml`;
    tempEl.textContent = `${currentHotWaterTemp}°C`;

    const hwTarget = hotWaterMode === 'volume'
        ? `${currentHotWaterVolume}ml`
        : `${currentHotWaterTemp}°c`;
    syncPresetHighlight(document.getElementById('hotwater-presets'), t => t.toLowerCase() === hwTarget.toLowerCase());

    if (hotWaterMode === 'volume') {
        volEl.classList.remove('text-[20px]');
        volEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        tempEl.classList.remove('text-[26px]', 'font-bold');
        tempEl.classList.add('text-[20px]');
        modeVolEl.className = 'text-[var(--mimoja-blue-v2)]';
        modeTempEl.className = 'text-[var(--low-contrast-white)]';
    } else { // temperature mode
        tempEl.classList.remove('text-[20px]');
        tempEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        volEl.classList.remove('text-[26px]', 'font-bold');
        volEl.classList.add('text-[20px]');
        modeTempEl.className = 'text-[var(--mimoja-blue-v2)]';
        modeVolEl.className = 'text-[var(--low-contrast-white)]';
    }
}

function scheduleHotWaterApi() {
    clearTimeout(hotWaterApiDebounce);
    hotWaterApiDebounce = setTimeout(() => {
        if (hotWaterMode === 'volume') {
            setTargetHotWaterVolume(currentHotWaterVolume).catch(e => logger.error(e));
        } else {
            setTargetHotWaterTemp(currentHotWaterTemp).catch(e => logger.error(e));
        }
    }, API_DEBOUNCE_MS);
}

function incrementHotWater() {
    const hotWaterPlusBtn = document.getElementById('hot-water-vol-plus');
    if (hotWaterPlusBtn) { flashPlusMinusButton(hotWaterPlusBtn); }
    if (hotWaterMode === 'volume') {
        if (currentHotWaterVolume < 255) {
            currentHotWaterVolume += 5;
            if (currentHotWaterVolume > 255) currentHotWaterVolume = 255;
        }
    } else {
        if (currentHotWaterTemp < 100) {
            currentHotWaterTemp += 1;
        }
    }
    updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume, targetHotWaterTemp: currentHotWaterTemp });
    scheduleHotWaterApi();
}

function decrementHotWater() {
    const hotWaterMinusBtn = document.getElementById('hot-water-vol-minus');
    if (hotWaterMinusBtn) { flashPlusMinusButton(hotWaterMinusBtn); }
    if (hotWaterMode === 'volume') {
        if (currentHotWaterVolume > 3) {
            currentHotWaterVolume -= 5;
            if (currentHotWaterVolume < 3) currentHotWaterVolume = 3;
        }
    } else {
        if (currentHotWaterTemp > 0) {
            currentHotWaterTemp -= 1;
        }
    }
    updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume, targetHotWaterTemp: currentHotWaterTemp });
    scheduleHotWaterApi();
}

function updateHotWaterPresetDisplay() {
    const presetContainer = document.getElementById('hotwater-presets');
    if (!presetContainer) return;

    const presets = hotWaterMode === 'temperature' ? hotWaterTempPresets : hotWaterVolPresets;
    const unit = hotWaterMode === 'temperature' ? '°c' : 'ml';

    Array.from(presetContainer.children).forEach((button, index) => {
        if (presets[index] !== undefined) {
            button.textContent = `${presets[index]}${unit}`;
        }
    });
}

function toggleHotWaterMode() {
    hotWaterMode = hotWaterMode === 'volume' ? 'temperature' : 'volume';
    logger.info(`Hot water mode switched to: ${hotWaterMode}`);
    updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume, targetHotWaterTemp: currentHotWaterTemp });
    updateHotWaterPresetDisplay();
}

function setupValueAdjuster(minusBtnId, plusBtnId, valueElId, step, min, formatter, onUpdate, afterUpdate) {
    const minusBtn = document.getElementById(minusBtnId);
    const plusBtn = document.getElementById(plusBtnId);

    if (!minusBtn || !plusBtn || !document.getElementById(valueElId)) return;

    const getStep = () => typeof step === 'function' ? step() : step;
    const format = (v) => typeof formatter === 'function' ? formatter(v) : v;

    let debounceTimer = null;
    const scheduleUpdate = (value) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => onUpdate(value), API_DEBOUNCE_MS);
    };

    minusBtn.addEventListener('click', (e) => {
        flashPlusMinusButton(e.currentTarget);
        const valueEl = document.getElementById(valueElId);
        if (!valueEl) return;
        let currentValue = parseFloat(valueEl.textContent);
        if (currentValue > min) {
            currentValue -= getStep();
            valueEl.textContent = format(currentValue);
            scheduleUpdate(currentValue);
            if (afterUpdate) afterUpdate(format(currentValue));
        }
    });

    plusBtn.addEventListener('click', (e) => {
        flashPlusMinusButton(e.currentTarget);
        const valueEl = document.getElementById(valueElId);
        if (!valueEl) return;
        let currentValue = parseFloat(valueEl.textContent);
        currentValue += getStep();
        valueEl.textContent = format(currentValue);
        scheduleUpdate(currentValue);
        if (afterUpdate) afterUpdate(format(currentValue));
    });
}

export const LONG_PRESS_MS = 600;

function makeNumpadMockInput(initialValue) {
    return {
        value: String(initialValue ?? ''),
        setAttribute: () => {},
        getAttribute: () => null,
        dispatchEvent: () => {},
    };
}

export function setupPressAndHold(element, clickCallback, longPressCallback, options = {}) {
    if (element.dataset.pressHoldInit) return; // already wired — prevent duplicate listeners on re-init
    element.dataset.pressHoldInit = '1';

    const duration = options.duration ?? LONG_PRESS_MS;

    let timer;
    let longPressOccurred = false;

    const setActiveRing = (on) => {
        if (on) element.classList.add('long-press-active');
        else element.classList.remove('long-press-active');
    };

    const startPress = (e) => {
        e.preventDefault();
        longPressOccurred = false;
        setActiveRing(true);
        timer = setTimeout(() => {
            longPressOccurred = true;
            setActiveRing(false);
            longPressCallback(element);
        }, duration);
    };

    const endPress = (e) => {
        clearTimeout(timer);
        setActiveRing(false);
        if (longPressOccurred) {
            e.preventDefault();
            e.stopPropagation();
        } else if (e.type === 'touchend') {
            // preventDefault on touchstart suppressed the synthetic click — fire manually
            e.preventDefault();
            clickCallback();
        }
    };

    const cancelPress = () => {
        clearTimeout(timer);
        setActiveRing(false);
    };

    // Desktop right-click opens the same menu (mouse parity)
    element.addEventListener('contextmenu', e => {
        e.preventDefault();
        longPressCallback(element);
    });

    // Mouse events
    element.addEventListener('mousedown', startPress);
    element.addEventListener('mouseup', endPress);
    element.addEventListener('mouseleave', cancelPress);

    // Touch events
    element.addEventListener('touchstart', startPress, { passive: false });
    element.addEventListener('touchend', endPress);
    element.addEventListener('touchcancel', cancelPress);

    element.addEventListener('click', (e) => {
        if (longPressOccurred) {
            e.preventDefault();
            e.stopPropagation();
        } else {
            clickCallback();
        }
    });
}

export function flashElement(element) {
    if (element) {
        element.classList.add('flash');
        setTimeout(() => {
            element.classList.remove('flash');
        }, 300); // 300ms flash duration
    }
}

export function updateSteamDisplay(data) {
    const durationEl = document.getElementById('steam-duration-value');
    const flowEl = document.getElementById('steam-flow-value');
    const modeTimeEl = document.getElementById('steam-mode-time');
    const modeFlowEl = document.getElementById('steam-mode-flow');

    if (!durationEl || !flowEl || !modeTimeEl || !modeFlowEl) return;

    if (data.targetSteamDuration !== undefined) {
        currentSteamDuration = data.targetSteamDuration;
    }
    if (data.targetSteamFlow !== undefined) {
        currentSteamFlow = data.targetSteamFlow;
    }

    durationEl.textContent = `${currentSteamDuration}s`;
    flowEl.textContent = `${currentSteamFlow.toFixed(1)}`;

    if (steamMode === 'time') {
        durationEl.classList.remove('text-[20px]');
        durationEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        flowEl.classList.remove('text-[26px]', 'font-bold');
        flowEl.classList.add('text-[20px]');
        modeTimeEl.className = 'text-[var(--mimoja-blue-v2)]';
        modeFlowEl.className = 'text-[var(--low-contrast-white)]';
    } else { // flow mode
        flowEl.classList.remove('text-[20px]');
        flowEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        durationEl.classList.remove('text-[26px]', 'font-bold');
        durationEl.classList.add('text-[20px]');
        modeFlowEl.className = 'text-[var(--mimoja-blue-v2)]';
        modeTimeEl.className = 'text-[var(--low-contrast-white)]';
    }
}

function scheduleSteamApi() {
    clearTimeout(steamApiDebounce);
    steamApiDebounce = setTimeout(() => {
        if (steamMode === 'time') {
            setTargetSteamDuration(currentSteamDuration).catch(e => logger.error(e));
        } else {
            setTargetSteamFlow(currentSteamFlow).catch(e => logger.error(e));
        }
    }, API_DEBOUNCE_MS);
}

function syncSteamPresets() {
    if (steamMode === 'time') {
        syncPresetHighlight(document.getElementById('steam-presets'), t => t === `${currentSteamDuration}s`);
    } else {
        syncPresetHighlight(document.getElementById('steam-flow-presets'), t => t === currentSteamFlow.toFixed(1));
    }
}

function incrementSteam() {
    const steamPlusBtn = document.getElementById('steam-plus');
    if (steamPlusBtn) { flashPlusMinusButton(steamPlusBtn); }
    if (steamMode === 'time') {
        currentSteamDuration += 1;
    } else {
        if (currentSteamFlow < 2.5) {
            currentSteamFlow += 0.1;
        }
    }
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    scheduleSteamApi();
    syncSteamPresets();
}

function decrementSteam() {
    const steamMinusBtn = document.getElementById('steam-minus');
    if (steamMinusBtn) { flashPlusMinusButton(steamMinusBtn); }
    if (steamMode === 'time') {
        if (currentSteamDuration > 0) {
            currentSteamDuration -= 1;
        }
    } else {
        if (currentSteamFlow > 0.4) {
            currentSteamFlow -= 0.1;
        }
    }
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    scheduleSteamApi();
    syncSteamPresets();
}

function updateSteamPresetDisplay() {
    const timePresetContainer = document.getElementById('steam-presets');
    const flowPresetContainer = document.getElementById('steam-flow-presets');
    if (!timePresetContainer || !flowPresetContainer) return;

    if (steamMode === 'flow') {
        timePresetContainer.classList.add('hidden');
        flowPresetContainer.classList.remove('hidden');
        const presets = steamFlowPresets;
        Array.from(flowPresetContainer.children).forEach((button, index) => {
            if (presets[index] !== undefined) {
                button.textContent = `${presets[index].toFixed(1)}`;
            }
        });
        const flowTarget = currentSteamFlow.toFixed(1);
        syncPresetHighlight(flowPresetContainer, t => t === flowTarget);
    } else { // time mode
        timePresetContainer.classList.remove('hidden');
        flowPresetContainer.classList.add('hidden');
        const presets = steamTimePresets;
        const unit = 's';
        Array.from(timePresetContainer.children).forEach((button, index) => {
            if (presets[index] !== undefined) {
                button.textContent = `${presets[index]}${unit}`;
            }
        });
        const timeTarget = `${currentSteamDuration}s`;
        syncPresetHighlight(timePresetContainer, t => t === timeTarget);
    }
}

function resolveSteamFlowPresetsForModel(model) {
    const m = String(model || '').toLowerCase();
    if (m.includes('15a')) return STEAM_FLOW_PRESETS_BY_MODEL.highGroup;
    if (m.includes('10a') || m.includes('xxl')) return STEAM_FLOW_PRESETS_BY_MODEL.midGroup;
    return STEAM_FLOW_PRESETS_BY_MODEL.standard;
}

async function persistSteamFlowPresets() {
    try {
        await setSetting(STEAM_FLOW_PRESETS_KEY, [...steamFlowPresets]);
    } catch (e) {
        logger.warn('Failed to persist steam flow presets:', e);
    }
}

async function persistSteamFlowSelectedIndex(index) {
    try {
        await setSetting(STEAM_FLOW_PRESET_INDEX_KEY, index);
    } catch (e) {
        logger.warn('Failed to persist steam flow preset index:', e);
    }
}

function syncPresetHighlight(container, matchFn) {
    if (!container) return;
    for (const btn of container.children) {
        const active = matchFn(btn.textContent.trim());
        btn.classList.toggle('preset-active', active);
        btn.classList.remove('text-gray-400', 'text-black');
    }
}

function syncDrinkOutPresets() {
    const dose = parseFloat(document.getElementById('dose-in-value')?.textContent);
    const drink = parseFloat(document.getElementById('drink-out-value')?.textContent);
    if (isNaN(dose) || isNaN(drink)) return;
    syncPresetHighlight(document.getElementById('drink-out-presets'), t => t === `${dose}:${drink}`);
}

function highlightSteamFlowPreset(index) {
    const container = document.getElementById('steam-flow-presets');
    if (!container) return;
    Array.from(container.children).forEach((btn, i) => {
        btn.classList.toggle('preset-active', i === index);
        btn.classList.remove('text-gray-400', 'text-black');
    });
}

export async function setSteamFlowPresetsFromMachineModel(model) {
    try {
        await openDB();
        const baseline = resolveSteamFlowPresetsForModel(model);
        DEFAULT_STEAM_FLOW_PRESETS = [...baseline];

        const storedModel = await getSetting(STEAM_FLOW_PRESETS_MODEL_KEY);
        const userPresets = await getSetting(STEAM_FLOW_PRESETS_KEY);
        const storedIndex = await getSetting(STEAM_FLOW_PRESET_INDEX_KEY);

        // If model changed since last save, drop the old user array — its values
        // are tuned for a different group head and would be misleading.
        const sameModel = storedModel && storedModel === String(model || '');
        if (Array.isArray(userPresets) && userPresets.length === 4 && sameModel) {
            steamFlowPresets = userPresets.map(Number);
        } else {
            steamFlowPresets = [...baseline];
            await setSetting(STEAM_FLOW_PRESETS_KEY, [...steamFlowPresets]);
        }
        await setSetting(STEAM_FLOW_PRESETS_MODEL_KEY, String(model || ''));

        selectedSteamFlowPresetIndex = (Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < 4)
            ? storedIndex
            : 1; // second leftmost

        updateSteamPresetDisplay();
        highlightSteamFlowPreset(selectedSteamFlowPresetIndex);

        const initialValue = steamFlowPresets[selectedSteamFlowPresetIndex];
        if (typeof initialValue === 'number' && !isNaN(initialValue)) {
            currentSteamFlow = initialValue;
            updateSteamDisplay({ targetSteamFlow: initialValue });
            try { await setTargetSteamFlow(initialValue); }
            catch (e) { logger.warn('Could not push initial steam flow preset to machine:', e); }
        }
        logger.info(`Steam flow presets initialized for model "${model}":`, steamFlowPresets, 'selected index:', selectedSteamFlowPresetIndex);
    } catch (e) {
        logger.error('Failed to init steam flow presets from machine model:', e);
    }
}

function toggleSteamMode() {
    steamMode = steamMode === 'time' ? 'flow' : 'time';
    logger.info(`Steam mode switched to: ${steamMode}`);
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    updateSteamPresetDisplay();
}

export function initThemeToggle() {
    const themeToggle = document.getElementById('theme-toggle');
    if (!themeToggle) return;

    const applyTheme = (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);

        // Dynamically import the chart module and apply theme if chart element exists
        if (document.getElementById('plotly-chart')) {
            import('./chart.js').then((chartModule) => {
                chartModule.setTheme(theme);
            }).catch(error => {
                console.error('Error importing chart module:', error);
            });
        }
    };

    const currentTheme = localStorage.getItem('theme') || 'light';
    themeToggle.checked = currentTheme === 'dark';
    applyTheme(currentTheme);

    themeToggle.addEventListener('change', function() {
        const theme = this.checked ? 'dark' : 'light';
        applyTheme(theme);
    });
}

export function initScaleClick(callback) {
    const weightEl = document.getElementById('data-weight');
    const weighttext = document.getElementById('weight-text');
    if (weightEl||weighttext) {
        weightEl.classList.add('cursor-pointer');
        weightEl.addEventListener('click', callback);
        weighttext.addEventListener('click', callback);
    }
}

export function showScaleInfo() {
    const scaleInfoContainer = document.getElementById('scale-info-container');
    if (scaleInfoContainer) {
        scaleInfoContainer.style.display = 'block';
    }
}

// Latest real machine state (source of truth for the sleep/wake button —
// never parse the displayed status text, it's translated/substate-laden).
let currentMachineState = null;

// Screensaver functionality
let screensaverActive = false;
let screensaverElement = null;
let screensaverDimOverlay = null;
let screensaverImages = [];
let screensaverCurrentIndex = 0;
let screensaverCycleInterval = null;
const DEFAULT_SCREENSAVER_CYCLE_SECONDS = 10;
const MIN_SCREENSAVER_CYCLE_SECONDS = 2;
const MAX_SCREENSAVER_CYCLE_SECONDS = 600;
const DEFAULT_SCREENSAVER = 'url("src/ui/saver-1.jpg")';

function getScreensaverCycleMs() {
    const raw = parseInt(localStorage.getItem('screensaverCycleSeconds'), 10);
    const secs = Number.isFinite(raw) ? raw : DEFAULT_SCREENSAVER_CYCLE_SECONDS;
    const clamped = Math.min(MAX_SCREENSAVER_CYCLE_SECONDS, Math.max(MIN_SCREENSAVER_CYCLE_SECONDS, secs));
    return clamped * 1000;
}

// Detect in-app webview (mirrors logic in app.js initialization). In a native
// webview the host OS dims the actual hardware display, so we skip the CSS
// overlay. In a regular browser there's no hardware control — apply a gray
// overlay so the user sees a visible "dim" while the screensaver is up.
function isInWebView() {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    const isStandalone = window.navigator.standalone === true;
    const isAndroidWebView = /Android/.test(ua) && /wv/.test(ua);
    const isIOSWebView = isIOS && !isStandalone && !/Safari\//.test(ua);
    const isDecentWebView = ua.includes('Decent');
    return isAndroidWebView || isIOSWebView || isDecentWebView;
}

export async function initScreensaver() {
    screensaverElement = document.createElement('div');
    screensaverElement.id = 'screensaver';
    screensaverElement.style.position = 'fixed';
    screensaverElement.style.top = '0';
    screensaverElement.style.left = '0';
    screensaverElement.style.width = '100vw';
    screensaverElement.style.height = '100vh';
    screensaverElement.style.backgroundSize = 'cover';
    screensaverElement.style.backgroundPosition = 'center';
    screensaverElement.style.zIndex = '10000';
    screensaverElement.style.display = 'none';
    screensaverElement.style.justifyContent = 'center';
    screensaverElement.style.alignItems = 'center';

    // Dim overlay child — gray semi-transparent layer used in browser mode.
    screensaverDimOverlay = document.createElement('div');
    screensaverDimOverlay.id = 'screensaver-dim-overlay';
    screensaverDimOverlay.style.position = 'absolute';
    screensaverDimOverlay.style.inset = '0';
    screensaverDimOverlay.style.backgroundColor = 'rgba(40, 40, 40, 0.55)';
    screensaverDimOverlay.style.pointerEvents = 'none';
    screensaverDimOverlay.style.display = 'none';
    screensaverElement.appendChild(screensaverDimOverlay);

    screensaverElement.addEventListener('click', deactivateScreensaver);
    screensaverElement.addEventListener('touchstart', deactivateScreensaver);

    document.body.appendChild(screensaverElement);

    try {
        await openDB();
        const stored = await getSetting('screensaverImages');
        if (Array.isArray(stored) && stored.length > 0) {
            screensaverImages = stored;
        }
    } catch (e) {
        // fall through to default
    }
    _applyScreensaverImage();
}

function _applyScreensaverImage() {
    if (!screensaverElement) return;
    if (screensaverImages.length > 0) {
        screensaverElement.style.backgroundImage = `url("${screensaverImages[screensaverCurrentIndex]}")`;
    } else {
        screensaverElement.style.backgroundImage = DEFAULT_SCREENSAVER;
    }
}

export function setScreensaverImages(images) {
    screensaverImages = images;
    screensaverCurrentIndex = 0;
    _applyScreensaverImage();
}

// Called by settings UI when user changes cycle seconds — restart the
// interval so the new cadence takes effect immediately if active.
export function setScreensaverCycleSeconds(seconds) {
    const clamped = Math.min(MAX_SCREENSAVER_CYCLE_SECONDS, Math.max(MIN_SCREENSAVER_CYCLE_SECONDS, parseInt(seconds, 10) || DEFAULT_SCREENSAVER_CYCLE_SECONDS));
    localStorage.setItem('screensaverCycleSeconds', String(clamped));
    if (screensaverActive && screensaverCycleInterval) {
        clearInterval(screensaverCycleInterval);
        screensaverCycleInterval = setInterval(() => {
            screensaverCurrentIndex = (screensaverCurrentIndex + 1) % screensaverImages.length;
            _applyScreensaverImage();
        }, getScreensaverCycleMs());
    }
    return clamped;
}

export function activateScreensaver() {
    if (!screensaverElement) {
        console.error('Screensaver element not initialized');
        return;
    }
    screensaverCurrentIndex = 0;
    _applyScreensaverImage();
    if (screensaverDimOverlay) {
        screensaverDimOverlay.style.display = isInWebView() ? 'none' : 'block';
    }
    screensaverElement.style.display = 'flex';
    screensaverActive = true;

    if (screensaverImages.length > 1) {
        screensaverCycleInterval = setInterval(() => {
            screensaverCurrentIndex = (screensaverCurrentIndex + 1) % screensaverImages.length;
            _applyScreensaverImage();
        }, getScreensaverCycleMs());
    }
}

export function deactivateScreensaver() {
    if (!screensaverElement) {
        console.error('Screensaver element not initialized');
        return;
    }
    if (screensaverCycleInterval) {
        clearInterval(screensaverCycleInterval);
        screensaverCycleInterval = null;
    }
    screensaverElement.style.display = 'none';
    screensaverActive = false;
    setMachineState('idle');
}

export function isScreensaverActive() {
    return screensaverActive;
}

export function initUI(callbacks) {
    initThemeToggle();
    initFullscreenHandler();
    initSettingsModal();
    initLanguageSwitcher();
    initScaleClick(callbacks.onWeightClick);
    initScreensaver(); // Initialize screensaver functionality
    const drinkOutValueEl = document.getElementById('drink-out-value');
    const tempValueEl = document.getElementById('temp-value');
    const doseInValueEl = document.getElementById('dose-in-value');
    const grindValueEl = document.getElementById('grind-value');
    const sleepButton = document.getElementById('sleep-button');
    const hotWaterMinusBtn = document.getElementById('hot-water-vol-minus');
    const hotWaterPlusBtn = document.getElementById('hot-water-vol-plus');
    const hotWaterModeToggle = document.getElementById('hot-water-mode-toggle');
    const hotWaterVolValueEl = document.getElementById('hot-water-vol-value');
    const hotWaterTempValueEl = document.getElementById('hot-water-temp-value');
    const tempPresets = document.getElementById('temp-presets');
    const drinkOutPresets = document.getElementById('drink-out-presets');
    const flushPresets = document.getElementById('flush-presets');
    const flushValueEl = document.getElementById('flush-value');
    const hotwaterPresets = document.getElementById('hotwater-presets');
    const steamMinusBtn = document.getElementById('steam-minus');
    const steamPlusBtn = document.getElementById('steam-plus');
    const steamModeToggle = document.getElementById('steam-mode-toggle');
    const steamPresets = document.getElementById('steam-presets');
    const steamFlowPresetsEl = document.getElementById('steam-flow-presets');
    const machineStateEl = document.getElementById('machine-status');
    if (tempPresets) {
        for (const button of tempPresets.children) {
            button.classList.add('no-select', 'has-context-menu');
            button.dataset.defaultValue = button.textContent;
            const clickCallback = () => {
                const newValue = parseFloat(button.textContent);
                if (isNaN(newValue)) return;

                updateTemperatureValue(newValue);
                updateTemperatureDisplay(newValue);

                syncPresetHighlight(tempPresets, t => t === button.textContent.trim());

                flashElement(document.getElementById('temp-value'));
            };

            const longPressCallback = () => {
                const tempValueEl = document.getElementById('temp-value');
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', button.textContent), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        const current = parseFloat(button.textContent);
                        openNumpadModal(makeNumpadMockInput(isNaN(current) ? '' : current), {
                            fieldType: 'temperature',
                            onConfirm: (newVal) => {
                                button.textContent = `${newVal}°c`;
                                flashElement(button);
                                showToast(`Preset saved as ${button.textContent}`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', tempValueEl.textContent), onSelect: () => {
                        button.textContent = tempValueEl.textContent;
                        flashElement(button);
                        flashElement(tempValueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', button.dataset.defaultValue), danger: true, onSelect: () => {
                        button.textContent = button.dataset.defaultValue;
                        flashElement(button);
                        showToast(`Preset reverted to ${button.dataset.defaultValue}`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        }
    }

    if (drinkOutPresets) {
        for (const button of drinkOutPresets.children) {
            button.classList.add('no-select', 'has-context-menu');
            button.dataset.defaultValue = button.textContent;
            const clickCallback = () => {
                const [doseInStr, drinkOutStr] = button.textContent.split(':');
                const newDoseIn = parseFloat(doseInStr);
                const newDrinkOut = parseFloat(drinkOutStr);

                if (!isNaN(newDoseIn) && !isNaN(newDrinkOut)) {
                    updateDoseAndDrinkOutValue(newDoseIn, newDrinkOut);
                    updateDrinkOutPresetsDisplay(newDoseIn, newDrinkOut);
                    flashElement(document.getElementById('dose-in-value'));
                    flashElement(document.getElementById('drink-out-value'));

                    syncPresetHighlight(drinkOutPresets, t => t === button.textContent.trim());
                }
            };

            const longPressCallback = () => {
                const doseInValue = parseFloat(document.getElementById('dose-in-value').textContent);
                const drinkOutValue = parseFloat(document.getElementById('drink-out-value').textContent);
                const currentLabel = `${doseInValue}:${drinkOutValue}`;
                const [presetDoseStr, presetOutStr] = button.textContent.split(':');
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', button.textContent), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetDoseStr), {
                            fieldType: 'dose-in',
                            onConfirm: (doseVal) => {
                                const dose = parseFloat(doseVal);
                                if (isNaN(dose)) return;
                                // Open second numpad for drink-out after dose is confirmed
                                setTimeout(() => {
                                    openNumpadModal(makeNumpadMockInput(presetOutStr), {
                                        fieldType: 'drink-out',
                                        onConfirm: (outVal) => {
                                            const out = parseFloat(outVal);
                                            if (isNaN(out)) return;
                                            button.textContent = `${dose}:${out}`;
                                            flashElement(button);
                                            showToast(`Preset saved as ${button.textContent}`, 2000, 'success');
                                        },
                                    });
                                }, 150);
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', currentLabel), onSelect: () => {
                        button.textContent = currentLabel;
                        flashElement(button);
                        flashElement(document.getElementById('dose-in-value'));
                        flashElement(document.getElementById('drink-out-value'));
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', button.dataset.defaultValue), danger: true, onSelect: () => {
                        button.textContent = button.dataset.defaultValue;
                        flashElement(button);
                        showToast(`Preset reverted to ${button.dataset.defaultValue}`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        }
    }

    if (flushPresets) {
        for (const button of flushPresets.children) {
            button.classList.add('no-select', 'has-context-menu');
            button.dataset.defaultValue = button.textContent;
            const clickCallback = () => {
                const newValue = parseFloat(button.textContent);
                if (isNaN(newValue)) return;

                // Use workflow-based update for flush/rinse settings
                updateFlushValue(newValue);
                updateFlushDisplay(newValue);

                syncPresetHighlight(flushPresets, t => t === button.textContent.trim());
                flashElement(document.getElementById('flush-value'));
            };

            const longPressCallback = () => {
                const flushValueEl = document.getElementById('flush-value');
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', button.textContent), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        const current = parseFloat(button.textContent);
                        openNumpadModal(makeNumpadMockInput(isNaN(current) ? '' : current), {
                            fieldType: 'flush',
                            onConfirm: (newVal) => {
                                button.textContent = `${newVal}s`;
                                flashElement(button);
                                showToast(`Preset saved as ${button.textContent}`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', flushValueEl.textContent), onSelect: () => {
                        button.textContent = flushValueEl.textContent;
                        flashElement(button);
                        flashElement(flushValueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', button.dataset.defaultValue), danger: true, onSelect: () => {
                        button.textContent = button.dataset.defaultValue;
                        flashElement(button);
                        showToast(`Preset reverted to ${button.dataset.defaultValue}`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        }
    }

    if (hotwaterPresets) {
        // Initial display update
        updateHotWaterPresetDisplay();

        Array.from(hotwaterPresets.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const isTempMode = hotWaterMode === 'temperature';
                const presets = isTempMode ? hotWaterTempPresets : hotWaterVolPresets;
                const newValue = presets[index];

                if (newValue === undefined) return;

                if (isTempMode) {
                    setTargetHotWaterTemp(newValue).catch(e => logger.error(e));
                    updateHotWaterDisplay({ targetHotWaterTemp: newValue });

                    flashElement(document.getElementById('hot-water-temp-value'));

                } else {
                    setTargetHotWaterVolume(newValue).catch(e => logger.error(e));
                    updateHotWaterDisplay({ targetHotWaterVolume: newValue });
                    flashElement(document.getElementById("hot-water-vol-value"));
                }

                syncPresetHighlight(hotwaterPresets, t => t === button.textContent.trim());
            };

            const longPressCallback = () => {
                const isTempMode = hotWaterMode === 'temperature';
                const valueEl = document.getElementById(isTempMode ? 'hot-water-temp-value' : 'hot-water-vol-value');
                const currentValue = parseFloat(valueEl.textContent);
                const presetValue = (isTempMode ? hotWaterTempPresets : hotWaterVolPresets)[index];
                const defaultValue = (isTempMode ? DEFAULT_HOT_WATER_TEMP_PRESETS : DEFAULT_HOT_WATER_VOL_PRESETS)[index];
                const unit = isTempMode ? '°c' : 'ml';
                const fieldType = isTempMode ? 'hot-water-temp' : 'hot-water-vol';
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', `${presetValue}${unit}`), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetValue), {
                            fieldType,
                            onConfirm: (newVal) => {
                                const num = parseFloat(newVal);
                                if (isNaN(num)) return;
                                if (isTempMode) hotWaterTempPresets[index] = num;
                                else hotWaterVolPresets[index] = num;
                                updateHotWaterPresetDisplay();
                                flashElement(button);
                                showToast(`Preset saved as ${num}${unit}`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', valueEl.textContent), disabled: isNaN(currentValue), onSelect: () => {
                        if (isTempMode) hotWaterTempPresets[index] = currentValue;
                        else hotWaterVolPresets[index] = currentValue;
                        updateHotWaterPresetDisplay();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', `${defaultValue}${unit}`), danger: true, onSelect: () => {
                        if (isTempMode) hotWaterTempPresets[index] = defaultValue;
                        else hotWaterVolPresets[index] = defaultValue;
                        updateHotWaterPresetDisplay();
                        flashElement(button);
                        showToast(`Preset reverted to ${defaultValue}${unit}`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (steamPresets) {
        updateSteamPresetDisplay();

        Array.from(steamPresets.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const newValue = steamTimePresets[index];
                if (newValue === undefined) return;

                setTargetSteamDuration(newValue).catch(e => logger.error(e));
                updateSteamDisplay({ targetSteamDuration: newValue });

                syncPresetHighlight(steamPresets, t => t === button.textContent.trim());
                flashElement(document.getElementById('steam-duration-value'));
            };

            const longPressCallback = () => {
                const valueEl = document.getElementById('steam-duration-value');
                const currentValue = parseFloat(valueEl.textContent);
                const presetValue = steamTimePresets[index];
                const defaultValue = DEFAULT_STEAM_TIME_PRESETS[index];
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', `${presetValue}s`), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetValue), {
                            fieldType: 'steam-duration',
                            onConfirm: (newVal) => {
                                const num = parseFloat(newVal);
                                if (isNaN(num)) return;
                                steamTimePresets[index] = num;
                                updateSteamPresetDisplay();
                                flashElement(button);
                                showToast(`Preset saved as ${num}s`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', valueEl.textContent), disabled: isNaN(currentValue), onSelect: () => {
                        steamTimePresets[index] = currentValue;
                        updateSteamPresetDisplay();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', `${defaultValue}s`), danger: true, onSelect: () => {
                        steamTimePresets[index] = defaultValue;
                        updateSteamPresetDisplay();
                        flashElement(button);
                        showToast(`Preset reverted to ${defaultValue}s`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (steamFlowPresetsEl) {
        updateSteamPresetDisplay();

        Array.from(steamFlowPresetsEl.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const newValue = steamFlowPresets[index];
                if (newValue === undefined) return;

                setTargetSteamFlow(newValue).catch(e => logger.error(e));
                updateSteamDisplay({ targetSteamFlow: newValue });

                highlightSteamFlowPreset(index);
                selectedSteamFlowPresetIndex = index;
                persistSteamFlowSelectedIndex(index);
                flashElement(document.getElementById('steam-flow-value'));
            };

            const longPressCallback = () => {
                const valueEl = document.getElementById('steam-flow-value');
                const currentValue = parseFloat(valueEl.textContent);
                const presetValue = steamFlowPresets[index];
                const defaultValue = DEFAULT_STEAM_FLOW_PRESETS[index];
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', `${presetValue.toFixed(1)}ml/s`), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetValue.toFixed(1)), {
                            fieldType: 'steam-flow',
                            onConfirm: (newVal) => {
                                const num = parseFloat(newVal);
                                if (isNaN(num)) return;
                                steamFlowPresets[index] = num;
                                updateSteamPresetDisplay();
                                persistSteamFlowPresets();
                                flashElement(button);
                                showToast(`Preset saved as ${num.toFixed(1)}ml/s`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', `${valueEl.textContent}ml/s`), disabled: isNaN(currentValue), onSelect: () => {
                        steamFlowPresets[index] = currentValue;
                        updateSteamPresetDisplay();
                        persistSteamFlowPresets();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', `${defaultValue.toFixed(1)}ml/s`), danger: true, onSelect: () => {
                        steamFlowPresets[index] = defaultValue;
                        updateSteamPresetDisplay();
                        persistSteamFlowPresets();
                        flashElement(button);
                        showToast(`Preset reverted to ${defaultValue.toFixed(1)}ml/s`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (sleepButton) {
        sleepButton.addEventListener('click', async () => {
            if (currentMachineState === 'sleeping') {
                // Wake machine up
                await setMachineState('idle');
                logger.info("current machine state in sleep button:", currentMachineState);
                logger.info('Machine state set to idle.');

                // Deactivate screensaver if it's active
                if (isScreensaverActive()) {
                    deactivateScreensaver();
                }
            } else {
                // Put machine to sleep
                await setMachineState('sleeping');
                logger.info("current machine state in sleep button:", currentMachineState);
                logger.info('Machine state set to sleeping.');

                // Activate screensaver (unless disabled by user)
                if (!isScreensaverActive() && localStorage.getItem('screensaverEnabled') !== 'false') {
                    activateScreensaver();
                }
            }
        });
    }

    if (doseInValueEl) {
        makeEditable(doseInValueEl, (newValue) => {
            let value = newValue;
            if (value > 30) {
                alert('Dose weight is limited to 30g.');
                value = 30;
            }
            if (value < 0) {
                alert('Dose weight must be at least 0g.');
                value = 0;
            }
            doseInValueEl.textContent = `${value}g`;
            updateDoseValue('in', value);
            updateDrinkRatio();
        });
    }

    if (tempValueEl) {
        makeEditable(tempValueEl, (newValue) => {
            let value = Math.round(newValue); // Ensure it's an integer
            if (value > 105) {
                alert('Brew temperature is limited to 105°C.');
                value = 105;
            }
            if (value < 0) {
                alert('Brew temperature must be at least 0°C.');
                value = 0;
            }
            tempValueEl.textContent = `${value}°c`;
            updateTemperatureValue(value);
        });
    }

    if (drinkOutValueEl) {
        makeEditable(drinkOutValueEl, (newValue) => {
            let value = newValue;
            if (value > 2000) {
                alert('Drink weight is limited to 2000g.');
                value = 2000;
            }
            if (value < 0) {
                alert('Drink weight must be at least 0g.');
                value = 0;
            }
            drinkOutValueEl.textContent = `${value}g`;
            updateDoseValue('out', value);
            updateDrinkRatio();
        });
    }

    if (grindValueEl) {
        makeEditable(grindValueEl, (newValue) => {
            let value = newValue;
            if (value > 9999) {
                alert('Grind setting is limited to 9999.');
                value = 9999;
            }
            if (value < 0) {
                alert('Grind setting must be at least 0.');
                value = 0;
            }
            grindStep = Number.isInteger(value) ? 1 : 0.1;
            grindValueEl.textContent = Number.isInteger(value) ? String(value) : value.toFixed(1);
            updateGrindValue(value);
        });
    }

    if (hotWaterVolValueEl) {
        makeEditable(hotWaterVolValueEl, (newValue) => {
            let value = newValue;
            if (value > 255) {
                alert('Hot water volume is limited to 255 ml.');
                value = 255;
            }
            if (value < 3) {
                alert('Hot water volume must be at least 3 ml.');
                value = 3;
            }
            currentHotWaterVolume = value;
            setTargetHotWaterVolume(currentHotWaterVolume).catch(e => logger.error(e));
            updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume });
        });
    }

    if (hotWaterTempValueEl) {
        makeEditable(hotWaterTempValueEl, (newValue) => {
            let value = newValue;
            if (value > 100) {
                alert('Hot water temperature is limited to 100°C.');
                value = 100;
            }
            if (value < 0) {
                alert('Hot water temperature must be at least 0°C.');
                value = 0;
            }
            currentHotWaterTemp = value;
            setTargetHotWaterTemp(currentHotWaterTemp).catch(e => logger.error(e));
            updateHotWaterDisplay({ targetHotWaterTemp: currentHotWaterTemp });
        });
    }

    if (flushValueEl) {
        makeEditable(flushValueEl, (newValue) => {

            if (newValue > 255) {
                alert('Flush time is limited to 255s.');
                newValue = 255;
            }
            if (newValue < 3) {
                alert('Flush time must be at least 3s.');
                newValue = 3;
            }
            flushValueEl.textContent = `${newValue}s`;
            updateFlushDisplay(newValue);
            updateFlushValue(newValue);
        });
    }

    const steamDurationValueEl = document.getElementById('steam-duration-value');
    if (steamDurationValueEl) {
        makeEditable(steamDurationValueEl, (newValue) => {
            let value = newValue;
            if (value > 255) {
                alert('Steam time is limited to 255s.');
                value = 255;
            }
            if (value < 0) {
                alert('Steam time must be at least 0s.');
                value = 0;
            }
            currentSteamDuration = value;
            setTargetSteamDuration(currentSteamDuration).catch(e => logger.error(e));
            updateSteamDisplay({ targetSteamDuration: currentSteamDuration });
        });
    }

    const steamFlowValueEl = document.getElementById('steam-flow-value');
    if (steamFlowValueEl) {
        makeEditable(steamFlowValueEl, (newValue) => {
            let value = newValue;
            if (value > 2.5) {
                alert('Steam flow is limited to 2.5 ml/s.');
                value = 2.5;
            }
            if (value < 0.4) {
                alert('Steam flow must be at least 0.4 ml/s.');
                value = 0.4;
            }
            currentSteamFlow = value;
            setTargetSteamFlow(currentSteamFlow).catch(e => logger.error(e));
            updateSteamDisplay({ targetSteamFlow: currentSteamFlow });
        });
    }

    setupValueAdjuster('drink-out-minus', 'drink-out-plus', 'drink-out-value', 1, 0, (val) => `${val}g`, (val) => { updateDoseValue('out', val); updateDrinkRatio(); }, syncDrinkOutPresets);
    setupValueAdjuster('temp-minus', 'temp-plus', 'temp-value', 1, 0, (val) => `${val}°c`, updateTemperatureValue, (fmt) => syncPresetHighlight(document.getElementById('temp-presets'), t => t === fmt));
    setupValueAdjuster('dose-in-minus', 'dose-in-plus', 'dose-in-value', 1, 0, (val) => `${val}g`, (val) => { updateDoseValue('in', val); updateDrinkRatio(); }, syncDrinkOutPresets);
    setupValueAdjuster('grind-minus', 'grind-plus', 'grind-value', () => grindStep, 0, (val) => grindStep === 1 ? String(Math.round(val)) : val.toFixed(1), updateGrindValue);
    setupValueAdjuster('flush-minus', 'flush-plus', 'flush-value', 1, 0, (val) => `${val}s`, (val) => {
        updateFlushValue(val);
        updateFlushDisplay(val);
    }, (fmt) => syncPresetHighlight(document.getElementById('flush-presets'), t => t === fmt));

    if (hotWaterMinusBtn) {
        hotWaterMinusBtn.addEventListener('click', decrementHotWater);
    }

    if (hotWaterPlusBtn) {
        hotWaterPlusBtn.addEventListener('click', incrementHotWater);
    }

    if (hotWaterModeToggle) {
        hotWaterModeToggle.addEventListener('click', toggleHotWaterMode);
        hotWaterModeToggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHotWaterMode(); } });
    }

    if (steamMinusBtn) {
        steamMinusBtn.addEventListener('click', decrementSteam);
    }

    if (steamPlusBtn) {
        steamPlusBtn.addEventListener('click', incrementSteam);
    }

    if (steamModeToggle) {
        steamModeToggle.addEventListener('click', toggleSteamMode);
        steamModeToggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSteamMode(); } });
    }

    updateDrinkRatio(); // Initial calculation
}

export function updateSleepButton(state) {
    currentMachineState = state;
    const sleepButton = document.getElementById('sleep-button');
    if (sleepButton) {
        if (state === 'sleeping') {
            const awake = getTranslation('awake');
            sleepButton.textContent = awake.charAt(0).toUpperCase() + awake.slice(1);
            sleepButton.setAttribute('data-i18n-key', 'awake');
        } else {
            sleepButton.textContent = getTranslation('Sleep');
            sleepButton.setAttribute('data-i18n-key', 'Sleep');
        }
    }
}

export function updateMachineStatus(data) {
    const { status, substate, stepName, timeValue, isClickable,  isHeating, isHeatingFromTimeToReady, steamTemperature } = data;
    // Steam boiler is considered ready at/above 130°C. Below that it still needs
    // warming, which is the only time we surface a steam "Heating" message.
    const STEAM_HEATER_READY_C = 130;
    const steamHeaterCold = typeof steamTemperature === 'number' && steamTemperature < STEAM_HEATER_READY_C;
    // logger.debug(`Updating machine status to: ${status}, substate: ${substate}, stepName: ${stepName}, time: ${timeValue}, clickable: ${isClickable}`);
    const machineStatusEl = document.getElementById('machine-status');
    const hotWaterVolValueEl = document.getElementById('hot-water-vol-value');
    const flushtimevalue = document.getElementById('flush-value');
    if (!machineStatusEl) {
        return;
    }

    // Define state checks early
    const isEspressoPreparingForShot = status?.toLowerCase().includes('espresso') &&
                                      (substate?.toLowerCase().includes('preparingforshot') ||
                                       substate?.toLowerCase().includes('preparing for shot'));


    const isPreinfusionState = status?.toLowerCase().includes('preinfusion') ||
                               substate?.toLowerCase().includes('preinfusion') ||

                               substate?.toLowerCase().includes('preinfusing') ||
                               (status?.toLowerCase().includes('idle') && substate?.toLowerCase().includes('preinfusion')) ;
                            //    (status?.toLowerCase().includes('espresso') && substate?.toLowerCase().includes('preparingforshot')); substate?.toLowerCase().includes('preparingforshot') ||
    const isPouringState = status?.toLowerCase().includes('pouring') ||
                           substate?.toLowerCase().includes('pouring') ||
                           substate?.toLowerCase().includes('pour') ;
                        //    (status?.toLowerCase().includes('idle') && substate?.toLowerCase().includes('pouring')) ||
                        //    (status?.toLowerCase().includes('espresso') && substate?.toLowerCase().includes('pouring') && !isPreinfusionState) ||
                        //    (status?.toLowerCase().includes('espresso') && substate?.toLowerCase().includes('espresso') && !isPreinfusionState && !substate?.toLowerCase().includes('preparingforshot') && !substate?.toLowerCase().includes('preinfusing'));
    const isFlushState = status?.toLowerCase().includes('flush') ||
                         substate?.toLowerCase().includes('flush') ||
                         status?.includes('Flush (Pouring)');
    const isreadystate = status?.toLowerCase().includes('preparing') ||
                         substate?.toLowerCase().includes('preparing for shot') ;
    // Steam uses its own display and should NOT reuse the shot preinfusion/pouring timer.
    // We care specifically about steam states regardless of substate (e.g. "Steam (Preparing for Shot)", "Steam (Pouring)").
    const isSteamState = (
        (status?.toLowerCase().includes('steam') || status?.toLowerCase().includes('steaming'))
    );

    // Hot water uses its own display and should NOT reuse the preinfusion/pouring timer.
    const isHotWaterState = status?.toLowerCase().includes('hotwater') ||
                            status?.toLowerCase().includes('hot water') ||
                            substate?.toLowerCase().includes('hotwater');
    //needswater state
    const isNeedsWaterState = status?.toLowerCase().includes('needs water') ||
                                status?.toLowerCase().includes('need')||
                                status?.toLowerCase().includes('out of water')||
                             substate?.toLowerCase().includes('needs water');
    // pouringDone is the post-action tail (e.g. steam auto-purge). DE1 keeps
    // state='steam' during this window but the user-visible action is over —
    // exit the steam counter immediately rather than counting through the purge.
    const isPouringDone = substate === 'pouringDone';

    // Flush should take priority over preinfusion/pouring when both match,
    // e.g. "Flush (Pouring)" should be treated as a flush state, not a shot pour.
    const isCurrentlyFlushState = isFlushState && !isPouringDone;
    const isCurrentlySteamState = isSteamState && !isPouringDone;
    const isCurrentlyHotWaterState = isHotWaterState && !isPouringDone;

    // When we're in a steam, hot water, or flush state, we must NOT treat it as
    // preinfusion/pouring, otherwise the shot timer interval will keep
    // running and overwrite those UIs.
    const isCurrentlyPreinfusionOrPouring =
        !isCurrentlyFlushState &&
        !isCurrentlySteamState &&
        !isCurrentlyHotWaterState &&
        (isPreinfusionState || isPouringState);

    // Log the evaluated state checks (retained as per user request)
    // logger.debug(`isPreinfusionState: ${isPreinfusionState}, status: ${status}, substate: ${substate}`);
    // logger.debug(`isPouringState: ${isPouringState}, status: ${status}, substate: ${substate}`);

    // Clear previous classes and intervals to prevent conflicts
    machineStatusEl.classList.remove('status-msg-green', 'status-msg-red', 'status-msg-clickable', 'text-red-500', 'text-[var(--status-ready-green)]', 'text-[var(--status-needs-water-red)]', 'text-[var(--status-water-blue)]');
    machineStatusEl.onclick = null; // Clear previous click handler

    // Manage preinfusion/pouring interval lifecycle
    if (!isCurrentlyPreinfusionOrPouring && machineStatusEl.preinfusionOrPouringIntervalId) {
        clearInterval(machineStatusEl.preinfusionOrPouringIntervalId);
        delete machineStatusEl.preinfusionOrPouringIntervalId;
    }

    // Manage steam interval lifecycle
    if (!isCurrentlySteamState && machineStatusEl.steamIntervalId) {
        clearInterval(machineStatusEl.steamIntervalId);
        delete machineStatusEl.steamIntervalId;
    }

    // Manage flush interval lifecycle
    if (!isCurrentlyFlushState && machineStatusEl.flushIntervalId) {
        clearInterval(machineStatusEl.flushIntervalId);
        delete machineStatusEl.flushIntervalId;
    }

    // Steam/flush/hotwater pouringDone is the post-action tail (e.g. auto-purge).
    // Freeze the last counter value so the UI doesn't keep ticking through the
    // purge, and don't fall into the espresso pouring branch. Once state leaves
    // steam/flush/hotwater, the normal path renders Ready.
    if (isPouringDone && (isSteamState || isFlushState || isHotWaterState)) {
        if (isSteamState) {
            const steamText = getTranslation('Steaming');
            const frozenValue = typeof machineStatusEl.currentSteamValue === 'number'
                ? machineStatusEl.currentSteamValue
                : 0;
            machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${frozenValue}s</span>`;
        } else if (isFlushState) {
            const flushText = getTranslation('Flush');
            const frozenValue = typeof machineStatusEl.currentFlushValue === 'number'
                ? machineStatusEl.currentFlushValue
                : 0;
            machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${flushText}:</span> <span class="text-[var(--status-clickable-color)]">${frozenValue}s</span>`;
        } else {
            const pouringText = getTranslation('Pouring');
            const mlText = (hotWaterVolValueEl && hotWaterVolValueEl.textContent)
                ? hotWaterVolValueEl.textContent.trim()
                : '';
            machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${pouringText}:</span> <span class="text-[var(--status-clickable-color)]">${mlText}</span>`;
        }
        return;
    }

    // Check if this is a heating state with time remaining and apply special formatting
    const isHeatingWithTimeRemaining = isHeating && isHeatingFromTimeToReady && status && status.includes('Heating: ') && status.includes('s remaining');
    
    // Handle Needs Water state - takes priority
    if (isNeedsWaterState) {
        const outOfWaterText = getTranslation('Out of water') || 'Out of water';
        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${outOfWaterText}</span>`;
        logger.debug('DEBUG: Out of water state - Set machine status with red styling');
    } else if (isEspressoPreparingForShot) {
        logger.debug('Entering isEspressoPreparingForShot condition');
        const espressoonlytext = getTranslation('Espresso');
        const espressoheatingtext = getTranslation('Heating'); 
        const pleasetext = getTranslation('please');
        const waittext = getTranslation('wait');
        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${espressoonlytext} ${espressoheatingtext}:</span><span class="text-[var(--status-clickable-color)]">${pleasetext} ${waittext}</span>`;
    } else if (isHeatingWithTimeRemaining) {
        // Split the status string to apply different colors to "Heating" and "Xs remaining"
        const parts = status.split(': ');
        const heatingPart = parts[0] // "Heating"
        const timeRemainingPart = ': ' + parts[1]; // ": Xs remaining"

        // Apply --status-red-color to "Heating" and --heatingstatus to "Xs remaining" <span class="text-[var(--heatingstatus)]">${timeRemainingPart}</span>
        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${heatingPart}</span><span class="text-[var(--heatingstatus)]">${timeRemainingPart}</span>`;
        // logger.info(`DEBUG: Heating with time remaining - Set machine status to: ${machineStatusEl.innerHTML}`);
    } else {
        // Check if this is a preinfusion or pouring state and apply special formatting
        // More comprehensive matching to catch all possible espresso-related states
        // Check for preinfusion states first (more specific)


        if (isCurrentlyPreinfusionOrPouring) { // Use the new combined state check
            // Special handling for preinfusion/pouring state to show time counting up
            // NOTE: We want the label to be able to change from "Preinfusion" to "Pouring"
            // without resetting the timer when the state transitions.
            const stageText = isPreinfusionState ? getTranslation('Preinfusion') : getTranslation('Pouring');

            // Always store the latest stage text so the running interval can pick it up
            machineStatusEl.currentPreinfusionOrPouringStageText = stageText;

            // Only start a new interval if one is NOT already running.
            if (!machineStatusEl.preinfusionOrPouringIntervalId) {
                machineStatusEl.currentPreinfusionOrPouringValue = Math.floor(getShotTotalTime());

                machineStatusEl.preinfusionOrPouringIntervalId = setInterval(() => {
                    // Drive from the same source as shot-data-total-time so the two stay in sync.
                    // Math.floor: integer never reads ahead of the XX.X decimal shown in shot-data.
                    machineStatusEl.currentPreinfusionOrPouringValue = Math.floor(getShotTotalTime());

                    const currentStageText = machineStatusEl.currentPreinfusionOrPouringStageText || stageText;
                    machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${currentStageText}</span> <span class="text-[var(--status-clickable-color)]">| ${machineStatusEl.currentPreinfusionOrPouringValue}s >></span>`;
                    logger.info(`DEBUG: Preinfusion/Pouring live counter update: ${machineStatusEl.innerHTML}`); // Keep log
                }, 1000);
            }

            // Whenever updateMachineStatus is called in a preinfusion/pouring state,
            // make sure the label and value reflect the *current* stage.
            const displayValue = Math.floor(getShotTotalTime());
            machineStatusEl.currentPreinfusionOrPouringValue = displayValue;
            machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${stageText}</span> <span class="text-[var(--status-clickable-color)]">| ${displayValue}s <span id="skip-step-indicator" class="cursor-pointer">>></span></span>`;
            
            // Add click handler to the skip indicator
            const skipIndicator = document.getElementById('skip-step-indicator');
            if (skipIndicator) {
                skipIndicator.onclick = (e) => {
                    e.stopPropagation(); // Prevent event bubbling
                    logger.info('Skip step indicator clicked');
                    setMachineState('skipStep').catch(error => {
                        logger.error('Failed to skip step:', error);
                    });
                };
            }
        } else {
            // Check if this is a flush state and apply special formatting


            if (isCurrentlyFlushState) { // Use the new combined state check
                // Special handling for flush state to have different colors for "Flushing" and the value
                const flushText = getTranslation('Flush');
                logger.info(`DEBUG: Detected flush state: ${flushText}`); // Retained as per user request to inspect flush state updates
                // Only start a new interval if one is NOT already running for this state.
                if (!machineStatusEl.flushIntervalId) {
                    machineStatusEl.currentFlushValue = 0; // Start from 0

                    // Start the continuous count-up effect from 0
                    machineStatusEl.flushIntervalId = setInterval(() => {
                        machineStatusEl.currentFlushValue += 1;

                        machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${flushText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentFlushValue}s</span>`;
                        logger.info(`DEBUG: Flush live counter update: ${machineStatusEl.innerHTML}`);
                    }, 1000);
                    // Manually set the initial state immediately after starting the interval
                    machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${flushText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentFlushValue}s</span>`;
                }
            } else if (isCurrentlySteamState) {
                // Special handling for steam "pouring" state to show a live time counter.
                const steamText = getTranslation('Steaming');
                const steamwaitingText = getTranslation('Please Wait');
                const steamonlytext = getTranslation('Steam');
                const steamheatingtext = getTranslation('Heating');
                
                // Steam boiler warm-up. Flush/hot water never surface a heating
                // message, so steam shouldn't either unless the heater genuinely
                // needs warming: only show "Steam Heating" below 130°C, otherwise
                // drop straight into the steaming counter (Steaming: 0s).
                const isSteamHeatingPhase =
                    substate?.toLowerCase().includes('preparingforshot') ||
                    substate?.toLowerCase().includes('preparing for shot') ||
                    isreadystate;
                if (isSteamHeatingPhase && steamHeaterCold) {
                    machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${steamonlytext}${steamheatingtext}:</span><span class="text-[var(--status-clickable-color)]">${steamwaitingText}</span>`;
                } else {
                    // Original steam counter logic for active steaming
                    if (!machineStatusEl.steamIntervalId) {
                        machineStatusEl.currentSteamValue = 0;

                        machineStatusEl.steamIntervalId = setInterval(() => {
                            machineStatusEl.currentSteamValue += 1;

                            machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentSteamValue}s</span>`;
                            logger.info(`DEBUG: Steam live counter update: ${machineStatusEl.innerHTML}`);
                        }, 1000);

                        // Initial render at 0s
                        machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentSteamValue}s</span>`;
                    } else {
                        // If already running, just ensure we render the latest value with correct label.
                        const currentValue = typeof machineStatusEl.currentSteamValue === 'number'
                            ? machineStatusEl.currentSteamValue
                            : 0;
                        machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${currentValue}s</span>`;
                    }
                }
            } else {
                // Check if this is a hotwater state and apply special formatting
                if (isCurrentlyHotWaterState) {
                    // Special handling for hotwater state to have different colors for "Pouring" and the value.
                    // Use the original hotWaterVolValueEl text (e.g. "150ml") instead of flowAmount.
                    const pouringText = getTranslation('Pouring');
                    const mlText = (hotWaterVolValueEl && hotWaterVolValueEl.textContent)
                        ? hotWaterVolValueEl.textContent.trim()
                        : '';

                    machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${pouringText}:</span> <span class="text-[var(--status-clickable-color)]">${mlText}</span>`;
                    logger.info(`DEBUG: Hot Water state - Set machine status to: ${machineStatusEl.innerHTML}`);
                } else {
                    // Determine message and class based on status and substate using a mapping approach
                    const statusConfig = getStatusConfiguration(status, substate, stepName, timeValue, isClickable);

                    // Handle plain "Heating" message (without time remaining)
                    if (isHeating && status === "Heating") {
                        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">Heating</span>`;
                        logger.info(`DEBUG: Generic Heating state - Set machine status to: ${machineStatusEl.innerHTML}`);
                    } else {
                        machineStatusEl.textContent = statusConfig.message;
                        // logger.info(`DEBUG: Generic state from getStatusConfiguration - Set machine status to: ${machineStatusEl.textContent}`);
                        
                    }
                    
                    if (statusConfig.messageClass) {
                        machineStatusEl.classList.add(statusConfig.messageClass);
                    }
                    if (statusConfig.clickHandler) {
                        machineStatusEl.onclick = statusConfig.clickHandler;
                    }
                }
            }
        }
    }
}

function getStatusConfiguration(status, substate, stepName, timeValue, isClickable) {
    // logger.info(`getStatusConfiguration called with: status=${status}, substate=${substate}, stepName=${stepName}, timeValue=${timeValue}, isClickable=${isClickable}`);
    const configMap = {
        'disconnected': {
            message: getTranslation('Disconnected') || 'Disconnected',
            messageClass: 'status-msg-red'
        },
        // Shown only when the screensaver is off (otherwise its overlay hides this).
        'sleeping': {
            message: getTranslation('Sleeping') || 'Sleeping',
            messageClass: 'status-msg-red'
        },
        'error': {
            message: getTranslation('Error') || 'Error',
            messageClass: 'status-msg-red'
        },
        'heating': (inputStatus) => ({
            message: inputStatus,
            additionalClass: 'text-red-500'
        }),
        'idle': {
            message: getTranslation('Ready'),
            messageClass: 'status-msg-green'
        },
        'preinfusion': {
            message: `${stepName} | ${formatTimeAbbreviated(timeValue)} >>`,
            messageClass: isClickable ? 'status-msg-clickable' : 'status-msg-green',
            clickHandler: isClickable ? createStepAdvanceHandler() : null
        },
        'pouring': {
            
            message: `${stepName} | ${formatTimeAbbreviated(timeValue)} >>`,
            messageClass: isClickable ? 'status-msg-clickable' : 'status-msg-green',
            clickHandler: isClickable ? createStepAdvanceHandler() : null
        },
        'flushing': {
            message: `${getTranslation('Flushing')}: ${formatTimeAbbreviated(timeValue)}`,
            messageClass: 'status-msg-red'
        },
        'steaming': {
            message: `${getTranslation('Steaming')}: ${formatTimeAbbreviated(timeValue)}`,
            messageClass: 'status-msg-red'
        },
        'hotwater': {
            message: `${getTranslation('Pouring')}: ${0}ml`,
            messageClass: 'status-msg-green'
        }
    };

    const lowerStatus = status?.toLowerCase() || '';
    const lowerSubstate = substate?.toLowerCase() || '';

    // Prioritized list of states to check against `status` and `substate`
    const statePriority = [
        'disconnected', 'sleeping', 'error', 'heating', 'idle',
        'flushing', 'steaming', 'hotwater',
        'preinfusion', 'pouring'
    ];

    let effectiveState = '';

    // Determine the effective state based on inclusion and priority
    for (const stateKey of statePriority) {
        if (lowerStatus.includes(stateKey)) {
            effectiveState = stateKey;
            break;
        }
        if (lowerSubstate.includes(stateKey)) {
            effectiveState = stateKey;
            break;
        }
    }

    if (effectiveState && configMap[effectiveState]) {
        const config = configMap[effectiveState];
        if (typeof config === 'function') {
            return config(status); // Pass original status for 'heating' as it expects it
        } else {
            // Apply custom formatting for specific states based on requirements
            if (effectiveState === 'hotwater') {
                // For hotwater, show "Pouring(green): x ml(blue)" with different colors for different parts
                return {
                    message: `${getTranslation('Pouring')}: ${hotWaterVolValueEl.textContent || 0}ml`,
                    messageClass: 'status-msg-green-blue'  // Custom class to handle green "Pouring" and blue value
                };
            } else if (effectiveState === 'steaming') {
                // For steaming, show "Steaming: x s" with seconds counting up
                return {
                    message: `${getTranslation('Steaming')}: ${formatTimeAbbreviated(timeValue)}`,
                    messageClass: config.messageClass
                };
            } else if (effectiveState === 'flushing') {
                // For flush, show "Flushing: x s"
                return {
                    message: `${getTranslation('Flushing')}: ${formatTimeAbbreviated(timeValue)}`,
                    messageClass: config.messageClass
                };
            } else {
                return config;
            }
        }
    }

    // Fallback if no specific match
    return {
        message: status || '',
        messageClass: 'status-msg-green'
    };
}

function createStepAdvanceHandler() {
    return () => {
        logger.info('Clickable status message clicked to advance step.');
        // Call the appropriate function to advance the step
        // This would need to be implemented based on the app's architecture
        // window.advanceStep ? window.advanceStep() : null;
    };
}
export function updateTemperatures({ mix, group, steam }) {
    const mixTempEl = document.getElementById('data-mix-temp');
    const groupTempEl = document.getElementById('data-group-temp');
    const steamTempEl = document.getElementById('data-steam-temp');

    if (mixTempEl) {
        mixTempEl.textContent = `${mix.toFixed(1)}°c`;
    }
    if (groupTempEl) {
        groupTempEl.textContent = `${group.toFixed(1)}°c`;
    }
    if (steamTempEl) {
        steamTempEl.textContent = `${steam.toFixed(0)}°c`;
    }
}

export function updateWeight(weight, classUpdates = {}) {
    const { dataWeight, weightText } = classUpdates;
    const weightEl = document.getElementById('data-weight');
    const weightTextEl = document.getElementById('weight-text');

    if (weightEl) {
        if (typeof weight === 'number' && !isNaN(weight)) {
            weightEl.textContent = ` ${weight.toFixed(1)}g`;
        } else {
            weightEl.textContent = weight;
        }

        if (dataWeight) {
            if (dataWeight.add) {
                weightEl.classList.add(...dataWeight.add);
            }
            if (dataWeight.remove) {
                weightEl.classList.remove(...dataWeight.remove);
            }
        }
    }

    if (weightTextEl) {
        if (weightText) {
            if (weightText.add) {
                weightTextEl.classList.add(...weightText.add);
            }
            if (weightText.remove) {
                weightTextEl.classList.remove(...weightText.remove);
            }
        }
    }
}

export function updateProfileName(name) {
    logger.debug(`Updating profile name to: ${name}`);
    const profileNameEl = document.getElementById('profile-name');
    if (profileNameEl) {
        profileNameEl.firstChild.textContent = getTranslation(name);
    }
}

export function updateDrinkOut(doseOut) {
    logger.debug(`Updating drink out to: ${doseOut}g`);
    const drinkOutValueEl = document.getElementById('drink-out-value');
    if (drinkOutValueEl) {
        drinkOutValueEl.textContent = `${doseOut}g`;
    }
}

export function updateTemperatureDisplay(temperature) {
    const tempValueEl = document.getElementById('temp-value');
    if (tempValueEl) {
        tempValueEl.textContent = `${parseFloat(temperature).toFixed(0)}°c`;
    }
    const target = `${parseFloat(temperature).toFixed(0)}°c`;
    syncPresetHighlight(document.getElementById('temp-presets'), t => t === target);
}

export function updateFlushDisplay(duration) {
    const flushValueEl = document.getElementById('flush-value');
    if (flushValueEl) {
        flushValueEl.textContent = `${parseFloat(duration).toFixed(0)}s`;
    }
    const target = `${parseFloat(duration).toFixed(0)}s`;
    syncPresetHighlight(document.getElementById('flush-presets'), t => t === target);
}

export function updateGrindDisplay(grinderData) {
    const grindValueEl = document.getElementById('grind-value');
    // Support both new context format (grinderData.grinderSetting) and legacy format (grinderData.setting)
    // Prefer grinderSetting over setting (context takes precedence)
    const grindValue = grinderData?.grinderSetting ?? grinderData?.setting;
    if (grindValueEl && grindValue !== undefined) {
        const parsed = parseFloat(grindValue);
        grindValueEl.textContent = Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
    }
}

export function updateDoseInDisplay(doseInValue) {
    const doseInValueEl = document.getElementById('dose-in-value');
    if (doseInValueEl && doseInValue) {
        doseInValueEl.textContent = `${doseInValue}g`;
    }
}

// --- Fullscreen Handling ---

function toggleFullScreen() {
    const doc = window.document;
    const docEl = doc.documentElement;

    const requestFullScreen = docEl.requestFullscreen || docEl.mozRequestFullScreen || docEl.webkitRequestFullScreen || docEl.msRequestFullscreen;
    const cancelFullScreen = doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;

    // Check if fullscreen is active using vendor-prefixed properties
    const isFullScreen = doc.fullscreenElement || doc.mozFullScreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;

    if (!isFullScreen) {
        if (requestFullScreen) {
            requestFullScreen.call(docEl)
                .then(() => {
                    if (screen.orientation?.lock) {
                        screen.orientation.lock('landscape').catch(err => {
                            logger.warn(`Orientation lock failed: ${err.message}`);
                        });
                    }
                })
                .catch(err => {
                    logger.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
                });
        }
    } else {
        if (cancelFullScreen) {
            if (screen.orientation?.unlock) {
                screen.orientation.unlock();
            }
            cancelFullScreen.call(doc).catch(err => {
                logger.error(`Error attempting to exit full-screen mode: ${err.message} (${err.name})`);
            });
        }
    }
}

export function updateFullscreenState() {
    const isFullScreen = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

    const enterIcon = document.querySelector('#fullscreen-toggle-btn .enter-fullscreen-icon');
    const exitIcon = document.querySelector('#fullscreen-toggle-btn .exit-fullscreen-icon');

    if (!enterIcon || !exitIcon) {
        return; // Exit if icons aren't found
    }

    if (isFullScreen) {
        document.body.setAttribute('fullscreen', '');
        enterIcon.style.display = 'none';
        exitIcon.style.display = 'block';
    } else {
        document.body.removeAttribute('fullscreen');
        enterIcon.style.display = 'block';
        exitIcon.style.display = 'none';
    }
}

export function initFullscreenHandler() {
    const fullscreenButton = document.getElementById('fullscreen-toggle-btn'); // Assuming a button with this ID exists

    if (fullscreenButton) {
        const fsEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled || document.mozFullScreenEnabled || document.msFullscreenEnabled;

        if (fsEnabled) {
            fullscreenButton.addEventListener('click', toggleFullScreen);

            document.addEventListener('fullscreenchange', updateFullscreenState);
            document.addEventListener('webkitfullscreenchange', updateFullscreenState);
            document.addEventListener('mozfullscreenchange', updateFullscreenState);
            document.addEventListener('MSFullscreenChange', updateFullscreenState);

            updateFullscreenState(); // Set initial state
        } else {
            fullscreenButton.style.display = 'none'; // Hide button if not supported
        }
    } else {
        logger.warn('Fullscreen toggle button with id "fullscreen-toggle-btn" not found.');
    }
}

function initSettingsModal() {
    const settingsModal = document.getElementById('settings_modal');
    const settingsBtn = document.getElementById('settings-btn');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const visualizerUsernameEl = document.getElementById('visualizer-username');
    const visualizerPasswordEl = document.getElementById('visualizer-password');
    const visualizerAutoUploadEl = document.getElementById('visualizer-auto-upload');
    const visualizerStatusEl = document.getElementById('visualizer-status');
    const reaHostnameInput = document.getElementById('rea-hostname-input');
    const saveReaHostnameBtn = document.getElementById('save-rea-hostname-btn');
    const pluginId = 'visualizer.reaplugin';

    // When the modal is opened, load the latest settings
    if (settingsBtn) {
        settingsBtn.addEventListener('click', async () => {
            if (settingsModal) {
                // 1. Populate hostname
                if (reaHostnameInput) {
                    reaHostnameInput.value = reaHostname;
                }

                // 2. Load and populate plugin settings
                try {
                    const savedSettings = await getPluginSettings(pluginId);
                    if (savedSettings && savedSettings.Username) {
                        visualizerUsernameEl.value = savedSettings.Username;
                    } else {
                        visualizerUsernameEl.value = '';
                    }
                    visualizerPasswordEl.value = ''; // Always clear password field
                    visualizerStatusEl.textContent = ''; // Clear status
                } catch (error) {
                    logger.error(`Failed to load settings for ${pluginId}:`, error);
                    visualizerStatusEl.textContent = 'Could not load plugin settings.';
                    visualizerStatusEl.className = 'text-red-500';
                }

                // 3. Load UI-only settings from localStorage
                const autoUpload = localStorage.getItem('visualizerAutoUpload');
                if (visualizerAutoUploadEl) {
                    visualizerAutoUploadEl.checked = autoUpload === 'true';
                }

                settingsModal.showModal();
            }
        });
    }

    // Handle saving the REA hostname
    if (saveReaHostnameBtn) {
        saveReaHostnameBtn.addEventListener('click', () => {
            if (reaHostnameInput) {
                const newHostname = reaHostnameInput.value.trim();
                if (newHostname) {
                    localStorage.setItem('reaHostname', newHostname);
                    alert('Hostname saved. The page will now reload.');
                    location.reload();
                } else {
                    localStorage.removeItem('reaHostname');
                    alert('Hostname cleared. The page will now reload to use the default address.');
                    location.reload();
                }
            }
        });
    }

    // Handle saving all other settings
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
            const username = visualizerUsernameEl.value.trim();
            const password = visualizerPasswordEl.value; // Don't trim password

            if (!username || !password) {
                visualizerStatusEl.textContent = 'Username and Password are required.';
                visualizerStatusEl.className = 'text-red-500';
                return;
            }

            visualizerStatusEl.textContent = 'Testing credentials...';
            visualizerStatusEl.className = 'text-gray-500';

            const isValid = await verifyVisualizerCredentials(username, password);

            if (!isValid) {
                visualizerStatusEl.textContent = 'Invalid Visualizer credentials.';
                visualizerStatusEl.className = 'text-red-500';
                // Clear any previously saved (and now invalid) credentials
                localStorage.removeItem('visualizerUsername');
                localStorage.removeItem('visualizerPassword');
                return; // Stop here if credentials are bad
            }

            visualizerStatusEl.textContent = 'Visualizer credentials valid.';
            visualizerStatusEl.className = 'text-green-500';

            // On success, save to localStorage for future auto-login
            localStorage.setItem('visualizerUsername', username);
            localStorage.setItem('visualizerPassword', btoa(password)); // Basic obfuscation

            // If credentials are valid, proceed to save to plugin
            const autoUpload = visualizerAutoUploadEl.checked;

            // 1. Save UI-only settings to localStorage
            localStorage.setItem('visualizerAutoUpload', autoUpload);

            // 2. Prepare and save plugin settings
            const settingsPayload = {
                Username: username,
                Password: password, // Send the actual password to the plugin
                AutoUpload: autoUpload,
                LengthThreshold: parseInt(document.getElementById('visualizer-min-duration').value, 10) || 5,
            };

            try {
                await setPluginSettings(pluginId, settingsPayload);
                visualizerStatusEl.textContent = 'Credentials saved successfully!';
                visualizerStatusEl.className = 'text-green-500';

                // Hide status after a few seconds
                setTimeout(() => {
                    visualizerStatusEl.textContent = '';
                }, 3000);

            } catch (error) {
                logger.error('Failed to save visualizer plugin settings:', error);
                visualizerStatusEl.textContent = `Failed to save to REA plugin: ${error.message}.`;
                visualizerStatusEl.className = 'text-red-500';
            }
        });
    }
}


export function showToast(message, duration = 2400, type = 'info') {
    const toastEl = document.getElementById('app-toast');
    const messageEl = document.getElementById('app-toast-message');
    if (toastEl && messageEl) {
        messageEl.textContent = message;

        const alertEl = toastEl.querySelector('.alert');
        if (alertEl) {
            alertEl.classList.remove('alert-info', 'alert-success', 'alert-error');
            alertEl.classList.add(`alert-${type}`);
        }

        // Set accessibility roles based on type
        if (type === 'error' || type === 'alert') {
            toastEl.setAttribute('role', 'alert');
            toastEl.setAttribute('aria-live', 'assertive');
        } else {
            toastEl.setAttribute('role', 'status');
            toastEl.setAttribute('aria-live', 'polite');
        }

        toastEl.style.display = 'grid';

        if (duration > 0) {
            setTimeout(() => {
                hideToast();
            }, duration);
        }
    } else {
        logger.warn('App toast element not found.');
    }
}

export function hideToast() {

    const toastEl = document.getElementById('app-toast');

    if (toastEl) {

        toastEl.style.display = 'none';

    }

}



export function initResizablePanels(separatorId) {
    const separator = document.getElementById(separatorId);
    if (!separator) {
        logger.warn(`Separator with id #${separatorId} not found.`);
        return;
    }

    const container = separator.parentElement;
    if (!container) {
        logger.warn('Separator has no parent container.');
        return;
    }

    const leftPanel = separator.previousElementSibling;
    if (!leftPanel) {
        logger.warn('Left panel not found for separator.');
        return;
    }

    let isDragging = false;
    let initialX = 0;
    let initialLeftWidth = 0;

    const thicken = () => {
        separator.classList.remove('w-px');
        separator.classList.add('w-2');
    };
    const restore = () => {
        separator.classList.remove('w-2');
        separator.classList.add('w-px');
    };

    const startDrag = (e) => {
        isDragging = true;
        thicken();

        const clientX = e.clientX || e.touches[0].clientX;
        initialX = clientX;

        initialLeftWidth = leftPanel.offsetWidth;

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);

        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', stopDrag);
    };

    const drag = (e) => {
        if (!isDragging) return;

        if (e.type === 'touchmove') {
            e.preventDefault();
        }

        requestAnimationFrame(() => {
            const clientX = e.clientX || e.touches[0].clientX;
            const deltaX = clientX - initialX;
            let newLeftWidth = initialLeftWidth + deltaX;

            const containerRect = container.getBoundingClientRect();
            // Calculate minimum width to ensure right panel has enough space for buttons
            const minRightPanelWidth = 300; // Minimum width needed for buttons in right panel
            const minWidth = containerRect.width * 0.2;
            const maxWidth = containerRect.width - minRightPanelWidth;

            if (newLeftWidth < minWidth) newLeftWidth = minWidth;
            if (newLeftWidth > maxWidth) newLeftWidth = maxWidth;

            container.style.gridTemplateColumns = `${newLeftWidth}px auto minmax(${minRightPanelWidth}px, 1fr)`;
        });
    };

    const stopDrag = () => {
        isDragging = false;
        restore();

        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', stopDrag);

        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', stopDrag);
    };

    separator.addEventListener('mousedown', startDrag);
    separator.addEventListener('touchstart', startDrag);
}

// Export functions needed by app.js
export { updateDoseValue };

export function showGhcControls() {
    const el = document.getElementById('ghc-controls');
    if (!el || el.style.display === 'flex') return; // already visible, skip
    el.style.display = 'flex';

    const panel = document.getElementById('shot-data-panel');
    if (panel) panel.style.width = '878px';

    const status = document.getElementById('machine-status');
    if (status) {
        status.style.right = '100px'; // 172px GHC + 20px gap
        status.style.width = 'auto';  // size to content; right edge stays anchored, box grows leftward
    }

    // Shrink Pressure column so it doesn't overlap GHC
    document.querySelectorAll('.shot-data-cols').forEach(grid => {
        grid.style.gridTemplateColumns = '90px 90px 90px 100px 200px 110px';
    });

    // Resize Plotly: clear inline width (set by Plotly at init) then relayout to new size.
    // 1920px canvas - 480px left aside - 172px GHC = 1268px chart width.
    // Right margin is computed dynamically from label widths — refresh after resize
    // so labels stay inside the new plot box.
    const chartEl = document.getElementById('plotly-chart');
    if (chartEl) {
        chartEl.style.width = '';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            Plotly.relayout(chartEl, { width: 1268 });
            chart.refreshLabelMargin();
        }));
    }
}

export function hideGhcControls() {
    const el = document.getElementById('ghc-controls');
    if (!el || el.style.display === 'none') return; // already hidden, skip
    el.style.display = 'none';

    const panel = document.getElementById('shot-data-panel');
    if (panel) panel.style.width = '';

    const status = document.getElementById('machine-status');
    if (status) {
        status.style.right = '';
        status.style.width = '';
    }

    // Restore Pressure column width
    document.querySelectorAll('.shot-data-cols').forEach(grid => {
        grid.style.gridTemplateColumns = '';
    });

    // Restore chart to full main width: 1920px - 480px left aside = 1440px.
    // Right margin recomputed from label widths.
    const chartEl = document.getElementById('plotly-chart');
    if (chartEl) {
        chartEl.style.width = '';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            Plotly.relayout(chartEl, { width: 1460 });
            chart.refreshLabelMargin();
        }));
    }
}

const SIDEBAR_GROUPS = {
    grind:    ['grind-section'],
    dose:     ['dose-section'],
    drink:    ['drink-section', 'drink-out-presets'],
    brew:     ['brew-section', 'temp-presets'],
    steam:    ['steam-section', 'steam-presets', 'steam-flow-presets'],
    flush:    ['flush-section', 'flush-presets'],
    hotwater: ['hotwater-section', 'hotwater-presets'],
};

const ALL_GROUPS = Object.keys(SIDEBAR_GROUPS);

const STATE_DIM_MAP = {
    'espresso':   ALL_GROUPS,
    'steam':      ALL_GROUPS.filter(g => g !== 'steam'),
    'steamRinse': ALL_GROUPS.filter(g => g !== 'steam'),
    'hotWater':   ALL_GROUPS.filter(g => g !== 'hotwater'),
    'flush':      ALL_GROUPS.filter(g => g !== 'flush'),
};

export function updateSidebarOverlay(state) {
    const groupsToDim = STATE_DIM_MAP[state] || [];
    for (const groupName of ALL_GROUPS) {
        const shouldDim = groupsToDim.includes(groupName);
        for (const id of SIDEBAR_GROUPS[groupName]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.style.opacity = shouldDim ? '0.25' : '';
            el.style.pointerEvents = shouldDim ? 'none' : '';
            el.style.transition = 'opacity 0.3s ease';
        }
    }
}

export function updateGhcStopButton(isActive) {
    const stopBtn = document.getElementById('ghc-stop-btn');
    const actionIds = ['ghc-coffee-btn', 'ghc-water-btn', 'ghc-steam-btn', 'ghc-flush-btn'];

    if (isActive) {
        // Machine running: stop button fully visible (red bg, white text already in HTML)
        stopBtn?.classList.remove('opacity-20');
        // Gray out the 4 action buttons
        for (const id of actionIds) {
            document.getElementById(id)?.classList.add('opacity-20');
        }
    } else {
        // Machine idle: stop button grayed out, action buttons normal
        stopBtn?.classList.add('opacity-20');
        for (const id of actionIds) {
            document.getElementById(id)?.classList.remove('opacity-20');
        }
    }
}