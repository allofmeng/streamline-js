import * as chart from './chart.js';
import { logger } from './logger.js';
import { openDB, getAllShots, addShot, deleteShot as idbDeleteShot, clearShots } from './idb.js';
import { API_BASE_URL } from './api.js';
import { renderPastShot, clearShotData } from './shotData.js';
import { getTranslation } from './i18n.js';
import { generateShotSummary } from './shotSummary.js';
import { openContextMenu } from './context-menu.js';
import { showToast } from './ui.js';

const DEREK_URL = 'https://derek.decentespresso.com/';

const PAGE_SIZE = 20;
let shots = [];
let currentShotIndex = -1;
let totalAvailable = 0;

async function loadShotHistory() {
    try {
        const response = await fetch(`${API_BASE_URL}/shots?limit=${PAGE_SIZE}&offset=0&order=desc`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        totalAvailable = data.total ?? 0;
        for (const shot of data.items ?? []) {
            await addShot(shot);
        }
        logger.info(`${data.items?.length ?? 0} shots fetched from API.`);
    } catch (error) {
        logger.warn('Could not fetch shots from API, loading from cache:', error);
    }

    try {
        shots = await getAllShots();
        shots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        if (totalAvailable < shots.length) totalAvailable = shots.length;
        logger.info('Shot history loaded:', shots.length, 'shots');
    } catch (error) {
        logger.error('Error loading shots from IndexedDB:', error);
    }
}

async function loadMoreShots() {
    if (shots.length >= totalAvailable) return;
    try {
        const response = await fetch(`${API_BASE_URL}/shots?limit=${PAGE_SIZE}&offset=${shots.length}&order=desc`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        totalAvailable = data.total ?? totalAvailable;
        for (const shot of data.items ?? []) {
            await addShot(shot);
            shots.push(shot);
        }
        logger.info(`Loaded ${data.items?.length ?? 0} more shots.`);
    } catch (error) {
        logger.warn('Could not load more shots:', error);
    }
}

async function displayShot(index) {
    if (index < 0 || index >= shots.length) {
        logger.warn('Invalid shot index', index);
        return;
    }

    currentShotIndex = index;
    const shot = shots[currentShotIndex];

    // Update footer text
    const dateEl = document.getElementById('history-date');
    const profileNameEl = document.getElementById('history-profile-name');
    const historyLabelEl = document.getElementById('shot-history-label');

    if (dateEl) {
        const date = new Date(shot.timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        dateEl.textContent = `${year}/${month}/${day} ${hours}:${minutes}`;
    }
    if (profileNameEl && shot.workflow && shot.workflow.profile) {
        profileNameEl.textContent = shot.workflow.profile.title;
    }
    if (historyLabelEl) {
        if (index === 0) {
            historyLabelEl.textContent = getTranslation('NEWEST');
        } else if (index === shots.length - 1 && shots.length >= totalAvailable) {
            historyLabelEl.textContent = getTranslation('OLDEST');
        } else {
            historyLabelEl.textContent = getTranslation('SHOT HISTORY');
        }
    }

    const doseInEl = document.getElementById('history-dose-in');
    const grindSizeEl = document.getElementById('history-grind-size');

    if (doseInEl) {
        const doseIn = shot.annotations?.actualDoseWeight
            ?? shot.workflow?.context?.targetDoseWeight
            ?? shot.workflow?.doseData?.doseIn;
        if (typeof doseIn !== 'undefined' && doseIn !== null) {
            doseInEl.textContent = `In ${doseIn}g`;
        } else {
            doseInEl.textContent = `In: N/A`;
        }
    }

    if (grindSizeEl) {
        const grindSetting = shot.workflow?.context?.grinderSetting ?? shot.workflow?.grinderData?.setting;
        if (typeof grindSetting !== 'undefined' && grindSetting !== null) {
            const settingFloat = parseFloat(grindSetting);
            grindSizeEl.textContent = !isNaN(settingFloat) ? `Grind ${settingFloat}` : `Grind N/A`;
        } else {
            grindSizeEl.textContent = `Grind N/A`;
        }
    }

    // Lazy-load measurements if not present
    if (!shots[currentShotIndex].measurements) {
        try {
            const response = await fetch(`${API_BASE_URL}/shots/${shot.id}`);
            if (response.ok) {
                const fullShot = await response.json();
                shots[currentShotIndex] = { ...shot, ...fullShot };
                await addShot(shots[currentShotIndex]);
            }
        } catch (error) {
            logger.warn('Could not fetch full shot data:', error);
        }
    }

    if (shots[currentShotIndex].measurements) {
        chart.plotHistoricalShot(shots[currentShotIndex].measurements, shots[currentShotIndex].workflow);
        renderPastShot(shots[currentShotIndex]);
    }

    // Update button states
    const prevBtn = document.getElementById('history-prev-btn');
    const nextBtn = document.getElementById('history-next-btn');

    if (prevBtn) {
        prevBtn.classList.toggle('invisible', currentShotIndex >= shots.length - 1 && shots.length >= totalAvailable);
    }
    if (nextBtn) {
        nextBtn.classList.toggle('invisible', currentShotIndex <= 0);
    }

    // Transparently prefetch next page when approaching the end
    if (currentShotIndex >= shots.length - 3 && shots.length < totalAvailable) {
        loadMoreShots();
    }
}

// Re-plot the currently selected history shot. The main-page chart shares the
// `plotly-chart` id with the profile selector, so the selector's plotProfile()
// paints over it; call this when returning to the main page to restore history.
export function refreshCurrentShot() {
    if (currentShotIndex >= 0 && shots[currentShotIndex]?.measurements) {
        chart.plotHistoricalShot(shots[currentShotIndex].measurements, shots[currentShotIndex].workflow);
        renderPastShot(shots[currentShotIndex]);
    } else {
        chart.clearChart();
    }
}

// Ensure the current shot has its measurements loaded (the list endpoint
// strips them; the summary needs the full record).
async function ensureCurrentShotMeasurements() {
    const shot = shots[currentShotIndex];
    if (!shot) return null;
    if (shot.measurements) return shot;
    try {
        const response = await fetch(`${API_BASE_URL}/shots/${shot.id}`);
        if (response.ok) {
            shots[currentShotIndex] = { ...shot, ...(await response.json()) };
            await addShot(shots[currentShotIndex]);
        }
    } catch (error) {
        logger.warn('Could not fetch full shot data for summary:', error);
    }
    return shots[currentShotIndex];
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API blocked (insecure context / webview) — fall back.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
}

// Build the markdown summary of the displayed shot (loading measurements as
// needed). Returns null and toasts if there's nothing to summarize.
async function buildCurrentShotSummary() {
    if (currentShotIndex < 0) { showToast(getTranslation('No shot selected'), 2400, 'warning'); return null; }
    const shot = await ensureCurrentShotMeasurements();
    if (!shot?.measurements?.length) { showToast(getTranslation('No shot data to summarize'), 3000, 'warning'); return null; }
    return generateShotSummary(shot);
}

async function copyCurrentShotSummary() {
    const md = await buildCurrentShotSummary();
    if (md == null) return;
    const ok = await copyText(md);
    showToast(getTranslation(ok ? 'Summary copied to clipboard' : 'Could not copy summary'), 2400, ok ? 'success' : 'error');
}

// Copy the summary, then open Derek in the external browser so the user can
// paste and discuss. (Derek has no CORS/prefill, so we can't inject it directly.)
async function discussCurrentShotWithDerek() {
    const md = await buildCurrentShotSummary();
    if (md == null) return;
    const ok = await copyText(md);
    showToast(getTranslation(ok ? 'Summary copied — paste it into Derek' : 'Could not copy summary'), 4000, ok ? 'success' : 'error');
    // Browser: new tab. Webview: window.open returns null, so location.href hands
    // off to the system browser while the skin stays put (reaprime gh#384).
    const win = window.open(DEREK_URL, '_blank');
    if (win) win.opener = null;
    else window.location.href = DEREK_URL;
}

// Guarded long-press on the shot history panel -> options menu. Ignores the
// prev/next buttons so navigation taps still work; no preventDefault on down.
function setupHistoryLongPress() {
    const panel = document.getElementById('shot-history-panel');
    if (!panel || panel.dataset.lpInit) return;
    panel.dataset.lpInit = '1';

    // Suppress OS/browser text selection, the iOS long-press callout, the
    // desktop right-click menu, and drag — otherwise they fire during the hold
    // and pre-empt our long-press menu.
    panel.style.userSelect = 'none';
    panel.style.webkitUserSelect = 'none';
    panel.style.webkitTouchCallout = 'none';
    panel.style.webkitTapHighlightColor = 'transparent';
    panel.style.touchAction = 'manipulation';
    ['contextmenu', 'selectstart', 'dragstart'].forEach((ev) =>
        panel.addEventListener(ev, (e) => e.preventDefault()));

    let timer = null;
    const clear = () => { clearTimeout(timer); timer = null; };
    panel.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, a, input')) return; // let controls work
        clear();
        timer = setTimeout(() => {
            openContextMenu(panel, [
                { label: getTranslation('Discuss with Derek'), onSelect: discussCurrentShotWithDerek },
                { label: getTranslation('Copy Shot Summary'), onSelect: copyCurrentShotSummary },
            ]);
        }, 450);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) =>
        panel.addEventListener(ev, clear));
}

export async function initHistory() {
    try {
        await openDB();
    } catch (error) {
        logger.error('Failed to open IndexedDB:', error);
        return;
    }
    await loadShotHistory();

    setupHistoryLongPress();

    const prevBtn = document.getElementById('history-prev-btn');
    const nextBtn = document.getElementById('history-next-btn');

    prevBtn.onclick = async () => {
        if (currentShotIndex < shots.length - 1) {
            displayShot(currentShotIndex + 1);
        } else if (shots.length < totalAvailable) {
            await loadMoreShots();
            if (currentShotIndex < shots.length - 1) {
                displayShot(currentShotIndex + 1);
            }
        }
    };

    nextBtn.onclick = () => {
        if (currentShotIndex > 0) {
            displayShot(currentShotIndex - 1);
        }
    };

    if (shots.length > 0) {
        displayShot(0);
    } else {
        chart.clearChart();
        clearShotData();
    }
}

export function getNewestShotId() {
    return shots[0]?.id ?? null;
}

// After a shot finishes, REA can take several seconds to persist it to /shots.
// A single fixed-delay reload races that write and silently shows the previous
// shot. Poll the list until a shot newer than `knownNewestId` appears, then
// render it. ponytail: fixed retry budget, not a server-side watcher.
export async function refreshToNewestShot(knownNewestId, tries = 6, intervalMs = 2000) {
    for (let i = 0; i < tries; i++) {
        await loadShotHistory();
        if (shots.length > 0 && shots[0].id !== knownNewestId) {
            displayShot(0);
            return;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    // Gave up waiting — show whatever is newest so the panel isn't left stale.
    if (shots.length > 0) displayShot(0);
}

export async function clearShotHistory() {
    try {
        await openDB();
        await clearShots();
        shots = [];
        totalAvailable = 0;
        logger.info('Shot history cleared.');
        await loadShotHistory();
        if (shots.length > 0) {
            displayShot(0);
        } else {
            chart.clearChart();
            clearShotData();
            const dateEl = document.getElementById('history-date');
            const profileNameEl = document.getElementById('history-profile-name');
            if (dateEl) dateEl.textContent = '';
            if (profileNameEl) profileNameEl.textContent = '';
            document.getElementById('history-prev-btn')?.classList.add('invisible');
            document.getElementById('history-next-btn')?.classList.add('invisible');
        }
    } catch (error) {
        logger.error('Error clearing shot history:', error);
    }
}

export async function updateShot(id, updates) {
    const response = await fetch(`${API_BASE_URL}/shots/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const updated = await response.json();
    const idx = shots.findIndex(s => s.id === id);
    if (idx !== -1) {
        shots[idx] = { ...shots[idx], ...updated };
        await addShot(shots[idx]);
    }
    return updated;
}

export async function deleteCurrentShot() {
    const shot = shots[currentShotIndex];
    const response = await fetch(`${API_BASE_URL}/shots/${shot.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    await idbDeleteShot(shot.id);
    shots.splice(currentShotIndex, 1);
    totalAvailable--;
    if (shots.length === 0) {
        chart.clearChart();
        clearShotData();
        document.getElementById('history-prev-btn')?.classList.add('invisible');
        document.getElementById('history-next-btn')?.classList.add('invisible');
    } else {
        displayShot(Math.min(currentShotIndex, shots.length - 1));
    }
}
