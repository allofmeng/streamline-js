// Single entry point for opening an external URL, correct in both targets.
//
//  - Real browser: window.open -> new tab (keeps the SPA).
//  - In-app webview (window.__DECENT_HOST__ injected by the host): window.open
//    is unreliable here — some webviews return a truthy-but-dead window, so we
//    must NOT trust its return value. Navigating instead hands the URL to the
//    host's shouldOverrideUrlLoading, which launches the system browser and
//    keeps the skin loaded (reaprime gh#384).
//
// If the host launch silently fails the page stays foreground (no
// visibilitychange/blur), so after a short wait we surface a copy-the-URL modal.

const isWebview = () => typeof window !== 'undefined' && !!window.__DECENT_HOST__;

export function openExternalUrl(url) {
    if (!url) return;
    if (isWebview()) { handoffToHost(url); return; }
    // Note: passing 'noopener' as a feature makes window.open return null even on
    // success, which would wrongly trigger the fallback. Open without it.
    const win = window.open(url, '_blank');
    if (win) { win.opener = null; return; }
    handoffToHost(url); // popup blocked in a real browser
}

function handoffToHost(url) {
    let backgrounded = false;
    const onHide = () => { if (document.visibilityState === 'hidden') backgrounded = true; };
    const onBlur = () => { backgrounded = true; };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onBlur, { once: true });

    location.href = url; // host intercepts and opens externally; page stays put

    setTimeout(() => {
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('blur', onBlur);
        if (!backgrounded && document.visibilityState === 'visible') {
            showExternalUrlModal(url); // external open didn't happen -> let user copy it
        }
    }, 1200);
}

// Surface a URL in a DaisyUI modal with a Copy button (webview launch-failure fallback).
export function showExternalUrlModal(url) {
    document.getElementById('external-url-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'external-url-modal';
    modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-6';
    modal.innerHTML = `
        <div class="bg-white text-[#385a92] rounded-2xl p-8 max-w-[700px] w-full flex flex-col gap-6">
            <p class="text-[28px] font-bold">Open this page in your browser</p>
            <input id="external-url-input" type="text" readonly value="${url}"
                class="w-full text-[24px] px-4 py-3 rounded-lg border-2 border-[#385a92] bg-[#f5f7fa] select-all" />
            <div class="flex gap-4 justify-end">
                <button id="external-url-copy" class="bg-[#385a92] text-white text-[24px] font-bold px-8 py-3 rounded-full">Copy</button>
                <button id="external-url-close" class="border-2 border-[#385a92] text-[24px] font-bold px-8 py-3 rounded-full">Close</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const input = modal.querySelector('#external-url-input');
    input.focus();
    input.select();

    const close = () => modal.remove();
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
