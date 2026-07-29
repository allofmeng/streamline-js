// Check of the fit math in src/modules/scaling.js (mirrored here — the module
// touches the DOM at import time). Run: node test/scaling-fit.test.mjs
import assert from 'node:assert';

const DESIGN_W = 1920, DESIGN_H = 1200, MAX_STRETCH = 1.15;

// Screens taller than the 16:10 design ratio grow the canvas at a uniform scale
// instead of letterboxing; shorter ones fall back to the clamped x/y squash.
function fit(w, h) {
    let sx = w / DESIGN_W, sy = h / DESIGN_H, canvasH = DESIGN_H;
    if (h / sx >= DESIGN_H) {
        sy = sx;
        canvasH = h / sx;
    } else {
        const stretch = Math.max(sx, sy) / Math.min(sx, sy);
        if (stretch > MAX_STRETCH) {
            const k = MAX_STRETCH / stretch;
            if (sx > sy) sx *= k; else sy *= k;
        }
    }
    return { sx, sy, canvasH, gutterX: w - DESIGN_W * sx, gutterY: h - canvasH * sy };
}

// 16:10 panels are exact — no stretch, no gutters, no shrink.
for (const [w, h] of [[1920, 1200], [1280, 800], [2560, 1600]]) {
    const f = fit(w, h);
    assert.strictEqual(f.sx, f.sy, `${w}x${h} should be uniform`);
    assert.strictEqual(f.canvasH, DESIGN_H, `${w}x${h} canvas stays at design height`);
    assert.ok(Math.abs(f.gutterX) < 0.5 && Math.abs(f.gutterY) < 0.5, `${w}x${h} gutter-free`);
}

// Samsung A7 Lite 8.7" — the case the squash branch is for. Was 30px gutter each side.
const a7 = fit(1340, 800);
assert.ok(Math.abs(a7.gutterX) < 0.5, `1340x800 must fill: gutter ${a7.gutterX}`);
assert.ok(a7.sx / a7.sy < MAX_STRETCH + 1e-9);
assert.strictEqual(a7.canvasH, DESIGN_H, 'A7 must not grow the canvas');

// Same panel with browser chrome eating height (1340x736 is the A7 Lite's real
// usable area; de1app just declares it 800). Old uniform scale left 79px/side.
const chrome = fit(1340, 736);
assert.ok(chrome.sx / chrome.sy <= MAX_STRETCH + 1e-9, 'stretch clamped');
assert.ok(chrome.gutterX / 2 < 2, `residual gutter too big: ${chrome.gutterX / 2}`);
assert.ok(chrome.sy > 736 / DESIGN_H - 1e-9, 'never scales below the height fit');

// Wildly wrong aspect (portrait phone) must still be sane — it takes the grow
// branch, which is uniform by construction, so nothing can explode.
const portrait = fit(800, 1340);
assert.strictEqual(portrait.sx, portrait.sy, 'portrait stays uniform');
assert.ok(portrait.canvasH > DESIGN_H, 'portrait grows the canvas');

// 4:3 iPads: the grow branch must remove the bars outright, with no stretch.
for (const [name, w, h] of [['iPad Pro 12.9', 1366, 1024], ['iPad Pro 11', 1194, 834], ['iPad 10.2', 1080, 810]]) {
    const f = fit(w, h);
    assert.strictEqual(f.sx, f.sy, `${name} must not stretch`);
    assert.ok(Math.abs(f.gutterX) < 0.5 && Math.abs(f.gutterY) < 0.5, `${name} must have no bars`);
    assert.ok(f.canvasH > DESIGN_H, `${name} canvas should grow past ${DESIGN_H}`);
}

// The main page's vertical budget: header + telemetry band + chart, with the
// absolutely-placed footer band bottom-anchored (main.css). The growing chart
// must stop exactly at the footer's top edge and never shrink below its design
// height -- that pairing is what #chart-wrap's min-height and <main>'s
// padding-bottom enforce in CSS.
const HEADER = 168, TELEMETRY = 140, FOOTER = 242, CHART_DESIGN = 650;
for (const [name, w, h] of [
    ['design', 1920, 1200], ['A7 Lite', 1340, 800], ['iPad Pro 12.9', 1366, 1024], ['iPad 10.2', 1080, 810],
]) {
    const { canvasH } = fit(w, h);
    const chart = Math.max(CHART_DESIGN, canvasH - HEADER - FOOTER - TELEMETRY);
    const chartBottom = HEADER + TELEMETRY + chart;
    const footerTop = canvasH - FOOTER;
    assert.ok(chart >= CHART_DESIGN, `${name}: chart shrank below design (${chart})`);
    assert.ok(Math.abs(chartBottom - footerTop) < 1, `${name}: chart overlaps footer by ${chartBottom - footerTop}`);
}

// Design size must stay bit-identical to the pre-change layout.
const design = fit(1920, 1200);
assert.ok(design.sx === 1 && design.sy === 1 && design.canvasH === DESIGN_H, 'design size regressed');

console.log('ok — scaling fit math');
