const pageCache = new Map();

function getCleanUrl(pageUrl) {
    const filename = pageUrl.split('/').pop().replace('.html', '');
    return `?page=${filename}`;
}

function getPageUrlFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page');

    if (!page || page === 'index') {
        return null;
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
    } else {
        showMainPage();
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

function isIndexUrl(pageUrl) {
    if (!pageUrl) return true;
    const lc = pageUrl.toLowerCase();
    return lc === 'index.html' || lc === '/' || lc === '' || lc.endsWith('/index.html');
}

function showMainPage() {
    const mainPage = document.getElementById('main-page');
    const subpageHost = document.getElementById('subpage-host');

    if (subpageHost) {
        subpageHost.style.display = 'none';
        subpageHost.innerHTML = '';
    }
    if (mainPage) mainPage.style.display = '';

    const scaledContent = document.getElementById('scaled-content');
    if (scaledContent) scaledContent.classList.add('scaled');

    // Force rescale — keyboard use on the previous page may have left a stale transform
    window.dispatchEvent(new Event('resize'));

    window.history.pushState({ pageUrl: null }, 'Streamline', '?page=index');

    // Ensure main-page data init has run — booting on a sub-page URL skips it,
    // so without this the main page would render static HTML with no data.
    if (window.app?.initMainPageOnce) {
        window.app.initMainPageOnce().catch(e => console.error('initMainPageOnce error:', e));
    }

    // Re-render favorite buttons now that they're visible — avoids stale font-size
    // from any updateButtonUI calls that fired while #main-page was display:none.
    import('./profileManager.js').then(m => {
        if (m.updateButtonUI) m.updateButtonUI();
    }).catch(() => {});
}

export async function loadPage(pageUrl) {
    if (isIndexUrl(pageUrl)) {
        showMainPage();
        return;
    }

    const mainPage = document.getElementById('main-page');
    const subpageHost = document.getElementById('subpage-host');

    if (mainPage) mainPage.style.display = 'none';
    if (subpageHost) {
        subpageHost.innerHTML = '';
        subpageHost.style.display = '';
    }

    try {
        const pageHtml = await fetchPage(pageUrl);
        const parser = new DOMParser();
        const doc = parser.parseFromString(pageHtml, 'text/html');
        const newContent = doc.querySelector('#scaled-content');

        if (!newContent || !subpageHost) {
            console.error('Could not find content to load.');
            if (mainPage) mainPage.style.display = '';
            return;
        }

        subpageHost.innerHTML = newContent.innerHTML;

        // Apply current language to freshly injected HTML before page init runs
        import('./i18n.js').then(m => m.translatePage()).catch(() => {});

        const cleanUrl = getCleanUrl(pageUrl);
        window.history.pushState({ pageUrl }, cleanUrl.split('/').pop() || 'Streamline', cleanUrl);

        await new Promise(resolve => requestAnimationFrame(resolve));

        const scaledContent = document.getElementById('scaled-content');
        if (scaledContent) scaledContent.classList.add('scaled');

        if (pageUrl.includes('profile_selector.html')) {
            try {
                const { initializeProfileSelector } = await import('./profile_selector.js');
                if (initializeProfileSelector) {
                    initializeProfileSelector().catch(e => console.error('Router: Profile selector init error:', e));
                }
            } catch (e) {
                console.error('Router: Error initializing profile selector:', e);
            }
        } else if (pageUrl.includes('profile_editor.html')) {
            try {
                const { initializeProfileEditor } = await import('./profile_editor.js');
                if (initializeProfileEditor) await initializeProfileEditor();
            } catch (e) {
                console.error('Router: Error initializing profile editor:', e);
            }
        } else if (pageUrl.includes('settings.html')) {
            try {
                const { initializeSettings } = await import('../settings/settings.js');
                if (initializeSettings) {
                    initializeSettings().catch(e => console.error('Router: Settings init error:', e));
                }
            } catch (e) {
                console.error('Router: Error importing settings page:', e);
            }
        }
    } catch (error) {
        console.error('Error loading page:', error);
        if (mainPage) mainPage.style.display = '';
        if (subpageHost) subpageHost.style.display = 'none';
    }
}
