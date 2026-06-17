import * as chart from './chart.js';
import { logger } from './logger.js';
import { openDB, getAllShots, addShot, deleteShot as idbDeleteShot, clearShots } from './idb.js';
import { API_BASE_URL } from './api.js';
import { renderPastShot, clearShotData } from './shotData.js';
import { getTranslation } from './i18n.js';

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

export async function initHistory() {
    try {
        await openDB();
    } catch (error) {
        logger.error('Failed to open IndexedDB:', error);
        return;
    }
    await loadShotHistory();

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
