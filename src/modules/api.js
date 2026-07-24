import * as ui from './ui.js';
import { logger ,setDebug} from './logger.js';
import { createSocketSlot } from './socket-slot.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { buildCalibrateBody, calResponseHasBody } from './loadcell-cal.js';

export let reaHostname = localStorage.getItem('reaHostname') || window.location.hostname;
export const REA_PORT = 8080;
export let API_BASE_URL = `http://${reaHostname}:${REA_PORT}/api/v1`;
export const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

export const MachineState = {
    BOOTING: 'booting',
    BUSY: 'busy',
    IDLE: 'idle',
    SLEEPING: 'sleeping',
    HEATING: 'heating',
    PREHEATING: 'preheating',
    ESPRESSO: 'espresso',
    HOT_WATER: 'hotWater',
    FLUSH: 'flush',
    STEAM: 'steam',
    STEAM_RINSE: 'steamRinse',
    SKIP_STEP: 'skipStep',
    CLEANING: 'cleaning',
    DESCALING: 'descaling',
    CALIBRATION: 'calibration',
    SELF_TEST: 'selfTest',
    AIR_PURGE: 'airPurge',
    NEEDS_WATER: 'needsWater',
    ERROR: 'error',
    FW_UPGRADE: 'fwUpgrade',
    READY: 'ready', // Note: Not in the official API doc, but used in app.js for shot completion logic
};

export let reconnectingWebSocket = null; // Exporting for app.js access
export let currentMachineState = null;
let previousMachineState = null;
let scaleWebSocket = null;
let displayWebSocket = null;
let displayWebSocketReady = false;
// Latest DisplayState frame from ws/v1/display. Null until the socket delivers
// its first snapshot.
let lastDisplayState = null;
const displayListeners = new Set();
/** Last DisplayState REA pushed, or null before the first frame. */
export function getLastDisplayState() {
    return lastDisplayState;
}
// Brightness to return to on wake, captured just before we dim.
let brightnessBeforeDim = null;
let updateWebSocket = null;
let updateWebSocketReady = false;

// Local cache for current shot settings, initialized with default values and correct types
let currentShotSettings = {
    steamSetting: 0, // integer
    targetSteamTemp: 0, // integer
    targetSteamDuration: 0, // integer
    targetHotWaterTemp: 0, // integer
    targetHotWaterVolume: 0, // integer
    targetHotWaterDuration: 0, // integer
    targetShotVolume: 0, // integer
    groupTemp: 0.0, // number (float/double)
};

// Caching for DE1 settings to avoid multiple API calls
const de1SettingsCache = {
    data: null,
    timestamp: null,
    TTL: 60000 // 60 seconds TTL
};

// Caching for DE1 advanced settings to improve performance when navigating to settings page
const de1AdvancedSettingsCache = {
    data: null,
    timestamp: null,
    TTL: 40000 // 40 seconds TTL
};
const reatsettingscache = { 
    data: null,
    timestamp: null,
    TTL: 40000 // 40 seconds TTL
};


export function updateShotSettingsCache(newSettings) {
    if (newSettings) {
        currentShotSettings = { ...currentShotSettings, ...newSettings };
        logger.debug('Shot settings cache updated:', currentShotSettings);
    }
}

export async function getDevices() {
    const response = await fetch(`${API_BASE_URL}/devices`);
    if (!response.ok) {
        throw new Error('Failed to get devices');
    }
    return response.json();
}

export async function scanForDevices() {
    const response = await fetch(`${API_BASE_URL}/devices/scan`);
    if (!response.ok) {
        throw new Error('Failed to scan for devices');
    }
    return response.json();
}

export async function reconnectDevice(deviceId) {
    try {
        logger.info(`Attempting to reconnect to device: ${deviceId}`);
        if (!deviceId||deviceId==null) {
            logger.warn('No device ID provided for reconnection attempt.');
            return;
            
        }
        const response = await fetch(`${API_BASE_URL}/devices/connect?deviceId=${deviceId}`, {
            method: 'PUT',
        });
        if (!response.ok) {
            throw new Error(`Failed to send reconnect request for device ${deviceId}`);
        }
        logger.info(`Successfully sent reconnect request for device: ${deviceId}`);
    } catch (error) {
        logger.error(`Error during device reconnection attempt for ${deviceId}:`, error);
    }
}





export async function connectScaleDevice() {
    try {
        logger.info('Attempting to connect to scale...');
        const response = await fetch(`${API_BASE_URL}/devices/scan?connect=true`, {
            method: 'GET',
        });
        if (!response.ok) {
            logger.error(`Failed to send connect request for scale: ${response.statusText}`);
            return response.json();
            
        }
        logger.info('Successfully sent connect request for scale.');
         return response.json();
    } catch (error) {
        logger.error('Error during scale connection attempt:', error);
        return response.json();
    }
}





export async function tareScale() {
    try {
        logger.info('Taring scale...');
        const response = await fetch(`${API_BASE_URL}/scale/tare`, {
            method: 'PUT',
        });
        if (!response.ok) {
            throw new Error(`Failed to tare scale: ${response.statusText}`);
        }
        logger.info('Successfully tared scale.');
    } catch (error) {
        logger.error('Error taring scale:', error);
        throw error;
    }
}

// Close-before-open. app.js re-opens these sockets after a machine power-cycle to
// force reaprime to re-bind them to the live De1 (resyncMachineSockets); the slot
// guarantees the old socket is closed and silenced first, so a resync cannot leak
// a socket or double-deliver frames.
const snapshotSocketSlot = createSocketSlot('machine snapshot');
const shotSettingsSocketSlot = createSocketSlot('shot settings');
/**
 * Drive one step of the Bengle integrated-scale two-point load-cell
 * calibration (Bengle machines only; 404 elsewhere).
 * @param {'zero'|'left'|'right'|'abort'} command
 * @param {number} [grams] known reference mass — required for 'left'/'right'.
 * @returns {Promise<object>} the ScaleCalResult (`{success, finalStep,
 *   pointStatus, message?}`) for zero/left/right; `{success:true}` for abort.
 * This call blocks while the firmware settles + averages (~15 s per step).
 */
export async function calibrateScale(command, grams) {
    try {
        logger.info(`Scale calibration: ${command}${grams != null ? ` @ ${grams}g` : ''}`);
        const response = await fetch(`${API_BASE_URL}/machine/scale/calibrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildCalibrateBody(command, grams)),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Scale calibration (${command}) failed. Status: ${response.status}, Body: ${errorBody}`);
        }
        // zero/left/right -> 200 with a ScaleCalResult; abort -> 202 no body.
        if (!calResponseHasBody(command)) return { success: true };
        return await response.json();
    } catch (error) {
        logger.error('Error calibrating scale:', error);
        throw error;
    }
}

export function connectWebSocket(onData, onReconnect) {
    reconnectingWebSocket = snapshotSocketSlot.replace(() => new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/machine/snapshot`, [], {
        debug: true,
        reconnectInterval: 3000,
    })); // Enable debug logging

    reconnectingWebSocket.onopen = () => {
        logger.info('WebSocket (re)connected.');
        ui.updateMachineStatus({ status: "Connecting..." }); // Show a temporary status
        if (onReconnect) {
            onReconnect(); // Trigger the logic in app.js
        }
        logger.debug('DE1 WebSocket re-opened. Status set to Connected.'); // Added debug log
    };

    reconnectingWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // logger.info('Raw WebSocket data:', data);
            
            // Handle both cases: data.state could be a string or an object with .state property
            const stateValue = typeof data.state === 'object' ? data.state.state : data.state;
            // logger.info('Extracted state value:', stateValue);
            
            previousMachineState = currentMachineState;
            currentMachineState = stateValue;
            // logger.info('Current state after assignment:', currentMachineState);
            
            if (previousMachineState !== currentMachineState) {
                logger.info('State changed! Checking conditions...');
                if (currentMachineState === MachineState.SLEEPING) {
                    logger.info('Machine state changed to SLEEPING. Dimming display.');
                    dimDisplay();
                } else if (currentMachineState === MachineState.IDLE) {
                    logger.info('Machine state changed to IDLE. Restoring display.');
                    restoreDisplay();
                }
            } else {
                // logger.info('State did not change, skipping display adjustment.');
            }
            
            onData(data);
        } catch (error) {
            logger.error('Error parsing WebSocket message:', error);
        }
    };

    reconnectingWebSocket.onclose = () => {
        logger.info('WebSocket disconnected. Attempting to reconnect...');
        ui.updateMachineStatus({ status: "Disconnected" });
        setTimeout(() => {
            logger.info('reloading now');
            // location.reload();

        }, 6000);
    };

    reconnectingWebSocket.onerror = (error) => {
        logger.error('WebSocket error:', error);
        ui.updateMachineStatus({ status: "Disconnected" }); // Ensure this is present
    };

    reconnectingWebSocket.onreconnect = null;
}

export function connectScaleWebSocket(onData, onReconnect, onDisconnect) {
    if (scaleWebSocket) {
        logger.info('Closing existing scale WebSocket before creating a new one.');
        scaleWebSocket.close();
    }

    scaleWebSocket = new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/scale/snapshot`, [], {
        debug: true,
        reconnectInterval: 3000,
    });

    scaleWebSocket.onopen = () => {
        logger.info('Scale WebSocket (re)connected.');
        if (onReconnect) {
            onReconnect();
        }
    };

    scaleWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.status === 'disconnected') {
                logger.info('Scale disconnected (server status frame).');
                if (onDisconnect) onDisconnect();
            } else if (data.status === 'connected') {
                logger.info('Scale connected (server status frame).');
                if (onReconnect) onReconnect();
            } else {
                onData(data);
            }
        } catch (error) {
            logger.error('Error parsing scale WebSocket message:', error);
        }
    };

    scaleWebSocket.onclose = () => {
        logger.info('Scale WebSocket disconnected.');
        if (onDisconnect) {
            onDisconnect();
        }
    };

    scaleWebSocket.onerror = (error) => {
        logger.error('Scale WebSocket error:', error);
    };

    scaleWebSocket.onreconnect = null;
}

export function connectShotSettingsWebSocket(onData) {
    const shotSettingsWebSocket = shotSettingsSocketSlot.replace(() => new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/machine/shotSettings`, [], {
        debug: true,
        reconnectInterval: 3000,
    }));

    shotSettingsWebSocket.onopen = () => {
        logger.info('Shot Settings WebSocket connected');
    };

    shotSettingsWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            onData(data);
            logger.info('shotsettings data',data);
        } catch (error) {
            logger.error('Error parsing Shot Settings WebSocket message:', error);
        }
    };

    shotSettingsWebSocket.onclose = () => {
        logger.info('Shot Settings WebSocket disconnected. Attempting to reconnect...');
    };

    shotSettingsWebSocket.onerror = (error) => {
        logger.error('Shot Settings WebSocket error:', error);
    };
}

// ShotState feed (ws/v1/machine/shotState): shot phase + decision frames from
// Rea's shot sequencer. The server replays the latest frame on connect and the
// socket is not gated on a connected machine — attach once and keep it open.
export function connectShotStateWebSocket(onData) {
    const shotStateWebSocket = new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/machine/shotState`, [], {
        debug: true,
        reconnectInterval: 3000,
    });

    shotStateWebSocket.onopen = () => {
        logger.info('Shot State WebSocket connected');
    };

    shotStateWebSocket.onmessage = (event) => {
        try {
            onData(JSON.parse(event.data));
        } catch (error) {
            logger.error('Error parsing Shot State WebSocket message:', error);
        }
    };

    shotStateWebSocket.onclose = () => {
        logger.info('Shot State WebSocket disconnected. Attempting to reconnect...');
    };

    shotStateWebSocket.onerror = (error) => {
        logger.error('Shot State WebSocket error:', error);
    };
}

export function connectTimeToReadyWebSocket(onData) {
    const timeToReadyWebSocket = new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/plugins/time-to-ready.reaplugin/timeToReady`, [], {
        debug: true,
        reconnectInterval: 3000,
    });

    timeToReadyWebSocket.onopen = () => {
        logger.info('Time-to-ready WebSocket connected');
    };

    timeToReadyWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            onData(data);
        } catch (error) {
            logger.error('Error parsing time-to-ready WebSocket message:', error);
        }
    };

    timeToReadyWebSocket.onclose = () => {
        logger.info('Time-to-ready WebSocket disconnected. Attempting to reconnect...');
    };

    timeToReadyWebSocket.onerror = (error) => {
        logger.error('Time-to-ready WebSocket error:', error);
    };
}

let profileGeneratedWebSocket = null;

export function connectProfileGeneratedWebSocket(onData) {
    if (profileGeneratedWebSocket) return profileGeneratedWebSocket;
    profileGeneratedWebSocket = new ReconnectingWebSocket(
        `${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/plugins/decent-profile.reaplugin/profileGenerated`,
        [],
        { debug: false, reconnectInterval: 3000 }
    );

    profileGeneratedWebSocket.onopen = () => {
        logger.info('profileGenerated WebSocket connected');
    };

    profileGeneratedWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            onData(data);
        } catch (error) {
            logger.error('Error parsing profileGenerated WebSocket message:', error);
        }
    };

    profileGeneratedWebSocket.onclose = () => {
        logger.info('profileGenerated WebSocket disconnected. Attempting to reconnect...');
    };

    profileGeneratedWebSocket.onerror = (error) => {
        logger.error('profileGenerated WebSocket error:', error);
    };

    return profileGeneratedWebSocket;
}

let deviceWebSocket = null; // Module-level variable to track device WebSocket connection
// Latest devices frame, so a late subscriber (e.g. Settings opened after boot)
// is current at once instead of waiting for the next message.
let lastDeviceData = null;
let deviceLastErrorTimestamp = null;
const deviceDataListeners = new Set();
const deviceReconnectListeners = new Set();
const deviceDisconnectListeners = new Set();
const deviceErrorListeners = new Set();

export function connectDeviceWebSocket(onData, onReconnect, onDisconnect, onError) {
    // Every caller is a subscriber (mirrors connectDisplayWebSocket). This used to
    // close and replace the whole connection per call, so app.js connecting at boot
    // then Settings connecting again on first open silently evicted app.js's
    // callback -- machineLink's onLinkUp (and therefore setMachineModel) never fired
    // again for the rest of the session, so a live machine swap left Bengle-only UI
    // (e.g. the header cup-warmer button) stuck showing the old machine's gate.
    if (onData) {
        deviceDataListeners.add(onData);
        if (lastDeviceData) onData(lastDeviceData);
    }
    if (onReconnect) deviceReconnectListeners.add(onReconnect);
    if (onDisconnect) deviceDisconnectListeners.add(onDisconnect);
    if (onError) deviceErrorListeners.add(onError);

    if (deviceWebSocket && deviceWebSocket.readyState === WebSocket.OPEN) {
        logger.info('Device WebSocket already connected');
        return;
    }

    deviceWebSocket = new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/devices`, [], {
        debug: true,
        reconnectInterval: 3000,
    });

    deviceWebSocket.onopen = () => {
        logger.info('Device WebSocket (re)connected.');
        deviceReconnectListeners.forEach((fn) => {
            try { fn(); } catch (e) { logger.error('Device reconnect listener failed:', e); }
        });
    };

    deviceWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            lastDeviceData = data;
            const err = data.connectionStatus?.error;
            if (err && err.timestamp !== deviceLastErrorTimestamp) {
                deviceLastErrorTimestamp = err.timestamp;
                logger.warn('Device connection error:', err);
                deviceErrorListeners.forEach((fn) => {
                    try { fn(err); } catch (e) { logger.error('Device error listener failed:', e); }
                });
            }
            deviceDataListeners.forEach((fn) => {
                try { fn(data); } catch (e) { logger.error('Device data listener failed:', e); }
            });
            logger.debug('Device data:', data);
        } catch (error) {
            logger.error('Error parsing Device WebSocket message:', error);
        }
    };

    deviceWebSocket.onclose = () => {
        logger.info('Device WebSocket disconnected.');
        deviceDisconnectListeners.forEach((fn) => {
            try { fn(); } catch (e) { logger.error('Device disconnect listener failed:', e); }
        });
    };

    deviceWebSocket.onerror = (error) => {
        logger.error('Device WebSocket error:', error);
    };

    deviceWebSocket.onreconnect = null;
}

/**
 * Send a command to the devices WebSocket channel
 * @param {Object} command - The command payload
 * @param {string} command.command - The command type: 'scan', 'connect', or 'disconnect'
 * @param {string} [command.deviceId] - Device identifier (required for connect/disconnect)
 * @param {boolean} [command.connect] - Whether to auto-connect discovered devices (scan only)
 * @param {boolean} [command.quick] - Fire-and-forget scan without waiting for results (scan only)
 */
export function sendDeviceCommand(command) {
    if (!deviceWebSocket || deviceWebSocket.readyState !== WebSocket.OPEN) {
        logger.error('Device WebSocket is not connected. Cannot send command.');
        return;
    }

    try {
        deviceWebSocket.send(JSON.stringify(command));
        logger.info('Device command sent:', command);
    } catch (error) {
        logger.error('Error sending device command:', error);
        throw error;
    }
}

export function getDeviceWebSocket() {
    return deviceWebSocket;
}

const SCALE_DEVICE_ID_KEY = 'streamline_scale_device_id';

export function saveScaleDeviceId(deviceId) {
    try {
        localStorage.setItem(SCALE_DEVICE_ID_KEY, deviceId);
        logger.info('Scale device ID saved:', deviceId);
    } catch (error) {
        logger.error('Error saving scale device ID:', error);
    }
}

export function getScaleDeviceId() {
    try {
        return localStorage.getItem(SCALE_DEVICE_ID_KEY);
    } catch (error) {
        logger.error('Error getting scale device ID:', error);
        return null;
    }
}

/**
 * Initialize display WebSocket connection
 * @param {Function} onData - Callback for display state updates
 */
export function connectDisplayWebSocket(onData) {
    // Every caller is a subscriber. This used to return early when the socket was
    // already open, silently dropping the callback -- app.js connects at boot, so
    // the settings page's callback never fired, its displayStateCache stayed null
    // and every brightness control rendered its `?? 75` fallback instead of the
    // real level. Replay the cached frame so a late subscriber is current at once.
    if (onData) {
        displayListeners.add(onData);
        if (lastDisplayState) onData(lastDisplayState);
    }

    if (displayWebSocket && displayWebSocket.readyState === WebSocket.OPEN) {
        logger.info('Display WebSocket already connected');
        return;
    }

    displayWebSocket = new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/display`, [], {
        debug: true,
        reconnectInterval: 3000,
    });

    displayWebSocket.onopen = () => {
        logger.info('Display WebSocket connected');
        displayWebSocketReady = true;
        // REA scopes the wake-lock override to this connection and drops it
        // whenever the socket closes, so a reconnect (network blip, REA
        // restart) silently lets the tablet sleep again unless we re-request it.
        if (isWakeLockEnabled()) {
            enableWakeLock().catch((e) => logger.warn('Failed to re-arm wake-lock on connect:', e));
        }
    };

    displayWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // REA replays a DisplayState snapshot on connect and pushes one on
            // every change, so this cache is current without polling. Kept here
            // (not just in the settings page) because restoreDisplay needs the
            // user's brightness even when settings was never opened.
            if (data && typeof data.requestedBrightness === 'number') {
                lastDisplayState = data;
            }
            displayListeners.forEach((fn) => {
                try { fn(data); } catch (e) { logger.error('Display listener failed:', e); }
            });
        } catch (error) {
            logger.error('Error parsing display WebSocket message:', error);
        }
    };

    displayWebSocket.onerror = (error) => {
        logger.error('Display WebSocket error:', error);
    };

    displayWebSocket.onclose = () => {
        logger.info('Display WebSocket closed');
        displayWebSocketReady = false;
    };
}

/**
 * Send a command to the display WebSocket channel
 * @param {Object} command - The command payload
 * @param {string} command.command - The command type: 'setBrightness', 'requestWakeLock', or 'releaseWakeLock'
 * @param {number} [command.brightness] - Brightness value 0-100 (required for setBrightness)
 */
export function sendDisplayCommand(command) {
    if (!displayWebSocket) {
        logger.error('Display WebSocket not initialized. Cannot send command.');
        return;
    }

    if (!displayWebSocketReady || displayWebSocket.readyState !== WebSocket.OPEN) {
        logger.warn('Display WebSocket not ready. Queuing command:', command);
        // Retry after a short delay
        setTimeout(() => {
            if (displayWebSocketReady && displayWebSocket.readyState === WebSocket.OPEN) {
                try {
                    displayWebSocket.send(JSON.stringify(command));
                    logger.info('Display command sent (after retry):', command);
                } catch (error) {
                    logger.error('Error sending display command on retry:', error);
                }
            } else {
                logger.error('Display WebSocket still not ready after retry.');
            }
        }, 100);
        return;
    }

    try {
        displayWebSocket.send(JSON.stringify(command));
        logger.info('Display command sent:', command);
    } catch (error) {
        logger.error('Error sending display command:', error);
        throw error;
    }
}

export function getDisplayWebSocket() {
    return displayWebSocket;
}

/**
 * Initialize the app-update WebSocket connection (ws/v1/update).
 * Emits an AppUpdateState snapshot on connect and on every state change,
 * plus direct {error} replies for bad commands. Both are passed to onData.
 * @param {Function} onData - Callback for update-state / error messages
 */
export function connectUpdateWebSocket(onData) {
    if (updateWebSocket && updateWebSocket.readyState === WebSocket.OPEN) {
        logger.info('Update WebSocket already connected');
        return;
    }

    updateWebSocket = new ReconnectingWebSocket(`${WS_PROTOCOL}//${reaHostname}:${REA_PORT}/ws/v1/update`, [], {
        debug: true,
        reconnectInterval: 3000,
    });

    updateWebSocket.onopen = () => {
        logger.info('Update WebSocket connected');
        updateWebSocketReady = true;
    };

    updateWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (onData) onData(data);
        } catch (error) {
            logger.error('Error parsing update WebSocket message:', error);
        }
    };

    updateWebSocket.onerror = (error) => {
        logger.error('Update WebSocket error:', error);
    };

    updateWebSocket.onclose = () => {
        logger.info('Update WebSocket closed');
        updateWebSocketReady = false;
    };
}

/**
 * Send a command to the app-update WebSocket channel.
 * @param {Object} command - { command: 'check' | 'install' }
 */
export function sendUpdateCommand(command) {
    if (!updateWebSocket) {
        logger.error('Update WebSocket not initialized. Cannot send command.');
        return;
    }

    if (!updateWebSocketReady || updateWebSocket.readyState !== WebSocket.OPEN) {
        logger.warn('Update WebSocket not ready. Retrying command:', command);
        setTimeout(() => {
            if (updateWebSocketReady && updateWebSocket.readyState === WebSocket.OPEN) {
                try {
                    updateWebSocket.send(JSON.stringify(command));
                } catch (error) {
                    logger.error('Error sending update command on retry:', error);
                }
            } else {
                logger.error('Update WebSocket still not ready after retry.');
            }
        }, 100);
        return;
    }

    try {
        updateWebSocket.send(JSON.stringify(command));
        logger.info('Update command sent:', command);
    } catch (error) {
        logger.error('Error sending update command:', error);
    }
}

export function getUpdateWebSocket() {
    return updateWebSocket;
}

export function initDeviceWebSocketWithCallback(onReady, onData, onReconnect, onDisconnect, onError) {
    if (deviceWebSocket && deviceWebSocket.readyState === WebSocket.OPEN) {
        logger.info('Device WebSocket already connected');
        if (onReady) onReady();
        if (onData) {
            connectDeviceWebSocket(onData, onReconnect, onDisconnect, onError);
        }
        return;
    }

    const handleFirstOpen = () => {
        deviceWebSocket.removeEventListener('open', handleFirstOpen);
        logger.info('Device WebSocket ready for commands');
        if (onReady) onReady();
        connectDeviceWebSocket(onData, onReconnect, onDisconnect, onError);
    };

    connectDeviceWebSocket(onData, onReconnect, onDisconnect, onError);
    deviceWebSocket.addEventListener('open', handleFirstOpen);
}



export async function getProfiles() {
    const response = await fetch(`${API_BASE_URL}/profiles?includeHidden=true`);
    if (!response.ok) {
        throw new Error('Failed to get profiles');
    }
    return response.json();
}

export async function uploadProfile(profileData) {
    profileData = sanitizeProfileForRea(profileData);
    const response = await fetch(`${API_BASE_URL}/profiles`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profile: profileData }), // Wrap the profile data as required by the API
    });
    if (!response.ok) {
        const errorBody = await response.text();
        ui.showToast(`Error uploading profile: ${errorBody}`, 5000, 'error');
        throw new Error(`Failed to upload profile. Status: ${response.status}, Body: ${errorBody}`);
    }
    return response.json();
}

// ─── KV Store Helpers ────────────────────────────────────────────────────────

export async function getKVKeys(namespace) {
    const response = await fetch(`${API_BASE_URL}/store/${encodeURIComponent(namespace)}`);
    if (!response.ok) throw new Error(`KV getKeys failed: ${response.status}`);
    return response.json(); // array of key strings
}

export async function getKVValue(namespace, key) {
    const response = await fetch(`${API_BASE_URL}/store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
    if (!response.ok) throw new Error(`KV getValue failed: ${response.status}`);
    return response.json();
}

export async function setKVValue(namespace, key, value) {
    const response = await fetch(`${API_BASE_URL}/store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`KV setValue failed: ${response.status} ${errorBody}`);
    }
    // 204 No Content — no body to parse
}

export async function deleteKVValue(namespace, key) {
    const response = await fetch(`${API_BASE_URL}/store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
        method: 'DELETE',
    });
    if (!response.ok) throw new Error(`KV deleteValue failed: ${response.status}`);
}

// ─── Profile API ─────────────────────────────────────────────────────────────

// Adapt an internal DE1 v2 profile to REA's stricter Profile model before any
// write. Returns a sanitized clone; the caller's object is left untouched.
//  - Strips legacy TCL fields not part of Rea's Profile model (it tolerates
//    them, but they bloat records). See profile.dart for the canonical shape.
//  - REA's StepExitCondition.type enum is [pressure, flow] only — a
//    weight-triggered step exit (a valid DE1 feature the old KV store accepted
//    raw) is rejected; REA represents "stop at weight" via the step's `weight`
//    field instead, so fold the threshold in and drop the unsupported exit.
function sanitizeProfileForRea(profileData) {
    const profile = structuredClone(profileData);

    profile.version = profile.version || '2';
    for (const k of ['type', 'legacy_profile_type', 'lang', 'hidden', 'reference_file', 'changes_since_last_espresso']) {
        delete profile[k];
    }

    if (Array.isArray(profile?.steps)) {
        for (const step of profile.steps) {
            if (!step?.exit) continue;
            // 'weight' folds into the step's weight field; everything that
            // isn't pressure/flow (notably the UI-only 'off') has no REA exit.
            if (step.exit.type === 'weight') {
                if (!step.weight) step.weight = step.exit.value;
                delete step.exit;
            } else if (step.exit.type !== 'pressure' && step.exit.type !== 'flow') {
                step.exit = null;
            }
        }
    }
    return profile;
}

export async function uploadProfileWithParent(profileData, parentId = null) {
    profileData = sanitizeProfileForRea(profileData);
    const body = { profile: profileData };
    if (parentId) body.parentId = parentId;
    const response = await fetch(`${API_BASE_URL}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        ui.showToast(`Error saving profile: ${errorBody}`, 5000, 'error');
        throw new Error(`Failed to save profile. Status: ${response.status}`);
    }
    return response.json();
}

// Full version chain (parents + children) for a profile. Array of ProfileRecords.
export async function getProfileLineage(profileId) {
    const response = await fetch(`${API_BASE_URL}/profiles/${encodeURIComponent(profileId)}/lineage`);
    if (!response.ok) {
        throw new Error(`Failed to get lineage for profile ${profileId}`);
    }
    return response.json();
}

export async function deleteProfile(profileId) {
    const response = await fetch(`${API_BASE_URL}/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
    });
    if (!response.ok) {
        throw new Error(`Failed to delete profile ${profileId}`);
    }
}

export async function updateProfileVisibility(profileId, visibility) {
    const response = await fetch(`${API_BASE_URL}/profiles/${encodeURIComponent(profileId)}/visibility`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ visibility: visibility }),
    });
    if (!response.ok) {
        throw new Error(`Failed to update visibility for profile ${profileId}`);
    }
    return response.json();
}

export async function updateProfile(profileId, profileData) {
    profileData = sanitizeProfileForRea(profileData);
    const response = await fetch(`${API_BASE_URL}/profiles/${encodeURIComponent(profileId)}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profile: profileData }),
    });
    if (!response.ok) {
        throw new Error(`Failed to update profile ${profileId}`);
    }
    return response.json();
}

export async function updateProfileMetadata(profileId, metadata) {
    const response = await fetch(`${API_BASE_URL}/profiles/${encodeURIComponent(profileId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
    });
    if (!response.ok) throw new Error(`Failed to update profile metadata ${profileId}`);
    return response.json();
}

export async function getProfile() {
    const response = await fetch(`${API_BASE_URL}/workflow`, { targetAddressSpace: 'local' });
    if (!response.ok) {
        throw new Error('Failed to get profile');
    }
    const data = await response.json();
    return data.profile || null;
}

function isValidProfile(profile) {
    const requiredKeys = [
        'title',
        'author',
        'notes',
        'beverage_type',
        'steps',
        'version',
        'target_volume',
        'target_weight',
        'target_volume_count_start',
        'tank_temperature'
    ];

    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        const errorMessage = 'Profile validation failed: Profile is not a valid object.';
        logger.error(errorMessage);
        alert(errorMessage); // Pop-up message
        return false;
    }

    for (const key of requiredKeys) {
        if (!Object.prototype.hasOwnProperty.call(profile, key)) {
            const errorMessage = `Profile validation failed: Profile is missing required key: '${key}'.`;
            logger.error(errorMessage);
            alert(errorMessage); // Pop-up message
            return false;
        }
    }

    if (!Array.isArray(profile.steps)) {
        const errorMessage = `Profile validation failed: 'steps' property is not an array.`;
        logger.error(errorMessage);
        alert(errorMessage); // Pop-up message
        return false;
    }

    logger.info('Profile validation successful.');
    return true;
}

export async function sendProfile(profileJson) {
    if (!isValidProfile(profileJson)) {
        throw new Error('Profile validation failed. Not sending to REA.');
    }
    return updateWorkflow({ profile: profileJson });
}

export async function getWorkflow() {
    const response = await fetch(`${API_BASE_URL}/workflow`);
    if (!response.ok) {
        logger.info('Failed to get workflow');
        throw new Error('Failed to get workflow');
    }
    logger.info('workflow returned');
    return response.json();

}

export async function updateWorkflow(data) {
    // Deep copy to avoid side effects on the original object.
    const dataToSend = JSON.parse(JSON.stringify(data));

    // Helper to find and convert grinder setting to an integer.
    const convertGrinderSettingToFloat = (obj) => {
        if (obj && obj.grinderData && typeof obj.grinderData.setting !== 'undefined') {
            const floatValue = parseFloat(obj.grinderData.setting);
            if (!isNaN(floatValue)) {
                obj.grinderData.setting = String(floatValue);
            }
        }
    };

    // Check for grinderData at the top level and within a profile object.
    convertGrinderSettingToFloat(dataToSend);
    if (dataToSend.profile) {
        convertGrinderSettingToFloat(dataToSend.profile);
        // Strip legacy TCL profile fields not in Rea v2 schema. Rea's strict
        // Dart deserializer rejects them; keeping them stalls PUT /workflow.
        delete dataToSend.profile.type;
        delete dataToSend.profile.legacy_profile_type;
        delete dataToSend.profile.lang;
        delete dataToSend.profile.hidden;
        delete dataToSend.profile.reference_file;
        delete dataToSend.profile.changes_since_last_espresso;
        // Step shape sanitization: Rea's ProfileStep is discriminated on
        // `pump`, and ExitType enum is {pressure, flow} only. Sending mixed
        // pump fields or weight/time/off exits trips ArgumentError inside a
        // Timer callback in WorkflowHandler → completer never resolves → hang.
        if (Array.isArray(dataToSend.profile.steps)) {
            for (const step of dataToSend.profile.steps) {
                if (step.pump === 'flow') delete step.pressure;
                else if (step.pump === 'pressure') delete step.flow;
                if (step.limiter && step.limiter.value === 0) step.limiter = null;
                if (step.exit && step.exit.type !== 'pressure' && step.exit.type !== 'flow') {
                    step.exit = null;
                }
            }
        }
    }

    const response = await fetch(`${API_BASE_URL}/workflow`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(dataToSend),
    });
    if (!response.ok) {
        const body = await response.text();
        logger.error('updateWorkflow failed', response.status, body);
        logger.error('updateWorkflow payload was', JSON.stringify(dataToSend));
        throw new Error(`Failed to update workflow: ${response.status} ${body}`);
    }
    return response.json();
}

export async function setMachineState(newState) {
    const response = await fetch(`${API_BASE_URL}/machine/state/${newState}`, {
        method: 'PUT',
    });
    if (!response.ok) {
        throw new Error(`Failed to set machine state to ${newState}`);
    }
    return response;
}

async function sendShotSettings() {
    const payload = {
        steamSetting: Math.round(currentShotSettings.steamSetting),
        targetSteamTemp: Math.round(currentShotSettings.targetSteamTemp),
        targetSteamDuration: Math.round(currentShotSettings.targetSteamDuration),
        targetHotWaterTemp: Math.round(currentShotSettings.targetHotWaterTemp),
        targetHotWaterVolume: Math.round(currentShotSettings.targetHotWaterVolume),
        targetHotWaterDuration: Math.round(currentShotSettings.targetHotWaterDuration),
        targetShotVolume: Math.round(currentShotSettings.targetShotVolume),
        groupTemp: parseFloat(currentShotSettings.groupTemp.toFixed(1)),
    };

    const response = await fetch(`${API_BASE_URL}/machine/shotSettings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        // The body might contain a useful error message
        const errorBody = await response.text();
        throw new Error(`Failed to set shot settings. Status: ${response.status}, Body: ${errorBody}`);
    }
    return;
}

// Last-value-set-by-the-user cache, per main-page control. Kept fresh from
// every surface that can change these (dashboard +/-, presets, numpad),
// since each setter below writes here on success. Used at boot to tell
// "the device drifted from what the user set" apart from "nothing changed" —
// see resyncIfDrifted.
export const STEAM_DURATION_LAST_VALUE_KEY = 'last-steam-duration';
export const STEAM_FLOW_LAST_VALUE_KEY = 'last-steam-flow';
export const FLUSH_DURATION_LAST_VALUE_KEY = 'last-flush-duration';
export const HOT_WATER_VOLUME_LAST_VALUE_KEY = 'last-hot-water-volume';
export const HOT_WATER_TEMP_LAST_VALUE_KEY = 'last-hot-water-temp';
export const BRIGHTNESS_LAST_VALUE_KEY = 'last-brightness';

export async function persistLastValue(key, value) {
    try {
        await openDB();
        await setSetting(key, value);
    } catch (e) {
        logger.warn(`Failed to persist ${key}:`, e);
    }
}

// Boot-time resync for a main-page control. A plain GET tells us what Rea's
// workflow record says, not whether the DE1 itself is still holding that
// value (BLE reconnect / Rea restart can leave it stale). Re-pushing on
// every boot unconditionally works but is wasteful and, if `fetchedValue`
// were ever the stale one, would clobber a legitimate reading. Comparing
// against our own last-written value avoids both: push only when they
// actually disagree.
export async function resyncIfDrifted(key, fetchedValue, pushFn) {
    if (fetchedValue == null) return;
    try {
        await openDB();
        const remembered = await getSetting(key);
        if (remembered != null && remembered !== fetchedValue) {
            await pushFn(remembered);
        }
    } catch (e) {
        logger.warn(`resyncIfDrifted failed for ${key}:`, e);
    }
}

export async function setTargetHotWaterVolume(volume) {
    const value = parseFloat(volume);
    const result = await updateWorkflow({ hotWaterData: { volume: value } });
    persistLastValue(HOT_WATER_VOLUME_LAST_VALUE_KEY, value);
    return result;
}

export async function setTargetHotWaterTemp(temp) {
    const value = parseFloat(temp);
    const result = await updateWorkflow({ hotWaterData: { targetTemperature: value } });
    persistLastValue(HOT_WATER_TEMP_LAST_VALUE_KEY, value);
    return result;
}

export async function setTargetHotWaterDuration(duration) {
    return updateWorkflow({
        hotWaterData: {
            duration: parseFloat(duration)
        }
    });
}

export async function setTargetSteamTemp(temp) {
    return updateWorkflow({
        steamSettings: {
            targetTemperature: parseFloat(temp)
        }
    });
}

export async function setTargetSteamDuration(duration) {
    const value = parseFloat(duration);
    const result = await updateWorkflow({ steamSettings: { duration: value } });
    persistLastValue(STEAM_DURATION_LAST_VALUE_KEY, value);
    return result;
}

export async function setTargetSteamFlow(flow) {
    const value = parseFloat(flow);
    const result = await updateWorkflow({ steamSettings: { flow: value } });
    persistLastValue(STEAM_FLOW_LAST_VALUE_KEY, value);
    return result;
}

// Milk-probe auto-stop target °C (0 = off). Bengle: the steam auto-stops when
// the milk reaches this temperature.
export async function setStopAtTemperature(celsius) {
    return updateWorkflow({
        steamSettings: {
            stopAtTemperature: parseFloat(celsius)
        }
    });
}

export async function getReaSettings() {
    if (reatsettingscache.data && reatsettingscache.timestamp) {
        const now = Date.now();
        if (now - reatsettingscache.timestamp < reatsettingscache.TTL) {
            // Return cached data if it's still fresh
            return reatsettingscache.data;
        }
    }
    try {
        const response = await fetch(`${API_BASE_URL}/settings`);
        if (!response.ok) {
            throw new Error(`Failed to get Rea settings: ${response.statusText}`);
        }
        const data = await response.json();
        // Update the cache with new data
        reatsettingscache.data = data;
        reatsettingscache.timestamp = Date.now();
        return data;
    } catch (error) {
        logger.error("Error in getReaSettings:", error);
        return null; // Return null or a default settings object
    }
}

export async function getMachineInfo() {
    const response = await fetch(`${API_BASE_URL}/machine/info`);
    if (!response.ok) {
        throw new Error(`Failed to get machine info: ${response.statusText}`);
    }
    return response.json();
}

// Current machine state as a MachineSnapshot (same shape as the snapshot WS).
// Lets callers sync status without waiting on a snapshot frame.
export async function getMachineState() {
    const response = await fetch(`${API_BASE_URL}/machine/state`);
    if (!response.ok) {
        throw new Error(`Failed to get machine state: ${response.statusText}`);
    }
    return response.json();
}

// ── Bengle: cup warmer ──────────────────────────────────────────────────────
// GET returns { temperature, currentTemperature?, prewarmEnabled?,
// prewarmLeadMinutes?, prewarmActive? }. `temperature` is the SETPOINT in °C
// (0 = off) — the field name reads like a measurement but it is a MatSetPoint
// read-back. `currentTemperature` is the live mat temperature in °C, null when
// the firmware has no valid reading, and ABSENT entirely on older reaprime
// builds. PUT accepts { temperature } (0–80). 404 on a non-Bengle. There is no
// separate enable field (firmware CupWarmerMode is not exposed), so temperature
// 0 is the "off" signal.
//
// The three `prewarm*` fields are the FIRMWARE-owned scheduled pre-warm; all
// three are null on firmware without the registers ("unavailable" — see
// cup-warmer.js). `prewarmActive` is read-only status and is ignored in a PUT.
export async function getCupWarmer() {
    const response = await fetch(`${API_BASE_URL}/machine/cupWarmer`);
    if (!response.ok) throw new Error(`Failed to get cup warmer (status ${response.status})`);
    return response.json();
}

export async function setCupWarmer(temperature) {
    const response = await fetch(`${API_BASE_URL}/machine/cupWarmer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temperature }),
    });
    if (!response.ok) throw new Error(`Failed to set cup warmer (status ${response.status})`);
    return true;
}

/**
 * Write the scheduled pre-warm pair (MatPreheatEnable + MatPreheatLeadMin).
 * They are ONE firmware register pair and the API writes them together, so both
 * are always sent — passing only one would leave the other at whatever the
 * machine happens to hold.
 *
 * `leadMinutes` must be 0–120 (the caller clamps; out of range is a 400).
 *
 * Returns the machine's ECHO — { prewarmEnabled, prewarmLeadMinutes } read back
 * AFTER the write — because a write to firmware that lacks these registers lands
 * in unmapped space and is silently inert. Both come back `null` there, which is
 * how the caller learns the write did nothing. Never treat a 200 alone as proof
 * the setting took.
 */
export async function setCupWarmerPrewarm(enabled, leadMinutes) {
    const response = await fetch(`${API_BASE_URL}/machine/cupWarmer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prewarmEnabled: enabled, prewarmLeadMinutes: leadMinutes }),
    });
    if (!response.ok) throw new Error(`Failed to set cup warmer pre-warm (status ${response.status})`);
    return response.json();
}

// ── Bengle: LED strip ───────────────────────────────────────────────────────
// State = { frontStrip, backStrip, frontSwitch }, each { awake, sleeping } as a
// 12-char hex 'RRRRGGGGBBBB'. PUT pushes live (no NVM); commit persists to NVM;
// reset reloads NVM and returns the refreshed state. 404 on a non-Bengle.
export async function getLedStrip() {
    const response = await fetch(`${API_BASE_URL}/machine/ledStrip`);
    if (!response.ok) throw new Error(`Failed to get LED strip (status ${response.status})`);
    return response.json();
}

export async function setLedStrip(state) {
    const response = await fetch(`${API_BASE_URL}/machine/ledStrip`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
    });
    if (!response.ok) throw new Error(`Failed to set LED strip (status ${response.status})`);
    return true;
}

export async function commitLedStrip() {
    const response = await fetch(`${API_BASE_URL}/machine/ledStrip/commit`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to commit LED strip (status ${response.status})`);
    return true;
}

export async function resetLedStrip() {
    const response = await fetch(`${API_BASE_URL}/machine/ledStrip/reset`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to reset LED strip (status ${response.status})`);
    return response.json();
}

// Live preview: show `front`/`back` (12-char hex) on the strip now, regardless
// of awake/sleep, without changing the stored palette. clear -> restore awake.
export async function previewLedStrip(front, back) {
    const response = await fetch(`${API_BASE_URL}/machine/ledStrip/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ front, back }),
    });
    if (!response.ok) throw new Error(`Failed to preview LED (status ${response.status})`);
    return true;
}

export async function clearLedStripPreview() {
    const response = await fetch(`${API_BASE_URL}/machine/ledStrip/preview/clear`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to clear LED preview (status ${response.status})`);
    return true;
}

export async function getAppInfo() {
    const response = await fetch(`${API_BASE_URL}/info`);
    if (!response.ok) {
        throw new Error(`Failed to get app info: ${response.statusText}`);
    }
    return response.json();
}


export async function getDe1Settings() {
    // Check if we have cached data that is still fresh
    if (de1SettingsCache.data && de1SettingsCache.timestamp) {
        const now = Date.now();
        if (now - de1SettingsCache.timestamp < de1SettingsCache.TTL) {
            // Return cached data if it's still fresh
            return de1SettingsCache.data;
        }
    }

    try {
        const response = await fetch(`${API_BASE_URL}/machine/settings`);
        if (!response.ok) {
            // Throw an error that includes the status code for better error handling
            const errorText = await response.text(); // Get response body for more details
            const error = new Error(`Failed to get DE1 settings: ${response.statusText}`);
            error.status = response.status; // Add status code to error object
            error.statusText = response.statusText;
            error.responseBody = errorText;
            throw error;
        }
        const data = await response.json();

        // Update the cache with new data
        de1SettingsCache.data = data;
        de1SettingsCache.timestamp = Date.now();

        return data;
    } catch (error) {
        logger.error("Error in getDe1Settings:", error);
        
        if (error.status === 500) {
            throw error;
        }
        
        // Return cached data if available, even if expired, to avoid breaking functionality
        if (de1SettingsCache.data) {
            return de1SettingsCache.data;
        }
        return null;
    }
}

export async function setDe1Settings(settings) {
    try {
        const response = await fetch(`${API_BASE_URL}/machine/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to set DE1 settings. Status: ${response.status}, Body: ${errorBody}`);
        }
        logger.info('DE1 settings updated successfully:', settings);
    } catch (error) {
        logger.error('Error setting DE1 settings:', error);
        throw error; // Re-throw to allow calling code to handle
    }
}

export async function getDe1AdvancedSettings() {
    // Check if we have cached data that is still fresh
    if (de1AdvancedSettingsCache.data && de1AdvancedSettingsCache.timestamp) {
        const now = Date.now();
        if (now - de1AdvancedSettingsCache.timestamp < de1AdvancedSettingsCache.TTL) {
            // Return cached data if it's still fresh
            return de1AdvancedSettingsCache.data;
        }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6-second timeout

    const url = `${API_BASE_URL}/machine/settings/advanced`;
    logger.info(`Fetching advanced settings from: ${url}`); // Log the URL

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId); // Clear the timeout if the fetch completes in time

        if (!response.ok) {
            // Throw an error that includes the status code for better error handling
            const errorText = await response.text(); // Get response body for more details
            const error = new Error(`Failed to get DE1 advanced settings: ${response.statusText}`);
            error.status = response.status; // Add status code to error object
            error.statusText = response.statusText;
            error.responseBody = errorText;
            throw error;
        }
        const data = await response.json();

        // Update the cache with new data
        de1AdvancedSettingsCache.data = data;
        de1AdvancedSettingsCache.timestamp = Date.now();

        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            logger.error(`Error in getDe1AdvancedSettings: Request timed out after 5 seconds.`);
            // window.location.reload(); // Reload the page on timeout to attempt recovery
        } else {
            logger.error("Error in getDe1AdvancedSettings:", error);
            
            // Check if this is a 500 error and re-throw with status info
            if (error.status === 500) {
                throw error; // Re-throw so calling code can handle 500 specifically
            }
        }
        
        // Return cached data if available, even if expired, to avoid breaking functionality
        if (de1AdvancedSettingsCache.data) {
            return de1AdvancedSettingsCache.data;
        }
        return null;
    }
}

export async function setDe1AdvancedSettings(settings) {
    try {
        const response = await fetch(`${API_BASE_URL}/machine/settings/advanced`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to set DE1 advanced settings. Status: ${response.status}, Body: ${errorBody}`);
        }
        logger.info('DE1 advanced settings updated successfully:', settings);
    } catch (error) {
        logger.error('Error setting DE1 advanced settings:', error);
        throw error; // Re-throw to allow calling code to handle
    }
}

export async function resetDe1Settings() {
    try {
        const response = await fetch(`${API_BASE_URL}/machine/settings/reset`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to reset DE1 settings. Status: ${response.status}, Body: ${errorBody}`);
        }
        logger.info('DE1 settings reset to defaults');
    } catch (error) {
        logger.error('Error resetting DE1 settings:', error);
        throw error;
    }
}

export async function setReaSettings(settings) {
    try {
        const response = await fetch(`${API_BASE_URL}/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to set REA settings. Status: ${response.status}, Body: ${errorBody}`);
        }
        logger.info('REA settings updated successfully:', settings);
    } catch (error) {
        logger.error('Error setting REA settings:', error);
        throw error; // Re-throw to allow calling code to handle
    }
}

export async function ensureGatewayModeTracking() {
    const settings = await getReaSettings();
    if (settings && settings.gatewayMode !== 'tracking') {
        logger.info("Gateway mode is not 'tracking', attempting to set it.");
        try {
            const response = await fetch(`${API_BASE_URL}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ gatewayMode: 'tracking' }),
            });
            if (!response.ok) {
                throw new Error(`Failed to set gateway mode: ${response.statusText}`);
            }
            logger.info("Successfully set gateway mode to 'tracking'.");
        } catch (error) {
            logger.error("Error in ensureGatewayModeTracking POST:", error);
        }
    }
}

export async function getValueFromStore(namespace, key) {
    try {
        const response = await fetch(`${API_BASE_URL}/store/${namespace}/${key}`);
        if (response.status === 404) {
            return null; // Key not found, which is a valid case
        }
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        logger.info('getValueFromStore ok');
        return response.json();
    } catch (error) {
        logger.error(`Failed to get value for key '${key}':`, error);
        throw error;
    }
}

export async function setValueInStore(namespace, key, value) {
    try {
        const response = await fetch(`${API_BASE_URL}/store/${namespace}/${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
        });
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        logger.info('setValueInStore ok');
        return true;
    } catch (error) {
        logger.error(`Failed to set value for key '${key}':`, error);
        throw error;
    }
}

export async function getShotIds() {
    const response = await fetch(`${API_BASE_URL}/shots/ids`);
    if (!response.ok) {
        throw new Error('Failed to get shot ids');
    }
    return response.json();
}

export async function getShots(options = {}) {
    const { limit = 20, offset = 0, grinderId, grinderModel, beanBatchId, coffeeName, coffeeRoaster, profileTitle, ids, orderBy = 'timestamp', order = 'desc' } = options;
    
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit);
    if (offset) params.append('offset', offset);
    if (grinderId) params.append('grinderId', grinderId);
    if (grinderModel) params.append('grinderModel', grinderModel);
    if (beanBatchId) params.append('beanBatchId', beanBatchId);
    if (coffeeName) params.append('coffeeName', coffeeName);
    if (coffeeRoaster) params.append('coffeeRoaster', coffeeRoaster);
    if (profileTitle) params.append('profileTitle', profileTitle);
    if (ids) params.append('ids', Array.isArray(ids) ? ids.join(',') : ids);
    if (orderBy) params.append('orderBy', orderBy);
    if (order) params.append('order', order);
    
    const response = await fetch(`${API_BASE_URL}/shots?${params.toString()}`);
    if (!response.ok) {
        throw new Error('Failed to get shots');
    }
    return response.json();
}

export async function updateShot(id, shotData) {
    const response = await fetch(`${API_BASE_URL}/shots/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shotData),
    });
    if (!response.ok) {
        throw new Error(`Failed to update shot ${id}`);
    }
    return response.json();
}

export async function deleteShot(id) {
    const response = await fetch(`${API_BASE_URL}/shots/${id}`, {
        method: 'DELETE',
    });
    if (!response.ok) {
        throw new Error(`Failed to delete shot ${id}`);
    }
    return response.json();
}

export async function getBeans(includeArchived = false) {
    const response = await fetch(`${API_BASE_URL}/beans?includeArchived=${includeArchived}`);
    if (!response.ok) throw new Error('Failed to get beans');
    return response.json();
}

export async function createBean(beanData) {
    const response = await fetch(`${API_BASE_URL}/beans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(beanData),
    });
    if (!response.ok) throw new Error('Failed to create bean');
    return response.json();
}

export async function getBean(id) {
    const response = await fetch(`${API_BASE_URL}/beans/${id}`);
    if (!response.ok) throw new Error(`Failed to get bean ${id}`);
    return response.json();
}

export async function updateBean(id, beanData) {
    const response = await fetch(`${API_BASE_URL}/beans/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(beanData),
    });
    if (!response.ok) throw new Error(`Failed to update bean ${id}`);
    return response.json();
}

export async function deleteBean(id) {
    const response = await fetch(`${API_BASE_URL}/beans/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Failed to delete bean ${id}`);
    return response.json();
}

export async function getBeanBatches(beanId, includeArchived = false) {
    const response = await fetch(`${API_BASE_URL}/beans/${beanId}/batches?includeArchived=${includeArchived}`);
    if (!response.ok) throw new Error(`Failed to get batches for bean ${beanId}`);
    return response.json();
}

export async function createBeanBatch(beanId, batchData) {
    const response = await fetch(`${API_BASE_URL}/beans/${beanId}/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchData),
    });
    if (!response.ok) throw new Error(`Failed to create batch for bean ${beanId}`);
    return response.json();
}

export async function getBeanBatch(id) {
    const response = await fetch(`${API_BASE_URL}/bean-batches/${id}`);
    if (!response.ok) throw new Error(`Failed to get bean batch ${id}`);
    return response.json();
}

export async function updateBeanBatch(id, batchData) {
    const response = await fetch(`${API_BASE_URL}/bean-batches/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchData),
    });
    if (!response.ok) throw new Error(`Failed to update bean batch ${id}`);
    return response.json();
}

export async function deleteBeanBatch(id) {
    const response = await fetch(`${API_BASE_URL}/bean-batches/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Failed to delete bean batch ${id}`);
    return response.json();
}

export async function getGrinders(includeArchived = false) {
    const response = await fetch(`${API_BASE_URL}/grinders?includeArchived=${includeArchived}`);
    if (!response.ok) throw new Error('Failed to get grinders');
    return response.json();
}

export async function createGrinder(grinderData) {
    const response = await fetch(`${API_BASE_URL}/grinders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(grinderData),
    });
    if (!response.ok) throw new Error('Failed to create grinder');
    return response.json();
}

export async function getGrinder(id) {
    const response = await fetch(`${API_BASE_URL}/grinders/${id}`);
    if (!response.ok) throw new Error(`Failed to get grinder ${id}`);
    return response.json();
}

export async function updateGrinder(id, grinderData) {
    const response = await fetch(`${API_BASE_URL}/grinders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(grinderData),
    });
    if (!response.ok) throw new Error(`Failed to update grinder ${id}`);
    return response.json();
}

export async function deleteGrinder(id) {
    const response = await fetch(`${API_BASE_URL}/grinders/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Failed to delete grinder ${id}`);
    return response.json();
}

export async function uploadMachineProfile(profileData) {
    const response = await fetch(`${API_BASE_URL}/machine/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileData),
    });
    if (!response.ok) throw new Error('Failed to upload machine profile');
    return response.json();
}

export async function setWaterLevels(refillLevel) {
    const response = await fetch(`${API_BASE_URL}/machine/waterLevels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refillLevel: Math.trunc(refillLevel) }),
    });
    if (!response.ok) throw new Error(`Failed to set water levels (status ${response.status})`);
    return true;
}

export async function uploadFirmware(firmwareFile) {
    const response = await fetch(`${API_BASE_URL}/machine/firmware`, {
        method: 'POST',
        body: firmwareFile,
    });
    if (!response.ok) throw new Error('Failed to upload firmware');
    return response.json();
}

export async function getPlugins() {
    try {
        const response = await fetch(`${API_BASE_URL}/plugins`);
        if (!response.ok) {
            throw new Error(`Failed to get plugins: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        logger.error("Error in getPlugins:", error);
        return null;
    }
}

export async function getPluginSettings(pluginId) {
    try {
        const response = await fetch(`${API_BASE_URL}/plugins/${pluginId}/settings`);
        if (!response.ok) {
            // If settings are not found (e.g., first time), return empty object rather than error
            if (response.status === 404) {
                return {};
            }
            throw new Error(`Failed to get plugin settings for ${pluginId}: ${response.statusText}`);
        }
        const settings = await response.json();
        logger.info(`Plugin settings for ${pluginId} retrieved successfully.`, settings);
        return settings;
    } catch (error) {
        logger.error(`Error getting plugin settings for ${pluginId}:`, error);
        return {}; // Return empty object on error to prevent UI from breaking
    }
}

export async function setPluginSettings(pluginId, settings) {
    try {
        const response = await fetch(`${API_BASE_URL}/plugins/${pluginId}/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to set plugin settings for ${pluginId}. Status: ${response.status}, Body: ${errorBody}`);
        }
        logger.info(`Plugin settings for ${pluginId} updated successfully:`, settings);
        return true;
    } catch (error) {
        throw error; // Re-throw to allow calling code to handle
    }
}

export async function callPluginEndpoint(pluginId, endpoint, body, method = 'POST') {
    try {
        const response = await fetch(`${API_BASE_URL}/plugins/${pluginId}/${endpoint}`, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : null,
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Failed to call plugin endpoint ${pluginId}/${endpoint}. Status: ${response.status}, Body: ${errorBody}`);
        }
        
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        }
        return await response.text();
    } catch (error) {
        logger.error(`Error calling plugin endpoint ${pluginId}/${endpoint}:`, error);
        throw error;
    }
}

export async function verifyVisualizerCredentials(username, password) {
    try {
        const response = await fetch(`${API_BASE_URL}/plugins/visualizer.reaplugin/verifyCredentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        const result = await response.json();
        return result.valid;
    } catch (error) {
        logger.error('Failed to verify Visualizer credentials:', error);
        return false; // Assume invalid on error
    }
}

export async function getDisplayState() {
    try {
        const response = await fetch(`${API_BASE_URL}/display`);
        if (!response.ok) {
            throw new Error(`Failed to get display state: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        logger.error('Error getting display state:', error);
        throw error;
    }
}

/** Brightness used while the machine sleeps when "screen off" is switched off.
 *  Dim enough to read as asleep, bright enough to see the screensaver. */
const SAVER_BRIGHTNESS_DEFAULT = 10;

/** Black screen saver: a full black cover at brightness 0 instead of the image
 *  screensaver. Mutually exclusive with it -- the settings toggles enforce that --
 *  and OFF by default, so the image saver stays the out-of-box behaviour.
 *
 *  Named after the TCL setting of the same name, which is also a black page at
 *  brightness 0 (de1plus/utils.tcl:483-485). Neither app can truly power the
 *  panel off -- REA exposes no such command and TCL only calls `borg brightness`
 *  -- so a black cover at 0 is as dark as a sleeping tablet gets. */
export function isBlackScreenSaver() {
    return localStorage.getItem('blackScreenSaver') === 'true';
}

export function setBlackScreenSaver(enabled) {
    localStorage.setItem('blackScreenSaver', enabled ? 'true' : 'false');
    return !!enabled;
}

export function getSaverBrightness() {
    return isBlackScreenSaver() ? 0 : SAVER_BRIGHTNESS_DEFAULT;
}

export function dimDisplay() {
    try {
        // Remember where to come back to. requestedBrightness (not brightness) is
        // the user's intent -- they differ when REA's low-battery cap is active.
        // Skip capture if we are already dimmed, so a second dim cannot record
        // the saver level as the thing to restore.
        const current = lastDisplayState?.requestedBrightness;
        if (typeof current === 'number' && current !== getSaverBrightness()) {
            brightnessBeforeDim = current;
        }
        sendDisplayCommand({
            command: 'setBrightness',
            brightness: getSaverBrightness()
        });
    } catch (error) {
        logger.error('Error dimming display:', error);
        throw error;
    }
}

export function restoreDisplay() {
    try {
        // Restore what the user had, not a hardcoded 100 -- per the API, 100 means
        // "hand back to OS-managed brightness", so restoring to it discarded any
        // level set on the settings slider on every sleep/wake cycle. TCL restores
        // to its app_brightness setting for the same reason (de1plus/utils.tcl:496).
        // The remembered level is the fallback: it survives an app restart, where
        // the in-memory capture does not.
        sendDisplayCommand({
            command: 'setBrightness',
            brightness: brightnessBeforeDim ?? rememberedBrightness ?? 100
        });
        brightnessBeforeDim = null;
    } catch (error) {
        logger.error('Error restoring display:', error);
        throw error;
    }
}

/** The user's brightness, remembered across restarts. Read once at boot by
 *  restoreBrightnessFromStorage() so restoreDisplay() can fall back to it
 *  synchronously. */
let rememberedBrightness = null;

/** Persist a brightness the user actually chose. Not called for the saver dim,
 *  which is a transient state, nor for the wake restore, which replays it. */
export function rememberBrightness(value) {
    const v = Math.min(100, Math.max(0, parseInt(value, 10)));
    if (!Number.isFinite(v)) return;
    rememberedBrightness = v;
    persistLastValue(BRIGHTNESS_LAST_VALUE_KEY, v);
}

/**
 * Boot: re-apply the remembered brightness.
 *
 * REA does not persist it -- ReaSettings has no brightness field, only the
 * lowBatteryBrightnessLimit toggle -- so after a restart the panel comes back at
 * whatever the OS decides and the user's choice is gone. This also rescues the
 * case where the app died while the saver had it dimmed to 0, which otherwise
 * leaves the tablet dark with no way back except the settings slider you cannot
 * see. Pushes only when the live level actually differs, via resyncIfDrifted.
 */
export async function restoreBrightnessFromStorage() {
    try {
        await openDB();
        const remembered = await getSetting(BRIGHTNESS_LAST_VALUE_KEY);
        if (remembered == null) return;
        rememberedBrightness = remembered;
        const live = lastDisplayState?.brightness;
        if (live != null && live !== remembered) {
            sendDisplayCommand({ command: 'setBrightness', brightness: remembered });
        }
    } catch (e) {
        logger.warn('restoreBrightnessFromStorage failed:', e);
    }
}

/** Wake-lock defaults ON: absent key means never-touched, not opted-out. */
export function isWakeLockEnabled() {
    const stored = localStorage.getItem('wakeLockEnabled');
    return stored === null ? true : stored === 'true';
}

export async function enableWakeLock() {
    try {
        const response = await fetch(`${API_BASE_URL}/display/wakelock`, {
            method: 'POST',
        });
        if (!response.ok) {
            throw new Error(`Failed to enable wake-lock: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        logger.error('Error enabling wake-lock:', error);
        throw error;
    }
}

export async function disableWakeLock() {
    try {
        const response = await fetch(`${API_BASE_URL}/display/wakelock`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            throw new Error(`Failed to disable wake-lock: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        logger.error('Error disabling wake-lock:', error);
        throw error;
    }
}

export async function signalHeartbeat() {
    try {
        const response = await fetch(`${API_BASE_URL}/machine/heartbeat`, {
            method: 'POST',
        });
        if (!response.ok) {
            throw new Error(`Failed to signal heartbeat: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        logger.error('Error signaling heartbeat:', error);
        throw error;
    }
}

// --- Manual WiFi scale endpoints ---------------------------------------------
// Auto-discovered (DNS-SD) WiFi scales show up in the device list with no extra
// calls; these drive MANUAL IP/hostname entry for networks where mDNS is blocked.

/** List manually-added WiFi scale endpoints → ["192.168.1.42", ...]. */
export async function listWifiScales() {
    try {
        const response = await fetch(`${API_BASE_URL}/devices/wifi`);
        if (!response.ok) throw new Error(`Failed to list WiFi scales: ${response.status}`);
        const data = await response.json();
        return data.endpoints || [];
    } catch (error) {
        logger.error('Error listing WiFi scales:', error);
        throw error;
    }
}

/** Add a WiFi scale by IP/hostname. Returns the updated endpoint list. */
export async function addWifiScale(host) {
    try {
        const response = await fetch(`${API_BASE_URL}/devices/wifi`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host }),
        });
        if (!response.ok) throw new Error(`Failed to add WiFi scale: ${response.status}`);
        const data = await response.json();
        return data.endpoints || [];
    } catch (error) {
        logger.error('Error adding WiFi scale:', error);
        throw error;
    }
}

/** Remove a manual WiFi scale endpoint. Returns the updated endpoint list. */
export async function removeWifiScale(host) {
    try {
        const response = await fetch(`${API_BASE_URL}/devices/wifi`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host }),
        });
        if (!response.ok) throw new Error(`Failed to remove WiFi scale: ${response.status}`);
        const data = await response.json();
        return data.endpoints || [];
    } catch (error) {
        logger.error('Error removing WiFi scale:', error);
        throw error;
    }
}

// Forget a remembered device: drops it from the persistent registry so a
// currently-absent (`available: false`) device stops appearing in the list.
// deviceId goes in the body (serial/WiFi ids aren't URL-path-safe).
export async function forgetDevice(deviceId) {
    try {
        const response = await fetch(`${API_BASE_URL}/devices/forget`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId }),
        });
        if (!response.ok) throw new Error(`Failed to forget device: ${response.status}`);
        return true;
    } catch (error) {
        logger.error('Error forgetting device:', error);
        throw error;
    }
}

// Presence API functions
export async function getPresenceSettings() {
    try {
        const response = await fetch(`${API_BASE_URL}/presence/settings`);
        if (!response.ok) {
            const error = new Error(`Failed to get presence settings: ${response.status} ${response.statusText}`);
            logger.error('Error getting presence settings:', error);
            throw error;
        }
        return response.json();
    } catch (error) {
        if (!error.message.includes('Failed to get')) {
            logger.error('Error getting presence settings:', error);
        }
        throw error;
    }
}

export async function setPresenceSettings(settings) {
    try {
        const response = await fetch(`${API_BASE_URL}/presence/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        if (!response.ok) {
            const error = new Error(`Failed to update presence settings: ${response.status} ${response.statusText}`);
            logger.error('Error updating presence settings:', error);
            throw error;
        }
        return response.json();
    } catch (error) {
        if (!error.message.includes('Failed to update')) {
            logger.error('Error updating presence settings:', error);
        }
        throw error;
    }
}

export async function getPresenceSchedules() {
    try {
        const response = await fetch(`${API_BASE_URL}/presence/schedules`);
        if (!response.ok) {
            const error = new Error(`Failed to get schedules: ${response.status} ${response.statusText}`);
            logger.error('Error getting presence schedules:', error);
            throw error;
        }
        return response.json();
    } catch (error) {
        if (!error.message.includes('Failed to get')) {
            logger.error('Error getting presence schedules:', error);
        }
        throw error;
    }
}

export async function createPresenceSchedule(schedule) {
    try {
        const response = await fetch(`${API_BASE_URL}/presence/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(schedule)
        });
        if (!response.ok) {
            const error = new Error(`Failed to create schedule: ${response.status} ${response.statusText}`);
            logger.error('Error creating presence schedule:', error);
            throw error;
        }
        return response.json();
    } catch (error) {
        if (!error.message.includes('Failed to create')) {
            logger.error('Error creating presence schedule:', error);
        }
        throw error;
    }
}

export async function updatePresenceSchedule(id, schedule) {
    try {
        const response = await fetch(`${API_BASE_URL}/presence/schedules/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(schedule)
        });
        if (!response.ok) {
            const error = new Error(`Failed to update schedule ${id}: ${response.status} ${response.statusText}`);
            logger.error('Error updating presence schedule:', error);
            throw error;
        }
        return response.json();
    } catch (error) {
        if (!error.message.includes('Failed to update')) {
            logger.error('Error updating presence schedule:', error);
        }
        throw error;
    }
}

export async function deletePresenceSchedule(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/presence/schedules/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            const error = new Error(`Failed to delete schedule ${id}: ${response.status} ${response.statusText}`);
            logger.error('Error deleting presence schedule:', error);
            throw error;
        }
        return response.json();
    } catch (error) {
        if (!error.message.includes('Failed to delete')) {
            logger.error('Error deleting presence schedule:', error);
        }
        throw error;
    }
}

export async function getAllSkins() {
    const response = await fetch(`${API_BASE_URL}/webui/skins`);
    if (!response.ok) throw new Error(`Failed to get skins: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function getDefaultSkin() {
    const response = await fetch(`${API_BASE_URL}/webui/skins/default`);
    if (!response.ok) throw new Error(`Failed to get default skin: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function setDefaultSkin(skinId) {
    const response = await fetch(`${API_BASE_URL}/webui/skins/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skinId })
    });
    if (!response.ok) throw new Error(`Failed to set default skin: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function enablePlugin(pluginId) {
    const response = await fetch(`${API_BASE_URL}/plugins/${encodeURIComponent(pluginId)}/enable`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to enable plugin ${pluginId}: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function disablePlugin(pluginId) {
    const response = await fetch(`${API_BASE_URL}/plugins/${encodeURIComponent(pluginId)}/disable`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to disable plugin ${pluginId}: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function stopWebuiServer() {
    const response = await fetch(`${API_BASE_URL}/webui/server/stop`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to stop WebUI server: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function startWebuiServer() {
    const response = await fetch(`${API_BASE_URL}/webui/server/start`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to start WebUI server: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function updateSkins() {
    const response = await fetch(`${API_BASE_URL}/webui/skins/update`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to update skins: ${response.status} ${response.statusText}`);
    return response.json();
}

export async function submitFeedback(payload) {
    const res = await fetch(`${API_BASE_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}
