import { connectWebSocket, getWorkflow, connectScaleWebSocket, ensureGatewayModeTracking, reconnectingWebSocket, getDevices, reconnectDevice, scanForDevices,connectShotSettingsWebSocket, getDe1AdvancedSettings, updateShotSettingsCache, getDe1Settings, MachineState, getShotIds, getShots, getValueFromStore, verifyVisualizerCredentials, connectScaleDevice, tareScale, connectTimeToReadyWebSocket, connectShotStateWebSocket, sendDeviceCommand, saveScaleDeviceId, getScaleDeviceId, getDeviceWebSocket, initDeviceWebSocketWithCallback, connectDeviceWebSocket, connectDisplayWebSocket, restoreBrightnessFromStorage, getMachineInfo, getMachineState, setMachineState, getReaSettings, getAppInfo } from './api.js';
import { initScaling } from './scaling.js';
import * as chart from './chart.js';
import * as ui from './ui.js';
import { initI18n, getTranslation, fitTelemetry, fitTextToWidth } from './i18n.js';
import { initUnits, formatTemp, fromDisplayTemp } from './units.js';
import * as history from './history.js';
import * as shotData from './shotData.js';
import * as profileManager from './profileManager.js';
import * as api from './api.js';
import { loadPage, initRouter, isSubPage } from './router.js';
import { initWaterTankSocket, isTankBelowRefillLevel } from './waterTank.js';
import { logger, setDebug } from './logger.js';
import { deriveScreensaverAction, isMachineAsleep } from './screensaver-policy.js';
import { createMachineLinkWatcher, machineFromDevicesPayload } from './machine-link.js';
import { setMachineModel, isBengleMachine } from './machine.js';
import { resolveMilkProbePresence } from './steam-mode.js';
import { isCupWarmerOn, readCupWarmerTarget, resolvePrewarm, getCupWarmerState, setCupWarmerState, patchCupWarmerState, invalidateCupWarmerState, onCupWarmerStateChange, CUP_WARMER_TARGET_KEY } from './cup-warmer.js';
import { initNumpadModal, attachToNumericInputs, openModal, shouldUseNumpad } from './numpad-modal.js';
import { initTimePicker } from './time-picker-modal.js';
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
                        // temperature / hot-water-temp: newVal is in the active display
                        // unit (the numpad was seeded from el.textContent) — convert to
                        // Celsius before writing/displaying so the writer always gets Celsius.
                        const tempC = fromDisplayTemp(parseFloat(newVal));
                        el.textContent = type === 'temperature' ? formatTemp(tempC, 0) :
                                        type === 'grind' ? newVal :
                                        type === 'steam-duration' ? `${newVal}s` :
                                        type === 'steam-flow' ? newVal :
                                        type === 'flush' ? `${newVal}s` :
                                        type === 'hot-water-vol' ? `${newVal}ml` :
                                        type === 'hot-water-temp' ? formatTemp(tempC, 0) :
                                        `${newVal}g`;

                        if (type === 'dose-in') {
                            window.app.ui.updateDoseValue('in', newVal);
                            window.app.ui.updateDrinkRatio();
                        } else if (type === 'drink-out') {
                            window.app.ui.updateDoseValue('out', newVal);
                            window.app.ui.updateDrinkRatio();
                        } else if (type === 'temperature') {
                            window.app.ui.updateTemperatureValue(tempC);
                        } else if (type === 'steam-duration') {
                            // The numpad blanks a bare "0" to '' — treat empty/NaN as 0.
                            // 0 = steam heater off: the middleware gates steamEnabled on
                            // duration > 0, so sending 0 sets targetSteamTemp 0 and the
                            // firmware disables the steam heater (temporary, reversible).
                            const v = (newVal === '' || isNaN(parseFloat(newVal))) ? 0 : parseFloat(newVal);
                            window.app.ui.updateSteamDisplay({ targetSteamDuration: v });
                            window.app.api.setTargetSteamDuration(v).catch(e => logger.error('setTargetSteamDuration failed:', e));
                        } else if (type === 'steam-flow') {
                            // Numpad blanks a bare "0" to ''. Unlike duration, 0 steam
                            // flow has no meaning (steam is gated on duration, not flow),
                            // so floor empty/0/NaN to the 0.4 minimum the inline editor
                            // enforces — avoids NaN on screen.
                            const parsed = parseFloat(newVal);
                            const v = (newVal === '' || isNaN(parsed) || parsed < 0.4) ? 0.4 : parsed;
                            window.app.ui.updateSteamDisplay({ targetSteamFlow: v });
                            window.app.api.setTargetSteamFlow(v).catch(e => logger.error('setTargetSteamFlow failed:', e));
                        } else if (type === 'flush') {
                            window.app.ui.updateFlushValue(parseFloat(newVal));
                            window.app.ui.updateFlushDisplay(parseFloat(newVal));
                        } else if (type === 'hot-water-vol') {
                            // The numpad blanks a bare "0" to '' — treat empty/NaN as 0.
                            // 0 = no volume cap: hot water then stops by time/manual, not
                            // volume. Sending 0 (not null) avoids the middleware 500.
                            const v = (newVal === '' || isNaN(parseFloat(newVal))) ? 0 : parseFloat(newVal);
                            window.app.ui.updateHotWaterDisplay({ targetHotWaterVolume: v });
                            window.app.api.setTargetHotWaterVolume(v).catch(e => logger.error('setTargetHotWaterVolume failed:', e));
                        } else if (type === 'hot-water-temp') {
                            window.app.ui.updateHotWaterDisplay({ targetHotWaterTemp: tempC });
                            window.app.api.setTargetHotWaterTemp(tempC).catch(e => logger.error('setTargetHotWaterTemp failed:', e));
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
window.getIsScaleConnected = () => isScaleConnected;
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
    // Retry text / spinner change the row's width — re-fit so it stays one line.
    fitTelemetry();
}

// ---------------------------------------------------------------------------
// Machine link: surviving the machine's power-cycle
//
// reaprime binds /ws/v1/machine/snapshot (and shotSettings, and waterLevels) to a
// De1 *instance*. On a power-cycle it builds a NEW machine object and neither
// re-binds those sockets nor CLOSES them — so they go open-but-silent, forever.
// ReconnectingWebSocket only retries on *close*, so it never notices, and the 5 s
// data timeout below used to latch isDe1Connected = false with nothing left alive
// to ever set it true again: "disconnected" until the app was reloaded.
//
// The /ws/v1/devices socket is bound to reaprime's DevicesStateAggregator, not to
// a machine instance, so it SURVIVES the power-cycle and keeps telling us the
// truth. We were already holding it open and reading only `scanning` from it.
// It is now the authority on link state, and a link-up re-opens the machine-bound
// sockets so the server re-binds them to the live machine.
//
// Belt and braces: this must be correct whether or not reaprime's server-side
// re-bind fix is present. Both fixes are safe together — the worst case is that
// the server closes the socket first and ReconnectingWebSocket heals it before we
// get here.
// ---------------------------------------------------------------------------

// Re-open every socket reaprime binds to a De1 instance, forcing it to re-run
// `_withDe1Ws` against the CURRENT machine. Proven on the bench: a fresh snapshot
// socket streams 97 frames in 6 s while the pre-existing one sits silent.
//
// All three factories close-before-open, so this does not leak a socket per
// power-cycle (the tell would be a doubled snapshot frame rate).
function resyncMachineSockets(reason) {
    logger.info(`Re-binding machine WebSockets to the live machine (${reason}).`);
    connectWebSocket(handleData, onMachineSnapshotSocketOpen);
    connectShotSettingsWebSocket(handleShotSettingsData);
    initWaterTankSocket();
    resetDataTimeout(); // fresh socket: give it the full window before judging it
}

const machineLink = createMachineLinkWatcher({
    onLinkUp: (deviceId) => {
        logger.info(`Machine link up (${deviceId}). Snapshot socket may be bound to a dead machine — resyncing.`);
        if (deviceId) de1DeviceId = deviceId;
        // Also un-sticks the Bluetooth-banner suppression in
        // handleDeviceConnectionError, which is gated on this same flag.
        isDe1Connected = true;
        resyncMachineSockets('machine link up');
        // The machine may come back ASLEEP, in which case handleData's reconnect
        // branch deliberately skips the reload — so do it here.
        loadInitialData();
    },
    onLinkDown: () => {
        logger.warn('Machine link down (devices feed).');
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" });
    },
});

function handleDeviceWsData(data) {
    const next = !!data?.scanning;
    if (next !== isScaleScanning) {
        isScaleScanning = next;
        renderScaleDisconnectedText();
    }
    // Edge-triggered, NOT id-diffed: the USB device id is byte-identical across a
    // power-cycle (it comes from the SAMD21 factory unique id), so watching for an
    // id change would silently never fire.
    //
    // This watcher supersedes the earlier ad-hoc rising-edge REST sync that lived
    // here (the DE1 late-connect fix): a late connect is a not-connected ->
    // connected edge, so onLinkUp resyncs the machine sockets and reloads data
    // for that case too.
    machineLink.update(data);
}

function onScaleReconnect() {
    logger.info('Scale WebSocket reconnected.');
}

function onScaleDisconnect() {
    logger.warn('Scale has disconnected.');
    isScaleConnected = false;
    window.onScaleConnectionChange?.(false);
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
    // Adapter-level nags (Bluetooth off / permission missing) are meaningless
    // while a machine is already connected -- connected over USB serial with BT
    // off is a fully valid state, so don't tell the user to turn BT on. If the
    // machine is NOT connected the banner still shows, since BT may genuinely be
    // the missing piece.
    if ((err.kind === 'adapterOff' || err.kind === 'bluetoothPermissionDenied') && isDe1Connected) return;
    const msg = deviceErrorCopy[err.kind] ?? `${err.message}${err.suggestion ? `\n${err.suggestion}` : ''}`;
    ui.showToast(msg, 5000, 'error');
}

// The snapshot socket's onopen fires on every (re)connect — boot, a
// ReconnectingWebSocket auto-retry, and our own resync. Boot and resync share this
// handler so the two call sites cannot drift apart.
function onMachineSnapshotSocketOpen() {
    logger.info('Machine snapshot WebSocket (re)opened. Awaiting a frame to confirm the machine.');
    isDe1Connected = false; // the first frame re-confirms it (handleData)
}

// A silent snapshot socket is NOT proof of a disconnected machine — it is exactly
// what a stale, open-but-silent socket looks like after a power-cycle . Ask
// REA who is actually connected before painting a lie. Rate-limited so a genuinely
// absent machine is not hammered.
const DEVICES_PROBE_MIN_INTERVAL_MS = 10000;
let lastDevicesProbeAt = 0;
let devicesProbeInFlight = false;

function markMachineDisconnected() {
    ui.updateMachineStatus({ status: "disconnected" });
    isDe1Connected = false;
}

async function probeMachineOnSilentSocket() {
    const now = Date.now();
    if (devicesProbeInFlight || (now - lastDevicesProbeAt) < DEVICES_PROBE_MIN_INTERVAL_MS) {
        markMachineDisconnected(); // rate-limited: fall back to believing the silence
        return;
    }
    devicesProbeInFlight = true;
    lastDevicesProbeAt = now;
    try {
        const link = machineFromDevicesPayload(await getDevices());
        if (link.known && link.connected) {
            logger.warn('Snapshot socket silent for 5 s but REA reports the machine connected — stale socket. Resyncing.');
            if (link.deviceId) de1DeviceId = link.deviceId;
            isDe1Connected = true;
            resyncMachineSockets('stale snapshot socket');
            return;
        }
    } catch (err) {
        logger.warn('Devices probe failed while checking a silent machine socket:', err);
    } finally {
        devicesProbeInFlight = false;
    }
    markMachineDisconnected();
}

// Sets a timer. If no data is received within 5 seconds, the connection is stale —
// but "stale" may mean a dead socket rather than a dead machine, so check first.
function resetDataTimeout() {
    clearTimeout(dataTimeout);
    dataTimeout = setTimeout(() => {
        logger.warn('No WebSocket data received for 5 seconds. Checking whether the machine or the socket is gone.');
        probeMachineOnSilentSocket();
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

// The screensaver is a pure function of the machine's CONFIRMED state.
//
// The derived action is paint-only -- 'show' | 'hide' | 'none' -- so a snapshot
// frame is structurally incapable of commanding the machine. That is the whole
// bug: 'hide' used to be spelled ui.deactivateScreensaver(), which sent
// setMachineState('idle'), so this branch -- whose precondition is "the machine is
// awake" -- WOKE the machine. In the 46 ms after a sleep press, with the overlay
// optimistically up and the snapshot still reporting 'idle', that is the command
// that cancelled the user's sleep.
//
// The one concession to latency runs the OTHER way. When the user taps to wake, we
// hide the overlay immediately instead of making them watch it for a round-trip —
// so for the next frame or three the machine still (honestly) reports 'sleeping'
// and this function would raise the overlay straight back up. `wakePending` marks
// those frames as stale by our own doing. It is time-bounded, so a wake that never
// lands expires and the overlay returns: we decline to repaint a state we have
// asked the machine to leave, we never paint one it never reported.
function applyScreensaverAction(state) {
    const action = deriveScreensaverAction({
        machineState: state,
        screensaverActive: ui.isScreensaverActive(),
        // Either mode raises the overlay: the image saver, or the black cover.
        // They are mutually exclusive in settings, but both need the overlay up --
        // the black one because tapping it is what wakes the machine.
        screensaverEnabled: localStorage.getItem('screensaverEnabled') !== 'false'
            || localStorage.getItem('blackScreenSaver') === 'true',
        wakePending: ui.isWakeRequestPending(),
    });
    if (action === 'show') {
        logger.info('Machine confirmed sleeping. Activating screensaver.');
        ui.activateScreensaver();
    } else if (action === 'hide') {
        ui.hideScreensaver(); // PURE UI -- never a machine command
    }

    // The machine has confirmed it is awake: the wake we were waiting on has
    // landed, so stop suppressing. (A wake superseded by a sleep press is cleared
    // by the sleep button itself.)
    if (!isMachineAsleep(state)) ui.clearWakeRequest();
}

// ── Milk probe (Bengle) ──────────────────────────────────────────────────────
// Fed one snapshot milkTemperature per frame (contract: 0/absent = no probe or
// no reading). Presence survives brief 0-glitches and drops only after a
// sustained absence (resolveMilkProbePresence, steam-mode.js). The main-screen
// steam tile consumes this through ui.setMilkProbePresent (Milk-mode gating +
// probe-loss un-arm); the settings steam page through window.app.getMilkProbe
// (render-time state) and window.onMilkProbeUpdate (live ticks + presence flips).
let milkProbeState = { present: false, lastPositiveMs: null };
let latestMilkTemp = 0; // last positive reading while present; 0 when absent
function updateMilkProbeFromSnapshot(tempC) {
    milkProbeState = resolveMilkProbePresence(milkProbeState, tempC, Date.now());
    if (typeof tempC === 'number' && isFinite(tempC) && tempC > 0) {
        latestMilkTemp = tempC;
    } else if (!milkProbeState.present) {
        latestMilkTemp = 0;
    }
    ui.setMilkProbePresent(milkProbeState.present); // no-op until presence flips
    ui.updateMilkTelemetry(milkProbeState.present, latestMilkTemp); // top-row Milk °C field, per frame
    window.onMilkProbeUpdate?.(milkProbeState.present, latestMilkTemp);
}
window.app.getMilkProbe = () => ({ present: milkProbeState.present, temperature: latestMilkTemp });

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
        applyScreensaverAction(state);
        statusString = "Sleeping";
    } else {
        applyScreensaverAction(state);
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

        // Tank-level warning, independent of the machine's own `needsWater`
        // state (that's a hard block that only fires once the machine actively
        // tries to heat/pull). Same priority a real needsWater state already
        // has -- it wins over Heating/pouring text too, since isHeatingState()
        // never returns true for state === 'needsWater'.
        if (state !== MachineState.NEEDS_WATER && isTankBelowRefillLevel()) {
            statusString = formatStateString(MachineState.NEEDS_WATER);
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
        // Log the edge only. Snapshots keep arriving at ~10 Hz while the machine is
        // gone, and logging every one of them filled the host's WebView console log
        // (1 MB every ~2 min) for as long as the DE1 stayed disconnected.
        if (previousState.state !== MachineState.ERROR) {
            logger.warn('DE1 machine in error state, likely disconnected.');
        }
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" });
    }

    // Check for shot completion (transition from 'espresso' to 'ready' or 'idle').
    // If the shotState feed tracked this shot, it already owns the stop toast,
    // history refresh, and upload confirmation — the heuristics below are the
    // gateway-mode fallback (no sequencer -> feed stays idle -> seqTrackedShot false).
    if (previousState.state === MachineState.ESPRESSO && (state === MachineState.READY || state === MachineState.IDLE) && seqTrackedShot) {
        logger.info('Shot finished — handled by shotState feed; skipping stop-reason heuristics.');
    } else if (previousState.state === MachineState.ESPRESSO && (state === MachineState.READY || state === MachineState.IDLE)) {
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
                stopReason = stopReasonText('Stopped by weight:', `${finalWeight.toFixed(1)}g`);
            } else if (!isScaleConnected && VOLUME_HIT) {
                stopReason = stopReasonText('Stopped by volume:', `${Math.round(finalVolume)}ml`);
            } else if (TIME_HIT) {
                stopReason = stopReasonText('Stopped by time:', `${totalS.toFixed(1)}s`);
            } else {
                stopReason = `${getTranslation('Shot Stopped')}: ${totalS.toFixed(1)}s`;
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
    updateMilkProbeFromSnapshot(data.milkTemperature);

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
                // Feed frames during this shot re-assert it; stays false in
                // gateway mode so the fallback heuristics run at shot end.
                seqTrackedShot = false;
                chart.clearChart();
                shotData.clearShotData();
                const historyLabelEl = document.getElementById('shot-history-label');
                if (historyLabelEl) {
                    historyLabelEl.textContent = getTranslation('NEWEST');
                }
            }
            // Bengle: use the machine's true gravimetric flow (GFlow) straight from
            // the snapshot — no local delta+EMA smoothing. Non-Bengle keeps the
            // external-scale path (ScaleSnapshot server-smoothed g/s → EMA fallback).
            // `?? null` (not || 0): 0 is a real GFlow value; only an ABSENT field
            // may fall through to the chart's local EMA.
            const chartWeightFlow = isBengleMachine() ? (data.weightFlow ?? null) : latestScaleWeightFlow;
            chart.updateChart(shotStartTime, data, latestScaleWeight, chartWeightFlow);
            shotData.updateShotData(data, latestScaleWeight);
        }
    } else {
        if (shotStartTime) {
            shotEndedAt = Date.now();
            chart.finalizeLiveChart();
        }
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
            window.onScaleConnectionChange?.(true);
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
        // debug, not warn: weightless frames repeat for as long as the scale is
        // away (and some scales send battery-only frames while connected), so one
        // warn each flooded the host's WebView console log. The connect and
        // disconnect edges are already logged either side of this.
        logger.debug('Scale message received without weight data.');
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

// ── ShotState feed (ws/v1/machine/shotState) ────────────────────────────────
// Authoritative shot phase + decision frames from Rea's shot sequencer. When
// frames arrive for a shot they replace the snapshot-based stop-reason
// heuristics in handleData, which stay as fallback: in full gateway mode no
// sequencer runs and this feed stays idle.
let seqTrackedShot = false;   // sequencer emitted frames for the current shot
let seqLastState = 'idle';
let seqScaleLostWarned = false;
let seqHistoryRefreshed = false;
let seqUploadPolled = false;

// Refresh the history panel to the finished shot and confirm its upload.
// Fired from stop/terminal AND finalize (first one wins): the feed replays
// only its latest frame on reconnect, so a socket blip at shot end can
// swallow the finalize frame — hanging the refresh on it alone left the
// panel showing the previous shot.
function seqRefreshHistory(shotId) {
    if (!seqHistoryRefreshed) {
        seqHistoryRefreshed = true;
        history.refreshToNewestShot(history.getNewestShotId(), 6, 2000, shotId ?? null);
    }
    if (shotId && !seqUploadPolled) {
        seqUploadPolled = true;
        pollForUploadConfirmation(shotId);
    }
}

// The translation sheet's stop-reason keys end at the colon ("Stopped by weight:",
// with fr "Arrêt en fonction du poids :"), so the measured value is appended rather
// than substituted into a {value} placeholder. Asking for a key that carries the
// placeholder finds no row and silently falls back to English.
function stopReasonText(key, value) {
    return `${getTranslation(key)} ${value}`;
}

function shotStateStopMessage(decision, machineHasAutonomousSAW) {
    const reason = decision.reason;
    // With firmware-side stop-at-weight (Bengle) the target-yield stop is
    // reported as machineEnded — present it as a weight stop like app-side SAW.
    if (reason === 'targetWeight' || (reason === 'machineEnded' && machineHasAutonomousSAW && isScaleConnected)) {
        const w = parseFloat(decision.data?.projectedWeight ?? latestScaleWeight);
        return stopReasonText('Stopped by weight:', `${w.toFixed(1)}g`);
    }
    if (reason === 'targetVolume') {
        const v = shotData.getCurrentShot()?.volumes?.at(-1) ?? 0;
        return stopReasonText('Stopped by volume:', `${Math.round(v)}ml`);
    }
    // apiStop / appStop / machineEnded / stoppingBackstop — and any unknown
    // reason: the enum is an open set, newer builds may add values.
    return `${getTranslation('Shot Stopped')}: ${shotData.getTotalTime().toFixed(1)}s`;
}

function handleShotStateEvent(frame) {
    if (!frame?.event) return;

    const active = frame.state && frame.state !== 'idle' && frame.state !== 'finished';
    // Any active-shot or decision frame proves the sequencer is running this
    // shot, so handleData's fallback heuristics stand down.
    if (active || frame.decision) seqTrackedShot = true;
    if (active && (seqLastState === 'idle' || seqLastState === 'finished')) {
        seqScaleLostWarned = false;
        seqHistoryRefreshed = false;
        seqUploadPolled = false;
    }
    seqLastState = frame.state ?? seqLastState;

    // Scale dropped mid-shot. Sticky per spec: stop-at-weight stays disabled
    // for the rest of the shot even if the scale reconnects — warn once.
    if (frame.scaleLost && active && !seqScaleLostWarned) {
        seqScaleLostWarned = true;
        ui.showToast(getTranslation('Scale lost — stop at weight disabled'), 6000, 'error');
    }

    const d = frame.decision;
    if (!d) return;

    switch (d.kind) {
        case 'abort':
            ui.showToast(d.reason === 'noScale'
                ? getTranslation('Shot blocked: no scale connected')
                : (d.details || `${getTranslation('Shot Stopped')}: ${shotData.getTotalTime().toFixed(1)}s`),
                4000, 'error');
            break;
        case 'stop':
            ui.showToast(shotStateStopMessage(d, frame.machineHasAutonomousSAW), 6000, 'info');
            seqRefreshHistory(frame.shotId);
            break;
        case 'terminal':
            // Abnormal end (error / disconnect).
            ui.showToast(d.details || `${getTranslation('Shot Stopped')}: ${shotData.getTotalTime().toFixed(1)}s`, 6000, 'error');
            seqRefreshHistory(frame.shotId);
            break;
        case 'finalize':
            // Post-stop settling closed — the shot record is persisted.
            seqRefreshHistory(frame.shotId);
            break;
        // advance frames: chart already tracks step changes via profileFrame
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
            api.resyncIfDrifted(api.FLUSH_DURATION_LAST_VALUE_KEY, flushtimeout.duration, (v) => ui.updateFlushValue(v))
                .catch(e => logger.warn('Flush duration resync failed:', e));
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
        if (hotwatersettings) {
            ui.updateHotWaterDisplay({ targetHotWaterVolume: hotwatersettings.volume, targetHotWaterTemp: hotwatersettings.targetTemperature });
            // Re-push only if the DE1 disagrees with what we last set — a plain GET
            // can't tell us the device itself stayed in sync (BLE reconnect / Rea
            // restart can leave it stale), but blindly re-pushing every boot would
            // be wasteful and could clobber a legitimate reading if our cache were
            // ever the stale one. See api.resyncIfDrifted.
            api.resyncIfDrifted(api.HOT_WATER_VOLUME_LAST_VALUE_KEY, hotwatersettings.volume, api.setTargetHotWaterVolume)
                .catch(e => logger.warn('Hot water volume resync failed:', e));
            api.resyncIfDrifted(api.HOT_WATER_TEMP_LAST_VALUE_KEY, hotwatersettings.targetTemperature, api.setTargetHotWaterTemp)
                .catch(e => logger.warn('Hot water temp resync failed:', e));
        }

        // Resolve the machine model BEFORE the first updateSteamDisplay:
        // Bengle-only steam UI (an armed milk stop persisted in the workflow)
        // must be able to restore visually on boot, so the Bengle gate has to
        // be set before the steam display first renders.
        let machineInfo = null;
        try {
            machineInfo = await getMachineInfo();
        } catch (e) {
            logger.warn('Could not fetch machine info; Bengle gating stays off:', e);
        }
        setMachineModel(machineInfo?.model ?? null);

        // Bengle-only header quick-toggle for the cup warmer. Fails closed: a
        // failed machine-info fetch leaves the gate off and the button hidden.
        // Also re-runs on a live machine swap (loadInitialData fires again via
        // machineLink.onLinkUp) -- hide it explicitly when the newly connected
        // machine isn't a Bengle, since the button starts hidden but nothing
        // else re-hides it once shown.
        if (isBengleMachine()) {
            initCupWarmerToggle();
        } else {
            const cupWarmerBtn = document.getElementById('cupwarmer-toggle-btn');
            if (cupWarmerBtn) cupWarmerBtn.style.display = 'none';
        }

        if (steamsettings) {
            // Workflow steamSettings speaks {flow, duration, ...} while
            // updateSteamDisplay speaks {targetSteamFlow, targetSteamDuration},
            // so map flow explicitly. This boot paint is the ONLY feed of the
            // persisted flow into the tile: the shot-settings WS carries no
            // steam flow field, and the old "restore selected preset" push in
            // setSteamFlowPresetsFromMachineModel is gone (it was
            // resetting the stored flow, not painting it).
            ui.updateSteamDisplay({
                ...steamsettings,
                ...(typeof steamsettings.flow === 'number' && isFinite(steamsettings.flow)
                    ? { targetSteamFlow: steamsettings.flow } : {}),
            });
            api.resyncIfDrifted(api.STEAM_DURATION_LAST_VALUE_KEY, steamsettings.duration, api.setTargetSteamDuration)
                .catch(e => logger.warn('Steam duration resync failed:', e));
            api.resyncIfDrifted(api.STEAM_FLOW_LAST_VALUE_KEY, steamsettings.flow, api.setTargetSteamFlow)
                .catch(e => logger.warn('Steam flow resync failed:', e));
        }

        // Show GHC machine controls column only for non-GHC machines, and pick steam-flow
        // presets based on machine model (group-head size).
        try {
            if (machineInfo && machineInfo.GHC === false) {
                isNonGhcMachine = true;
                ui.showGhcControls();
            }
            await ui.setSteamFlowPresetsFromMachineModel(machineInfo?.model ?? null);
        } catch (e) {
            logger.warn('Could not init GHC controls / steam presets:', e);
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

// ── Bengle cup-warmer quick toggle (header button) ───────────────────────────
// Reflects/toggles the warmer live via /machine/cupWarmer (temperature 0 = off).
// Uses the same target the Settings → Cup Warmer page stores in localStorage.
//
// On/off state is NOT kept here: this button and the Settings → Cup Warmer
// page both render from the ONE shared snapshot in ./cup-warmer.js (the old
// boot-seeded local boolean was one of three diverging copies — audit I1 /
// bench checklist 2b). initCupWarmerToggle runs from loadInitialData on boot
// AND on every machine (re)connect/wake, so a reconnect invalidates the
// snapshot and re-seeds it fresh; the subscription below repaints the button
// whenever anyone (this button, the Settings page, its ~5 s poll) updates the
// store — #main-page is display-toggled, never rebuilt, so the element and
// this one subscription live for the whole session.
async function initCupWarmerToggle() {
    invalidateCupWarmerState(); // (re)connect: drop any stale snapshot before re-seeding
    const btn = document.getElementById('cupwarmer-toggle-btn');
    if (!btn) return;
    btn.style.display = '';
    try {
        const data = await api.getCupWarmer();
        setCupWarmerState(data || { temperature: 0 });
    } catch (e) {
        // Model already said Bengle — keep the button. The snapshot stays null
        // (renders as "off") and the Settings page refetches on entry.
    }
    if (!btn.dataset.wired) { // idempotent: init runs again on reconnect flows
        btn.dataset.wired = '1';
        btn.addEventListener('click', toggleCupWarmerFromHeader);
    }
    startCupWarmerHeaderPoll();
}

// The whole point of a scheduled pre-warm is that the FIRMWARE starts the mat on
// its own — typically at 06:30, with the tablet sitting on the main page and
// nobody touching it. Nothing else on that page ever refetches the cup warmer
// (the ~5 s poll belongs to the Settings page), so without this the button would
// only ever learn about a pre-warm on a reconnect: the "Pre-warming" label would
// essentially never appear in the one scenario it exists for.
//
// A minute is the right cadence — the firmware's lead time is minute-granular —
// and it costs one GET/min. On firmware without the registers the app latches the
// failed register read per connection, so this does not re-enter a read-timeout
// ladder every tick. The revalidate folds into the SHARED store, so when the
// Settings page is open its faster poll simply supersedes this one.
let cupWarmerHeaderPollTimer = null;
const CUP_WARMER_HEADER_POLL_MS = 60_000;
function startCupWarmerHeaderPoll() {
    if (cupWarmerHeaderPollTimer !== null) return; // idempotent across reconnects
    cupWarmerHeaderPollTimer = setInterval(async () => {
        try {
            const data = await api.getCupWarmer();
            if (data) setCupWarmerState(data);
        } catch (e) {
            // Transient/disconnected: keep the last snapshot rather than
            // inventing an "off". A reconnect re-seeds it via initCupWarmerToggle.
        }
    }, CUP_WARMER_HEADER_POLL_MS);
}
onCupWarmerStateChange(() => updateCupWarmerButton());
function updateCupWarmerButton() {
    const btn = document.getElementById('cupwarmer-toggle-btn');
    if (!btn) return;
    const state = getCupWarmerState();
    const on = isCupWarmerOn(state?.temperature);
    // A scheduled pre-warm runs the mat BY ITSELF — at 06:30, with the machine
    // still asleep and the boilers cold. The button would just light up with no
    // explanation, which reads as a bug. MatPreheatActive is the firmware saying
    // "that was me", so we say so on the button. It is null on firmware without
    // the register, and a null is never fabricated into a `true` — old firmware
    // simply keeps the plain "Warmer" label.
    const prewarming = resolvePrewarm(state).active;
    const labelKey = prewarming ? 'Pre-warming' : 'Warmer';
    if (btn.dataset.i18nKey !== labelKey) {
        // Swap the i18n KEY too, not just the text: translatePage() rewrites
        // textContent from the key on every language change, and would otherwise
        // silently revert the label (the #sleep-button precedent in ui.js).
        btn.setAttribute('data-i18n-key', labelKey);
        btn.textContent = getTranslation(labelKey);
        fitTextToWidth(btn); // "Pre-warming" is much longer than "Warmer" in a fixed box
    }
    btn.setAttribute('aria-label', getTranslation(
        prewarming ? 'Cup warmer pre-warming for a scheduled wake' : 'Toggle Cup Warmer',
    ));
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.style.backgroundColor = on ? 'var(--mimoja-blue)' : '';
    btn.style.color = on ? '#ffffff' : '';
}
async function toggleCupWarmerFromHeader() {
    const target = readCupWarmerTarget(localStorage.getItem(CUP_WARMER_TARGET_KEY));
    const next = !isCupWarmerOn(getCupWarmerState()?.temperature);
    try {
        await api.setCupWarmer(next ? target : 0);
        // Store notify repaints this button and any open Settings page; merging
        // keeps the last currentTemperature reading visible there.
        patchCupWarmerState({ temperature: next ? target : 0 });
        ui.showToast(next ? 'Cup warmer on' : 'Cup warmer off', 2000, 'success');
    } catch (e) {
        ui.showToast('Failed to set cup warmer', 3000, 'error');
    }
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

// Resolves as soon as history.initHistory() has populated the shots array --
// long before the rest of initMainPageOnce() (DE1 connect, visualizer, six+
// websockets) finishes. The router awaits this alone to repaint the chart
// ASAP on return from a sub-page, instead of blocking on unrelated work.
let resolveHistoryReady;
const historyReadyPromise = new Promise(resolve => { resolveHistoryReady = resolve; });

let mainPageInitialized = false;
let mainPageInitPromise = null;
async function initMainPageOnce() {
    if (mainPageInitialized) return;
    if (mainPageInitPromise) return mainPageInitPromise;
    mainPageInitPromise = (async () => {
        logger.info('initMainPageOnce: starting.');
        await history.initHistory();
        resolveHistoryReady();
        await profileManager.init();
        window.app.saveGrindToActiveProfile = (val) => profileManager.saveGrindToActiveProfile(val);
        window.app.saveContextToActiveProfile = (fields) => profileManager.saveContextToActiveProfile(fields);
        window.app.getActiveProfileRecord = () => profileManager.getActiveProfileRecord();
        await loadInitialData();
        await initializeDe1Connection();
        await initVisualizer();
        connectWebSocket(handleData, onMachineSnapshotSocketOpen);
        connectScaleWebSocket(handleScaleData, onScaleReconnect, onScaleDisconnect);
        connectDeviceWebSocket(handleDeviceWsData, () => {}, () => {}, handleDeviceConnectionError);
        initWaterTankSocket();
        initClockTicker();
        connectTimeToReadyWebSocket(handleTimeToReadyData);
        connectShotStateWebSocket(handleShotStateEvent);
        connectDisplayWebSocket((data) => logger.debug('Display state updated:', data));
        // Re-apply the user's brightness. REA does not persist it, so without this
        // a restart comes back at whatever the OS picks -- and if the app died
        // while the saver had it at 0, the tablet stays dark. Deferred so the
        // display socket has delivered a frame to compare against; it only pushes
        // when the live level actually differs.
        setTimeout(() => { restoreBrightnessFromStorage(); }, 1500);
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
window.app.historyReady = () => historyReadyPromise;
// True while a shot is being recorded — lets the router skip repainting history
// over a live chart when returning to the main page.
window.app.isShotActive = () => shotStartTime !== null;
// Lets the router blank the shared #plotly-chart element the instant we
// return to the main page, before the async history repaint lands — without
// this the profile-selector's last-plotted profile curve stays visible on
// the shared element for the duration of that repaint.
window.app.clearChart = () => chart.clearChart();

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

// Tap the main chart (or its expand button) to open the full-screen live charts;
// Back button / Escape closes it. Bound once at startup.
function wireExpandedChart() {
    const open = () => { try { chart.openExpandedChart(); } catch (e) { console.error('openExpandedChart', e); } };
    const close = () => { try { chart.closeExpandedChart(); } catch (e) { console.error('closeExpandedChart', e); } };

    const expandBtn = document.getElementById('chart-expand-btn');
    if (expandBtn) expandBtn.addEventListener('click', (e) => { e.stopPropagation(); open(); });

    const chartEl = document.getElementById('plotly-chart');
    if (chartEl) chartEl.addEventListener('click', open);

    const backBtn = document.getElementById('expanded-chart-back');
    if (backBtn) backBtn.addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && chart.isExpandedChartOpen && chart.isExpandedChartOpen()) close();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        setDebug(true);
        logger.info('App DOMContentLoaded: Starting initialization.');

        chart.initChart();
        wireExpandedChart();
        logger.info('App DOMContentLoaded: Chart initialized.');

        await initI18n();
        await initUnits();
        ui.initUI({ onWeightClick: handleWeightClick }); // also inits the screensaver
        initScaling();
        initNumpadModal();
        initTimePicker();
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
        // Canonical signal: the reaprime/Decent host injects window.__DECENT_HOST__
        // into the tablet webview. It's the most reliable tablet/kiosk indicator
        // (the UA-sniffing above misses hosts that don't brand their UA), and it's
        // absent in a normal desktop browser — so this only ever hides the
        // fullscreen control on-device, never for a desktop user. Ceiling: a host
        // that neither brands its UA nor injects the global is still treated as a
        // browser (acceptable — the button is harmless there).
        const isDecentHost = !!window.__DECENT_HOST__;
        const isWebView = isAndroidWebView || isIOSWebView || isDecentWebView || isDecentHost;

        if (isWebView) {
            // A root class, not an inline style on the one button that exists right
            // now: index.html, profile_selector.html and settings.html each carry
            // their own #fullscreen-toggle-btn, and the router injects the sub-page
            // ones long after this runs -- so hiding by id here only ever covered
            // the main page. CSS on <html> covers every page, present and future.
            // The host OS owns fullscreen in a webview, so the button is never
            // useful there. See main.css; help-overlay.css deliberately overrides
            // this on the main page to keep the slot laid out for the help button.
            document.documentElement.classList.add('is-webview');
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
