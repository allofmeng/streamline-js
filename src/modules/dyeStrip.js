// dyeStrip.js — Phase B of the DYE2 → Streamline dashboard bridge.
//
// Streamline's header carries a vertical P / F / R toggle (top-left):
//   P = Profile favourites  (the existing profile <nav>, untouched — DEFAULT)
//   F = DYE2 auto-favourites (bean + recipe snapshots)
//   R = DYE2 recipes
// F and R are driven by data DYE2 writes to the generic KV store; Streamline is a
// read-only consumer (see dye2-plugin/KV_CONTRACT.md). When the DYE2 keys are
// empty/missing the header behaves exactly as today: default P, F/R render empty.
//
// Apply semantics mirror dye2-plugin/src/pages/dashboard.ts (applyAutoFavourite /
// applyRecipe): PUT the item's ready-made `workflow` ({context, profile?}); for
// recipes ALSO live-merge steam / hot-water / flush onto the fetched workflow
// (those need targetTemperature/flow a recipe doesn't capture, so they can't live
// in the stored `workflow`). Legacy items without `workflow` fall back to
// snapshot+copyMask / dashboardVariables.

import { API_BASE_URL, getWorkflow, updateWorkflow, getDye2KvArray } from './api.js';
import { applyWorkflowToMainPageUI } from './profileManager.js';
import { logger } from './logger.js';

const AF_KEY = 'autoFavourites';
const RECIPES_KEY = 'recipes';
const MODE_KEY = 'streamline.dyeStripMode';
// Master on/off for the whole DYE2 header UI (set in Extensions settings).
// DEFAULT OFF: when this is not 'true' the header is byte-identical to stock
// Streamline (profile favourites only, no toggle / DYE button / strip).
const ENABLED_KEY = 'streamline.dye2Enabled';
const PLUGIN_BASE = `${API_BASE_URL}/plugins/dye2.reaplugin`; // …/api/v1/plugins/dye2.reaplugin
const MAX_FAV_CELLS = 4; // + a trailing "VIEW ALL AUTO FAV" cell

// Cell classes mirror the existing profile favourite buttons (index.html) so the
// F/R strip is visually identical to the P strip.
const CELL_BASE =
    'flex justify-center items-center text-center text-balance px-3 leading-tight ' +
    'line-clamp-2 [overflow-wrap:anywhere] w-[240px] h-[98px] text-[22px] rounded-[19px] ' +
    'border-2 font-semibold cursor-pointer';
const CELL_IDLE = ' border-[var(--profile-button-outline-color)] bg-[var(--profile-button-background-color)] text-[var(--profile-button-text-color)]';
const CELL_ACTIVE = ' border-[var(--mimoja-blue)] bg-[var(--mimoja-blue-v2)] text-white';
const CELL_ACCENT = ' border-[var(--mimoja-blue)] bg-[var(--box-color)] text-[var(--mimoja-blue)]'; // VIEW ALL

let favCache = [];
let recipeCache = [];
let currentMode = 'P';
let activeItemId = null; // transient highlight of the last-applied F/R cell

// ─── Data ────────────────────────────────────────────────────────────────────

export async function loadDyeStripData() {
    const [favs, recipes] = await Promise.all([
        getDye2KvArray(AF_KEY),
        getDye2KvArray(RECIPES_KEY),
    ]);
    favCache = Array.isArray(favs) ? favs : [];
    recipeCache = Array.isArray(recipes) ? recipes : [];
    logger.info(`dyeStrip: loaded ${favCache.length} favs, ${recipeCache.length} recipes`);
}

function visibleFavs() {
    return favCache
        .filter(f => f && f.alwaysOnDashboard !== false)
        .sort((a, b) => {
            const sa = a.favSlot ?? Infinity, sb = b.favSlot ?? Infinity;
            if (sa !== sb) return sa - sb;
            return String(a.capturedAt || '').localeCompare(String(b.capturedAt || ''));
        })
        .slice(0, MAX_FAV_CELLS);
}

function favLabel(fav) {
    const snp = fav.snapshot || {};
    return fav.subtitle || snp.coffeeName || fav.title || 'Favourite';
}

function recipeLabel(recipe) {
    return recipe.title || recipe.name || 'Recipe';
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function makeCell(label, extraClass, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CELL_BASE + extraClass;
    btn.textContent = label;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
}

export function renderStrip(mode) {
    const strip = document.getElementById('dye-strip');
    if (!strip) return;
    strip.innerHTML = '';

    if (mode === 'F') {
        const favs = visibleFavs();
        favs.forEach(fav => {
            const active = fav.id != null && fav.id === activeItemId;
            const cell = makeCell(favLabel(fav), active ? CELL_ACTIVE : CELL_IDLE, () => {
                activeItemId = fav.id;
                renderStrip('F');
                applyFavourite(fav).catch(e => logger.error('applyFavourite failed', e));
            });
            strip.appendChild(cell);
        });
        // Trailing "VIEW ALL AUTO FAV" cell (always present, opens the DYE2 page).
        strip.appendChild(makeCell('VIEW ALL AUTO FAV', CELL_ACCENT, () => openPluginOverlay('auto-favs')));
        if (favs.length === 0) {
            // Nothing captured yet — a soft hint before the VIEW ALL cell.
            const hint = document.createElement('span');
            hint.className = 'flex items-center text-[20px] text-[var(--low-contrast-white)] px-2';
            hint.textContent = 'No auto-favourites yet';
            strip.insertBefore(hint, strip.firstChild);
        }
    } else if (mode === 'R') {
        const recipes = recipeCache.slice(0, 5);
        if (recipes.length === 0) {
            const hint = document.createElement('span');
            hint.className = 'flex items-center text-[20px] text-[var(--low-contrast-white)] px-2';
            hint.textContent = 'No recipes yet';
            strip.appendChild(hint);
        }
        recipes.forEach(recipe => {
            const active = recipe.id != null && recipe.id === activeItemId;
            const cell = makeCell(recipeLabel(recipe), active ? CELL_ACTIVE : CELL_IDLE, () => {
                activeItemId = recipe.id;
                renderStrip('R');
                applyRecipe(recipe).catch(e => logger.error('applyRecipe failed', e));
            });
            strip.appendChild(cell);
        });
    }
}

// ─── Apply ─────────────────────────────────────────────────────────────────────

// Fetch the live workflow, merge the item onto it, PUT, then refresh the left
// controls — the same GET→mutate→PUT shape DYE2's dashboard.ts uses so no other
// workflow field is clobbered.
export async function applyFavourite(fav) {
    if (!fav) return;
    const live = (await getWorkflow()) || {};
    if (fav.workflow) {
        applyStoredWorkflow(live, fav.workflow);
    } else {
        applyFavLegacy(live, fav); // snapshot + copyMask
    }
    await updateWorkflow(live);
    await refreshAfterApply();
}

export async function applyRecipe(recipe) {
    if (!recipe) return;
    const live = (await getWorkflow()) || {};
    if (recipe.workflow) {
        applyStoredWorkflow(live, recipe.workflow);
    } else {
        applyRecipeLegacy(live, recipe); // dashboardVariables + top-level fields
    }
    // Steam / hot-water / flush are NOT in the stored workflow — live-merge them.
    mergeRecipeLiveSettings(live, recipe.dashboardVariables || {});
    await updateWorkflow(live);
    await refreshAfterApply();
}

// The stored `workflow` is a ready-to-PUT { context, profile? }. Merge its context
// over the live context (preserving fields it doesn't set) and its profile if any.
function applyStoredWorkflow(live, workflow) {
    live.context = { ...(live.context || {}), ...(workflow.context || {}) };
    if (workflow.profile) live.profile = workflow.profile;
}

// Legacy favourite (no `workflow`): copyMask-gated snapshot → context. Mirrors
// dashboard.ts applyAutoFavourite. Absent mask key ⇒ on.
function applyFavLegacy(live, fav) {
    const snp = fav.snapshot || {};
    const mask = fav.copyMask || {};
    const on = k => mask[k] !== false;
    const ctx = { ...(live.context || {}) };
    if (on('dose') && snp.dose != null) ctx.targetDoseWeight = snp.dose;
    if (on('drink') && snp.drink != null) ctx.targetYield = snp.drink;
    if (on('grindSetting')) {
        if (snp.grindSetting != null) ctx.grinderSetting = String(snp.grindSetting);
        if (snp.rpm != null) ctx.extras = { ...(ctx.extras || {}), rpm: snp.rpm };
    }
    if (on('grinder')) {
        if (snp.grinderId) ctx.grinderId = snp.grinderId;
        if (snp.grinderModel) ctx.grinderModel = snp.grinderModel;
    }
    if (on('beans')) {
        if (snp.beanBatchId) ctx.beanBatchId = snp.beanBatchId;
        if (snp.coffeeName) ctx.coffeeName = snp.coffeeName;
        if (snp.coffeeRoaster) ctx.coffeeRoaster = snp.coffeeRoaster;
    }
    if (on('roastDate') && snp.roastDate) ctx.roastDate = snp.roastDate;
    if (on('barista') && snp.barista) ctx.baristaName = snp.barista;
    if (on('drinker') && snp.drinker) ctx.drinkerName = snp.drinker;
    if (on('note') && snp.note) ctx.extras = { ...(ctx.extras || {}), note: snp.note };
    live.context = ctx;
    if (on('profile') && (snp.profileId || snp.profileTitle)) {
        live.profile = { id: snp.profileId, title: snp.profileTitle };
    }
}

// Legacy recipe (no `workflow`): dashboardVariables → context. Mirrors dashboard.ts
// applyRecipe (context portion; steam/hw/flush handled by mergeRecipeLiveSettings).
function applyRecipeLegacy(live, recipe) {
    const dv = recipe.dashboardVariables || {};
    const ctx = { ...(live.context || {}) };
    if (dv.dose != null) ctx.targetDoseWeight = dv.dose;
    if (dv.drink != null) ctx.targetYield = dv.drink;
    else if (dv.ratio != null && dv.dose != null) ctx.targetYield = Math.round(dv.dose * dv.ratio * 10) / 10;
    if (dv.grind != null) ctx.grinderSetting = String(dv.grind);
    if (dv.rpm != null) ctx.extras = { ...(ctx.extras || {}), rpm: dv.rpm };
    if (dv.grinderId) ctx.grinderId = dv.grinderId;
    if (recipe.barista) ctx.baristaName = recipe.barista;
    if (recipe.drinker) ctx.drinkerName = recipe.drinker;
    live.context = ctx;
    if (recipe.profileId || recipe.profileTitle) {
        live.profile = { id: recipe.profileId, title: recipe.profileTitle };
    }
}

// Override only the recipe's steam/hot-water/flush fields on the LIVE sub-objects
// (which already carry the required targetTemperature/flow). Guarded so we never
// send a partial. Identical to dashboard.ts applyRecipe.
function mergeRecipeLiveSettings(wf, dv) {
    if (wf.steamSettings && (dv.steamTimeS != null || dv.steamFlowMls != null)) {
        const ss = { ...wf.steamSettings };
        if (dv.steamMode === 'time' && dv.steamTimeS != null) ss.duration = dv.steamTimeS;
        if (dv.steamMode === 'flow' && dv.steamFlowMls != null) ss.flow = dv.steamFlowMls;
        wf.steamSettings = ss;
    }
    if (wf.hotWaterData && (dv.hotWaterMl != null || dv.hotWaterTempC != null)) {
        const hw = { ...wf.hotWaterData };
        if (dv.hotWaterMode === 'vol' && dv.hotWaterMl != null) hw.volume = dv.hotWaterMl;
        if (dv.hotWaterMode === 'temp' && dv.hotWaterTempC != null) hw.targetTemperature = dv.hotWaterTempC;
        wf.hotWaterData = hw;
    }
    if (wf.rinseData && dv.flushS != null) {
        wf.rinseData = { ...wf.rinseData, duration: dv.flushS };
    }
}

// Re-pull the workflow and update the left-rail controls — the same path used on
// initial load / after a profile change (window.loadInitialData is set by app.js).
async function refreshAfterApply() {
    try {
        if (typeof window.loadInitialData === 'function') {
            await window.loadInitialData();
            return;
        }
        const wf = await getWorkflow();
        applyWorkflowToMainPageUI(wf);
    } catch (e) {
        logger.error('dyeStrip refreshAfterApply failed', e);
    }
}

// ─── DYE2 page navigation (iframe overlay, same-origin) ────────────────────────
//
// In production reaprime serves the skin and the plugin from the same origin, so
// the DYE2 page can load in a same-origin <iframe> overlay and the parent can read
// iframe.contentWindow.location on `load` to detect the plugin returning. The DYE2
// pages honour a `?return=` param; we point it at a sentinel skin URL and close +
// refresh when the iframe navigates there.
//
// In dev the skin (:8000) and bridge (:8080) are cross-origin: X-Frame-Options
// SAMEORIGIN blocks the iframe and reading contentWindow.location throws, so we
// fall back to a full-page navigation with ?return set to this page.

function sentinelReturnUrl() {
    return `${window.location.origin}${window.location.pathname}?dyeReturn=1`;
}

function isSameOrigin(url) {
    try {
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
        return false;
    }
}

export function openPluginOverlay(page) {
    const pluginUrl = `${PLUGIN_BASE}/${page}`;
    const ret = sentinelReturnUrl();

    // Cross-origin (dev): iframe would be blocked → full-page navigation instead.
    if (!isSameOrigin(pluginUrl)) {
        window.location.href = `${pluginUrl}?return=${encodeURIComponent(window.location.href)}`;
        return;
    }

    let overlay = document.getElementById('dye-plugin-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dye-plugin-overlay';
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:9999;background:var(--bgmain-color, #fff);display:flex;flex-direction:column;';
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 12px;background:var(--box-color,#f3f4f6);';
        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.cssText =
            'padding:8px 22px;border:2px solid var(--mimoja-blue);color:var(--mimoja-blue);border-radius:20px;font-weight:600;font-size:20px;cursor:pointer;';
        close.addEventListener('click', closePluginOverlay);
        bar.appendChild(close);
        const frame = document.createElement('iframe');
        frame.id = 'dye-plugin-frame';
        frame.style.cssText = 'flex:1;width:100%;border:0;';
        // Same-origin load handler: when the plugin navigates back to our sentinel
        // return URL, tear down the overlay and refresh the strip + controls.
        frame.addEventListener('load', () => {
            let href = '';
            try { href = frame.contentWindow.location.href; } catch (e) { return; } // cross-origin, ignore
            if (href.includes('dyeReturn=1')) closePluginOverlay(true);
        });
        overlay.appendChild(bar);
        overlay.appendChild(frame);
        document.body.appendChild(overlay);
    }
    const frame = document.getElementById('dye-plugin-frame');
    frame.src = `${pluginUrl}?return=${encodeURIComponent(ret)}`;
    overlay.style.display = 'flex';
}

function closePluginOverlay(refresh) {
    const overlay = document.getElementById('dye-plugin-overlay');
    if (overlay) overlay.style.display = 'none';
    if (refresh) {
        // DYE2 may have applied a fav/recipe or edited the collections while open.
        loadDyeStripData().then(() => { if (currentMode !== 'P') renderStrip(currentMode); }).catch(() => {});
        refreshAfterApply();
    }
}

// ─── Toggle + init ─────────────────────────────────────────────────────────────

export function setStripMode(mode) {
    currentMode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private mode */ }

    // Active pill styling.
    ['P', 'F', 'R'].forEach(m => {
        const pill = document.getElementById(`dye-toggle-${m}`);
        if (!pill) return;
        const active = m === mode;
        pill.classList.toggle('bg-[var(--mimoja-blue-v2)]', active);
        pill.classList.toggle('text-white', active);
        pill.classList.toggle('text-[var(--mimoja-blue)]', !active);
        pill.classList.toggle('bg-[var(--box-color)]', !active);
    });

    // Visibility via inline display (a Tailwind `flex` utility overrides [hidden]).
    const profileNav = document.getElementById('profile-fav-nav');
    const dyeStrip = document.getElementById('dye-strip');
    if (mode === 'P') {
        if (profileNav) profileNav.style.display = '';
        if (dyeStrip) dyeStrip.style.display = 'none';
    } else {
        if (profileNav) profileNav.style.display = 'none';
        if (dyeStrip) dyeStrip.style.display = '';
        renderStrip(mode);
    }
}

// ─── Master enable/disable (gates the whole DYE2 header UI) ─────────────────────

export function isDye2Enabled() {
    try { return localStorage.getItem(ENABLED_KEY) === 'true'; } catch (e) { return false; }
}

let wired = false; // one-time listener wiring, so re-enabling doesn't double-bind

function wireOnce() {
    if (wired) return;
    wired = true;
    ['P', 'F', 'R'].forEach(m => {
        const pill = document.getElementById(`dye-toggle-${m}`);
        if (pill) pill.addEventListener('click', () => setStripMode(m));
    });
    const dyeBtn = document.getElementById('dye-open-btn');
    if (dyeBtn) dyeBtn.addEventListener('click', () => openPluginOverlay('dashboard'));

    // No push channel for the KV store — re-poll on focus / tab visibility so edits
    // DYE2 made while Streamline was idle appear (KV_CONTRACT "Freshness").
    const repoll = () => {
        if (document.hidden || !isDye2Enabled()) return;
        loadDyeStripData().then(() => { if (currentMode !== 'P') renderStrip(currentMode); }).catch(() => {});
    };
    window.addEventListener('focus', repoll);
    document.addEventListener('visibilitychange', repoll);
    // The DYE button is a same-frame top-level nav away to the DYE2 plugin (see
    // openPluginOverlay); returning via the browser Back button restores this page
    // from bfcache — a frozen pre-edit snapshot that fires `pageshow` (persisted),
    // not focus/visibilitychange. Mirrors profile_selector.js's plugin-return guard.
    // getDye2KvArray coerces a fetch error to [] (its own bridge-quirk handling), so
    // a transient failure isn't visible as a rejection here — a fetch fired right as
    // the browser wakes the network stack back up from bfcache can intermittently
    // fail and get read as "no favourites". Retry once shortly after to cover that.
    window.addEventListener('pageshow', () => { repoll(); setTimeout(repoll, 500); });
}

// Reveal the DYE2 UI: shift the profile nav right to make room, show the toggle +
// DYE button, wire listeners, load KV data, restore the saved P/F/R mode.
export async function enableDye2Ui() {
    const profileNav = document.getElementById('profile-fav-nav');
    const toggle = document.getElementById('dye-strip-toggle');
    const dyeBtn = document.getElementById('dye-open-btn');
    if (profileNav) { profileNav.classList.remove('left-[30px]'); profileNav.classList.add('left-[80px]'); }
    if (toggle) toggle.style.display = '';   // revert to class-defined flex
    if (dyeBtn) dyeBtn.style.display = '';
    wireOnce();
    try { await loadDyeStripData(); } catch (e) { logger.error('dyeStrip load failed', e); }
    let saved = 'P';
    try { saved = localStorage.getItem(MODE_KEY) || 'P'; } catch (e) { /* private mode */ }
    setStripMode(saved);
}

// Restore the stock header: hide the toggle + DYE button + strip and move the
// profile nav back to its original position (byte-identical to stock Streamline).
export function disableDye2Ui() {
    const profileNav = document.getElementById('profile-fav-nav');
    const toggle = document.getElementById('dye-strip-toggle');
    const dyeBtn = document.getElementById('dye-open-btn');
    const dyeStrip = document.getElementById('dye-strip');
    if (toggle) toggle.style.display = 'none';
    if (dyeBtn) dyeBtn.style.display = 'none';
    if (dyeStrip) { dyeStrip.style.display = 'none'; dyeStrip.innerHTML = ''; }
    if (profileNav) {
        profileNav.style.display = '';
        profileNav.classList.remove('left-[80px]');
        profileNav.classList.add('left-[30px]');
    }
}

export async function initDyeStrip() {
    // Bridge for the Extensions-settings toggle to flip the header live (the header
    // stays in the DOM behind the settings overlay); if it isn't present the flag
    // still applies on the next dashboard load.
    window.applyDye2Enabled = (on) => { on ? enableDye2Ui() : disableDye2Ui(); };

    if (isDye2Enabled()) await enableDye2Ui();
    else disableDye2Ui();
}
