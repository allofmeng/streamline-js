import * as chart from './chart.js';
import { logger } from './logger.js';
import { openDB, getAllShots, getLatestCachedShot, addShot, addShots, deleteShot as idbDeleteShot, clearShots } from './idb.js';
import { API_BASE_URL } from './api.js';
import { renderPastShot, clearShotData } from './shotData.js';
import { getTranslation } from './i18n.js';
import { generateShotSummary } from './shotSummary.js';
import { openContextMenu } from './context-menu.js';
import { showToast, setupPressAndHold } from './ui.js';

const DEREK_URL = 'https://derek.decentespresso.com/';

const PAGE_SIZE = 20;
let shots = [];
let currentShotIndex = -1;
let totalAvailable = 0;
// id of the shot currently drawn on the chart -- lets displayShot() skip a
// redundant redraw right after paintNewestShotFast() already drew this exact
// shot during boot. Not touched by refreshCurrentShot(), which must always
// force a redraw (it exists specifically to repaint over whatever the
// profile selector left on the shared chart element).
let paintedShotId = null;

// Paints whatever the newest shot in the local IDB cache is, instantly --
// an indexed cursor read, no network wait. May be stale (a shot pulled since
// this cache was last written won't be here yet); paintNewestShotFast()
// below confirms/corrects it against the network moments later.
async function paintFromCacheFast() {
    try {
        const cached = await getLatestCachedShot();
        if (cached?.measurements) {
            chart.plotHistoricalShot(cached.measurements, cached.workflow);
            paintedShotId = cached.id;
            return cached;
        }
    } catch (error) {
        logger.warn('Cache-first shot paint failed:', error);
    }
    return null;
}

// Confirms/corrects the newest shot against the network: /shots/latest
// (cheap, no measurements) tells us the real newest id. If it matches what
// paintFromCacheFast() already painted, cache was current -- no further
// fetch or redraw needed. Otherwise fetches /shots/{id} for the full record
// and draws it. Runs in parallel with loadShotHistory()'s slower 20-item
// list + IDB sync in initHistory(), so the chart isn't gated behind fetching
// shots it doesn't need yet just to confirm/show the first one.
async function paintNewestShotFast(alreadyPaintedId = null, alreadyPaintedShot = null) {
    try {
        const latestResponse = await fetch(`${API_BASE_URL}/shots/latest`);
        if (!latestResponse.ok) return null;
        const latestSummary = await latestResponse.json();
        if (!latestSummary?.id) return null;

        if (latestSummary.id === alreadyPaintedId) {
            return alreadyPaintedShot; // cache was already correct
        }

        const fullResponse = await fetch(`${API_BASE_URL}/shots/${latestSummary.id}`);
        if (!fullResponse.ok) return null;
        const fullShot = { ...latestSummary, ...(await fullResponse.json()) };

        if (fullShot.measurements) {
            chart.plotHistoricalShot(fullShot.measurements, fullShot.workflow);
            paintedShotId = fullShot.id;
        }
        addShot(fullShot); // fire-and-forget cache write, doesn't gate the paint
        return fullShot;
    } catch (error) {
        logger.warn('Fast newest-shot paint failed:', error);
        return null;
    }
}

async function loadShotHistory() {
    try {
        const response = await fetch(`${API_BASE_URL}/shots?limit=${PAGE_SIZE}&offset=0&order=desc`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        totalAvailable = data.total ?? 0;
        // One transaction/commit for the whole page instead of one per shot --
        // addShot() in a loop was serializing up to PAGE_SIZE IDB round trips.
        await addShots(data.items ?? []);
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
            historyLabelEl.textContent = getTranslation('HISTORY');
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
        // Skip the redraw if paintNewestShotFast() already drew this exact
        // shot moments ago during boot -- same data, avoid a pointless second
        // Plotly.react().
        if (paintedShotId !== shot.id) {
            chart.plotHistoricalShot(shots[currentShotIndex].measurements, shots[currentShotIndex].workflow);
            paintedShotId = shot.id;
        }
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

    // Warm the neighbours so the next arrow tap draws without a network stall.
    prefetchMeasurements(index - 1);
    prefetchMeasurements(index + 1);
}

// Fire-and-forget load of a shot's measurements into the cache. No-op if the
// index is out of range or the shot already has data.
function prefetchMeasurements(index) {
    const shot = shots[index];
    if (!shot || shot.measurements) return;
    fetch(`${API_BASE_URL}/shots/${shot.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(full => {
            if (!full || shots[index]?.id !== shot.id || shots[index].measurements) return;
            shots[index] = { ...shots[index], ...full };
            addShot(shots[index]);
        })
        .catch(() => {}); // prefetch is best-effort
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

async function copyMd(md) {
    const ok = await copyText(md);
    showToast(getTranslation(ok ? 'Summary copied to clipboard' : 'Could not copy summary'), 2400, ok ? 'success' : 'error');
}

// Long-press the shot history panel -> options menu. Reuses the shared
// setupPressAndHold helper (same one profile cards use). The nav arrows stop
// their own press from bubbling so navigation taps still work.
//
// We build the summary up front so both actions act on a ready string: "Discuss
// with Derek" is a link item (anchor) — the user's tap opens the OS browser with
// the Derek URL (gh#384) and copies the summary on the same tap to paste.
function setupHistoryLongPress() {
    const panel = document.getElementById('shot-history-panel');
    if (!panel) return;

    // Stop BOTH press and release from reaching the panel. Release matters on
    // touch: the panel's press-and-hold endPress preventDefaults touchend,
    // which suppresses the button's synthetic click — arrows dead on tablets.
    ['history-prev-btn', 'history-next-btn'].forEach((id) => {
        const btn = document.getElementById(id);
        ['mousedown', 'touchstart', 'pointerdown', 'mouseup', 'touchend', 'pointerup'].forEach((ev) =>
            btn?.addEventListener(ev, (e) => e.stopPropagation()));
    });

    setupPressAndHold(panel, () => {}, async () => {
        const md = await buildCurrentShotSummary();
        if (md == null) return;
        openContextMenu(panel, [
            { label: getTranslation('Discuss with Derek'), href: DEREK_URL, onSelect: () => copyMd(md) },
            { label: getTranslation('Copy Shot Summary'), onSelect: () => copyMd(md) },
        ]);
    });
}

export async function initHistory() {
    try {
        await openDB();
    } catch (error) {
        logger.error('Failed to open IndexedDB:', error);
        return;
    }

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

    // Paint instantly from whatever's cached locally, then confirm/correct it
    // against the network in parallel with the slower list+IDB sync below --
    // the chart no longer waits on caching 20 shots it doesn't need yet just
    // to show shot #0.
    const cachedShot = await paintFromCacheFast();
    const fastPaintPromise = paintNewestShotFast(cachedShot?.id, cachedShot);

    await loadShotHistory();
    const fastShot = await fastPaintPromise;

    // Reuse the already-fetched full record so displayShot() below skips its
    // own network fetch (and the paintedShotId guard skips the redraw too).
    if (fastShot && shots.length > 0 && shots[0].id === fastShot.id) {
        shots[0] = fastShot;
    }

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
export async function refreshToNewestShot(knownNewestId, tries = 6, intervalMs = 2000, expectedId = null) {
    for (let i = 0; i < tries; i++) {
        await loadShotHistory();
        // Success = the expected shot id is on top (exact, from the shotState
        // feed) — or, without one, any id newer than what we knew before.
        if (shots.length > 0 && (expectedId ? shots[0].id === expectedId : shots[0].id !== knownNewestId)) {
            await displayShot(0); // labels itself NEWEST
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
