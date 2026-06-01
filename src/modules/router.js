const pageCache = new Map();

function getCleanUrl(pageUrl) {
    const filename = pageUrl.split('/').pop().replace('.html', '');
    return `?page=${filename}`;
}

function getPageUrlFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page');
    
    if (!page || page === 'index') {
        return null; // Main index page
    }
    
    const pageMap = {
        'settings': 'src/settings/settings.html',
        'profile_selector': 'src/profiles/profile_selector.html',
        'profile_editor': 'src/profiles/profile_editor.html',
    };
    return pageMap[page] || null;
}

export function isSubPage() {
    return getPageUrlFromQuery() !== null;
}

export async function initRouter() {
    const pageUrl = getPageUrlFromQuery();
    
    if (pageUrl) {
        await loadPage(pageUrl);
    }
}

window.addEventListener('popstate', async (event) => {
    if (event.state && event.state.pageUrl) {
        await loadPage(event.state.pageUrl);
    }
});
async function fetchPage(url) {
    if (pageCache.has(url)) {
        return pageCache.get(url);
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch page: ${response.statusText}`);
    }
    const text = await response.text();
    pageCache.set(url, text);
    return text;
}

export async function loadPage(pageUrl, containerSelector = '#scaled-content') {
    try {
        const pageHtml = await fetchPage(pageUrl);
        const parser = new DOMParser();
        const doc = parser.parseFromString(pageHtml, 'text/html');

        const newContent = doc.querySelector(containerSelector);
        const mainContainer = document.querySelector(containerSelector);

        if (newContent && mainContainer) {
            // Hide immediately — content will be revealed after initialization is complete
            mainContainer.classList.remove('scaled');

            // Store references to any existing scripts that might be affected
            const existingScripts = Array.from(document.querySelectorAll('script[data-dynamic]'));

            // Clear existing dynamic scripts to avoid conflicts
            existingScripts.forEach(script => {
                if (script.parentNode) {
                    script.parentNode.removeChild(script);
                }
            });

            mainContainer.innerHTML = newContent.innerHTML;

            // Execute scripts from the loaded page
            const scripts = doc.querySelectorAll('script');

            scripts.forEach(script => {
                if (script.src) {
                    // Handle external scripts
                    const newScript = document.createElement('script');

                    // Properly resolve the script URL relative to the page being loaded
                    // The script.src is relative to the HTML file location, not the current page
                    let resolvedSrc;
                    try {
                        // If the script URL is already absolute (starts with /), use it as-is
                        if (script.src.startsWith('/')) {
                            resolvedSrc = script.src;
                        } else {
                            // For relative paths, resolve relative to the page URL
                            resolvedSrc = new URL(script.src, new URL(pageUrl, window.location.origin)).href;

                            // If the path looks like it's going up from src/ to root, adjust accordingly
                            // For example, if pageUrl is /src/profiles/profile_selector.html and script.src is ../modules/profile_selector.js
                            // The resolved path should be /src/modules/profile_selector.js
                            if (pageUrl.includes('/src/') && script.src.startsWith('../')) {
                                const baseUrl = window.location.origin;
                                const pageDir = pageUrl.substring(0, pageUrl.lastIndexOf('/'));
                                resolvedSrc = new URL(script.src, new URL(pageDir, baseUrl)).href;
                            }
                        }
                    } catch (e) {
                        console.error(`Error resolving script URL: ${script.src} relative to ${pageUrl}`, e);
                        // Fallback to a relative path from the root
                        resolvedSrc = script.src.startsWith('/') ? script.src : `/${script.src}`;
                    }

                    newScript.src = resolvedSrc;
                    newScript.type = script.type || 'text/javascript';
                    newScript.setAttribute('data-dynamic', 'true');

                    // Copy other attributes
                    for (let attr of script.attributes) {
                        if (attr.name !== 'src' && attr.name !== 'type') {
                            newScript.setAttribute(attr.name, attr.value);
                        }
                    }

                    // Add error handling for external scripts
                    newScript.onload = () => {
                        console.log(`External script loaded: ${resolvedSrc}`);
                    };
                    newScript.onerror = (error) => {
                        console.error(`Error loading external script: ${resolvedSrc}`, error);
                    };

                    document.head.appendChild(newScript);
                } else {
                    // Handle inline scripts
                    const newScript = document.createElement('script');
                    newScript.textContent = script.textContent;
                    newScript.type = script.type || 'text/javascript';
                    newScript.setAttribute('data-dynamic', 'true');

                    // Copy other attributes
                    for (let attr of script.attributes) {
                        if (attr.name !== 'src' && attr.name !== 'type') {
                            newScript.setAttribute(attr.name, attr.value);
                        }
                    }

                    // For inline scripts, especially modules, we need to be careful about execution timing
                    if (script.type === 'module') {
                        // Module scripts need to be added to the DOM to execute
                        newScript.onload = () => {
                            console.log('Module script loaded');
                        };
                        newScript.onerror = (error) => {
                            console.error('Error loading module script', error);
                        };
                        document.head.appendChild(newScript);
                    } else {
                        // For regular inline scripts, execute immediately after DOM is updated
                        try {
                            document.head.appendChild(newScript);
                            console.log('Inline script executed');
                        } catch (error) {
                            console.error('Error executing inline script', error);
                        } finally {
                            // Clean up immediately after execution
                            setTimeout(() => {
                                if (newScript.parentNode) {
                                    newScript.parentNode.removeChild(newScript);
                                }
                            }, 0);
                        }
                    }
                }
            });

            // Initialize scaling after content is loaded
            try {
                if (window.initScaling) {
                    window.initScaling();
                } else {
                    // Import and initialize scaling if not already available
                    const { initScaling } = await import('./scaling.js');
                    initScaling();
                }

                const cleanUrl = getCleanUrl(pageUrl);
                const pageTitle = cleanUrl.split('/').pop() || 'Streamline';
                window.history.pushState({ pageUrl }, pageTitle, cleanUrl);
            } catch (e) {
                console.warn('Scaling module not available or failed to initialize:', e);
            }

            // After content is injected, yield one frame then initialize
            await new Promise(resolve => requestAnimationFrame(resolve));
            (async () => {
                console.log('Router: About to initialize page. Page URL =', pageUrl);

                document.dispatchEvent(new CustomEvent('dynamic-content-loaded', {
                    detail: { pageUrl, containerSelector }
                }));

                // Dispatch an event to signal that dynamic content has been loaded
                // This can be listened to by modules that need to initialize after content is loaded

                console.log('Router: Checking for initialization. Page URL =', pageUrl);
                console.log('Contains profile_selector.html?', pageUrl.includes('profile_selector.html'));
                console.log('Ends with profile_selector.html?', pageUrl.endsWith('profile_selector.html'));

                // Check if the loaded page has a specific initialization function
                // For profile selector, try to import and call the initialization function
                if (pageUrl.includes('profile_selector.html') || pageUrl.endsWith('profile_selector.html')) {
                    mainContainer.classList.add('scaled');
                    try {
                        const { initializeProfileSelector } = await import('./profile_selector.js');
                        if (initializeProfileSelector) {
                            initializeProfileSelector().catch(e => console.error('Router: Profile selector init error:', e));
                        }
                    } catch (e) {
                        console.error('Router: Error initializing profile selector:', e);
                    }
                } else if (pageUrl.includes('profile_editor.html') || pageUrl.endsWith('profile_editor.html')) {
                    mainContainer.classList.add('scaled');
                    try {
                        const { initializeProfileEditor } = await import('./profile_editor.js');
                        if (initializeProfileEditor) await initializeProfileEditor();
                    } catch (e) {
                        console.error('Router: Error initializing profile editor:', e);
                    }
                } else if (pageUrl.includes('settings.html') || pageUrl.endsWith('settings.html')) {
                    mainContainer.classList.add('scaled');
                    try {
                        const { initializeSettings } = await import('../settings/settings.js');
                        if (initializeSettings) {
                            initializeSettings().catch(e => console.error('Router: Settings init error:', e));
                        } else {
                            console.error('Router: initializeSettings not exported from settings.js');
                        }
                    } catch (e) {
                        console.error('Router: Error importing settings page:', e);
                    }
                } else {
                    // Reinitialize main index page components
                    try {
                        const [i18nModule, uiModule, scalingModule, historyModule, profileManagerModule, shotDataModule, chartModule, waterTankMod, numpadModule, appModule, apiModule] = await Promise.all([
                            import('./i18n.js'),
                            import('./ui.js'),
                            import('./scaling.js'),
                            import('./history.js'),
                            import('./profileManager.js'),
                            import('./shotData.js'),
                            import('./chart.js'),
                            import('./waterTank.js'),
                            import('./numpad-modal.js'),
                            import('./app.js'),
                            import('./api.js'),
                        ]);
                        const { showScaleInfo } = uiModule;

                        // Fast sync setup — no API calls yet
                        await i18nModule.initI18n();
                        uiModule.initUI({ onWeightClick: window.handleWeightClick || (() => {}) });
                        scalingModule.initScaling();
                        shotDataModule.clearShotData();
                        showScaleInfo();
                        chartModule.initChart();

                        // Reattach click handlers to value elements
                        const valueElements = [
                            { id: 'dose-in-value', type: 'dose-in', format: (v) => `${v}g` },
                            { id: 'drink-out-value', type: 'drink-out', format: (v) => `${v}g` },
                            { id: 'temp-value', type: 'temperature', format: (v) => `${v}°c` },
                            { id: 'grind-value', type: 'grind', format: (v) => v },
                            { id: 'steam-duration-value', type: 'steam-duration', format: (v) => `${v}s` },
                            { id: 'steam-flow-value', type: 'steam-flow', format: (v) => v },
                            { id: 'flush-value', type: 'flush', format: (v) => `${v}s` },
                            { id: 'hot-water-vol-value', type: 'hot-water-vol', format: (v) => `${v}ml` },
                            { id: 'hot-water-temp-value', type: 'hot-water-temp', format: (v) => `${v}°c` }
                        ];

                        valueElements.forEach(({ id, type, format }) => {
                            const el = document.getElementById(id);
                            if (!el) return;
                            const newEl = el.cloneNode(true);
                            el.parentNode.replaceChild(newEl, el);
                            newEl.style.cursor = 'pointer';
                            newEl.style.touchAction = 'manipulation';
                            newEl.setAttribute('tabindex', '-1');
                            newEl.addEventListener('click', async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const currentValue = newEl.textContent.replace(/[^0-9.]/g, '') || '0';
                                const mockInput = { value: currentValue, setAttribute: () => {}, dispatchEvent: () => {} };
                                if (numpadModule.openModal) {
                                    numpadModule.openModal(mockInput, {
                                        previousValues: [],
                                        fieldType: type,
                                        onConfirm: (val) => {
                                            newEl.textContent = format(val);
                                            if (type === 'dose-in') { window.app.ui.updateDoseValue('in', val); window.app.ui.updateDrinkRatio(); }
                                            else if (type === 'drink-out') { window.app.ui.updateDoseValue('out', val); window.app.ui.updateDrinkRatio(); }
                                            else if (type === 'grind') window.app.ui.updateGrindValue(val);
                                            else if (type === 'temperature') window.app.ui.updateTemperatureDisplay(val);
                                            else if (type === 'steam-duration') window.app.ui.updateSteamDisplay({ targetSteamDuration: parseFloat(val) });
                                            else if (type === 'steam-flow') window.app.ui.updateSteamDisplay({ targetSteamFlow: parseFloat(val) });
                                            else if (type === 'flush') window.app.ui.updateFlushDisplay(parseFloat(val));
                                            else if (type === 'hot-water-vol') window.app.ui.updateHotWaterDisplay({ targetHotWaterVolume: parseFloat(val) });
                                            else if (type === 'hot-water-temp') window.app.ui.updateHotWaterDisplay({ targetHotWaterTemp: parseFloat(val) });
                                        }
                                    });
                                }
                            });
                        });

                        // Reattach nav click handlers
                        const profileNameElement = document.getElementById('profile-name');
                        if (profileNameElement) {
                            const newEl = profileNameElement.cloneNode(true);
                            profileNameElement.parentNode.replaceChild(newEl, profileNameElement);
                            newEl.setAttribute('tabindex', '-1');
                            newEl.onclick = () => loadPage('src/profiles/profile_selector.html');
                        }
                        const settingsBtn = document.getElementById('settings-btn');
                        if (settingsBtn) {
                            const newBtn = settingsBtn.cloneNode(true);
                            settingsBtn.parentNode.replaceChild(newBtn, settingsBtn);
                            newBtn.addEventListener('click', () => loadPage('src/settings/settings.html'));
                        }

                        // Show skeleton now — data fills in below async
                        mainContainer.classList.add('scaled');

                        // Fire API calls + WebSocket reconnects without blocking paint
                        (async () => {
                            try {
                                if (numpadModule.resetNumpadModal) numpadModule.resetNumpadModal();
                                if (numpadModule.initNumpadModal) {
                                    numpadModule.initNumpadModal();
                                    if (numpadModule.attachToNumericInputs) numpadModule.attachToNumericInputs();
                                }
                                if (appModule.initMobileValueInputs) appModule.initMobileValueInputs();

                                await Promise.all([
                                    historyModule.initHistory(),
                                    profileManagerModule.init(),
                                ]);
                                waterTankMod.initWaterTankSocket();

                                if (appModule.resetDataTimeout) appModule.resetDataTimeout();
                                if (appModule.loadInitialData) {
                                    await appModule.loadInitialData();
                                    appModule.handleWeightClick();
                                    appModule.handleScaleData();
                                } else if (window.loadInitialData) {
                                    await window.loadInitialData();
                                }

                                if (window.handleData && typeof apiModule.connectWebSocket === 'function') {
                                    if (!apiModule.reconnectingWebSocket || apiModule.reconnectingWebSocket.readyState !== WebSocket.OPEN) {
                                        apiModule.connectWebSocket(window.handleData, () => {
                                            if (window.isDe1Connected !== undefined) window.isDe1Connected = false;
                                        });
                                    }
                                }
                                if (window.handleScaleData && typeof apiModule.connectScaleWebSocket === 'function') {
                                    apiModule.connectScaleWebSocket(window.handleScaleData, window.onScaleReconnect || (() => {}), window.onScaleDisconnect || (() => {}));
                                }
                                if (window.handleShotSettingsData && typeof apiModule.connectShotSettingsWebSocket === 'function') {
                                    apiModule.connectShotSettingsWebSocket(window.handleShotSettingsData);
                                }
                                if (window.handleTimeToReadyData && typeof apiModule.connectTimeToReadyWebSocket === 'function') {
                                    apiModule.connectTimeToReadyWebSocket(window.handleTimeToReadyData);
                                }
                            } catch (e) {
                                console.error('Router: Error loading index data:', e);
                            }
                        })();

                    } catch (e) {
                        console.error('Router: Error reinitializing main page components:', e);
                        mainContainer.classList.add('scaled');
                    }
                }
            })();
        } else {
            console.error('Could not find the container or content to load.');
        }
    } catch (error) {
        console.error('Error loading page:', error);
    }
}