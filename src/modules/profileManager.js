import { logger } from './logger.js';
import { updateWorkflow,sendProfile, getWorkflow, getValueFromStore, setValueInStore, getProfiles, deleteProfile, updateProfileVisibility, uploadProfile, updateProfile, updateProfileMetadata, getShots, getKVKeys, getKVValue } from './api.js';
import { updateProfileName, updateTemperatureDisplay, updateDrinkOut, updateDrinkRatio, updateDoseInDisplay, updateGrindDisplay, updateSteamDisplay, updateHotWaterDisplay, updateFlushDisplay, showToast, setupPressAndHold} from './ui.js';
import { openContextMenu } from './context-menu.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { loadPage } from './router.js'; // Singular and correctly formatted import
import { getTranslation } from './i18n.js';

/**
 * Rename a profile by ID
 * @param {string} profileId - The profile ID
 * @param {string} newTitle - The new title for the profile
 * @returns {Promise} - Resolves when rename is complete
 */
export async function renameProfile(profileId, newTitle) {
    try {
        // Get the current profile data
        const profiles = await getProfiles();
        const profileData = profiles.find(p => p.id === profileId);
        
        if (!profileData) {
            throw new Error(`Profile with ID ${profileId} not found`);
        }
        
        // Update the title
        profileData.profile.title = newTitle;
        
        // Save to API
        await updateProfile(profileId, profileData);
        
        // Update local cache
        if (availableProfiles[profileId]) {
            availableProfiles[profileId].profile.title = newTitle;
            await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        }
        
        logger.info(`Profile renamed to: ${newTitle}`);
        return { success: true, title: newTitle };
    } catch (error) {
        logger.error('Failed to rename profile:', error);
        throw error;
    }
}

const FAV_COUNT = 5;
const PROFILES_PATH = 'profiles/';

const SETTINGS_NAMESPACE = 'streamline-app';
const FAVORITES_KEY = 'favorite-profiles';
const FAVORITES_INITIALIZED_KEY = 'favorite-profiles-initialized';
const UPLOADED_PROFILES_KEY = 'uploaded-profiles';
const DEFAULT_PROFILES_KEY = 'default-profiles';
const DEFAULT_PROFILES_MIGRATED_KEY = 'default-profiles-migrated';
const PROFILES_CACHE_KEY = 'available-profiles-cache';
let favoriteButtons = [];
export let availableProfiles = {};
export let favoriteAssignments = {};
let activeProfileId = null;

function validateButtonIndices() {
    const validAssignments = {};
    let hasInvalid = false;
    for (let i = 0; i < FAV_COUNT; i++) {
        if (favoriteAssignments.hasOwnProperty(i)) {
            validAssignments[i] = favoriteAssignments[i];
        }
    }
    for (const key of Object.keys(favoriteAssignments)) {
        if (!Number.isInteger(+key) || +key < 0 || +key >= FAV_COUNT) {
            hasInvalid = true;
            logger.warn(`Removing invalid button index: ${key}`);
        }
    }
    if (hasInvalid || Object.keys(validAssignments).length !== Object.keys(favoriteAssignments).length) {
        favoriteAssignments = validAssignments;
        logger.info('Validated and normalized button assignments to valid indices (0-' + (FAV_COUNT - 1) + ')');
    }
}

// Global flag to prevent duplicate execution of profile updates
let profileUpdateInProgress = false;

// --- Helper Functions ---

/**
 * Translates a profile title if a translation exists.
 * Looks for a translation key in the format "profile:{title}".
 * If no translation is found, returns the original title.
 * @param {string} title The profile title to translate
 * @returns {string} The translated or original title
 */
export function translateProfileTitle(title) {
    if (!title) return title;
    
    // Try to find a translation for the profile title
    // Translation key format: "profile:{title}"
    
    // Sanitize the title to create a valid translation key
    
    const translatedTitle = getTranslation(title);
    logger.info(`Translating profile title. Original: '${title}', Translation key: '${title}', Translated: '${translatedTitle}'`);
    // If the translation is the same as the key, it means no translation was found
    // Return the original title in that case
    return translatedTitle === title ? title : translatedTitle;
}

async function mergeKVProfiles() {
    try {
        const kvKeys = await getKVKeys('streamline');
        if (!kvKeys || kvKeys.length === 0) return;
        await Promise.all(kvKeys.map(async (key) => {
            try {
                const kvRecord = await getKVValue('streamline', key);
                if (kvRecord && kvRecord.profile) {
                    availableProfiles[kvRecord.id || `kv:${key}`] = kvRecord;
                }
            } catch (e) {
                logger.warn(`Failed to load KV profile ${key}:`, e);
            }
        }));
        logger.info(`Merged ${kvKeys.length} user profile(s) from KV store.`);
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);
    } catch (e) {
        logger.warn('Could not load KV profiles:', e);
    }
}

export async function loadAvailableProfiles() {
    try {
        logger.info('Attempting to load profiles from API...');
        const profilesFromApi = await getProfiles(); // This is an array of ProfileRecords

        // Process and populate in-memory cache
        availableProfiles = {};
        for (const profileRecord of profilesFromApi) {
            availableProfiles[profileRecord.id] = profileRecord;
        }

        logger.info(`Successfully loaded ${Object.keys(availableProfiles).length} profiles from API.`);

        // Sync to IndexedDB as a fallback
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        logger.info('Successfully synced profiles to IndexedDB cache.');

        await mergeKVProfiles();

        return { profilesFrom: 'API' };

    } catch (apiError) {
        logger.warn('API failed. Attempting to load profiles from IndexedDB fallback.', apiError);

        try {
            const profilesFromCache = await getSetting(PROFILES_CACHE_KEY);
            if (profilesFromCache && Object.keys(profilesFromCache).length > 0) {
                availableProfiles = profilesFromCache;
                logger.info(`Successfully loaded ${Object.keys(availableProfiles).length} profiles from IndexedDB cache.`);
                await mergeKVProfiles();
                return { profilesFrom: 'IDB_CACHE' };
            } else {
                logger.error('API failed and IndexedDB cache is empty. No profiles could be loaded.');
                availableProfiles = {};
                await mergeKVProfiles();
                return { profilesFrom: 'NONE' };
            }
        } catch (idbError) {
            logger.error('CRITICAL: API failed and also failed to read from IndexedDB cache.', idbError);
            availableProfiles = {};
            await mergeKVProfiles();
            return { profilesFrom: 'NONE' };
        }
    }
}

function isValidAssignments(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

async function getFavoritesInitializedFlag() {
    try {
        const reaFlag = await getValueFromStore(SETTINGS_NAMESPACE, FAVORITES_INITIALIZED_KEY);
        if (reaFlag === true) return true;
    } catch (e) {
        logger.warn('Could not read favorites-initialized flag from REA store:', e);
    }
    try {
        const idbFlag = await getSetting(FAVORITES_INITIALIZED_KEY);
        if (idbFlag === true) return true;
    } catch (e) {
        logger.warn('Could not read favorites-initialized flag from IDB:', e);
    }
    return false;
}

export async function loadAssignments() {
    logger.info('Loading assignments...');
    try {
        // 1. Try to fetch from the primary source (REA store)
        const reaAssignments = await getValueFromStore(SETTINGS_NAMESPACE, FAVORITES_KEY);

        if (isValidAssignments(reaAssignments)) {
            logger.info('Loaded assignments from REA store.');
            favoriteAssignments = reaAssignments;
            validateButtonIndices();
            // Save validated data back to REA store AND local backup to prevent stale data on next load
            await setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments);
            await setSetting(FAVORITES_KEY, favoriteAssignments);
            return favoriteAssignments;
        }

        // 2. If REA has no data, try the local backup (IndexedDB)
        logger.warn('No assignments in REA store, checking IndexedDB backup...');
        const idbAssignments = await getSetting(FAVORITES_KEY);

        if (isValidAssignments(idbAssignments)) {
            logger.info('Loaded assignments from IndexedDB backup.');
            favoriteAssignments = idbAssignments;
            validateButtonIndices();
            // Save validated data back to REA store AND local backup to prevent stale data on next load
            await setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments);
            await setSetting(FAVORITES_KEY, favoriteAssignments);
            return favoriteAssignments;
        }

        // 3. If neither source has data, leave slots null so init() auto-populates from history/fallbacks.
        logger.info('No assignments found in REA or IDB. Deferring to auto-populate.');
        favoriteAssignments = {};
        for (let i = 0; i < FAV_COUNT; i++) {
            favoriteAssignments[i] = null;
        }

    } catch (error) {
        // This catch block handles network failures when trying to reach the REA store.
        logger.error('Failed to load from REA store. Falling back to IndexedDB.', error);
        try {
            const idbAssignments = await getSetting(FAVORITES_KEY);
            if (isValidAssignments(idbAssignments)) {
                logger.info('Successfully loaded from IndexedDB backup during fallback.');
                favoriteAssignments = idbAssignments;
                validateButtonIndices();
                await setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments);
                await setSetting(FAVORITES_KEY, favoriteAssignments);
            } else {
                 // Both stores empty — leave slots null so init() auto-populates.
                 logger.warn('IndexedDB backup is also empty. Deferring to auto-populate.');
                 favoriteAssignments = {};
                 for (let i = 0; i < FAV_COUNT; i++) {
                     favoriteAssignments[i] = null;
                 }
            }
        } catch (idbError) {
            logger.error('CRITICAL: Failed to load from both REA store and IndexedDB backup.', idbError);
        }
    }
    return favoriteAssignments;
}

async function saveAssignments({ markUserInitialized = true } = {}) {
    logger.info('Saving assignments to REA store and IndexedDB backup...');

    // markUserInitialized: when true, persist a flag indicating user has intentionally
    // set assignments (even an all-empty state via clearing slots). init() reads this
    // to decide whether to auto-populate defaults. autoPopulate passes false so a
    // failed first-run populate can retry on the next launch.
    const tasks = [
        setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments),
        setSetting(FAVORITES_KEY, favoriteAssignments)
    ];
    if (markUserInitialized) {
        tasks.push(setValueInStore(SETTINGS_NAMESPACE, FAVORITES_INITIALIZED_KEY, true));
        tasks.push(setSetting(FAVORITES_INITIALIZED_KEY, true));
    }
    const results = await Promise.allSettled(tasks);

    if (results[0].status === 'fulfilled') {
        logger.info('Assignments saved to REA store successfully.');
    } else {
        logger.error('Failed to save assignments to REA store:', results[0].reason);
    }

    if (results[1].status === 'fulfilled') {
        logger.info('Assignments saved to IndexedDB backup successfully.');
    } else {
        logger.error('Failed to save assignments to IndexedDB backup:', results[1].reason);
    }
}

export function setActiveProfile(profileId) {
    activeProfileId = profileId;
}

export function getActiveProfileRecord() {
    if (!activeProfileId || !availableProfiles[activeProfileId]) return null;
    return availableProfiles[activeProfileId];
}

export async function saveContextToActiveProfile(fields) {
    if (!activeProfileId || !availableProfiles[activeProfileId]) return;
    const profileRecord = availableProfiles[activeProfileId];
    const updatedMetadata = { ...(profileRecord.metadata || {}), ...fields };
    try {
        let updatedRecord;
        if (activeProfileId.startsWith('kv:')) {
            // KV-store profile — save back via KV API, not /profiles REST.
            const kvKey = activeProfileId.slice(3);
            updatedRecord = { ...profileRecord, metadata: updatedMetadata };
            await setValueInStore('streamline', kvKey, updatedRecord);
        } else {
            updatedRecord = await updateProfileMetadata(activeProfileId, updatedMetadata);
        }
        availableProfiles[activeProfileId] = updatedRecord;
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        logger.info(`Saved context to profile ${activeProfileId}:`, fields);
    } catch (error) {
        logger.error('Failed to save context to profile:', error);
    }
}

export async function saveGrindToActiveProfile(grindValue) {
    console.log(`[saveGrindToActiveProfile] grindValue=${grindValue} activeProfileId=${activeProfileId} profileFound=${!!availableProfiles[activeProfileId]}`);
    return saveContextToActiveProfile({ grinderSetting: String(grindValue) });
}

const FAV_MAX_FONT = 22;
const FAV_SINGLE_LINE_MIN = 18; // single-line shrink floor; below this switch to wrap
const FAV_MIN_FONT = 14;        // overall floor (wrap mode)

function fitButtonText(button) {
    const text = button.textContent;
    if (!text || !text.trim()) return;

    const padX = 16; // px-2 = 8px each side
    const padY = 8;
    const maxWidth = button.offsetWidth - padX;
    const maxHeight = button.offsetHeight - padY;
    if (maxWidth <= 0 || maxHeight <= 0) return; // button not visible, skip measurement
    const wordCount = text.trim().split(/\s+/).length;

    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-weight:600;line-height:1.25;';
    span.textContent = text;
    document.body.appendChild(span);

    let fontSize = 0;

    if (wordCount <= 3) {
        // Short names: use FAV_MAX_FONT in wrap mode — two lines at 22px fit easily.
        span.style.whiteSpace = 'normal';
        span.style.width = maxWidth + 'px';
        span.style.textWrap = 'balance';
        span.style.fontSize = FAV_MAX_FONT + 'px';
        fontSize = span.offsetHeight <= maxHeight ? FAV_MAX_FONT : FAV_MIN_FONT;
    } else {
        // Longer names: try single-line shrink down to FAV_SINGLE_LINE_MIN.
        for (let f = FAV_MAX_FONT; f >= FAV_SINGLE_LINE_MIN; f -= 2) {
            span.style.fontSize = f + 'px';
            if (span.offsetWidth <= maxWidth) {
                fontSize = f;
                break;
            }
        }

        // If single-line didn't fit even at FAV_SINGLE_LINE_MIN, switch to wrap mode.
        if (!fontSize) {
            span.style.whiteSpace = 'normal';
            span.style.width = maxWidth + 'px';
            span.style.textWrap = 'balance';
            fontSize = FAV_MIN_FONT;
            for (let f = FAV_SINGLE_LINE_MIN; f >= FAV_MIN_FONT; f -= 2) {
                span.style.fontSize = f + 'px';
                if (span.offsetHeight <= maxHeight) {
                    fontSize = f;
                    break;
                }
            }
        }
    }

    document.body.removeChild(span);
    button.style.fontSize = fontSize + 'px';
}

export function updateButtonUI() {
    const mainPage = document.getElementById('main-page');
    if (mainPage && mainPage.style.display === 'none') return;
    for (let i = 0; i < FAV_COUNT; i++) {
        const button = favoriteButtons[i];
        const profileKey = favoriteAssignments[i];
        const profileRecord = availableProfiles[profileKey];

        if (button && profileRecord && profileRecord.profile) {
            let translatedTitle = translateProfileTitle(profileRecord.profile.title);
            // Strip category prefix: any " / " (space-slash-space) is treated as a
            // category delimiter — keep only the tail. Covers "A. Espresso-Advanced /",
            // "A-Flow /", "B. Espresso-Pressure /" etc.
            if (translatedTitle && translatedTitle.includes(' / ')) {
                translatedTitle = translatedTitle.split(' / ').pop();
            }
            // Strip short uppercase tag prefix like "GHC/", "DE1/" without spaces.
            // Requires 2+ uppercase/digit chars so "A/B testing" or "Light/Medium" stay intact.
            if (translatedTitle) {
                translatedTitle = translatedTitle.replace(/^[A-Z][A-Z0-9]+\s*\/\s*/, '');
            }
            button.textContent = translatedTitle || 'Untitled';
            button.style.fontSize = '';
            fitButtonText(button);
            if (activeProfileId && profileKey === activeProfileId) {
                button.classList.remove('text-[var(--mimoja-blue)]', 'text-[var(--profile-button-text-color)]', 'bg-[var(--profile-button-background-color)]');
                button.classList.add('text-white', 'bg-[var(--mimoja-blue-v2)]');
            } else {
                button.classList.remove('text-white', 'bg-[var(--mimoja-blue-v2)]');
                button.classList.add('text-[var(--mimoja-blue)]', 'text-[var(--profile-button-text-color)]', 'bg-[var(--profile-button-background-color)]');
            }
        }
        else if (button) {
            button.textContent = '';
            button.style.fontSize = '';
            button.classList.remove('text-white', 'bg-[var(--mimoja-blue-v2)]');
            button.classList.add('text-[var(--mimoja-blue)]', 'text-[var(--profile-button-text-color)]', 'bg-[var(--profile-button-background-color)]');
        }
    }
}

export async function verifyProfileChange(sentProfileTitle, retries = 5, delay = 300) {
    if (retries <= 0) {
        logger.error(`Profile verification failed after multiple retries. Sent '${sentProfileTitle}'.`);
        return false;
    }

    const currentWorkflow = await getWorkflow();
    const activeProfileTitle = currentWorkflow?.profile?.title;

    if (sentProfileTitle === activeProfileTitle) {
        logger.info('Verification successful. Active profile matches sent profile.');
        return true;
    } else {
        logger.warn(`Verification attempt failed. Retrying... (${retries - 1} left). Sent: '${sentProfileTitle}', Active: '${activeProfileTitle}'`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return verifyProfileChange(sentProfileTitle, retries - 1, delay);
    }
}

async function handleProfileClick(index) {
    if (index < 0 || index >= FAV_COUNT) {
        logger.error(`Invalid button index ${index} in handleProfileClick - must be between 0 and ${FAV_COUNT - 1}`);
        return;
    }

    // Empty slot: route straight to selector for assignment instead of nagging with a toast
    if (!favoriteAssignments[index] || !availableProfiles[favoriteAssignments[index]]) {
        logger.info(`Tap on unassigned favorite button ${index}. Navigating to profile selector.`);
        sessionStorage.setItem('pendingAssignmentIndex', index);
        loadPage('src/profiles/profile_selector.html');
        return;
    }

    // Add a unique identifier to track this specific call
    const callId = Date.now() + Math.random();
    logger.info(`handleProfileClick called with index ${index}, callId: ${callId}, profileUpdateInProgress: ${profileUpdateInProgress}`);

    // Check the global flag to prevent duplicate execution
    if (profileUpdateInProgress) {
        logger.warn(`Profile update already in progress. Skipping duplicate call with callId: ${callId}`);
        return;
    }

    // Set the global flag to indicate a profile update is in progress
    profileUpdateInProgress = true;

    // Get the button element to apply waiting state
    const button = favoriteButtons[index];

    // Apply waiting state to the button by replacing the background class
    if (button) {
        button.classList.remove('bg-[var(--profile-button-background-color)]');
        button.classList.add('bg-[var(--fav-button-wait)]');
    }

    const profileKey = favoriteAssignments[index];
    const profileRecord = availableProfiles[profileKey];

    const profile = profileRecord.profile;

    logger.info(`Sending profile '${profile.title}' to REA (callId: ${callId})...`);
    let profileSuccessfullySet = false;
    const meta = profileRecord.metadata || {};
    const savedGrind = meta.grinderSetting ?? null;
    const grindContext = savedGrind != null ? { grinderSetting: savedGrind } : { grinderSetting: null };
    const effectiveDose  = meta.targetDoseWeight  ?? (profile.dose_weight   || 18);
    const effectiveYield = meta.targetYield        ?? parseFloat(profile.target_weight);
    try {
        // Skip the sendProfile call since updateWorkflow can handle sending the profile
        logger.info(`Skipping sendProfile call, using updateWorkflow directly (callId: ${callId})`);

        let workflowResponse;
        if (profile.target_weight) {
            const workflowUpdate = {
                profile: profile,
                context: {
                    targetDoseWeight: effectiveDose,
                    targetYield: effectiveYield,
                    ...grindContext
                }
            };
            workflowResponse = await updateWorkflow(workflowUpdate);
            updateDrinkOut(effectiveYield);
            updateDoseInDisplay(effectiveDose);
            updateDrinkRatio();
        } else {
            workflowResponse = await updateWorkflow({ profile, context: { ...grindContext } });
            const displayYield = isNaN(effectiveYield) ? 0 : effectiveYield;
            updateDrinkOut(displayYield);
            updateDoseInDisplay(effectiveDose);
            updateDrinkRatio();
        }

        // Use the response from updateWorkflow to confirm the profile was set
        if (workflowResponse && workflowResponse.profile && workflowResponse.profile.title === profile.title) {
            profileSuccessfullySet = true;
            logger.info(`Profile successfully set (callId: ${callId})`);
            const translatedTitle = translateProfileTitle(profile.title);
            updateProfileName(translatedTitle);
            if (profile.steps && profile.steps.length > 0) {
                updateTemperatureDisplay(profile.steps[0].temperature);
            }

            if (savedGrind != null) {
                updateGrindDisplay({ grinderSetting: savedGrind });
            } else {
                const grindEl = document.getElementById('grind-value');
                if (grindEl) grindEl.textContent = '0';
            }

            activeProfileId = profileKey;

            favoriteButtons.forEach((btn, i) => {
                const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                const activeTextClass = 'text-white';
                const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                if (i === index) {
                    btn.classList.add(activeBgClass, activeTextClass);
                    btn.classList.remove(inactiveTextClass, defaultTextClass, defaultBgClass);
                } else {
                    btn.classList.remove(activeBgClass, activeTextClass);
                    btn.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                }
            });
        } else {
            logger.warn(`Profile may not have been set correctly (callId: ${callId}). Response did not match expected profile.`);
        }
    }
    catch (error) {
        logger.error(`Failed to update profile (callId: ${callId}):`, error);
    } finally {
        // Always reset the flag in the finally block to ensure it gets reset even if there's an error
        profileUpdateInProgress = false;
        // Remove the waiting state from the button and restore original background only on failure
        if (button) {
            button.classList.remove('bg-[var(--fav-button-wait)]');
            if (!profileSuccessfullySet) {
                button.classList.add('bg-[var(--profile-button-background-color)]');
            }
        }
        logger.info(`handleProfileClick completed (callId: ${callId}), reset profileUpdateInProgress flag`);
    }
}

export async function assignProfile(buttonIndex, profileKey) {
    if (buttonIndex < 0 || buttonIndex >= FAV_COUNT) {
        logger.error(`Invalid button index ${buttonIndex} passed to assignProfile - must be between 0 and ${FAV_COUNT - 1}`);
        return;
    }

    // Reject if profileKey already assigned to another favorite button.
    if (profileKey) {
        for (let i = 0; i < FAV_COUNT; i++) {
            if (i !== buttonIndex && favoriteAssignments[i] === profileKey) {
                logger.info(`Rejecting assign: profile '${profileKey}' already on button ${i}.`);
                showToast(`Profile already assigned to favorite ${i + 1}`, 3000, 'error');
                document.getElementById('profile_modal')?.close();
                return;
            }
        }
    }

    logger.info(`Assigning profile '${profileKey}' to button ${buttonIndex}`);
    favoriteAssignments[buttonIndex] = profileKey;
    await saveAssignments();
    updateButtonUI();
    document.getElementById('profile_modal')?.close();
}

function openProfileSelectionModal(buttonIndex) {
    currentButtonIndex = buttonIndex;
    const modal = document.getElementById('profile_modal');
    const container = document.getElementById('profile-list-container');
    if (!modal || !container) return;

    container.innerHTML = ''; // Clear previous list

    for (const profileKey in availableProfiles) {
        const profileRecord = availableProfiles[profileKey];
        if (profileRecord && profileRecord.profile) {
            const item = document.createElement('button');
            item.className = 'btn btn-ghost justify-start';
            const translatedTitle = translateProfileTitle(profileRecord.profile.title);
            item.textContent = translatedTitle;
            item.addEventListener('click', () => {
                assignProfile(buttonIndex, profileKey);
            });
            container.appendChild(item);
        }
    }

    modal.showModal();
}

function openFavoriteContextMenu(button, index) {
    const profileKey = favoriteAssignments[index];
    const profileRecord = profileKey ? availableProfiles[profileKey] : null;
    const assigned = !!profileRecord;
    const title = assigned ? translateProfileTitle(profileRecord.profile.title) : null;

    const items = assigned
        ? [
            { label: `Edit "${title}"`, onSelect: () => {
                window.__pendingEditProfile = profileRecord;
                loadPage('src/profiles/profile_editor.html');
            } },
            { label: 'Replace with…', onSelect: () => {
                sessionStorage.setItem('pendingAssignmentIndex', index);
                loadPage('src/profiles/profile_selector.html');
            } },
            { divider: true },
            { label: 'Clear slot', danger: true, onSelect: async () => {
                favoriteAssignments[index] = null;
                await saveAssignments();
                updateButtonUI();
                showToast(`Favorite ${index + 1} cleared`, 2000, 'info');
            } },
        ]
        : [
            { label: 'Browse profiles…', onSelect: () => {
                sessionStorage.setItem('pendingAssignmentIndex', index);
                loadPage('src/profiles/profile_selector.html');
            } },
        ];

    openContextMenu(button, items);
}

export async function handleProfileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const fileContent = await file.text();
        const profile = JSON.parse(fileContent);

        // Enhanced client-side validation before sending
        const validationResult = validateProfileStructure(profile);
        if (!validationResult.isValid) {
            throw new Error(validationResult.errorMessage);
        }

        logger.info(`Uploading new profile: ${profile.title}`);

        // Try API, then update local cache on success
        const newProfileRecord = await uploadProfile(profile);

        // API call succeeded, now update local state and cache
        availableProfiles[newProfileRecord.id] = newProfileRecord;
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);

        logger.info(`Profile '${newProfileRecord.profile.title}' uploaded successfully with ID ${newProfileRecord.id}.`);
        showToast(`Profile '${newProfileRecord.profile.title}' uploaded.`, 3000, 'success');

        // Dispatch a custom event to notify the UI that the profile list has been updated.
        // The page-specific JS (e.g., profile_selector.js) should listen for this.
        document.dispatchEvent(new CustomEvent('profiles-updated'));

    } catch (error) {
        logger.error('Failed to upload profile:', error);
        showToast(`Error uploading profile: ${error.message}`,5000,'error');
    } finally {
        // Reset the input so the user can upload the same file again
        event.target.value = '';
    }
}

// Enhanced validation function to check for specific missing fields
export function validateProfileStructure(profile) {
    // Check if profile is a valid object
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return {
            isValid: false,
            errorMessage: 'Uploaded file does not contain a valid profile object.'
        };
    }

    // Define required keys for a valid profile
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

    // Find missing keys
    const missingKeys = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(profile, key));

    if (missingKeys.length > 0) {
        const missingKeysString = missingKeys.join(', ');
        return {
            isValid: false,
            errorMessage: `Uploaded profile is missing required field(s): ${missingKeysString}.`
        };
    }

    // Validate that 'steps' is an array
    if (!Array.isArray(profile.steps)) {
        return {
            isValid: false,
            errorMessage: "Uploaded profile's 'steps' property is not an array."
        };
    }

    // If all validations pass
    return {
        isValid: true,
        errorMessage: null
    };
}

export async function deleteOrHideProfile(profileId) {
    const profileRecord = availableProfiles[profileId];
    if (!profileRecord) {
        logger.error(`Profile with ID ${profileId} not found in local cache.`);
        showToast(`Error: Profile not found.`, 5000, 'error');
        return;
    }
    const isDefault = profileRecord.isDefault;

    logger.info(`Requesting action for profile ID: ${profileId}. Is default: ${isDefault}`);

    if (isDefault) {
        // HIDE a default profile
        try {
            const updatedProfile = await updateProfileVisibility(profileId, 'hidden');
            availableProfiles[profileId] = updatedProfile;
            await setSetting(PROFILES_CACHE_KEY, availableProfiles);

            logger.info(`Profile ${profileId} successfully hidden.`);
            document.dispatchEvent(new CustomEvent('profiles-updated'));
            showToast('Default profile hidden.', 3000, 'success');
        } catch (error) {
            logger.error(`Failed to hide profile ${profileId}:`, error);
            showToast(`Error hiding profile: ${error.message}`, 5000, 'error');
        }
    } else {
        // DELETE a user-uploaded profile
        try {
            await deleteProfile(profileId);

            delete availableProfiles[profileId];

            await setSetting(PROFILES_CACHE_KEY, availableProfiles);

            logger.info(`Profile ${profileId} successfully deleted from backend and removed from local cache.`);

            document.dispatchEvent(new CustomEvent('profiles-updated'));
            showToast('Profile deleted.', 3000, 'success');

        } catch (error) {
            logger.error(`Failed to delete profile ${profileId}:`, error);
            showToast(`Error deleting profile: ${error.message}`, 5000, 'error');
        }
    }
}

export async function unhideProfile(profileId) {
    logger.info(`Requesting to unhide profile ID: ${profileId}`);
    try {
        // The new record is returned on success
        const updatedProfileRecord = await updateProfileVisibility(profileId, "visible");

        // Update local cache with the returned record
        availableProfiles[profileId] = updatedProfileRecord;

        // Update IndexedDB cache
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);

        logger.info(`Profile ${profileId} successfully unhidden.`);

        // Dispatch event to notify UI
        document.dispatchEvent(new CustomEvent('profiles-updated'));
        showToast('Profile restored.', 3000, 'success');

    } catch (error) {
        logger.error(`Failed to unhide profile ${profileId}:`, error);
        showToast(`Error: ${error.message}`, 5000, 'error');
    }
}

export function getHiddenProfiles() {
    return Object.values(availableProfiles).filter(p => p.visibility === 'hidden');
}

// --- Auto-populate favorites from shot history "default" "best_practice" "80s_Espresso" "rao_allonge" "Gentle and sweet"---

const FALLBACK_PROFILE_TITLES = [
    'Default',
    'Best practice (light roast)',
    "80's Espresso",
    'Rao Allongé',
    'Gentle and sweet',
];

function findProfileKeyByTitle(title) {
    const lower = title.toLowerCase();
    return Object.keys(availableProfiles).find(
        k => availableProfiles[k]?.profile?.title?.toLowerCase() === lower
    ) || null;
}

async function autoPopulateFavoritesFromHistory() {
    const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - THREE_WEEKS_MS).toISOString();

    let shots = [];
    try {
        const data = await getShots({ limit: 200, order: 'desc' });
        shots = (data.items ?? []).filter(s => s.timestamp >= cutoff);
    } catch (e) {
        logger.warn('autoPopulateFavoritesFromHistory: could not fetch shots, using fallbacks', e);
        shots = [];
    }
    if (shots.length === 0) {
        logger.info('autoPopulateFavoritesFromHistory: no history, assigning FALLBACK_PROFILE_TITLES by position');
        for (let i = 0; i < FAV_COUNT; i++) {
            const title = FALLBACK_PROFILE_TITLES[i];
            favoriteAssignments[i] = title ? (findProfileKeyByTitle(title) || null) : null;
        }
    } else {
        // Count frequency by profile key from shot history.
        const freq = new Map();
        for (const shot of shots) {
            const title = shot.workflow?.profile?.title;
            if (!title) continue;
            const key = findProfileKeyByTitle(title);
            if (!key) continue;
            freq.set(key, (freq.get(key) || 0) + 1);
        }

        const topKeys = [...freq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, FAV_COUNT)
            .map(([k]) => k);

        logger.info('autoPopulateFavoritesFromHistory: top by frequency',
            topKeys.map(k => ({ key: k, title: availableProfiles[k]?.profile?.title, count: freq.get(k) })));

        for (let i = 0; i < FAV_COUNT; i++) {
            favoriteAssignments[i] = topKeys[i] || null;
        }
    }

    // Secondary fallback: if all assignments are still null (named profiles not found,
    // or history profiles unresolvable), fill with first FAV_COUNT profiles alphabetically.
    const allStillNull = Object.values(favoriteAssignments).every(v => v === null || v === undefined);
    if (allStillNull) {
        logger.warn('autoPopulateFavoritesFromHistory: named/history profiles not found, falling back to first available profiles');
        const sortedKeys = Object.keys(availableProfiles)
            .filter(k => availableProfiles[k]?.profile?.title)
            .sort((a, b) => (availableProfiles[a].profile.title).localeCompare(availableProfiles[b].profile.title));
        for (let i = 0; i < FAV_COUNT; i++) {
            favoriteAssignments[i] = sortedKeys[i] || null;
        }
    }

    await saveAssignments({ markUserInitialized: false });
    updateButtonUI();

    // Best-effort: recipe sidebar pre-fill from the most recent shot.
    const latest = shots[0];
    if (latest?.workflow) applyWorkflowToMainPageUI(latest.workflow, { updateName: false });
}

export function applyWorkflowToMainPageUI(workflow, { updateName = true } = {}) {
    if (!workflow) return;
    const context = workflow.context;

    const dose = context?.targetDoseWeight ?? workflow.doseData?.doseIn;
    const yield_ = context?.targetYield ?? workflow.doseData?.drinkOut;
    const grind = context?.grinderSetting ?? workflow.grinderData?.setting;
    const brewTemp = workflow.profile?.steps?.[0]?.temperature;
    const steamDuration = workflow.steamSettings?.duration;
    const steamFlow = workflow.steamSettings?.flow;
    const hotWaterVol = workflow.hotWaterData?.volume;
    const hotWaterTemp = workflow.hotWaterData?.targetTemperature;
    const flushDuration = workflow.rinseData?.duration;

    if (updateName && workflow.profile?.title) updateProfileName(workflow.profile.title);

    if (dose != null) updateDoseInDisplay(dose);
    if (yield_ != null) { updateDrinkOut(yield_); updateDrinkRatio(); }
    if (grind != null) updateGrindDisplay({ grinderSetting: String(grind) });
    if (brewTemp != null) updateTemperatureDisplay(brewTemp);
    if (steamDuration != null || steamFlow != null) {
        updateSteamDisplay({
            ...(steamDuration != null && { targetSteamDuration: steamDuration }),
            ...(steamFlow != null && { targetSteamFlow: steamFlow }),
        });
    }
    if (hotWaterVol != null || hotWaterTemp != null) {
        updateHotWaterDisplay({
            ...(hotWaterVol != null && { targetHotWaterVolume: hotWaterVol }),
            ...(hotWaterTemp != null && { targetHotWaterTemp: hotWaterTemp }),
        });
    }
    if (flushDuration != null) updateFlushDisplay(flushDuration);
}

// --- Initialization ---

export async function init() {
    logger.info('Profile Manager init started.');
    let profileLoadStatus = {};

    try {
        // Clear the existing button array to ensure we're working with fresh DOM elements
        favoriteButtons = [];

        for (let i = 0; i < FAV_COUNT; i++) {
            const button = document.getElementById(`fav-profile-btn-${i}`);
            if (button) {
                favoriteButtons.push(button);
            } else {
                logger.warn(`Favorite button fav-profile-btn-${i} not found in DOM`);
            }
        }

        await openDB(); // Still needed for the backup functionality

        profileLoadStatus = await loadAvailableProfiles();
        await loadAssignments();

        const allEmpty = Object.values(favoriteAssignments).every(v => v === null || v === undefined);
        // If user has previously saved assignments (even all-empty via clearing slots),
        // respect that choice and skip auto-populate.
        const userInitialized = await getFavoritesInitializedFlag();
        if (allEmpty && !userInitialized) {
            logger.info('No favorite assignments found — auto-populating from shot history.');
            await autoPopulateFavoritesFromHistory();
        } else {
            if (allEmpty) logger.info('All favorites empty but user-initialized marker set — skipping auto-populate.');
            updateButtonUI();
        }

        document.addEventListener('streamline:languagechange', () => updateButtonUI());

        // Only attach event listeners to buttons that were found in the DOM
        favoriteButtons.forEach((originalButton, index) => {
            // Remove any existing listeners first to prevent duplicates by cloning the element
            const clonedButton = originalButton.cloneNode(true);
            originalButton.parentNode.replaceChild(clonedButton, originalButton);

            // Update our reference to point to the cloned button
            favoriteButtons[index] = clonedButton;

            clonedButton.classList.add('no-select', 'has-context-menu');
            // Clear the dataset flag so setupPressAndHold re-wires after the cloneNode
            delete clonedButton.dataset.pressHoldInit;

            const clickCallback = () => {
                handleProfileClick(index).catch(err => logger.error('handleProfileClick failed', err));
            };

            const longPressCallback = () => {
                openFavoriteContextMenu(clonedButton, index);
            };

            setupPressAndHold(clonedButton, clickCallback, longPressCallback);
        });

        // Note: This assumes a specific DOM structure which may not exist on all pages using this module.
        const uploadButton = document.getElementById('upload-profile-btn');
        const fileInput = document.getElementById('profile-upload-input');
        if (uploadButton && fileInput) {
            // Remove existing listeners to prevent duplicates by cloning the element
            const newUploadButton = uploadButton.cloneNode(true);
            uploadButton.parentNode.replaceChild(newUploadButton, uploadButton);

            newUploadButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            });
            fileInput.addEventListener('change', handleProfileUpload);
        }

    } catch (error) {
        logger.error('CRITICAL: Error during Profile Manager initialization:', error);
    }

    logger.info('Profile Manager initialized.');
    return profileLoadStatus;
}