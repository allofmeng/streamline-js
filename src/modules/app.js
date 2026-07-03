import { connectWebSocket, getWorkflow, connectScaleWebSocket, ensureGatewayModeTracking, reconnectingWebSocket, getDevices, reconnectDevice, scanForDevices,connectShotSettingsWebSocket, getDe1AdvancedSettings, updateShotSettingsCache, getDe1Settings, MachineState, getShotIds, getShots, getValueFromStore, verifyVisualizerCredentials, connectScaleDevice, tareScale, connectTimeToReadyWebSocket, sendDeviceCommand, saveScaleDeviceId, getScaleDeviceId, getDeviceWebSocket, initDeviceWebSocketWithCallback, connectDeviceWebSocket, connectDisplayWebSocket, getMachineInfo, setMachineState, getReaSettings, getAppInfo } from './api.js';
import { initScaling } from './scaling.js';
import * as chart from './chart.js';
import * as ui from './ui.js';
import { initI18n, getTranslation } from './i18n.js';
import * as history from './history.js';
import * as shotData from './shotData.js';
import * as profileManager from './profileManager.js';
import * as api from './api.js';
import { loadPage, initRouter, isSubPage } from './router.js';
import { initWaterTankSocket } from './waterTank.js';
import { logger, setDebug } from './logger.js';
import { initNumpadModal, attachToNumericInputs, openModal, shouldUseNumpad } from './numpad-modal.js';
import { openDB, setSetting } from './idb.js';
import { openContextMenu } from './context-menu.js';

window.app = { api, ui, chart };

// Export functions for UI and router access
window.handleWeightClick = handleWeightClick;
window.handleScaleData = handleScaleData;
window.loadInitialData = loadInitialData;
window.resetDataTimeout = resetDataTimeout;
window.onScaleDisconnect = onScaleDisconnect;
window.onScaleReconnect = onScaleReconnect;

function initClockTicker() {
    const el = document.getElementById('data-clock');
    if (!el) return;
    const tick = () => {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        el.textContent = `${h}:${m}`;
    };
    tick();
    // Re-align to wall-clock minute so updates land on the second hand crossing 0.
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    setTimeout(() => {
        tick();
        setInterval(tick, 60_000);
    }, msToNextMinute);
}

function initMobileValueInputs() {
    if (!shouldUseNumpad()) return;
    
    const valueElements = [
        { id: 'dose-in-value', type: 'dose-in', label: 'Dose In' },
        { id: 'drink-out-value', type: 'drink-out', label: 'Drink Out' },
        { id: 'temp-value', type: 'temperature', label: 'Temperature' },
        { id: 'grind-value', type: 'grind', label: 'Grind' },
        { id: 'steam-duration-value', type: 'steam-duration', label: 'Steam Duration' },
        { id: 'steam-flow-value', type: 'steam-flow', label: 'Steam Flow' },
        { id: 'flush-value', type: 'flush', label: 'Flush' },
        { id: 'hot-water-vol-value', type: 'hot-water-vol', label: 'Hot Water Volume' },
        { id: 'hot-water-temp-value', type: 'hot-water-temp', label: 'Hot Water Temp' }
    ];
    
    valueElements.forEach(({ id, type, label }) => {
        const el = document.getElementById(id);
        if (!el) return;
        
        el.style.cursor = 'pointer';
        // Tell browser this is for clicking, not text input
        el.style.touchAction = 'manipulation';
        el.style.webkitTapHighlightColor = 'transparent';
        el.setAttribute('tabindex', '-1');
        
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const currentValue = el.textContent.replace(/[^0-9.]/g, '') || '0';
            
            const mockInput = {
                value: currentValue,
                setAttribute: () => {},
                dispatchEvent: (event) => {
                    if (event.type === 'change' || event.type === 'input') {
                        const newVal = mockInput.value;
                        el.textContent = type === 'temperature' ? `${newVal}°c` : 
                                        type === 'grind' ? newVal : 
                                        type === 'steam-duration' ? `${newVal}s` :
                                        type === 'steam-flow' ? newVal :
                                        type === 'flush' ? `${newVal}s` :
                                        type === 'hot-water-vol' ? `${newVal}ml` :
                                        type === 'hot-water-temp' ? `${newVal}°c` :
                                        `${newVal}g`;
                                        
                        if (type === 'dose-in') {
                            window.app.ui.updateDoseValue('in', newVal);
                            window.app.ui.updateDrinkRatio();
                        } else if (type === 'drink-out') {
                            window.app.ui.updateDoseValue('out', newVal);
                            window.app.ui.updateDrinkRatio();
                        } else if (type === 'temperature') {
                            window.app.ui.updateTemperatureValue(parseFloat(newVal));
                        } else if (type === 'steam-duration') {
                            const v = parseFloat(newVal);
                            window.app.ui.updateSteamDisplay({ targetSteamDuration: v });
                            window.app.api.setTargetSteamDuration(v).catch(e => logger.error('setTargetSteamDuration failed:', e));
                        } else if (type === 'steam-flow') {
                            const v = parseFloat(newVal);
                            window.app.ui.updateSteamDisplay({ targetSteamFlow: v });
                            window.app.api.setTargetSteamFlow(v).catch(e => logger.error('setTargetSteamFlow failed:', e));
                        } else if (type === 'flush') {
                            window.app.ui.updateFlushValue(parseFloat(newVal));
                            window.app.ui.updateFlushDisplay(parseFloat(newVal));
                        } else if (type === 'hot-water-vol') {
                            const v = parseFloat(newVal);
                            window.app.ui.updateHotWaterDisplay({ targetHotWaterVolume: v });
                            window.app.api.setTargetHotWaterVolume(v).catch(e => logger.error('setTargetHotWaterVolume failed:', e));
                        } else if (type === 'hot-water-temp') {
                            const v = parseFloat(newVal);
                            window.app.ui.updateHotWaterDisplay({ targetHotWaterTemp: v });
                            window.app.api.setTargetHotWaterTemp(v).catch(e => logger.error('setTargetHotWaterTemp failed:', e));
                        } else if (type === 'grind') {
                            window.app.ui.updateGrindValue(newVal);
                        }
                    }
                }
            };
            
            openModal(mockInput, {
                previousValues: [],
                onConfirm: (val) => {},
                fieldType: type
            });
        });
    });
    
    logger.info('Mobile value inputs initialized');
}

// Display-label overrides for raw machine states whose camelCase split reads
// poorly. 'Out of water' is also an existing i18n key.
const STATE_LABEL_OVERRIDES = {
    needsWater: 'Out of water'
};

// Helper function to format state strings
function formatStateString(text) {
    if (!text) return '';
    if (STATE_LABEL_OVERRIDES[text]) return STATE_LABEL_OVERRIDES[text];
    // "camelCase" -> "Camel Case"
    const result = text.replace(/([A-Z])/g, ' $1');
    return result.charAt(0).toUpperCase() + result.slice(1).trim();
}

let shotStartTime = null;
let shotEndedAt = null;
const SHOT_RESTART_COOLDOWN_MS = 5000;
let dataTimeout;
let de1DeviceId = null;
let isDe1Connected = false;
let isNonGhcMachine = false;
let isScaleConnected = false; // New variable to track Scale connection status
let previousState = {}; // Track previous machine state object {state, substate}
let currentActiveProfile = null; // Track active profile for shot-end reason detection

let latestScaleWeight = 0;
let latestScaleWeightFlow = null; // server-smoothed g/s from ScaleSnapshot; null until a frame arrives
let latestScaleBattery = null;
window.getLatestScaleBattery = () => latestScaleBattery;
let heatingStartTime = null;
let heatingStartTemp = 0;
let isConnectingScale = false;
let timeToReadyMessage = null;
let isHeatingFromTimeToReady = false; // Flag to track if we're currently in a heating phase from time-to-ready
let timeToReadyStatus = null; // Track the status from time-to-ready data

// Scale reconnect text state — driven by /ws/v1/devices scanning flag + wake grace window
let isScaleScanning = false;
let isInWakeGracePeriod = false;
let wakeGraceTimeout = null;
const WAKE_RECONNECT_GRACE_MS = 4000;

// Scale auto-retry on disconnect
let scaleAutoRetryCount = 0;
let scaleAutoRetryTimer = null;
const SCALE_AUTO_RETRY_MAX = 3;
const SCALE_AUTO_RETRY_INTERVAL_MS = 5000;

function clearScaleAutoRetry() {
    clearTimeout(scaleAutoRetryTimer);
    scaleAutoRetryTimer = null;
    scaleAutoRetryCount = 0;
}

async function attemptScaleAutoRetry() {
    if (isScaleConnected) { clearScaleAutoRetry(); return; }
    if (scaleAutoRetryCount >= SCALE_AUTO_RETRY_MAX) { clearScaleAutoRetry(); return; }
    if (!getScaleDeviceId()) { clearScaleAutoRetry(); return; }
    try {
        const reaSettings = await getReaSettings();
        if (reaSettings?.scalePowerMode === 'disconnect') { clearScaleAutoRetry(); return; }
    } catch (_) { /* proceed */ }

    scaleAutoRetryCount++;
    logger.info(`Scale auto-retry ${scaleAutoRetryCount}/${SCALE_AUTO_RETRY_MAX}`);
    handleWeightClick();
    scaleAutoRetryTimer = setTimeout(attemptScaleAutoRetry, SCALE_AUTO_RETRY_INTERVAL_MS);
}

// Spinner shown in the weight slot while a scale scan is in flight. SMIL-animated
// so it spins without a CSS class (keeps the weight item narrow — no text width —
// so it never overflows the GHC column, and needs no Tailwind rebuild).
const SCAN_ICON_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="display:inline-block;vertical-align:middle" aria-label="Scanning"><path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></svg>`;

function renderScanIcon() {
    const weightEl = document.getElementById('data-weight');
    const weightTextEl = document.getElementById('weight-text');
    if (weightTextEl) weightTextEl.classList.add('text-red-600');
    if (weightEl) {
        weightEl.classList.add('text-[var(--mimoja-blue)]');
        weightEl.classList.remove('text-[var(--text-primary)]');
        weightEl.innerHTML = SCAN_ICON_SVG;
    }
}

function renderScaleDisconnectedText() {
    if (isScaleConnected) return;
    // Container is display:none by default and only revealed on first weight frame.
    // Force it visible here so the Retry text / Scan spinner — and the tap target — render.
    const scaleInfoContainer = document.getElementById('scale-info-container');
    if (scaleInfoContainer) scaleInfoContainer.style.display = '';
    const showScanning = isScaleScanning || isInWakeGracePeriod;
    if (showScanning) {
        renderScanIcon();
    } else {
        // 'Retry' is translated; most languages are short (German is longer but
        // the user accepts it here).
        ui.updateWeight(getTranslation('Retry'), {
            weightText: { add: ['text-red-600'] },
            dataWeight: { add: ['text-[var(--mimoja-blue)]'], remove: ['text-[var(--text-primary)]'] }
        });
    }
}

function handleDeviceWsData(data) {
    const next = !!data?.scanning;
    if (next !== isScaleScanning) {
        isScaleScanning = next;
        renderScaleDisconnectedText();
    }
}

function onScaleReconnect() {
    logger.info('Scale WebSocket reconnected.');
}

function onScaleDisconnect() {
    logger.warn('Scale has disconnected.');
    isScaleConnected = false;
    renderScaleDisconnectedText();
    clearScaleAutoRetry();
    scaleAutoRetryTimer = setTimeout(attemptScaleAutoRetry, SCALE_AUTO_RETRY_INTERVAL_MS);
}

const deviceErrorCopy = {
    scaleConnectFailed: 'Scale did not connect. Wake it and retry.',
    machineConnectFailed: 'DE1 did not connect. Retry scan.',
    scaleDisconnected: 'Scale dropped. Retry scan.',
    machineDisconnected: 'DE1 dropped. Retry scan.',
    adapterOff: 'Bluetooth is off. Turn it on to continue.',
    bluetoothPermissionDenied: 'Grant Bluetooth permission to continue.',
    scanFailed: 'Scan could not start. Retry.',
};

function handleDeviceConnectionError(err) {
    // scaleDisconnected is handled silently — the [Reconnect] UI on the main page covers it
    if (err.kind === 'scaleDisconnected') return;
    const msg = deviceErrorCopy[err.kind] ?? `${err.message}${err.suggestion ? `\n${err.suggestion}` : ''}`;
    ui.showToast(msg, 5000, 'error');
}

// Sets a timer. If no data is received within 5 seconds, it assumes a stale connection.
function resetDataTimeout() {
    clearTimeout(dataTimeout);
    dataTimeout = setTimeout(() => {
        logger.warn('No WebSocket data received for 5 seconds. Assuming REA or WebSocket disconnection.');
        ui.updateMachineStatus({ status: "disconnected" });
        isDe1Connected = false;
    }, 5000); // 5-second timeout
}

function isHeatingState(state, substate) {
    return state === MachineState.HEATING || (state === MachineState.IDLE && substate === 'preparingForShot');
}

async function pollForUploadConfirmation(shotId, timeout = 30000) {
    // Check if visualizer is enabled before attempting upload
    const isVisualizerEnabled = localStorage.getItem('visualizerEnabled') === 'true';
    
    if (!isVisualizerEnabled) {
        logger.info('Visualizer is disabled. Skipping upload confirmation for shot ID:', shotId);
        return Promise.resolve(false); // Return resolved promise with false to indicate no upload happened
    }
    
    logger.info(`Polling for upload confirmation for shot ID: ${shotId}`);
    const pollInterval = 3000; // 3 seconds
    const startTime = Date.now();

    const checkUploadStatus = async (resolve, reject) => {
        if (Date.now() - startTime > timeout) {
            logger.warn(`Polling timed out for shot ${shotId}.`);
            ui.showToast(`Upload to Visualizer Failed.`, 3000, 'error');
            return reject(new Error('Polling timed out'));
        }

        try {
            const lastUploadedShotId = await getValueFromStore('visualizer.reaplugin', 'lastUploadedShot');
            logger.debug(`Polled lastUploadedShotId: ${lastUploadedShotId}`);

            if (lastUploadedShotId === shotId) {
                logger.info(`Successfully confirmed upload for shot ${shotId}.`);
                ui.showToast('Shot uploaded successfully!', 3000, 'success');
                return resolve(true);
            } else {
                setTimeout(() => checkUploadStatus(resolve, reject), pollInterval);
            }
        } catch (error) {
            logger.error('Error during polling for upload confirmation:', error);
            // Don't reject immediately, let it retry until timeout
            setTimeout(() => checkUploadStatus(resolve, reject), pollInterval);
        }
    };

    return new Promise(checkUploadStatus);
}

function handleTimeToReadyData(data) {
    if (data.status === 'heating' && data.remainingTimeMs > 0) {
        const totalSeconds = Math.round(data.remainingTimeMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        timeToReadyStatus = data.status; // Store the status globally

        // Check if we're close to reaching the target (within 10 seconds)
        if (totalSeconds <= 15) {
            timeToReadyStatus = 'reached';
        }

        // logger.debug("time to read data",data);
        if (minutes > 5) {
            timeToReadyMessage = `Heating`;
        } else {
            timeToReadyMessage = `Heating: ${totalSeconds}s remaining`;
        }

        // Update the machine status directly when heating info is received
        isHeatingFromTimeToReady = true; // Set flag to indicate we're in a heating phase
    } else {
        timeToReadyMessage = null;
        timeToReadyStatus = data.status; // Update status to reflect current state
        isHeatingFromTimeToReady = false; // Clear flag when not heating

        // When heating is complete (reached), let handleData take over
        if (data.status === 'reached') {
            timeToReadyStatus = 'reached';
        }
    }
}

function handleData(data) {
    if (!data?.state) {
        logger.warn('Received WebSocket message with missing state:', data);
        return;
    }

    resetDataTimeout(); // Reset the timer every time data is received.

    const { state, substate } = data.state;
    const wasHeating = isHeatingState(previousState.state, previousState.substate);
    const isHeating = isHeatingState(state, substate);
    let statusString;

    // Reset heating timer if state changes FROM heating
    if (wasHeating && !isHeating) {
        heatingStartTime = null;
        heatingStartTemp = 0;
    }

    // Determine the status string based on state and substate
    if (state === MachineState.ERROR) {
        statusString = "Error";
    } else if (state === MachineState.SLEEPING) {
        // Activate screensaver when machine enters sleep state (if not disabled by user)
        if (!ui.isScreensaverActive() && localStorage.getItem('screensaverEnabled') !== 'false') {
            logger.info('Machine entered sleep state. Activating screensaver.');
            ui.activateScreensaver();
        }
        statusString = "Sleeping";
    } else {
        // Deactivate screensaver when machine wakes up from sleep (if it was active)
        if (ui.isScreensaverActive()) {
            ui.deactivateScreensaver();
        }
        if (isHeating && isHeatingFromTimeToReady) {
            // When heating and we're in a heating phase from time-to-ready,
            // rely solely on timeToReadyMessage from the time-to-ready WebSocket
            // Don't show temperature details here anymore
            statusString = timeToReadyMessage || "Heating";
        } else if (isHeating) {
            // When heating but not in a time-to-ready phase, show generic heating
            statusString = "Heating";
        } else {
            const formattedState = formatStateString(state);
            const formattedSubstate = formatStateString(substate);
            statusString = formattedState;

            // Append substate if it's meaningful and not redundant
            if (formattedSubstate && formattedSubstate.toLowerCase() !== 'idle' && formattedSubstate.toLowerCase() !== formattedState.toLowerCase()) {
                statusString += ` (${formattedSubstate})`;
            }
        }
    }

    // Detect DE1 reconnection
    if (state !== MachineState.ERROR && !isDe1Connected) {
        isDe1Connected = true;
        ui.updateMachineStatus({ status: statusString }); // Update status to reflect actual machine state
        if (state !== MachineState.SLEEPING) {
            logger.info('DE1 machine reconnected. Loading initial data.');
            loadInitialData(); // Refresh all configuration data
        }
        // Do not clear chart or reset shotStartTime as per user request
    } else if (state === MachineState.ERROR && isDe1Connected) {
        logger.warn('DE1 machine connected with error status.');
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" }); // Show disconnected when in error state
    }

    // Reload data when machine wakes from sleep
    const wasSleeping = previousState.state === MachineState.SLEEPING;
    if (wasSleeping && state !== MachineState.SLEEPING && state !== MachineState.ERROR) {
        logger.info('Machine woke from sleep. Reloading initial data.');
        loadInitialData();

        // Hold off "[Reconnect]" — REA fires devices ws scanning ~3s after wake.
        // Show "Scanning..." until grace window expires or scanning flag arrives.
        if (!isScaleConnected) {
            isInWakeGracePeriod = true;
            clearTimeout(wakeGraceTimeout);
            wakeGraceTimeout = setTimeout(() => {
                isInWakeGracePeriod = false;
                renderScaleDisconnectedText();
            }, WAKE_RECONNECT_GRACE_MS);
            renderScaleDisconnectedText();
        }
    }

    // Check if the machine is in an error state that indicates disconnection
    if (state === MachineState.ERROR) {
        logger.warn('DE1 machine in error state, likely disconnected.');
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" });
    }

    // Check for shot completion (transition from 'espresso' to 'ready' or 'idle')
    if (previousState.state === MachineState.ESPRESSO && (state === MachineState.READY || state === MachineState.IDLE)) {
        logger.info('Shot finished. Checking for upload confirmation and refreshing history.');

        (async () => {
            const finishedShot = shotData.getCurrentShot();
            const totalS = shotData.getTotalTime();

            // Detect REA-side block: very short transition + no scale + setting enabled
            const BLOCKED_SHOT_THRESHOLD_S = 3;
            if (totalS < BLOCKED_SHOT_THRESHOLD_S && !isScaleConnected) {
                try {
                    const reaSettings = await getReaSettings();
                    if (reaSettings?.blockOnNoScale) {
                        ui.showToast(getTranslation('Shot blocked: no scale connected'), 4000, 'error');
                        return;
                    }
                } catch { /* fall through to normal stop reason */ }
            }

            // Stop-reason classification — priority depends on whether scale is connected.
            // Scale present → weight is the authoritative stop signal; volume match is
            // coincidental and would mislead, so suppress it. Scale absent → volume
            // is the only mass proxy DE1 has, so it's the valid non-time stop reason.
            const finalWeight = finishedShot.finalWeight ?? finishedShot.weights?.at(-1) ?? latestScaleWeight;
            const finalVolume = finishedShot.volumes?.at(-1) ?? 0;
            // Prefer the live active profile: favorite-button switches update profileManager's
            // active record but not the local currentActiveProfile (only set on page load).
            const activeRecord = profileManager.getActiveProfileRecord();
            const activeProfile = activeRecord?.profile ?? currentActiveProfile;
            // targetYield (metadata, set via UI) overrides profile.target_weight everywhere
            // else (profileManager.js:599) — mirror that precedence or the weight stop reason
            // is missed when only the metadata yield was changed.
            const targetWeight = parseFloat(activeRecord?.metadata?.targetYield ?? activeProfile?.target_weight ?? 0);
            const targetVolume = parseFloat(activeProfile?.target_volume ?? 0);
            const profileSeconds = (activeProfile?.steps ?? [])
                .reduce((sum, s) => sum + (parseFloat(s.seconds) || 0), 0);

            const WEIGHT_HIT = targetWeight > 0 && finalWeight !== null && finalWeight >= targetWeight * 0.93;
            const VOLUME_HIT = targetVolume > 0 && finalVolume >= targetVolume * 0.93;
            const TIME_HIT = profileSeconds > 0 && totalS >= profileSeconds * 0.95;

            let stopReason;
            if (isScaleConnected && WEIGHT_HIT) {
                stopReason = getTranslation('Stopped by weight: {value}').replace('{value}', `${finalWeight.toFixed(1)}g`);
            } else if (!isScaleConnected && VOLUME_HIT) {
                stopReason = getTranslation('Stopped by volume: {value}').replace('{value}', `${Math.round(finalVolume)}ml`);
            } else if (TIME_HIT) {
                stopReason = getTranslation('Stopped by time: {value}').replace('{value}', `${totalS.toFixed(1)}s`);
            } else {
                stopReason = getTranslation('Shot stopped: {value}').replace('{value}', `${totalS.toFixed(1)}s`);
            }
            ui.showToast(stopReason, 6000, 'info');

            // Start polling for upload confirmation
            setTimeout(async () => {
                try {
                    const shotIds = await getShotIds();
                    if (shotIds && shotIds.length > 0) {
                        const latestShotId = shotIds[shotIds.length - 1];
                        pollForUploadConfirmation(latestShotId);
                    } else {
                        logger.warn('Could not get latest shot ID to confirm upload.');
                    }
                } catch (error) {
                    logger.error('Failed to initiate upload polling:', error);
                }
            }, 2000); // Delay to ensure shot is saved on server

            // Capture the current newest id NOW (before the new shot lands) so
            // the refresh knows which record is the just-finished one to wait for.
            const previousNewestId = history.getNewestShotId();
            history.refreshToNewestShot(previousNewestId);
        })();
    }
    previousState = data.state; // Update previous state

    // Update GHC stop button opacity: active (not idle/sleeping/error) = fully opaque
    const isActiveState = state !== MachineState.IDLE &&
                          state !== MachineState.SLEEPING &&
                          state !== MachineState.ERROR;
    ui.updateGhcStopButton(isActiveState);
    ui.updateSidebarOverlay(state);

    // Update UI elements
    // Pass detailed status information to match the enhanced updateMachineStatus function
    ui.updateMachineStatus({
        status: statusString,
        substate: substate,
        stepName: formatStateString(substate), // Use formatted substate as step name
        timeValue: data.elapsedTime, // Use elapsed time from data if available
        isClickable: (substate === 'preinfusion' || substate === 'pouring'), // Make preinfusion/pouring steps clickable
        isHeating: isHeating, // Pass heating state to UI
        isHeatingFromTimeToReady: isHeatingFromTimeToReady, // Pass time-to-ready heating state to UI
        steamTemperature: data.steamTemperature // Steam boiler temp — gates the steam "Heating" message
    });
    ui.updateSleepButton(state);
    ui.updateTemperatures({ mix: data.mixTemperature, group: data.groupTemperature, steam: data.steamTemperature });

    // Update Chart and Shot Data Table
    if (MachineState.ESPRESSO.includes(state)) {
        // Only start the shot clock and chart when preinfusion or pouring starts
        // This excludes the "preparingForShot" phase from the shot timing
        if (substate === 'preinfusion' || substate === 'pouring') {
            if (!shotStartTime) {
                if (shotEndedAt && (Date.now() - shotEndedAt) < SHOT_RESTART_COOLDOWN_MS) {
                    return;
                }
                shotStartTime = new Date(data.timestamp);
                chart.clearChart();
                shotData.clearShotData();
                const historyLabelEl = document.getElementById('shot-history-label');
                if (historyLabelEl) {
                    historyLabelEl.textContent = 'CURRENT';
                }
            }
            chart.updateChart(shotStartTime, data, latestScaleWeight, latestScaleWeightFlow);
            shotData.updateShotData(data, latestScaleWeight);
        }
    } else {
        if (shotStartTime) shotEndedAt = Date.now();
        shotStartTime = null;
    }
}

// Throttle function to limit the rate of execution
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

const throttledUpdateWeight = throttle(ui.updateWeight, 100); // 100ms throttle interval

function handleScaleData(data) {
    const scaleInfoContainer = document.getElementById('scale-info-container');
    const currentWeight = data.weight;
    latestScaleWeight = currentWeight;
    latestScaleWeightFlow = data.weightFlow ?? null; // server-smoothed flow for the chart's weight trace
    const batteryValue = data.batteryLevel ?? data.battery;
    if (batteryValue !== null && batteryValue !== undefined) {
        const wasNull = latestScaleBattery === null;
        latestScaleBattery = batteryValue;
        if (wasNull && document.getElementById('bluetooth-scale-devices-container')) {
            window.renderDeviceListFromCache?.();
        }
    }

    // Receiving any message means the websocket and BLE link are up.
    // The timeout in api.js will trigger a disconnect if data stops flowing.

    if (currentWeight !== null && currentWeight !== undefined) {
        // We have a weight, so we are fully connected.
        if (!isScaleConnected) {
            logger.info('Scale reconnected.');
            isScaleConnected = true;
            clearScaleAutoRetry();
            if (scaleInfoContainer) {
                scaleInfoContainer.style.display = '';
            }
        }
        // Update the UI with the new weight and reset styles.
        throttledUpdateWeight(currentWeight, {
            weightText: { remove: ['text-red-600'] },
            dataWeight: { remove: ['text-[var(--mimoja-blue)]'] }
        });
        // Carry settled weight through to the shot total card so it tracks the scale
        // after substate leaves 'pouring' (drip-down).
        shotData.setFinalWeight(currentWeight);
    } else {
        // We received a message without a weight.
        if (!isScaleConnected) {
            renderScaleDisconnectedText();
        }
        logger.warn('Scale message received without weight data.');
    }
}

async function handleWeightClick() {
    if (isScaleConnected) {
        try {
            await tareScale();
            ui.showToast('Scale tared', 2000, 'success');
        } catch (error) {
            ui.showToast('Failed to tare scale', 3000, 'error');
        }
        return;
    }

    // Untappable while a scan is already in flight (or grace window after wake)
    if (isScaleScanning || isInWakeGracePeriod) return;

    if (isConnectingScale) return;

    isConnectingScale = true;
    // Show the scanning spinner immediately (instead of a 'Connecting...' text
    // placeholder that flashed briefly and was wider/unstyled).
    renderScanIcon();

    try {
        const deviceWs = getDeviceWebSocket();
        if (!deviceWs || deviceWs.readyState !== WebSocket.OPEN) {
            initDeviceWebSocketWithCallback(
                () => {
                    sendDeviceCommand({ command: 'scan', connect: true });
                },
                handleDeviceWsData,
                () => {},
                () => {},
                handleDeviceConnectionError
            );
        } else {
            sendDeviceCommand({ command: 'scan', connect: true });
        }
        logger.info('Scale connection initiated via WebSocket, waiting for weight data...');
        let attempts = 0;
        const maxAttempts = 15;
        const poll = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(poll);
                ui.showToast('Scale Not Found', 3000, 'error');
                isConnectingScale = false;
                renderScaleDisconnectedText();
                // If scale connection failed, hide the container if it was never truly connected
                if (!isScaleConnected) {
                    const scaleInfoContainer = document.getElementById('scale-info-container');
                    if (scaleInfoContainer) {
                        scaleInfoContainer.style.display = 'none';
                    }
                }
                return;
            }

            try {
                const devices = await getDevices();
                const scale = devices.find(d => d.type === 'scale' && d.state === 'connected');

                if (scale) {
                    clearInterval(poll);
                    saveScaleDeviceId(scale.id);
                    logger.info('Scale BLE link established. Re-initializing WebSocket connection.');
                    isConnectingScale = false;
                    // Re-create the WebSocket with proper handlers to ensure a clean connection.
                    connectScaleWebSocket(
                        handleScaleData,
                        onScaleReconnect,
                        onScaleDisconnect
                    );
                }
            } catch (pollError) {
                // Ignore poll errors, let it retry
            }
        }, 1000);
    } catch (error) {
        ui.showToast('Failed to initiate scale connection', 3000, 'error');
        isConnectingScale = false;
        renderScaleDisconnectedText();
        // If initial connection failed, hide the container if it was never truly connected
        // if (!isScaleConnected) {
        //     const scaleInfoContainer = document.getElementById('scale-info-container');
        //     if (scaleInfoContainer) {
        //         scaleInfoContainer.style.display = 'none';
        //     }
        // }
    }
}

async function handleShotSettingsData(data) {
    updateShotSettingsCache(data);
    ui.updateHotWaterDisplay(data);

    // Update steam display with the data received from the WebSocket
    // Avoiding unnecessary API call to get DE1 settings on every WebSocket message
    ui.updateSteamDisplay(data);

    if (data.flushTimeout !== undefined) {
        logger.debug('Received flush timeout data:', data.flushTimeout);
        ui.updateFlushDisplay(data.flushTimeout);
    }
}

async function loadInitialData() {
    logger.debug("loadInitialData triggered.");
    try {
        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
        }

        const workflow = await getWorkflow();
        logger.debug("Workflow data received:", workflow);

        const profile = workflow?.profile;
        const context = workflow?.context;
        const doseData = workflow?.doseData; // Legacy fallback
        const grinderData = workflow?.grinderData; // Legacy fallback
        const flushtimeout = workflow?.rinseData;

        // Get the profile manager to access the favorite assignments
        const profileManagerModule = await import('./profileManager.js');
        const favoriteButtons = [];
        const FAV_COUNT = 5;

        for (let i = 0; i < FAV_COUNT; i++) {
            const button = document.getElementById(`fav-profile-btn-${i}`);
            if (button) {
                favoriteButtons.push(button);
                logger.info(`Found favorite button with ID: fav-profile-btn-${i}`); // Log found buttons
            } else {
                logger.info(`Favorite button with ID: fav-profile-btn-${i} not found`);
            }
        }
        
        if (profile) {
            ui.updateProfileName(profile.title || "Untitled Profile");
            logger.info(`Active profile: ${profile.title}`);
            currentActiveProfile = profile;

            // Set the current profile in the chart module for step change detection
            chart.setCurrentProfile(profile);
            logger.info('Profile set in chart module for step change detection');
            
            // Highlight the active profile button based on assignment rather than text matching
            // This is more reliable since it uses the internal assignment mapping
            if (profileManagerModule.favoriteAssignments && favoriteButtons.length > 0) {
                logger.debug('Using assignment mapping to highlight favorite button');
                
                // Find which button has the current profile assigned to it
                for (let i = 0; i < FAV_COUNT; i++) {
                    const assignedProfileKey = profileManagerModule.favoriteAssignments[i];
                    const button = favoriteButtons[i];
                    
                    logger.debug(`Checking favorite button ${i}: assignedProfileKey=${assignedProfileKey}, button exists=${!!button}`);
                    
                    if (button && assignedProfileKey) {
                        // Get the profile record to compare with the active profile
                        const assignedProfileRecord = profileManagerModule.availableProfiles[assignedProfileKey];
                        
                        logger.debug(`Assigned profile record for button ${i}: `, assignedProfileRecord);
                        
if (assignedProfileRecord && assignedProfileRecord.profile &&
                            assignedProfileRecord.profile.title === profile.title) {
                            // This button has the active profile assigned to it
                            // Sync activeProfileId so saveGrindToActiveProfile works after page load/refresh
                            profileManagerModule.setActiveProfile(assignedProfileKey);
                            logger.info(`Synced activeProfileId to ${assignedProfileKey} for profile "${profile.title}"`);
                            const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                            const activeTextClass = 'text-white';
                            const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                            const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                            const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                            logger.info(`Marking button at index ${i} as active for profile ${profile.title}. Adding: ${activeBgClass}, ${activeTextClass}. Removing: ${inactiveTextClass}. Current classes: ${button.className}`);
                            console.log(`[text-white APPLY] btn=${i} path=assignment-match profile="${profile.title}" assignedTitle="${assignedProfileRecord.profile.title}" alreadyHasTextWhite=${button.classList.contains('text-white')}`);
                            button.classList.add(activeBgClass, activeTextClass);
                            button.classList.remove(inactiveTextClass, defaultTextClass, defaultBgClass);
                            logger.info(`Button ${i} classes after change: ${button.className}`);
                        } else {
                            // This button doesn't have the active profile, ensure it's not highlighted
                            const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                            const activeTextClass = 'text-white';
                            const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                            const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                            const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                            logger.info(`Marking button ${i} as inactive. Removing: ${activeBgClass}, ${activeTextClass}. Adding: ${inactiveTextClass}. Current classes: ${button.className}`);
                            if (button.classList.contains('text-white')) {
                                console.log(`[text-white REMOVE] btn=${i} path=assignment-mismatch activeProfile="${profile.title}" assignedTitle="${assignedProfileRecord?.profile?.title}"`);
                            }
                            button.classList.remove(activeBgClass, activeTextClass);
                            button.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                            logger.info(`Button ${i} classes after change: ${button.className}`);
                        }
                    } else if (button) {
                        // Button exists but no profile assigned, ensure it's not highlighted
                        const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                        const activeTextClass = 'text-white';
                        const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                        const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                        const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                        logger.info(`Button ${i} has no assignment. Removing: ${activeBgClass}, ${activeTextClass}. Adding: ${inactiveTextClass}. Current classes: ${button.className}`);
                        if (button.classList.contains('text-white')) {
                            console.log(`[text-white REMOVE] btn=${i} path=no-assignment activeProfile="${profile.title}"`);
                        }
                        button.classList.remove(activeBgClass, activeTextClass);
                        button.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                        logger.info(`Button ${i} classes after change: ${button.className}`);
                    }
                }
            } else {
                logger.debug('Assignment mapping not available, using text matching fallback');
                
                // Fallback to the original text matching approach if the assignment mapping isn't available
                favoriteButtons.forEach((btn, index) => {
                    const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                    const activeTextClass = 'text-white';
                    const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                    const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                    const defaultBgClass = 'bg-[var(--profile-button-background-color)]';
                    const buttonText = btn.textContent.trim();
                    const profileTitle = profile.title;

                    logger.debug(`Checking button ${index} with text: \"${buttonText}\" against profile: \"${profileTitle}\"`);

                    if (buttonText === profileTitle) {
                        logger.info(`[FALLBACK] Marking button ${index} as active for profile ${profileTitle}. Adding: bg-[var(--mimoja-blue-v2)], text-white. Current classes: ${btn.className}`);
                        console.log(`[text-white APPLY] btn=${index} path=fallback-text-match buttonText="${buttonText}" profile="${profileTitle}" alreadyHasTextWhite=${btn.classList.contains('text-white')}`);
                        btn.classList.add(activeBgClass, activeTextClass);
                        btn.classList.remove(inactiveTextClass, defaultTextClass, defaultBgClass);
                        logger.info(`[FALLBACK] Button ${index} classes after change: ${btn.className}`);
                    } else {
                        logger.info(`[FALLBACK] Marking button ${index} as inactive. Removing: bg-[var(--mimoja-blue-v2)], text-white. Adding: text-[var(--mimoja-blue)]. Current classes: ${btn.className}`);
                        if (btn.classList.contains('text-white')) {
                            console.log(`[text-white REMOVE] btn=${index} path=fallback-text-mismatch buttonText="${buttonText}" activeProfile="${profileTitle}"`);
                        }
                        btn.classList.remove(activeBgClass, activeTextClass);
                        btn.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                        logger.info(`[FALLBACK] Button ${index} classes after change: ${btn.className}`);
                    }
                });
            }
            
            if (profile.steps && profile.steps.length > 0) {
                ui.updateTemperatureDisplay(profile.steps[0].temperature || 0);
            }
        }

        if (flushtimeout !== undefined) {
            logger.debug('Received flush timeout data:', flushtimeout);
            ui.updateFlushDisplay(flushtimeout.duration);

        }

        // Update grind display - prefer context.grinderSetting over legacy grinderData.setting
        if (context?.grinderSetting) {
            ui.updateGrindDisplay({ grinderSetting: context.grinderSetting });
        } else if (grinderData?.setting) {
            ui.updateGrindDisplay(grinderData);
        } else {
            const grindEl = document.getElementById('grind-value');
            if (grindEl) grindEl.textContent = '0';
        }
        logger.debug("Dose data received:", context || doseData);
        
        const doseInValue = context?.targetDoseWeight ?? doseData?.doseIn;
        const doseOutValue = context?.targetYield ?? doseData?.doseOut;
        
        if (doseInValue !== undefined) ui.updateDoseInDisplay(doseInValue);
        if (doseOutValue !== undefined) ui.updateDrinkOut(doseOutValue);
        ui.updateDrinkRatio();

        const hotwatersettings = workflow?.hotWaterData;
        const steamsettings = workflow?.steamSettings;
        if (hotwatersettings) ui.updateHotWaterDisplay(hotwatersettings);
        if (steamsettings) ui.updateSteamDisplay(steamsettings);

        // Show GHC machine controls column only for non-GHC machines, and pick steam-flow
        // presets based on machine model (group-head size).
        try {
            const machineInfo = await getMachineInfo();
            if (machineInfo && machineInfo.GHC === false) {
                isNonGhcMachine = true;
                ui.showGhcControls();
            }
            await ui.setSteamFlowPresetsFromMachineModel(machineInfo?.model);
        } catch (e) {
            logger.warn('Could not fetch machine info for GHC check / steam preset init:', e);
            // Fall back to standard presets so the UI still works offline
            await ui.setSteamFlowPresetsFromMachineModel(null);
        }

    } catch (error) {
        logger.error("Failed to load initial data:", error);
        ui.updateProfileName("Error loading profile");
    }
}

async function isShotBlockedByNoScale() {
    if (isScaleConnected) return false;
    try {
        const reaSettings = await getReaSettings();
        if (!reaSettings?.blockOnNoScale) return false;
    } catch {
        return false;
    }
    ui.showToast('No scale connected — shot blocked', 4000, 'error');
    return true;
}

// Delegated listener on document — survives all DOM replacements, no re-wiring needed
const GHC_STATE_MAP = {
    'ghc-coffee-btn': MachineState.ESPRESSO,
    'ghc-water-btn': MachineState.HOT_WATER,
    'ghc-steam-btn': MachineState.STEAM,
    'ghc-flush-btn': MachineState.FLUSH,
    'ghc-stop-btn': MachineState.IDLE,
};
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[id^="ghc-"]');
    if (!btn || !GHC_STATE_MAP[btn.id]) return;
    const targetState = GHC_STATE_MAP[btn.id];
    if (targetState === MachineState.ESPRESSO && await isShotBlockedByNoScale()) return;
    try {
        await setMachineState(targetState);
    } catch (err) {
        logger.error(`GHC state change failed (${btn.id}):`, err);
    }
});

export function initGhcButtonHandlers() {} // no-op — delegation handles it

// Keyboard shortcuts — only fire when DE1 connected and no input/textarea focused
const DEFAULT_KEY_BINDINGS = {
    'w': MachineState.HOT_WATER,
    'f': MachineState.FLUSH,
    ' ': MachineState.IDLE,
    's': MachineState.STEAM,
    'e': MachineState.ESPRESSO,
    'p': MachineState.SLEEPING,
};

function getKeyboardStateMap() {
    try {
        const saved = JSON.parse(localStorage.getItem('keyboardBindings') || '{}');
        const map = { ...DEFAULT_KEY_BINDINGS };
        for (const [stateValue, newKey] of Object.entries(saved)) {
            // remove old key bound to this state
            for (const [k, v] of Object.entries(map)) {
                if (v === stateValue) { delete map[k]; break; }
            }
            map[newKey] = stateValue;
        }
        return map;
    } catch { return { ...DEFAULT_KEY_BINDINGS }; }
}

document.addEventListener('keydown', async (e) => {
    if (!isDe1Connected || !isNonGhcMachine) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const state = getKeyboardStateMap()[e.key];
    if (!state) return;
    e.preventDefault();
    if (state === MachineState.ESPRESSO && await isShotBlockedByNoScale()) return;
    try {
        await setMachineState(state);
    } catch (err) {
        logger.error(`Keyboard shortcut state change failed (${e.key}):`, err);
    }
});

async function initializeDe1Connection() {
    try {
        logger.info('Attempting to find DE1 device...');
        
        // Try fast method first
        let devices = await getDevices();
        let de1Machine = devices.find(d => d.type === 'machine' && d.state === 'connected');
        
        // If not found, try the slower, more reliable scan
        if (!de1Machine) {
            logger.warn('DE1 not found with fast method. Trying fallback scan...');
            devices = await scanForDevices();
            de1Machine = devices.find(d => d.type === 'machine' && d.state === 'connected');
        }
        
        if (de1Machine) {
            de1DeviceId = de1Machine.id;
            logger.info(`DE1 machine ID found and stored: ${de1DeviceId}`);
            
            // Update connection status based on actual device state
            if (de1Machine.state === 'connected') {
                logger.info('DE1 machine is connected.');
                isDe1Connected = true;
                // Don't update status here - let handleData manage it based on actual machine state
            } else {
                logger.warn('DE1 machine is found but not connected.');
                isDe1Connected = false;
                ui.updateMachineStatus({ status: "disconnected" });
            }
        } else {
            logger.error('DE1 machine not found or not connected even after fallback scan.');
            isDe1Connected = false;
            ui.updateMachineStatus({ status: "disconnected" });
        }
    } catch (error) {
        logger.error('Failed to initialize DE1 device ID:', error);
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "disconnected" });
    }
}

async function initVisualizer() {
    // Check if visualizer is enabled before initializing
    const isVisualizerEnabled = localStorage.getItem('visualizerEnabled') === 'true';
    
    if (!isVisualizerEnabled) {
        logger.info('Visualizer is disabled. Skipping initialization.');
        return;
    }
    
    logger.info('Initializing Visualizer connection...');
    const username = localStorage.getItem('visualizerUsername');
    const encodedPassword = localStorage.getItem('visualizerPassword');

    if (username && encodedPassword) {
        try {
            const password = atob(encodedPassword); // Decode password
            const isValid = await verifyVisualizerCredentials(username, password);
            if (isValid) {
                logger.info('Saved Visualizer credentials are valid.');

            } else {
                logger.warn('Saved Visualizer credentials failed to validate. Please check your settings.');
                // Clearing the invalid credentials
                localStorage.removeItem('visualizerUsername');
                localStorage.removeItem('visualizerPassword');
            }
        } catch (e) {
            logger.error('Failed to decode or verify saved credentials', e);
            // Clear potentially corrupted credentials
            localStorage.removeItem('visualizerUsername');
            localStorage.removeItem('visualizerPassword');
        }
    } else {
        logger.info('No saved Visualizer credentials found.');
    }
}

let mainPageInitialized = false;
let mainPageInitPromise = null;
async function initMainPageOnce() {
    if (mainPageInitialized) return;
    if (mainPageInitPromise) return mainPageInitPromise;
    mainPageInitPromise = (async () => {
        logger.info('initMainPageOnce: starting.');
        await history.initHistory();
        await profileManager.init();
        window.app.saveGrindToActiveProfile = (val) => profileManager.saveGrindToActiveProfile(val);
        window.app.saveContextToActiveProfile = (fields) => profileManager.saveContextToActiveProfile(fields);
        window.app.getActiveProfileRecord = () => profileManager.getActiveProfileRecord();
        await loadInitialData();
        await initializeDe1Connection();
        await initVisualizer();
        connectWebSocket(handleData, () => {
            logger.info('WebSocket reconnected. Resetting DE1 connection status.');
            isDe1Connected = false;
        });
        connectScaleWebSocket(handleScaleData, onScaleReconnect, onScaleDisconnect);
        connectDeviceWebSocket(handleDeviceWsData, () => {}, () => {}, handleDeviceConnectionError);
        initWaterTankSocket();
        initClockTicker();
        connectTimeToReadyWebSocket(handleTimeToReadyData);
        connectDisplayWebSocket((data) => logger.debug('Display state updated:', data));
        ensureGatewayModeTracking();
        resetDataTimeout();
        connectShotSettingsWebSocket(handleShotSettingsData);
        getDe1AdvancedSettings();
        getDe1Settings();
        mainPageInitialized = true;
        logger.info('initMainPageOnce: finished.');
    })().catch(err => {
        mainPageInitPromise = null; // allow retry on next showMainPage
        logger.error('initMainPageOnce failed:', err);
        throw err;
    });
    return mainPageInitPromise;
}
window.app.initMainPageOnce = initMainPageOnce;
// True while a shot is being recorded — lets the router skip repainting history
// over a live chart when returning to the main page.
window.app.isShotActive = () => shotStartTime !== null;

async function prefetchSettingsToIDB() {
    try {
        await openDB();
        const [reaResult, de1Result, de1AdvResult, appInfoResult, workflowResult] = await Promise.allSettled([
            getReaSettings(),
            getDe1Settings(),
            getDe1AdvancedSettings(),
            getAppInfo(),
            getWorkflow()
        ]);
        const pairs = [
            ['settings-rea',         reaResult],
            ['settings-de1',         de1Result],
            ['settings-de1Advanced', de1AdvResult],
            ['settings-appInfo',     appInfoResult],
            ['settings-workflow',    workflowResult],
        ];
        for (const [key, result] of pairs) {
            if (result.status === 'fulfilled' && result.value) {
                try { await setSetting(key, result.value); } catch(e) { /* non-fatal */ }
            }
        }
        logger.debug('Settings pre-fetched and cached in IDB.');
    } catch(e) {
        logger.debug('Settings prefetch skipped:', e.message);
    }
}

// --- External-link debugging ---------------------------------------------
// The webview host opens the system browser ONLY when a top-level navigation
// reaches its shouldOverrideUrlLoading hook (reaprime gh#384): it sees an
// external http(s) URL, launches Chrome, and cancels the in-webview load so the
// skin stays put. target="_blank" never gets there — it routes to the unhandled
// onCreateWindow and dies. So intercept any external (cross-origin) link tap and
// drive a real same-frame navigation; the user gesture is preserved so the
// host's launchUrl works. Internal/same-origin and hash/JS links are left alone.
//
// Heavily logged with the [ext-link] tag so the on-device webview_console.log
// documents the whole flow: env at boot, every anchor tap, the classify
// decision, and the navigation attempt (incl. any thrown error).
const EXT = '[ext-link]';

// Boot banner — confirms this build is live on the device and whether we're in
// the host webview (host injects window.__DECENT_HOST__).
try {
    console.log(EXT, 'init', JSON.stringify({
        origin: location.origin,
        href: location.href,
        isWebview: !!window.__DECENT_HOST__,
        host: window.__DECENT_HOST__ || null,
        ua: navigator.userAgent,
    }));
} catch (err) {
    console.log(EXT, 'init log failed:', err && err.message);
}

// Log raw taps too, so we can see whether the gesture reaches document at all
// (rules out touch/SPA handlers swallowing the click before it bubbles here).
document.addEventListener('pointerup', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a) console.log(EXT, 'pointerup over a[href]:', a.getAttribute('href'));
}, true); // capture phase — fires even if a later handler stops propagation

document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const rawHref = link.getAttribute('href'); // as authored in the DOM
    const href = link.href;                    // resolved absolute URL
    console.log(EXT, 'click on a[href]', JSON.stringify({
        rawHref, href, target: link.target || '(none)',
        defaultPrevented: e.defaultPrevented,
    }));

    if (e.defaultPrevented) { console.log(EXT, 'skip: default already prevented upstream'); return; }
    if (!/^https?:\/\//i.test(href)) { console.log(EXT, 'skip: not http(s):', href); return; }
    if (href.startsWith(location.origin + '/') || href === location.origin) {
        console.log(EXT, 'skip: internal (same-origin):', href);
        return;
    }

    console.log(EXT, 'external -> driving top-level navigation:', href);
    e.preventDefault();
    try {
        window.location.assign(href); // host's shouldOverrideUrlLoading -> launchUrl -> OS browser
        console.log(EXT, 'location.assign called (no throw). If no browser opened, the host/device handled it — likely no browser app or launchUrl failed.');
    } catch (err) {
        console.log(EXT, 'location.assign threw:', err && err.message);
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    try {
        setDebug(true);
        logger.info('App DOMContentLoaded: Starting initialization.');

        chart.initChart();
        logger.info('App DOMContentLoaded: Chart initialized.');

        await initI18n();
        ui.initUI({ onWeightClick: handleWeightClick });
        ui.initScreensaver(); // Initialize screensaver functionality
        initScaling();
        initNumpadModal();
        initMobileValueInputs();
        logger.info('App DOMContentLoaded: UI initialized.');

        // Check URL and load appropriate page if navigating directly to a route
        await initRouter();
        logger.info('App DOMContentLoaded: Router initialized.');

        // Run main-page init unless we booted on a sub-page; sub-page returns will
        // trigger it lazily via window.app.initMainPageOnce() from the router.
        if (!isSubPage()) {
            await initMainPageOnce();
        }

        // Pre-warm settings cache so the settings page opens without redirecting on slow Rea responses
        prefetchSettingsToIDB();

        logger.info('App initialization finished successfully.');

        // Check if user is on desktop (Windows or macOS) to determine if we should show fullscreen prompt
        const isDesktop = navigator.userAgent.includes('Win') || navigator.userAgent.includes('Mac');
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                      (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
        const isStandalone = window.navigator.standalone === true;

        // Detect in-app webview: no Chrome/Safari/Firefox branding despite being on mobile,
        // or explicit webview signals (wv flag on Android, no window.safari on iOS)
        const ua = navigator.userAgent;
        const isAndroidWebView = /Android/.test(ua) && /wv/.test(ua);
        const isIOSWebView = isIOS && !isStandalone && !/Safari\//.test(ua);
        const isDecentWebView = ua.includes('Decent');
        const isWebView = isAndroidWebView || isIOSWebView || isDecentWebView;

        if (isWebView) {
            const fsBtn = document.getElementById('fullscreen-toggle-btn');
            if (fsBtn) fsBtn.style.display = 'none';
        }

        // Function to determine if we're in fullscreen mode
        // This accounts for both browser fullscreen API and web view fullscreen scenarios
        function isFullscreenMode() {
            // Check if using browser's native fullscreen API
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                return true;
            }

            // Check if viewport dimensions match screen dimensions (indicating fullscreen)
            // This is especially relevant for web views that start in fullscreen
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const screenWidth = screen.width;
            const screenHeight = screen.height;

            // Account for potential UI elements like mobile browsers' address bars
            // If viewport is very close to screen size, consider it fullscreen
            const widthRatio = viewportWidth / screenWidth;
            const heightRatio = viewportHeight / screenHeight;

            // If both dimensions are at least 95% of screen size, consider it fullscreen
            return widthRatio >= 0.95 && heightRatio >= 0.95;
        }

        // Helper function to check if rotation prompt should be shown (mobile + portrait)
        function shouldShowRotationPrompt() {
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            const isPortrait = window.innerHeight > window.innerWidth;
            return isMobile && isPortrait && !sessionStorage.getItem('rotationPromptDismissed');
        }

        // Prompt user to enter fullscreen only if not on desktop, not already in fullscreen,
        // and rotation prompt is not being shown (rotation takes priority on mobile)
        const isRotationPromptActive = shouldShowRotationPrompt();
        
        if (!isDesktop && !isWebView && !isFullscreenMode() && !sessionStorage.getItem('fullscreenPromptDismissed') && !isRotationPromptActive) {
            const toastContainer = document.getElementById('fullscreen-toast-container');
            if (toastContainer) {
                if (isIOS && !isStandalone) {
                    // iOS doesn't support the Fullscreen API — show "Add to Home Screen" tip instead
                    const alertBox = toastContainer.querySelector('.alert');
                    const heading = alertBox?.querySelector('h3');
                    const messageDiv = alertBox?.querySelector('.text-\\[9px\\]');
                    const buttonContainer = alertBox?.querySelector('.flex.gap-2');

                    if (heading) heading.textContent = 'Add to Home Screen';
                    if (messageDiv) messageDiv.textContent = 'Tap the Share button (⬆) in Safari, then "Add to Home Screen" for a fullscreen experience.';
                    if (buttonContainer) {
                        buttonContainer.innerHTML = `
                            <button id="toast-ios-got-it-btn" class="btn btn-primary btn-sm text-white">Got it</button>
                            <button id="toast-ios-later-btn" class="btn btn-ghost btn-sm">Later</button>
                        `;
                        setTimeout(() => {
                            document.getElementById('toast-ios-got-it-btn')?.addEventListener('click', () => {
                                toastContainer.style.display = 'none';
                                sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                            });
                            document.getElementById('toast-ios-later-btn')?.addEventListener('click', () => {
                                toastContainer.style.display = 'none';
                                sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                            });
                        }, 0);
                    }

                    toastContainer.style.display = 'grid';
                } else if (!isIOS) {
                    toastContainer.style.display = 'grid';

                    document.getElementById('toast-fullscreen-btn').onclick = () => {
                        document.getElementById('fullscreen-toggle-btn').click();
                        toastContainer.style.display = 'none';
                        sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                    };

                    document.getElementById('toast-close-btn').onclick = () => {
                        toastContainer.style.display = 'none';
                        sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                    };
                }
            }
        }

        // Add event listener to close the toast when fullscreen mode is entered
        // This handles the case where the user clicks the fullscreen toggle directly
        document.addEventListener('fullscreenchange', () => {
            const toastContainer = document.getElementById('fullscreen-toast-container');
            if (toastContainer && isFullscreenMode()) {
                // If we're now in fullscreen mode, hide the toast
                toastContainer.style.display = 'none';
            }
        });

        // Also handle the WebKit-specific event for Safari
        document.addEventListener('webkitfullscreenchange', () => {
            const toastContainer = document.getElementById('fullscreen-toast-container');
            if (toastContainer && isFullscreenMode()) {
                // If we're now in fullscreen mode, hide the toast
                toastContainer.style.display = 'none';
            }
        });

        const profileNameEl = document.getElementById('profile-name');
        if (profileNameEl) {
            profileNameEl.style.cursor = 'pointer';
            ui.setupPressAndHold(
                profileNameEl,
                () => loadPage('src/profiles/profile_selector.html'),
                (el) => {
                    const activeRecord = profileManager.getActiveProfileRecord()
                        ?? Object.values(profileManager.availableProfiles).find(r => {
                            const t = profileManager.translateProfileTitle(r.profile?.title ?? '');
                            return t === el.textContent.trim();
                        }) ?? null;
                    const profileTitle = activeRecord
                        ? profileManager.translateProfileTitle(activeRecord.profile.title)
                        : null;
                    const items = [
                        {
                            label: getTranslation('Browse Profiles'),
                            onSelect: () => loadPage('src/profiles/profile_selector.html'),
                        },
                        {
                            label: profileTitle ? `${getTranslation('Edit')} "${profileTitle}"` : getTranslation('Edit Profile'),
                            disabled: !activeRecord,
                            onSelect: () => {
                                window.__pendingEditProfile = activeRecord;
                                loadPage('src/profiles/profile_editor.html');
                            },
                        },
                        {
                            label: getTranslation('Use Profile Defaults'),
                            disabled: !activeRecord,
                            onSelect: async () => {
                                const ok = await profileManager.resetActiveProfileToDefaults();
                                ui.showToast(
                                    ok ? 'Reset to profile defaults' : 'Could not reset profile',
                                    3000,
                                    ok ? 'success' : 'error'
                                );
                            },
                        },
                    ];
                    openContextMenu(el, items);
                }
            );
        }

        // Add event listener for the settings button
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                loadPage('src/settings/settings.html');
            });
        }
    } catch (error) {
        logger.error('CRITICAL: Unhandled error during application initialization:', error);
        // Optionally, display a user-friendly error message on the page
        const body = document.querySelector('body');
        if (body) {
            body.innerHTML = `<div style="color: red; padding: 2rem;">
                <h1>Application Error</h1>
                <p>A critical error occurred during startup. Please check the console for details and try refreshing the page.</p>
            </div>`;
        }
    }
});
