// Check of the fit math in src/modules/scaling.js (mirrored here — the module
// touches the DOM at import time). Run: node test/scaling-fit.test.mjs
import assert from 'node:assert';

const DESIGN_W = 1920, DESIGN_H = 1200, MAX_STRETCH = 1.15;

function fit(w, h) {
    let sx = w / DESIGN_W, sy = h / DESIGN_H;
    const stretch = Math.max(sx, sy) / Math.min(sx, sy);
    if (stretch > MAX_STRETCH) {
        const k = MAX_STRETCH / stretch;
        if (sx > sy) sx *= k; else sy *= k;
    }
    return { sx, sy, gutterX: w - DESIGN_W * sx, gutterY: h - DESIGN_H * sy };
}

// 16:10 panels are exact — no stretch, no gutters, no shrink.
for (const [w, h] of [[1920, 1200], [1280, 800], [2560, 1600]]) {
    const f = fit(w, h);
    assert.strictEqual(f.sx, f.sy, `${w}x${h} should be uniform`);
    assert.ok(Math.abs(f.gutterX) < 0.5 && Math.abs(f.gutterY) < 0.5, `${w}x${h} gutter-free`);
}

// Samsung A7 Lite 8.7" — the case this fix is for. Was 30px gutter each side.
const a7 = fit(1340, 800);
assert.ok(Math.abs(a7.gutterX) < 0.5, `1340x800 must fill: gutter ${a7.gutterX}`);
assert.ok(a7.sx / a7.sy < MAX_STRETCH + 1e-9);

// Same panel with browser chrome eating height (1340x736 is the A7 Lite's real
// usable area; de1app just declares it 800). Old uniform scale left 79px/side.
const chrome = fit(1340, 736);
assert.ok(chrome.sx / chrome.sy <= MAX_STRETCH + 1e-9, 'stretch clamped');
assert.ok(chrome.gutterX / 2 < 2, `residual gutter too big: ${chrome.gutterX / 2}`);
assert.ok(chrome.sy > 736 / DESIGN_H - 1e-9, 'never scales below the height fit');

// Wildly wrong aspect (portrait phone) must still clamp, not explode.
const portrait = fit(800, 1340);
assert.ok(portrait.sy / portrait.sx <= MAX_STRETCH + 1e-9);

console.log('ok — scaling fit math');
