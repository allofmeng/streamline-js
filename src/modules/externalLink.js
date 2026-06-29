// Open an external URL, correct in both targets.
//
//  - Real browser: window.open -> new tab (keeps the SPA).
//  - In-app webview (window.__DECENT_HOST__ injected by the host): the host opens
//    external links via shouldOverrideUrlLoading (reaprime gh#384). BUT Android
//    System WebView only delivers a navigation to that handler for a REAL user
//    tap on an anchor — not for JS-initiated navigation (location.href, synthetic
//    a.click(), or window.open, which routes to the unhandled onCreateWindow). So
//    we can't open it programmatically; we show a small sheet with a tappable
//    same-frame link and let the user's own tap drive the navigation.

export const isWebview = () => typeof window !== 'undefined' && !!window.__DECENT_HOST__;

export function openExternalUrl(url) {
    if (!url) return;
    if (isWebview()) { showExternalUrlModal(url); return; }
    // Note: passing 'noopener' as a feature makes window.open return null even on
    // success, which would wrongly trigger the fallback. Open without it.
    const win = window.open(url, '_blank');
    if (win) { win.opener = null; return; }
    location.href = url; // popup blocked in a real browser
}

// Sheet with a real, tappable same-frame <a> (no target — _blank would hit the
// webview's unhandled onCreateWindow). The user's tap is the only thing the host
// intercepts, so this is what actually opens the system browser. Copy is kept as
// a belt-and-suspenders fallback.
export function showExternalUrlModal(url) {
    document.getElementById('external-url-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'external-url-modal';
    modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-6';
    modal.innerHTML = `
        <div class="bg-white text-[#385a92] rounded-2xl p-8 max-w-[700px] w-full flex flex-col gap-6">
            <p class="text-[28px] font-bold">Open this page in your browser</p>
            <a id="external-url-open" href="${url}" rel="noopener"
               class="bg-[#385a92] text-white text-[26px] font-bold px-8 py-4 rounded-full text-center no-underline">Open in browser</a>
            <input id="external-url-input" type="text" readonly value="${url}"
                class="w-full text-[22px] px-4 py-3 rounded-lg border-2 border-[#385a92] bg-[#f5f7fa] select-all" />
            <div class="flex gap-4 justify-end">
                <button id="external-url-copy" class="bg-[#385a92] text-white text-[24px] font-bold px-8 py-3 rounded-full">Copy</button>
                <button id="external-url-close" class="border-2 border-[#385a92] text-[24px] font-bold px-8 py-3 rounded-full">Close</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const input = modal.querySelector('#external-url-input');
    const close = () => modal.remove();
    // Tapping the link navigates same-frame; the host cancels the nav and opens
    // the system browser, so close our sheet right after.
    modal.querySelector('#external-url-open').addEventListener('click', () => setTimeout(close, 100));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#external-url-close').addEventListener('click', close);
    modal.querySelector('#external-url-copy').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        try {
            await navigator.clipboard.writeText(url);
        } catch {
            input.select();
            document.execCommand('copy'); // fallback when clipboard API is blocked
        }
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
}
