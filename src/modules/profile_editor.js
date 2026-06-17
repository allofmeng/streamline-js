import { loadPage } from './router.js';
import { showToast, flashPlusMinusButton } from './ui.js';
import { openModal, shouldUseNumpad, resetNumpadModal } from './numpad-modal.js';
import { openNotesModal } from './notes-modal.js';
import { getTranslation } from './i18n.js';
import { callPluginEndpoint, getPluginSettings } from './api.js';
import { validateProfileStructure } from './profileManager.js';

// ─── State ──────────────────────────────────────────────────────────────────

let editorState = {
    sourceProfileId: null,
    sourceProfileRecord: null,
    profile: null,
    activeTab: 0,
};

// IDs of profiles persisted to the server via share-code import during a
// new-profile session. Cleaned up on cancel so no orphans are left behind.
let _isNewProfileSession = false;
let _sessionImportedIds = [];
let _hasImportedInSession = false;

// Which step indices have their temp ± buttons expanded
let expandedTempSteps = new Set();

// Which step indices have their pump target ± buttons expanded
let expandedPumpSteps = new Set();

// Which step indices have their limiter ± buttons expanded
let expandedLimSteps = new Set();

// Which max field is expanded per step index: Map<stepIndex, 'seconds'|'volume'|'weight'|null>
let expandedMaxSteps = new Map();

// Which step indices have their exit value ± buttons expanded
let expandedExitSteps = new Set();

// Which review field is currently expanded (at most one at a time)
let expandedReviewField = null; // { collapseFunc: fn } | null

// ─── Focus Overlay ───────────────────────────────────────────────────────────
// 4-div hole approach: keep focal element in-place, surround it with 4 fixed
// overlay divs (top/right/bottom/left) leaving a rectangular hole. No DOM
// manipulation of focal elements — stacking context issues are irrelevant.

let _focusOverlay = null; // { top, right, bottom, left } — four divs

function _ensureFocusOverlayDivs() {
    if (_focusOverlay) return;
    _focusOverlay = {};
    ['top','right','bottom','left'].forEach(side => {
        const d = document.createElement('div');
        d.className = 'pe-focus-overlay';
        d.style.cssText = 'position:fixed;z-index:1000;display:none;cursor:default;';
        document.body.appendChild(d);
        _focusOverlay[side] = d;
    });
}

function showFocusOverlay(el, collapseCallback) {
    _ensureFocusOverlayDivs();
    const PAD = 8; // small breathing room around tight-fit bounds

    // Compute union bounding rect of el + all descendants (catches absolute ± buttons)
    const rects = [el.getBoundingClientRect()];
    el.querySelectorAll('*').forEach(child => {
        const cr = child.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0) rects.push(cr);
    });
    let minT = Infinity, minL = Infinity, maxB = -Infinity, maxR = -Infinity;
    for (const rc of rects) {
        if (rc.top    < minT) minT = rc.top;
        if (rc.left   < minL) minL = rc.left;
        if (rc.bottom > maxB) maxB = rc.bottom;
        if (rc.right  > maxR) maxR = rc.right;
    }

    const t = minT - PAD, l = minL - PAD;
    const b = maxB + PAD, ri = maxR + PAD;
    const W = window.innerWidth;

    Object.assign(_focusOverlay.top.style,    { display:'', top:'0',             left:'0',    width:W+'px',              height:Math.max(0,t)+'px'       });
    Object.assign(_focusOverlay.bottom.style, { display:'', top:b+'px',          left:'0',    width:W+'px',              height:'',        bottom:'0'      });
    Object.assign(_focusOverlay.left.style,   { display:'', top:Math.max(0,t)+'px', left:'0', width:Math.max(0,l)+'px', height:(b - Math.max(0,t))+'px' });
    Object.assign(_focusOverlay.right.style,  { display:'', top:Math.max(0,t)+'px', left:ri+'px', right:'0', width:'',  height:(b - Math.max(0,t))+'px' });

    Object.values(_focusOverlay).forEach(d => { d.onclick = () => collapseCallback(); });
}

function clearFocusOverlay() {
    if (!_focusOverlay) return;
    Object.values(_focusOverlay).forEach(d => { d.style.display = 'none'; d.onclick = null; });
}

// ─── Numpad Helper ─────────────────────────────────────────────────────────

function openNumpadForField(currentVal, numpadConfig, onCommit) {
    // After router navigation the DOM is rebuilt; reset flag if overlay was lost
    if (!document.getElementById('numpad-modal-overlay')) resetNumpadModal();
    clearFocusOverlay();
    const mockInput = { value: String(currentVal), dispatchEvent: () => {} };
    openModal(mockInput, {
        fieldType: numpadConfig.fieldType || 'pe-generic',
        config: numpadConfig,
        onConfirm: (val) => {
            const num = parseFloat(val);
            if (!isNaN(num)) onCommit(clamp(num, numpadConfig.min ?? 0, numpadConfig.max ?? 9999));
        }
    });
}

// ─── Review Settings Editable Pill ─────────────────────────────────────────
// Reusable inline editable value span — dotted blue underline; click opens
// numpad on tablet or inline edit on desktop. Used in the review tab's
// settings list under the graph preview.

function createSettingPill({ value, step, unit, min, max, fieldType, title, format, onCommit }) {
    const PILL_CLASS = 'text-[var(--button-primary-bg)] font-semibold cursor-pointer select-none inline-flex underline decoration-dashed underline-offset-[3px] px-[4px] rounded-[4px]';
    const fmt = format || ((v) => unit ? `${roundTo(v, step || 1)} ${unit}` : `${roundTo(v, step || 1)}`);

    const pill = document.createElement('span');
    pill.className = PILL_CLASS;
    pill.textContent = fmt(value);
    pill.addEventListener('mouseenter', () => { pill.style.backgroundColor = 'var(--button-grey)'; });
    pill.addEventListener('mouseleave', () => { pill.style.backgroundColor = ''; });

    pill.addEventListener('click', () => {
        if (shouldUseNumpad()) {
            openNumpadForField(value, {
                fieldType: fieldType || 'pe-review-setting',
                title: title || (unit ? unit.toUpperCase() : 'VALUE'),
                unit: unit || '',
                min: min ?? 0,
                max: max ?? 9999,
                label: `${min ?? 0}–${max ?? 9999}`
            }, (val) => {
                value = val;
                pill.textContent = fmt(value);
                onCommit(value);
            });
            return;
        }
        inlineEditValue(pill, value, {
            min, max, step: step || 1, unit,
            onCommit(val) {
                value = val;
                pill.textContent = fmt(value);
                onCommit(value);
            }
        });
    });

    return pill;
}

// ─── Desktop Inline Edit Helper ────────────────────────────────────────────
// On desktop (non-numpad), clicking a numeric display opens a small input field
// so the user can type a value directly instead of using +/- buttons.

function inlineEditValue(displayEl, currentValue, { min, max, step, unit, onCommit }) {
    if (shouldUseNumpad()) return false; // tablet — let numpad handle it
    if (!displayEl || !displayEl.querySelector) return false; // not a valid element
    if (displayEl.querySelector('input')) return false; // already editing

    // Find the first text node to replace (preserve child elements like ± buttons)
    let textNode = null;
    for (const child of displayEl.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { textNode = child; break; }
    }
    const savedText = textNode ? textNode.textContent : displayEl.textContent;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = currentValue;
    input.step = step || 'any';
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.className = 'bg-transparent border-b-2 border-[var(--text-primary)] outline-none text-center font-bold text-[var(--text-primary)]';
    input.style.cssText = `width:${Math.max(displayEl.offsetWidth, 60)}px;font-size:inherit;line-height:inherit;`;

    if (textNode) {
        displayEl.replaceChild(input, textNode);
    } else {
        displayEl.textContent = '';
        displayEl.appendChild(input);
    }
    input.focus();
    input.select();

    function commit() {
        const num = parseFloat(input.value);
        restore(); // always put text node back before calling onCommit
        if (!isNaN(num)) {
            const clamped = clamp(roundTo(num, step || 0.1), min ?? 0, max ?? 9999);
            onCommit(clamped);
        }
        cleanup();
    }

    function restore() {
        const newText = document.createTextNode(savedText);
        if (input.parentNode === displayEl) displayEl.replaceChild(newText, input);
    }

    function cancel() {
        restore();
        cleanup();
    }

    function cleanup() {
        input.removeEventListener('blur', commit);
        input.removeEventListener('keydown', onKey);
    }

    function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', onKey);
    return true; // handled
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Rea API only supports pressure/flow exit types (profile.dart:129 ExitType
// enum). 'off' is a UI-only state that maps to `step.exit = null` on save.
// Weight-based stop is expressed via profile-level `target_weight`; time-based
// stop is expressed via step `seconds`.
const EXIT_TYPES    = ['pressure', 'flow', 'off'];
const EXIT_UNIT_MAP = { pressure: 'bar', flow: 'mL/s' };
const EXIT_STEP_MAP = { pressure: 0.1, flow: 0.1 };
const EXIT_MAX_MAP  = { pressure: 12,  flow: 8 };

// Seed values used when the pump-toggle switches between flow and pressure
// modes. Not part of the persisted step shape — see makeNewStep().
const PUMP_SEED_FLOW = 6.0;
const PUMP_SEED_PRESSURE = 6.0;

const DEFAULT_STEP = {
    name: 'New Step',
    pump: 'flow',
    transition: 'fast',
    flow: PUMP_SEED_FLOW,
    temperature: 93,
    sensor: 'coffee',
    seconds: 30,
    weight: 0,
    volume: 0,
    exit: { type: 'pressure', condition: 'over', value: 9.0 },
    limiter: null,
};

// Factory for new steps inserted from the "+" button. Returns a deep copy of
// DEFAULT_STEP. Kept as a function so future variants (e.g. seeded from the
// previous step) can branch here.
function makeNewStep() {
    return JSON.parse(JSON.stringify(DEFAULT_STEP));
}

const TAB_COUNT = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function clamp(value, min, max) {
    if (min !== undefined && value < min) return min;
    if (max !== undefined && value > max) return max;
    return value;
}

function roundTo(value, step) {
    const decimals = step < 1 ? String(step).split('.')[1].length : 0;
    return parseFloat(value.toFixed(decimals));
}

// ─── Spinner Factory ────────────────────────────────────────────────────────

function createSpinner(initialValue, step, unit, onChange, opts = {}) {
    const { min, max } = opts;
    let value = typeof initialValue === 'number' ? initialValue : parseFloat(initialValue) || 0;
    let debounceTimer = null;

    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center gap-[10px]';

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
    minusBtn.textContent = '\u2212';
    minusBtn.setAttribute('aria-label', 'Decrease');

    const display = document.createElement('span');
    display.className = 'font-bold text-[20px] text-center w-[90px] text-[var(--text-primary)]';

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', 'Increase');

    function updateDisplay() {
        const formatted = roundTo(value, step);
        display.textContent = unit ? `${formatted} ${unit}` : `${formatted}`;
    }

    function debouncedOnChange() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            onChange(value);
        }, 300);
    }

    minusBtn.addEventListener('click', () => {
        flashPlusMinusButton(minusBtn);
        value = roundTo(clamp(value - step, min, max), step);
        updateDisplay();
        debouncedOnChange();
    });

    plusBtn.addEventListener('click', () => {
        flashPlusMinusButton(plusBtn);
        value = roundTo(clamp(value + step, min, max), step);
        updateDisplay();
        debouncedOnChange();
    });

    // Click display to edit:
    //   - Desktop: single click → inline edit
    //   - Tablet (numpad mode): two clicks → numpad modal (first click selects, second opens)
    display.style.cursor = 'pointer';
    let _spinnerSelected = false;
    let _spinnerSelectTimer = null;
    display.addEventListener('click', () => {
        if (shouldUseNumpad()) {
            if (_spinnerSelected) {
                clearTimeout(_spinnerSelectTimer);
                _spinnerSelected = false;
                display.style.outline = '';
                openNumpadForField(value, {
                    fieldType: 'pe-settings',
                    title: (unit || 'VALUE').toUpperCase(),
                    unit: unit || '',
                    min: min ?? 0,
                    max: max ?? 9999,
                    label: `${min ?? 0}–${max ?? 9999}`
                }, (val) => {
                    value = roundTo(val, step);
                    updateDisplay();
                    onChange(value);
                });
            } else {
                _spinnerSelected = true;
                display.style.outline = '2px solid var(--mimoja-blue)';
                display.style.borderRadius = '4px';
                clearTimeout(_spinnerSelectTimer);
                _spinnerSelectTimer = setTimeout(() => {
                    _spinnerSelected = false;
                    display.style.outline = '';
                }, 2000);
            }
            return;
        }
        inlineEditValue(display, value, { min, max, step, unit, onCommit: (val) => {
            value = val;
            updateDisplay();
            onChange(value);
        }});
    });

    updateDisplay();

    wrapper.appendChild(minusBtn);
    wrapper.appendChild(display);
    wrapper.appendChild(plusBtn);

    // Expose a way to get or set the current value externally
    wrapper._getValue = () => value;
    wrapper._setValue = (v) => { value = v; updateDisplay(); };

    return wrapper;
}

// ─── Toggle Button Group ────────────────────────────────────────────────────

function createToggle(options, activeValue, onChange) {
    // options: [{label, value}, ...]
    const wrapper = document.createElement('div');
    wrapper.className = 'flex gap-[8px]';

    let currentValue = activeValue;
    const buttons = [];

    function render() {
        buttons.forEach(({ btn, value }) => {
            if (value === currentValue) {
                btn.className = 'bg-[var(--button-primary-bg)] text-white rounded-[8px] px-[10px] py-[6px] text-[16px] font-semibold cursor-pointer transition-colors';
            } else {
                btn.className = 'bg-[var(--button-grey)] text-[var(--text-primary)] rounded-[8px] px-[10px] py-[6px] text-[16px] font-semibold cursor-pointer transition-colors';
            }
        });
    }

    options.forEach(({ label, value }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        buttons.push({ btn, value });

        btn.addEventListener('click', () => {
            currentValue = value;
            render();
            onChange(value);
        });

        wrapper.appendChild(btn);
    });

    render();
    return wrapper;
}

// ─── Render Functions ───────────────────────────────────────────────────────

function renderStepCards() {
    const container = document.getElementById('editor-steps-container');
    if (!container) return;
    container.innerHTML = '';

    const steps = editorState.profile.steps || [];
    const numSteps = steps.length;

    // CSS grid: label col + step cols (4 visible at once, extras scroll) + add-step col
    // 380px per step = (1920 - 220 label - 180 add) / 4; minmax keeps 4 visible, min enforces scroll beyond 4
    const R = { HEADER: 1, TEMP: 2, PUMP: 3, MAX: 4, EXIT: 5, FOOTER: 6 };
    const TOTAL_ROWS = 6;

    container.style.display = 'grid';
    container.style.gridTemplateColumns = `110px repeat(${numSteps}, minmax(300px, 1fr))`;
    container.style.gridTemplateRows = `60px 1fr 1fr 1fr 1fr 60px`;
    container.style.height = '100%';
    container.style.width = '100%';

    // Helper: create a grid cell, append to container
    function mkCell(row, col, className) {
        const el = document.createElement('div');
        el.style.gridRow = row;
        el.style.gridColumn = col;
        el.className = className;
        container.appendChild(el);
        return el;
    }

    // ── Label column (sticky left) ────────────────────────────────────────────
    const labelBase = 'flex items-center px-[20px] py-[8px] border-r-2 border-b border-[var(--border-color)] bg-[var(--box-color)]';

    function mkLabel(row, text, tip = '') {
        const el = mkCell(row, 1, labelBase);
        el.style.position = 'sticky';
        el.style.left = '0';
        el.style.zIndex = '2';
        if (text) {
            const span = document.createElement('span');
            span.className = 'text-[17px] font-semibold text-[var(--low-contrast-white)] leading-tight';
            span.textContent = text;
            el.appendChild(span);
        }
        if (tip) {
            const tipWrapper = document.createElement('div');
            tipWrapper.className = 'tooltip tooltip-right ml-[6px] before:text-[18px]';
            tipWrapper.setAttribute('data-tip', tip);
            tipWrapper.innerHTML = `<button type="button" class="w-[18px] h-[18px] rounded-full bg-[var(--button-grey)] text-[var(--low-contrast-white)] text-[12px] font-bold flex items-center justify-center shrink-0 focus:outline-none" tabindex="-1" aria-label="Help">i</button>`;
            el.appendChild(tipWrapper);
        }
        return el;
    }

    mkLabel(R.HEADER,  '');
    mkLabel(R.TEMP,    getTranslation('Temp'));
    mkLabel(R.PUMP,    getTranslation('Pump'));
    mkLabel(R.MAX,     getTranslation('Max'));
    mkLabel(R.EXIT,    getTranslation('Exit if'));
    mkLabel(R.FOOTER,  '');

    // ── Step columns ──────────────────────────────────────────────────────────
    const stepCell = 'flex items-center justify-start px-[16px] py-[8px] border-r border-b border-[var(--border-color)]';

    steps.forEach((step, index) => {
        const col = index + 2;
        const isFlow = step.pump !== 'pressure';

        // Header: step number + name input
        const hCell = mkCell(R.HEADER, col, 'flex items-center justify-center px-[16px] py-[10px] border-r border-b-2 border-[var(--border-color)] bg-[var(--box-color)]');
        const nameWrapper = document.createElement('div');
        nameWrapper.className = 'flex items-center gap-[6px]';
        const numSpan = document.createElement('span');
        numSpan.className = 'text-[24px] font-bold text-[var(--low-contrast-white)] shrink-0 select-none';
        numSpan.textContent = `${index + 1}.`;
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = step.name || '';
        nameInput.className = 'text-[24px] font-bold text-[var(--text-primary)] bg-transparent outline-none';
        const syncSize = () => { nameInput.size = Math.max(4, nameInput.value.length + 1); };
        syncSize();
        nameInput.addEventListener('input', syncSize);
        nameInput.addEventListener('change', () => { editorState.profile.steps[index].name = nameInput.value; });
        nameWrapper.appendChild(numSpan);
        nameWrapper.appendChild(nameInput);
        hCell.appendChild(nameWrapper);

        // Temp + Sensor combined row
        {
            const tCell = mkCell(R.TEMP, col, 'flex flex-col justify-center items-center px-[16px] py-[8px] border-r border-b border-[var(--border-color)] gap-[8px]');
            const isExpanded = expandedTempSteps.has(index);

            let tempValue = step.temperature || 93;
            let tempTimer = null;

            // Sensor toggle button
            let sensorValue = step.sensor || 'coffee';
            const sensorBtn = document.createElement('button');
            sensorBtn.type = 'button';
            sensorBtn.className = 'text-[var(--text-primary)] border border-[var(--secondary-button-outline)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            sensorBtn.textContent = sensorValue === 'coffee' ? getTranslation('Coffee') : getTranslation('Water');
            sensorBtn.addEventListener('click', () => {
                sensorValue = sensorValue === 'coffee' ? 'water' : 'coffee';
                sensorBtn.textContent = sensorValue === 'coffee' ? getTranslation('Coffee') : getTranslation('Water');
                editorState.profile.steps[index].sensor = sensorValue;
            });

            const tempDisplay = document.createElement('span');
            tempDisplay.className = 'bg-[var(--button-primary-bg)] text-white rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            tempDisplay.style.position = 'relative';
            tempDisplay.style.minWidth = '80px';
            tempDisplay.style.textAlign = 'center';
            tempDisplay.style.display = 'inline-block';
            const tempTextSpan = document.createElement('span');
            tempTextSpan.textContent = `${tempValue}\u00b0C`;
            tempDisplay.appendChild(tempTextSpan);

            const minusBtn = document.createElement('button');
            minusBtn.type = 'button';
            minusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            minusBtn.textContent = '\u2212';
            minusBtn.style.position = 'absolute';
            minusBtn.style.right = '100%';
            minusBtn.style.top = '50%';
            minusBtn.style.transform = 'translateY(-50%)';
            minusBtn.style.marginRight = '4px';
            minusBtn.style.display = isExpanded ? '' : 'none';

            const plusBtn = document.createElement('button');
            plusBtn.type = 'button';
            plusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            plusBtn.textContent = '+';
            plusBtn.style.position = 'absolute';
            plusBtn.style.left = '100%';
            plusBtn.style.top = '50%';
            plusBtn.style.transform = 'translateY(-50%)';
            plusBtn.style.marginLeft = '4px';
            plusBtn.style.display = isExpanded ? '' : 'none';

            tempDisplay.appendChild(minusBtn);
            tempDisplay.appendChild(plusBtn);

            // Display line: [tempDisplay] [sensorBtn] — always visible, never moves
            const tempDisplayLine = document.createElement('div');
            tempDisplayLine.className = 'flex items-center gap-[8px]';
            tempDisplayLine.appendChild(tempDisplay);
            tempDisplayLine.appendChild(sensorBtn);

            function collapseTempSpinner() {
                clearTimeout(tempTimer);
                expandedTempSteps.delete(index);
                minusBtn.style.display = 'none';
                plusBtn.style.display = 'none';
                sensorBtn.style.opacity = '';
                clearFocusOverlay();
            }

            function startTempTimer() {
                clearTimeout(tempTimer);
                tempTimer = setTimeout(collapseTempSpinner, 2000);
            }

            let tempLongPressTimer = null;
            let tempLongPressFired = false;

            tempDisplay.addEventListener('pointerdown', () => {
                if (!expandedTempSteps.has(index)) return;
                tempLongPressFired = false;
                tempLongPressTimer = setTimeout(() => {
                    tempLongPressFired = true;
                    tempValue = 0;
                    tempDisplay.firstChild.textContent = '0\u00b0C';
                    editorState.profile.steps[index].temperature = 0;
                    startTempTimer();
                }, 600);
            });
            tempDisplay.addEventListener('pointerup',     () => clearTimeout(tempLongPressTimer));
            tempDisplay.addEventListener('pointerleave',  () => clearTimeout(tempLongPressTimer));
            tempDisplay.addEventListener('pointercancel', () => clearTimeout(tempLongPressTimer));

            tempDisplay.addEventListener('click', (e) => {
                if (e.target === minusBtn || e.target === plusBtn) return;
                if (tempLongPressFired) { tempLongPressFired = false; return; }
                if (expandedTempSteps.has(index)) {
                    if (shouldUseNumpad()) {
                        openNumpadForField(tempValue, { fieldType: 'pe-temp', title: 'TEMPERATURE', unit: '\u00b0C', min: 0, max: 105, label: '0\u2013110' }, (val) => {
                            tempValue = val;
                            tempTextSpan.textContent = `${tempValue}\u00b0C`;
                            editorState.profile.steps[index].temperature = tempValue;
                            renderReviewGraph();
                        });
                        startTempTimer();
                        return;
                    }
                    // Desktop: inline edit on second click
                    const handled = inlineEditValue(tempTextSpan, tempValue, { min: 0, max: 110, step: 0.5, unit: '\u00b0C', onCommit: (val) => {
                        tempValue = val;
                        tempTextSpan.textContent = `${tempValue}\u00b0C`;
                        editorState.profile.steps[index].temperature = tempValue;
                        renderReviewGraph();
                        collapseTempSpinner();
                    }});
                    if (!handled) collapseTempSpinner();
                } else {
                    expandedTempSteps.add(index);
                    minusBtn.style.display = '';
                    plusBtn.style.display = '';
                    sensorBtn.style.opacity = '0.3';
                    showFocusOverlay(tempDisplay, collapseTempSpinner);
                    startTempTimer();
                }
            });

            minusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                flashPlusMinusButton(minusBtn);
                tempValue = roundTo(clamp(tempValue - 0.5, 0, 110), 0.5);
                tempTextSpan.textContent = `${tempValue}\u00b0C`;
                editorState.profile.steps[index].temperature = tempValue;
                startTempTimer();
            });

            plusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                flashPlusMinusButton(plusBtn);
                tempValue = roundTo(clamp(tempValue + 0.5, 0, 110), 0.5);
                tempTextSpan.textContent = `${tempValue}\u00b0C`;
                editorState.profile.steps[index].temperature = tempValue;
                startTempTimer();
            });

            if (isExpanded) sensorBtn.style.opacity = '0.3';

            tCell.appendChild(tempDisplayLine);
        }

        // Pump + Limit combined row — two lines
        {
            const pCell = mkCell(R.PUMP, col, 'flex flex-col justify-center items-center px-[16px] py-[4px] gap-[16px] border-r border-b border-[var(--border-color)]');

            // ── Line 1: pump ─────────────────────────────────────────────────
            const pumpLine = document.createElement('div');
            pumpLine.className = 'flex flex-col gap-[4px]';

            const targetUnit = isFlow ? 'mL/s' : 'bar';
            const targetMax  = isFlow ? 15 : 12;
            const targetMin  = isFlow ? 0  : 1;
            const tStep      = 0.1;
            const isPumpExp  = expandedPumpSteps.has(index);

            let targetValue = isFlow ? (step.flow || 0) : (step.pressure || 0);
            let transValue  = step.transition || 'fast';
            let pumpTimer = null;

            const transBtn = document.createElement('button');
            transBtn.type = 'button';
            transBtn.className = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            transBtn.textContent = transValue === 'fast' ? getTranslation('Quick') : getTranslation('Smooth');

            const rampText = document.createElement('span');
            rampText.className = 'text-[24px] text-[var(--text-primary)] select-none';
            rampText.textContent = getTranslation('ramp');

            const targetDisplay = document.createElement('span');
            targetDisplay.className = 'font-bold text-[24px] text-white px-[8px] py-[2px] cursor-pointer select-none';
            targetDisplay.textContent = `${roundTo(targetValue, tStep)}`;

            const unitBtn = document.createElement('button');
            unitBtn.type = 'button';
            unitBtn.className = 'text-white px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none bg-transparent';
            unitBtn.textContent = targetUnit;

            const targetWrapper = document.createElement('div');
            targetWrapper.className = 'flex items-center rounded-[8px]';
            const wrapDivider = document.createElement('span');
            wrapDivider.className = 'w-[1px] h-[18px] bg-[var(--text-primary)] opacity-40 shrink-0 self-center';
            targetWrapper.appendChild(targetDisplay);
            targetWrapper.appendChild(wrapDivider);
            targetWrapper.appendChild(unitBtn);

            function updateTargetStyle() {
                const active = targetValue > 0;
                targetWrapper.style.background = active ? 'var(--button-primary-bg)' : 'var(--secondary-button-bg)';
                const txtCls = active ? 'font-bold text-[24px] text-white px-[8px] py-[2px] cursor-pointer select-none' : 'font-bold text-[24px] text-white px-[8px] py-[2px] cursor-pointer select-none';
                const unitCls = active ? 'text-white px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none bg-transparent' : 'text-white px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none bg-transparent';
                targetDisplay.className = txtCls;
                unitBtn.className = unitCls;
                wrapDivider.style.opacity = active ? '' : '0';
            }
            updateTargetStyle();

            // Absolutely-positioned ± buttons on targetWrapper — no layout shift
            targetWrapper.style.position = 'relative';

            const targetMinus = document.createElement('button');
            targetMinus.type = 'button';
            targetMinus.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            targetMinus.textContent = '\u2212';
            targetMinus.style.position = 'absolute';
            targetMinus.style.right = '100%';
            targetMinus.style.top = '50%';
            targetMinus.style.transform = 'translateY(-50%)';
            targetMinus.style.marginRight = '4px';
            targetMinus.style.display = isPumpExp ? '' : 'none';

            const targetPlus = document.createElement('button');
            targetPlus.type = 'button';
            targetPlus.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            targetPlus.textContent = '+';
            targetPlus.style.position = 'absolute';
            targetPlus.style.left = '100%';
            targetPlus.style.top = '50%';
            targetPlus.style.transform = 'translateY(-50%)';
            targetPlus.style.marginLeft = '4px';
            targetPlus.style.display = isPumpExp ? '' : 'none';

            targetWrapper.appendChild(targetMinus);
            targetWrapper.appendChild(targetPlus);

            // Display line: [targetWrapper] [rampText] [transBtn] — always visible, never moves
            const pumpDisplayLine = document.createElement('div');
            pumpDisplayLine.className = 'flex items-center gap-[8px]';
            pumpDisplayLine.appendChild(targetWrapper);
            pumpDisplayLine.appendChild(rampText);
            pumpDisplayLine.appendChild(transBtn);

            function collapsePumpSpinner() {
                clearTimeout(pumpTimer);
                expandedPumpSteps.delete(index);
                targetMinus.style.display = 'none';
                targetPlus.style.display = 'none';
                transBtn.style.opacity = '';
                clearFocusOverlay();
            }

            function startPumpTimer() {
                clearTimeout(pumpTimer);
                pumpTimer = setTimeout(collapsePumpSpinner, 2000);
            }

            transBtn.addEventListener('click', () => {
                transValue = transValue === 'fast' ? 'smooth' : 'fast';
                transBtn.textContent = transValue === 'fast' ? getTranslation('Quick') : getTranslation('Smooth');
                editorState.profile.steps[index].transition = transValue;
            });

            let targetLongPressTimer = null;
            let targetLongPressFired = false;

            targetDisplay.addEventListener('pointerdown', () => {
                if (!expandedPumpSteps.has(index)) return;
                targetLongPressFired = false;
                targetLongPressTimer = setTimeout(() => {
                    targetLongPressFired = true;
                    targetValue = 0;
                    targetDisplay.textContent = '0';
                    updateTargetStyle();
                    if (isFlow) editorState.profile.steps[index].flow = 0;
                    else editorState.profile.steps[index].pressure = 0;
                    startPumpTimer();
                }, 600);
            });
            targetDisplay.addEventListener('pointerup',     () => clearTimeout(targetLongPressTimer));
            targetDisplay.addEventListener('pointerleave',  () => clearTimeout(targetLongPressTimer));
            targetDisplay.addEventListener('pointercancel', () => clearTimeout(targetLongPressTimer));

            targetDisplay.addEventListener('click', () => {
                if (targetLongPressFired) { targetLongPressFired = false; return; }
                if (expandedPumpSteps.has(index)) {
                    if (shouldUseNumpad()) {
                        const pumpConfig = isFlow
                            ? { fieldType: 'pe-pump', title: 'FLOW', unit: 'mL/s', min: 0, max: 15, label: '0\u201315' }
                            : { fieldType: 'pe-pump', title: 'PRESSURE', unit: 'bar', min: 1, max: 12, label: '1\u201312' };
                        openNumpadForField(targetValue, pumpConfig, (val) => {
                            targetValue = val;
                            targetDisplay.textContent = `${targetValue}`;
                            updateTargetStyle();
                            if (isFlow) editorState.profile.steps[index].flow = targetValue;
                            else editorState.profile.steps[index].pressure = targetValue;
                            renderReviewGraph();
                        });
                        startPumpTimer();
                        return;
                    }
                    // Desktop: inline edit
                    const tMax = isFlow ? 15 : 12;
                    const tMin = isFlow ? 0  : 1;
                    const handled = inlineEditValue(targetDisplay, targetValue, { min: tMin, max: tMax, step: tStep, onCommit: (val) => {
                        targetValue = val;
                        targetDisplay.textContent = `${targetValue}`;
                        updateTargetStyle();
                        if (isFlow) editorState.profile.steps[index].flow = targetValue;
                        else editorState.profile.steps[index].pressure = targetValue;
                        renderReviewGraph();
                        collapsePumpSpinner();
                    }});
                    if (!handled) collapsePumpSpinner();
                } else {
                    expandedPumpSteps.add(index);
                    targetMinus.style.display = '';
                    targetPlus.style.display = '';
                    transBtn.style.opacity = '0.3';
                    showFocusOverlay(targetWrapper, collapsePumpSpinner);
                    startPumpTimer();
                }
            });

            unitBtn.addEventListener('click', () => {
                const s = editorState.profile.steps[index];
                if (isFlow) {
                    s.pump = 'pressure';
                    if (!s.pressure) s.pressure = PUMP_SEED_PRESSURE;
                    delete s.flow;
                } else {
                    s.pump = 'flow';
                    if (!s.flow) s.flow = PUMP_SEED_FLOW;
                    delete s.pressure;
                }
                renderStepCards();
            });

            targetMinus.addEventListener('click', () => {
                flashPlusMinusButton(targetMinus);
                targetValue = roundTo(clamp(targetValue - tStep, targetMin, targetMax), tStep);
                targetDisplay.textContent = `${targetValue}`;
                updateTargetStyle();
                if (isFlow) editorState.profile.steps[index].flow = targetValue;
                else editorState.profile.steps[index].pressure = targetValue;
                startPumpTimer();
            });

            targetPlus.addEventListener('click', () => {
                flashPlusMinusButton(targetPlus);
                targetValue = roundTo(clamp(targetValue + tStep, targetMin, targetMax), tStep);
                targetDisplay.textContent = `${targetValue}`;
                updateTargetStyle();
                if (isFlow) editorState.profile.steps[index].flow = targetValue;
                else editorState.profile.steps[index].pressure = targetValue;
                startPumpTimer();
            });

            if (isPumpExp) transBtn.style.opacity = '0.3';

            pumpLine.appendChild(pumpDisplayLine);

            // ── Line 2: limiter ───────────────────────────────────────────────
            const limLine = document.createElement('div');
            limLine.className = 'flex flex-col gap-[4px]';

            const limUnit = isFlow ? 'bar' : 'mL/s';
            const limMax  = isFlow ? 12 : 8;
            const limMin  = isFlow ? 1  : 0;
            const lStep   = 0.1;
            const isLimExp = expandedLimSteps.has(index);

            let limValue = step.limiter?.value ?? 0;
            let limTimer = null;

            const withText = document.createElement('span');
            withText.className = 'text-[24px] text-[var(--text-primary)] select-none';
            withText.textContent = getTranslation('Limit to');

            const limDisplay = document.createElement('span');
            limDisplay.textContent = `${roundTo(limValue, lStep)}`;

            const limDivider = document.createElement('span');
            limDivider.className = 'w-[1px] h-[18px] bg-[var(--text-primary)] opacity-40 shrink-0 self-center';

            const limUnitText = document.createElement('span');
            limUnitText.textContent = limUnit;

            const limWrapper = document.createElement('div');
            limWrapper.className = 'flex items-center rounded-[8px] cursor-pointer';
            limWrapper.appendChild(limDisplay);
            limWrapper.appendChild(limDivider);
            limWrapper.appendChild(limUnitText);

            function updateLimStyle() {
                const active = limValue > 0;
                limWrapper.style.background = active ? 'var(--button-primary-bg)' : 'var(--secondary-button-bg)';
                const txtCls = active ? 'font-bold text-[24px] text-white px-[8px] py-[2px] cursor-pointer select-none' : 'font-bold text-[24px] text-white px-[8px] py-[2px] cursor-pointer select-none';
                const unitCls = active ? 'text-white px-[8px] py-[2px] text-[24px] font-semibold select-none' : 'text-white px-[8px] py-[2px] text-[24px] font-semibold select-none';
                limDisplay.className = txtCls;
                limUnitText.className = unitCls;
                limDivider.style.opacity = active ? '' : '0';
            }
            updateLimStyle();

            // Absolutely-positioned ± buttons on limWrapper — no layout shift
            limWrapper.style.position = 'relative';

            const limMinus = document.createElement('button');
            limMinus.type = 'button';
            limMinus.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            limMinus.textContent = '\u2212';
            limMinus.style.position = 'absolute';
            limMinus.style.right = '100%';
            limMinus.style.top = '50%';
            limMinus.style.transform = 'translateY(-50%)';
            limMinus.style.marginRight = '4px';
            limMinus.style.display = isLimExp ? '' : 'none';

            const limPlus = document.createElement('button');
            limPlus.type = 'button';
            limPlus.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            limPlus.textContent = '+';
            limPlus.style.position = 'absolute';
            limPlus.style.left = '100%';
            limPlus.style.top = '50%';
            limPlus.style.transform = 'translateY(-50%)';
            limPlus.style.marginLeft = '4px';
            limPlus.style.display = isLimExp ? '' : 'none';

            limWrapper.appendChild(limMinus);
            limWrapper.appendChild(limPlus);

            const limDisplayLine = document.createElement('div');
            limDisplayLine.className = 'flex items-center gap-[8px]';
            limDisplayLine.appendChild(withText);
            limDisplayLine.appendChild(limWrapper);

            function collapseLimSpinner() {
                clearTimeout(limTimer);
                expandedLimSteps.delete(index);
                limMinus.style.display = 'none';
                limPlus.style.display = 'none';
                withText.style.opacity = '';
                clearFocusOverlay();
            }

            function startLimTimer() {
                clearTimeout(limTimer);
                limTimer = setTimeout(collapseLimSpinner, 2000);
            }

            let limLongPressTimer = null;
            let limLongPressFired = false;

            limDisplay.addEventListener('pointerdown', () => {
                if (!expandedLimSteps.has(index)) return;
                limLongPressFired = false;
                limLongPressTimer = setTimeout(() => {
                    limLongPressFired = true;
                    limValue = 0;
                    limDisplay.textContent = '0';
                    updateLimStyle();
                    if (!editorState.profile.steps[index].limiter) editorState.profile.steps[index].limiter = { value: 0, range: 0.6 };
                    else editorState.profile.steps[index].limiter.value = 0;
                    startLimTimer();
                }, 600);
            });
            limDisplay.addEventListener('pointerup',     () => clearTimeout(limLongPressTimer));
            limDisplay.addEventListener('pointerleave',  () => clearTimeout(limLongPressTimer));
            limDisplay.addEventListener('pointercancel', () => clearTimeout(limLongPressTimer));

            limDisplay.addEventListener('click', () => {
                if (limLongPressFired) { limLongPressFired = false; return; }
                if (expandedLimSteps.has(index)) {
                    if (shouldUseNumpad()) {
                        const limConfig = isFlow
                            ? { fieldType: 'pe-lim', title: 'PRESSURE LIMIT', unit: 'bar', min: 1, max: 12, label: '1\u201312' }
                            : { fieldType: 'pe-lim', title: 'FLOW LIMIT', unit: 'mL/s', min: 0, max: 8, label: '0\u20138' };
                        openNumpadForField(limValue, limConfig, (val) => {
                            limValue = val;
                            limDisplay.textContent = `${limValue}`;
                            updateLimStyle();
                            if (!editorState.profile.steps[index].limiter) editorState.profile.steps[index].limiter = { value: limValue, range: 0.6 };
                            else editorState.profile.steps[index].limiter.value = limValue;
                            renderReviewGraph();
                        });
                        startLimTimer();
                        return;
                    }
                    // Desktop: inline edit
                    const handled = inlineEditValue(limDisplay, limValue, { min: limMin, max: limMax, step: lStep, onCommit: (val) => {
                        limValue = val;
                        limDisplay.textContent = `${limValue}`;
                        updateLimStyle();
                        if (!editorState.profile.steps[index].limiter) editorState.profile.steps[index].limiter = { value: limValue, range: 0.6 };
                        else editorState.profile.steps[index].limiter.value = limValue;
                        renderReviewGraph();
                        collapseLimSpinner();
                    }});
                    if (!handled) collapseLimSpinner();
                } else {
                    expandedLimSteps.add(index);
                    limMinus.style.display = '';
                    limPlus.style.display = '';
                    withText.style.opacity = '0.3';
                    showFocusOverlay(limWrapper, collapseLimSpinner);
                    startLimTimer();
                }
            });

            limMinus.addEventListener('click', () => {
                flashPlusMinusButton(limMinus);
                limValue = roundTo(clamp(limValue - lStep, limMin, limMax), lStep);
                limDisplay.textContent = `${limValue}`;
                updateLimStyle();
                if (!editorState.profile.steps[index].limiter) editorState.profile.steps[index].limiter = { value: limValue, range: 0.6 };
                else editorState.profile.steps[index].limiter.value = limValue;
                startLimTimer();
            });

            limPlus.addEventListener('click', () => {
                flashPlusMinusButton(limPlus);
                limValue = roundTo(clamp(limValue + lStep, limMin, limMax), lStep);
                limDisplay.textContent = `${limValue}`;
                updateLimStyle();
                if (!editorState.profile.steps[index].limiter) editorState.profile.steps[index].limiter = { value: limValue, range: 0.6 };
                else editorState.profile.steps[index].limiter.value = limValue;
                startLimTimer();
            });

            if (isLimExp) withText.style.opacity = '0.3';

            limLine.appendChild(limDisplayLine);

            pCell.appendChild(pumpLine);
            pCell.appendChild(limLine);
        }

        {
            const exitCell = mkCell(R.EXIT, col, 'flex flex-col justify-center items-center px-[16px] py-[4px] gap-[6px] border-r border-b border-[var(--border-color)]');

            const exitLine = document.createElement('div');
            exitLine.className = 'flex flex-col gap-[4px]';

            const exitDef  = step.exit || { type: 'pressure', condition: 'over', value: 0 };
            let exitType   = exitDef.type || 'pressure';
            let exitCond   = exitDef.condition || 'over';
            let exitValue  = exitDef.value ?? 0;
            let exitTimer = null;

            const btnGray = 'bg-[var(--button-grey)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            const btnGrayFlash = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';

            const typeBtn = document.createElement('button');
            typeBtn.type = 'button';
            typeBtn.className = btnGrayFlash;
            typeBtn.textContent = exitType.charAt(0).toUpperCase() + exitType.slice(1);

            const condBtn = document.createElement('button');
            condBtn.type = 'button';
            condBtn.className = btnGrayFlash;
            condBtn.textContent = exitCond.charAt(0).toUpperCase() + exitCond.slice(1);

            const isExitExpanded = expandedExitSteps.has(index);

            const valueDisplay = document.createElement('span');
            valueDisplay.className = 'bg-[var(--button-primary-bg)] text-white rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none whitespace-nowrap';
            valueDisplay.textContent = exitType !== 'off' ? `${exitValue} ${EXIT_UNIT_MAP[exitType]}` : '';

            const exitMinus = document.createElement('button');
            exitMinus.type = 'button';
            exitMinus.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            exitMinus.textContent = '\u2212';
            exitMinus.style.position = 'absolute';
            exitMinus.style.right = '100%';
            exitMinus.style.top = '50%';
            exitMinus.style.transform = 'translateY(-50%)';
            exitMinus.style.marginRight = '4px';
            exitMinus.style.display = 'none';

            const exitPlus = document.createElement('button');
            exitPlus.type = 'button';
            exitPlus.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
            exitPlus.textContent = '+';
            exitPlus.style.position = 'absolute';
            exitPlus.style.left = '100%';
            exitPlus.style.top = '50%';
            exitPlus.style.transform = 'translateY(-50%)';
            exitPlus.style.marginLeft = '4px';
            exitPlus.style.display = 'none';

            // Wrap valueDisplay so ± buttons can be positioned relative to it
            const valueWrapper = document.createElement('span');
            valueWrapper.style.position = 'relative';
            valueWrapper.style.display = 'inline-flex';
            valueWrapper.appendChild(exitMinus);
            valueWrapper.appendChild(valueDisplay);
            valueWrapper.appendChild(exitPlus);

            const exitDisplayLine = document.createElement('div');
            exitDisplayLine.className = 'flex items-center gap-[8px]';
            exitDisplayLine.appendChild(typeBtn);
            exitDisplayLine.appendChild(condBtn);
            exitDisplayLine.appendChild(valueWrapper);

            function collapseExitSpinner() {
                clearTimeout(exitTimer);
                expandedExitSteps.delete(index);
                exitMinus.style.display = 'none';
                exitPlus.style.display = 'none';
                typeBtn.style.opacity = '';
                condBtn.style.opacity = '';
                clearFocusOverlay();
            }

            function startExitTimer() {
                clearTimeout(exitTimer);
                exitTimer = setTimeout(collapseExitSpinner, 2000);
            }

            function applyExitOffState() {
                const isOff = exitType === 'off';
                typeBtn.className = isOff ? btnGray : btnGrayFlash;
                condBtn.style.display      = isOff ? 'none' : '';
                valueWrapper.style.display = isOff ? 'none' : '';
                if (isOff) {
                    clearTimeout(exitTimer);
                    exitMinus.style.display = 'none';
                    exitPlus.style.display = 'none';
                    expandedExitSteps.delete(index);
                    typeBtn.style.opacity = '';
                    condBtn.style.opacity = '';
                }
            }
            applyExitOffState();

            typeBtn.addEventListener('click', () => {
                exitType = EXIT_TYPES[(EXIT_TYPES.indexOf(exitType) + 1) % EXIT_TYPES.length];
                typeBtn.textContent = exitType.charAt(0).toUpperCase() + exitType.slice(1);
                if (exitType !== 'off') valueDisplay.textContent = `${exitValue} ${EXIT_UNIT_MAP[exitType]}`;
                applyExitOffState();
                if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                else editorState.profile.steps[index].exit.type = exitType;
            });

            condBtn.addEventListener('click', () => {
                exitCond = exitCond === 'over' ? 'under' : 'over';
                condBtn.textContent = exitCond.charAt(0).toUpperCase() + exitCond.slice(1);
                if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                else editorState.profile.steps[index].exit.condition = exitCond;
            });

            let exitLongPressTimer = null;
            let exitLongPressFired = false;

            valueDisplay.addEventListener('pointerdown', () => {
                if (!expandedExitSteps.has(index)) return;
                exitLongPressFired = false;
                exitLongPressTimer = setTimeout(() => {
                    exitLongPressFired = true;
                    exitValue = 0;
                    valueDisplay.textContent = `0 ${EXIT_UNIT_MAP[exitType]}`;
                    if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: 0 };
                    else editorState.profile.steps[index].exit.value = 0;
                    startExitTimer();
                }, 600);
            });
            valueDisplay.addEventListener('pointerup',     () => clearTimeout(exitLongPressTimer));
            valueDisplay.addEventListener('pointerleave',  () => clearTimeout(exitLongPressTimer));
            valueDisplay.addEventListener('pointercancel', () => clearTimeout(exitLongPressTimer));

            valueDisplay.addEventListener('click', () => {
                if (exitLongPressFired) { exitLongPressFired = false; return; }
                if (expandedExitSteps.has(index)) {
                    if (exitType !== 'off' && shouldUseNumpad()) {
                        openNumpadForField(exitValue, {
                            fieldType: 'pe-exit',
                            title: 'EXIT ' + exitType.toUpperCase(),
                            unit: EXIT_UNIT_MAP[exitType] || '',
                            min: 0,
                            max: EXIT_MAX_MAP[exitType] || 100,
                            label: '0\u2013' + (EXIT_MAX_MAP[exitType] || 100)
                        }, (val) => {
                            exitValue = val;
                            valueDisplay.textContent = `${exitValue} ${EXIT_UNIT_MAP[exitType]}`;
                            if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                            else editorState.profile.steps[index].exit.value = exitValue;
                            renderReviewGraph();
                        });
                        startExitTimer();
                        return;
                    }
                    if (!inlineEditValue(valueDisplay, exitValue, {
                        min: 0, max: EXIT_MAX_MAP[exitType] || 100,
                        step: EXIT_STEP_MAP[exitType], unit: EXIT_UNIT_MAP[exitType],
                        onCommit(val) {
                            exitValue = val;
                            valueDisplay.textContent = `${exitValue} ${EXIT_UNIT_MAP[exitType]}`;
                            if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                            else editorState.profile.steps[index].exit.value = exitValue;
                            renderReviewGraph();
                        }
                    })) collapseExitSpinner();
                } else {
                    expandedExitSteps.add(index);
                    exitMinus.style.display = '';
                    exitPlus.style.display = '';
                    typeBtn.style.opacity = '0.3';
                    condBtn.style.opacity = '0.3';
                    showFocusOverlay(valueWrapper, collapseExitSpinner);
                    startExitTimer();
                }
            });

            exitMinus.addEventListener('click', () => {
                flashPlusMinusButton(exitMinus);
                exitValue = roundTo(clamp(exitValue - EXIT_STEP_MAP[exitType], 0, EXIT_MAX_MAP[exitType]), EXIT_STEP_MAP[exitType]);
                valueDisplay.textContent = `${exitValue} ${EXIT_UNIT_MAP[exitType]}`;
                if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                else editorState.profile.steps[index].exit.value = exitValue;
                startExitTimer();
            });

            exitPlus.addEventListener('click', () => {
                flashPlusMinusButton(exitPlus);
                exitValue = roundTo(clamp(exitValue + EXIT_STEP_MAP[exitType], 0, EXIT_MAX_MAP[exitType]), EXIT_STEP_MAP[exitType]);
                valueDisplay.textContent = `${exitValue} ${EXIT_UNIT_MAP[exitType]}`;
                if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                else editorState.profile.steps[index].exit.value = exitValue;
                startExitTimer();
            });

            if (isExitExpanded) {
                typeBtn.style.opacity = '0.3';
                condBtn.style.opacity = '0.3';
                exitMinus.style.display = '';
                exitPlus.style.display = '';
            }

            exitLine.appendChild(exitDisplayLine);

            exitCell.appendChild(exitLine);
        }

        {
            const maxCell = mkCell(R.MAX, col, 'flex flex-col justify-center items-center px-[16px] py-[4px] border-r border-b border-[var(--border-color)] gap-[6px]');

            const maxTopRow = document.createElement('div');
            maxTopRow.className = 'flex items-center gap-[8px] flex-wrap';

            const maxExtrasRow = document.createElement('div');
            maxExtrasRow.className = 'flex items-center gap-[8px]';
            maxExtrasRow.style.display = 'none';

            const MAX_FIELDS = [
                { key: 'weight',  unit: 'g',   fStep: 1, fMax: 1000 },
                { key: 'seconds', unit: 'sec', fStep: 1, fMax: 300 },
                { key: 'volume',  unit: 'ml',  fStep: 1, fMax: 1000 },
            ];

            const fieldRefs = [];
            let maxTimer = null;

            const blueDisplayClass = 'bg-[var(--button-primary-bg)] text-white rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            const grayDisplayClass = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';

            const maxPlaceholder = document.createElement('span');
            maxPlaceholder.className = grayDisplayClass;
            maxPlaceholder.textContent = getTranslation('None');
            maxTopRow.appendChild(maxPlaceholder);

            function collapseMaxSpinner() {
                clearTimeout(maxTimer);
                expandedMaxSteps.delete(index);
                updateMaxSectionVisibility();
                clearFocusOverlay();
            }

            function startMaxTimer() {
                clearTimeout(maxTimer);
                maxTimer = setTimeout(collapseMaxSpinner, 2000);
            }

            function updateMaxSectionVisibility() {
                const activeKey = expandedMaxSteps.get(index) ?? null;
                const nonZeroCount = fieldRefs.filter(r => r.getValue() > 0).length;
                const allZero = nonZeroCount === 0;

                // Update blue/gray class
                fieldRefs.forEach(ref => {
                    let isBlue;
                    if (nonZeroCount === 0) {
                        isBlue = false;
                    } else if (nonZeroCount === 1) {
                        isBlue = ref.getValue() > 0;
                    } else {
                        const weightVal = fieldRefs.find(r => r.key === 'weight')?.getValue() ?? 0;
                        const secsVal   = fieldRefs.find(r => r.key === 'seconds')?.getValue() ?? 0;
                        if (weightVal > 0)    isBlue = ref.key === 'weight';
                        else if (secsVal > 0) isBlue = ref.key === 'seconds';
                        else                  isBlue = ref.key === 'volume';
                    }
                    ref.display.className = isBlue ? blueDisplayClass : grayDisplayClass;
                });

                // Reset section positioning before rebuild
                fieldRefs.forEach(ref => {
                    ref.section.style.position = '';
                    ref.section.style.top = '';
                    ref.section.style.bottom = '';
                    ref.section.style.left = '';
                    ref.section.style.transform = '';
                    ref.section.style.whiteSpace = '';
                    ref.section.style.marginTop = '';
                    ref.section.style.marginBottom = '';
                });

                // In edit mode prev/next sections are nested inside curr.section —
                // extract them before clearing so they aren't lost inside curr's subtree
                fieldRefs.forEach(ref => {
                    if (ref.section.parentNode && ref.section.parentNode !== maxTopRow) {
                        ref.section.parentNode.removeChild(ref.section);
                    }
                });

                maxTopRow.innerHTML = '';
                maxExtrasRow.style.display = 'none';
                maxExtrasRow.innerHTML = '';

                if (activeKey === null) {
                    // Collapsed: horizontal row, non-zero only (or placeholder)
                    maxTopRow.className = 'flex items-center gap-[8px]';
                    if (allZero) {
                        maxTopRow.appendChild(maxPlaceholder);
                    } else {
                        fieldRefs.forEach(ref => {
                            ref.minusBtn.style.display = 'none';
                            ref.plusBtn.style.display  = 'none';
                            if (ref.getValue() > 0) maxTopRow.appendChild(ref.section);
                        });
                    }
                } else {
                    // Edit: active pill stays in flow (no horizontal shift).
                    // Prev floats above via absolute, next floats below — both anchored to curr.section.
                    maxTopRow.className = 'flex items-center gap-[8px]';
                    const activeIdx = fieldRefs.findIndex(r => r.key === activeKey);
                    const n = fieldRefs.length;
                    const prev = fieldRefs[(activeIdx - 1 + n) % n];
                    const curr = fieldRefs[activeIdx];
                    const next = fieldRefs[(activeIdx + 1) % n];

                    fieldRefs.forEach(ref => {
                        ref.minusBtn.style.display = ref.key === activeKey ? '' : 'none';
                        ref.plusBtn.style.display  = ref.key === activeKey ? '' : 'none';
                    });

                    // curr stays in normal flow, centered in container
                    maxTopRow.className = 'flex items-center justify-center gap-[8px]';
                    curr.section.style.position = 'relative';
                    maxTopRow.appendChild(curr.section);

                    // prev floats above curr, centered over it
                    prev.section.style.position = 'absolute';
                    prev.section.style.bottom = '100%';
                    prev.section.style.left = '50%';
                    prev.section.style.transform = 'translateX(-50%)';
                    prev.section.style.marginBottom = '6px';
                    prev.section.style.whiteSpace = 'nowrap';
                    curr.section.appendChild(prev.section);

                    // next floats below curr, centered over it
                    next.section.style.position = 'absolute';
                    next.section.style.top = '100%';
                    next.section.style.left = '50%';
                    next.section.style.transform = 'translateX(-50%)';
                    next.section.style.marginTop = '6px';
                    next.section.style.whiteSpace = 'nowrap';
                    curr.section.appendChild(next.section);
                }
            }

            maxPlaceholder.addEventListener('click', () => {
                expandedMaxSteps.set(index, 'weight');
                updateMaxSectionVisibility();
                startMaxTimer();
                showFocusOverlay(maxTopRow, collapseMaxSpinner);
            });

            MAX_FIELDS.forEach(({ key, unit, fStep, fMax }) => {
                const isThisExpanded = (expandedMaxSteps.get(index) ?? null) === key;
                let fieldValue = step[key] || 0;

                const display = document.createElement('span');
                display.className = grayDisplayClass;
                display.textContent = `${fieldValue} ${unit}`;
                display.style.position = 'relative';

                const minusBtn = document.createElement('button');
                minusBtn.type = 'button';
                minusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
                minusBtn.textContent = '\u2212';
                minusBtn.style.position = 'absolute';
                minusBtn.style.right = '100%';
                minusBtn.style.top = '50%';
                minusBtn.style.transform = 'translateY(-50%)';
                minusBtn.style.marginRight = '4px';
                minusBtn.style.display = isThisExpanded ? '' : 'none';

                const plusBtn = document.createElement('button');
                plusBtn.type = 'button';
                plusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
                plusBtn.textContent = '+';
                plusBtn.style.position = 'absolute';
                plusBtn.style.left = '100%';
                plusBtn.style.top = '50%';
                plusBtn.style.transform = 'translateY(-50%)';
                plusBtn.style.marginLeft = '4px';
                plusBtn.style.display = isThisExpanded ? '' : 'none';

                display.appendChild(minusBtn);
                display.appendChild(plusBtn);

                const section = document.createElement('span');
                section.appendChild(display);

                fieldRefs.push({ key, minusBtn, plusBtn, display, section, getValue: () => fieldValue });

                let longPressTimer = null;
                let longPressFired = false;

                display.addEventListener('pointerdown', (e) => {
                    if (e.target === minusBtn || e.target === plusBtn) return;
                    if (expandedMaxSteps.get(index) !== key) return;
                    longPressFired = false;
                    longPressTimer = setTimeout(() => {
                        longPressFired = true;
                        fieldValue = 0;
                        display.childNodes[0].textContent = `0 ${unit}`;
                        editorState.profile.steps[index][key] = 0;
                        updateMaxSectionVisibility();
                        startMaxTimer();
                    }, 600);
                });
                display.addEventListener('pointerup',     () => clearTimeout(longPressTimer));
                display.addEventListener('pointerleave',  () => clearTimeout(longPressTimer));
                display.addEventListener('pointercancel', () => clearTimeout(longPressTimer));

                display.addEventListener('click', (e) => {
                    if (e.target === minusBtn || e.target === plusBtn) return;
                    if (longPressFired) { longPressFired = false; return; }
                    const current = expandedMaxSteps.get(index) ?? null;
                    if (current === key) {
                        if (shouldUseNumpad()) {
                            const MAX_CONFIG = {
                                weight:  { fieldType: 'pe-max-weight',  title: 'MAX WEIGHT', unit: 'g',   min: 0, max: 1000, label: '0\u20131000' },
                                seconds: { fieldType: 'pe-max-seconds', title: 'MAX TIME',   unit: 'sec', min: 0, max: 300,  label: '0\u2013300' },
                                volume:  { fieldType: 'pe-max-volume',  title: 'MAX VOLUME', unit: 'ml',  min: 0, max: 1000, label: '0\u20131000' },
                            };
                            openNumpadForField(fieldValue, MAX_CONFIG[key], (val) => {
                                fieldValue = val;
                                editorState.profile.steps[index][key] = val;
                                display.childNodes[0].textContent = `${val} ${unit}`;
                                renderReviewGraph();
                                updateMaxSectionVisibility();
                            });
                            startMaxTimer();
                            return;
                        }
                        if (!inlineEditValue(display, fieldValue, {
                            min: 0, max: fMax, step: fStep, unit,
                            onCommit(val) {
                                fieldValue = val;
                                editorState.profile.steps[index][key] = val;
                                display.childNodes[0].textContent = `${val} ${unit}`;
                                renderReviewGraph();
                                updateMaxSectionVisibility();
                            }
                        })) collapseMaxSpinner();
                    } else {
                        expandedMaxSteps.set(index, key);
                        updateMaxSectionVisibility();
                        startMaxTimer();
                        showFocusOverlay(maxTopRow, collapseMaxSpinner);
                    }
                });

                minusBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    flashPlusMinusButton(minusBtn);
                    fieldValue = roundTo(clamp(fieldValue - fStep, 0, fMax), fStep);
                    display.childNodes[0].textContent = `${fieldValue} ${unit}`;
                    editorState.profile.steps[index][key] = fieldValue;
                    updateMaxSectionVisibility();
                    startMaxTimer();
                });

                plusBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    flashPlusMinusButton(plusBtn);
                    fieldValue = roundTo(clamp(fieldValue + fStep, 0, fMax), fStep);
                    display.childNodes[0].textContent = `${fieldValue} ${unit}`;
                    editorState.profile.steps[index][key] = fieldValue;
                    updateMaxSectionVisibility();
                    startMaxTimer();
                });

            });

            updateMaxSectionVisibility();

            maxCell.appendChild(maxTopRow);
            maxCell.appendChild(maxExtrasRow);
        }

        // Footer: delete + insert
        const fCell = mkCell(R.FOOTER, col, 'flex justify-center items-center gap-[40px] px-[16px] py-[8px] border-r border-[var(--border-color)]');

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'pe-step-action-btn w-[60px] h-[60px] flex items-center justify-center text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>';
        deleteBtn.setAttribute('aria-label', 'Delete step');
        deleteBtn.addEventListener('click', () => { editorState.profile.steps.splice(index, 1); renderStepCards(); });

        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.className = 'pe-step-action-btn w-[60px] h-[60px] flex items-center justify-center text-[var(--mimoja-blue)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
        insertBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>';
        insertBtn.setAttribute('aria-label', 'Insert step after');
        insertBtn.addEventListener('click', () => { editorState.profile.steps.splice(index + 1, 0, makeNewStep()); renderStepCards(); });

        fCell.appendChild(deleteBtn);
        fCell.appendChild(insertBtn);
    });

}

function renderSettingsTab() {
    const container = document.getElementById('editor-settings-container');
    if (!container) return;
    container.innerHTML = '';

    const profile = editorState.profile;

    // Create 3 column containers. Use flex ratios (1:1:2) so columns divide the
    // ACTUAL available row space (after padding + gaps), not the parent's full
    // width — otherwise widths sum to 100% + 160px and rightCol overflows back
    // onto middleCol, clipping the Import button on tablet. min-w-0 lets
    // children shrink below their intrinsic min-content width.
    const leftCol = document.createElement('div');
    leftCol.className = 'flex flex-col gap-[45px] min-w-0';
    leftCol.style.flex = '1 1 0';

    const middleCol = document.createElement('div');
    middleCol.className = 'flex flex-col gap-[45px] min-w-0';
    middleCol.style.flex = '1 1 0';

    const rightCol = document.createElement('div');
    rightCol.className = 'flex flex-col gap-[24px] min-w-0';
    rightCol.style.flex = '2 1 0';

    container.appendChild(leftCol);
    container.appendChild(middleCol);
    container.appendChild(rightCol);

    function addFieldTo(targetCol, labelText, element) {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col gap-[12px]';
        const label = document.createElement('div');
        label.className = 'text-[24px] font-semibold text-[var(--text-primary)]';
        label.textContent = labelText;
        wrapper.appendChild(label);
        wrapper.appendChild(element);
        targetCol.appendChild(wrapper);
        return wrapper;
    }

    // ── Left column: Target Weight, Tank Temperature, Beverage Type, Author ──

    // Target Weight
    addFieldTo(leftCol, getTranslation('Target Weight (g)'), createSpinner(
        profile.target_weight || 0, 0.1, 'g', (val) => { editorState.profile.target_weight = val; }, { min: 0, max: 1000 }
    ));

    // Tank Temperature
    addFieldTo(leftCol, getTranslation('Tank Temperature (\u00b0c)'), createSpinner(
        profile.tank_temperature || 0, 1, '\u00b0c', (val) => { editorState.profile.tank_temperature = val; }, { min: 0, max: 110 }
    ));

    // Limiter Tolerance — separate controls for bar (flow-pump steps) and mL/s (pressure-pump steps)
    {
        const steps = profile.steps || [];
        const flowPumpStep = steps.find(s => s.pump === 'flow');
        const pressurePumpStep = steps.find(s => s.pump === 'pressure');

        const barRange = parseFloat(flowPumpStep?.limiter?.range ?? 0.6);
        addFieldTo(leftCol, getTranslation('Limiter Tolerance (bar)'), createSpinner(
            barRange, 0.1, 'bar', (val) => {
                (editorState.profile.steps || []).forEach(step => {
                    if (step.pump === 'flow') {
                        if (!step.limiter) step.limiter = { value: 0, range: val };
                        else step.limiter.range = val;
                    }
                });
            }, { min: 0, max: 5 }
        ));

        const mlsRange = parseFloat(pressurePumpStep?.limiter?.range ?? 0.6);
        addFieldTo(leftCol, getTranslation('Limiter Tolerance (mL/s)'), createSpinner(
            mlsRange, 0.1, 'mL/s', (val) => {
                (editorState.profile.steps || []).forEach(step => {
                    if (step.pump === 'pressure') {
                        if (!step.limiter) step.limiter = { value: 0, range: val };
                        else step.limiter.range = val;
                    }
                });
            }, { min: 0, max: 5 }
        ));
    }

    // Beverage Type (select)
    const select = document.createElement('select');
    select.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] w-full';
    ['espresso', 'manual', 'cleaning'].forEach((type) => {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = type.charAt(0).toUpperCase() + type.slice(1);
        if (profile.beverage_type === type) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => { editorState.profile.beverage_type = select.value; });
    addFieldTo(leftCol, getTranslation('Beverage type'), select);

    // Author (text input)
    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.value = profile.author || '';
    authorInput.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] w-full';
    authorInput.addEventListener('change', () => { editorState.profile.author = authorInput.value; });
    addFieldTo(leftCol, getTranslation('Author'), authorInput);

    // ── Middle column: Preinfusion ends after, After preinfusion stop the shot at ──

    // Preinfusion ends after — dropdown of step names
    {
        const steps = profile.steps || [];
        const countStart = profile.target_volume_count_start || 0;

        const preinfSelect = document.createElement('select');
        preinfSelect.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] w-full';

        const noneOpt = document.createElement('option');
        noneOpt.value = '0';
        noneOpt.textContent = getTranslation('None');
        if (countStart === 0) noneOpt.selected = true;
        preinfSelect.appendChild(noneOpt);

        steps.forEach((step, i) => {
            const opt = document.createElement('option');
            opt.value = String(i + 1);
            opt.textContent = step.name || `Step ${i + 1}`;
            if (countStart === i + 1) opt.selected = true;
            preinfSelect.appendChild(opt);
        });

        preinfSelect.addEventListener('change', () => {
            editorState.profile.target_volume_count_start = parseInt(preinfSelect.value, 10);
        });

        addFieldTo(middleCol, getTranslation('Preinfusion ends after'), preinfSelect);
    }

    // Target Volume (stop shot after preinfusion)
    addFieldTo(middleCol, getTranslation('After preinfusion stop the shot at'), createSpinner(
        profile.target_volume || 0, 1, 'ml', (val) => { editorState.profile.target_volume = val; }, { min: 0, max: 500 }
    ));

    // ── Middle column: Load Profile From (new profile only) ──

    const isNewProfile = editorState.sourceProfileId === null;

    function reloadEditorWithProfile(newProfile, sourceRecord) {
        // Track any server record created during a new-profile session so cancel can delete it
        if (_isNewProfileSession) {
            _hasImportedInSession = true;
            if (sourceRecord?.id && !_sessionImportedIds.includes(sourceRecord.id)) {
                _sessionImportedIds.push(sourceRecord.id);
            }
        }
        editorState.profile = deepCopy(newProfile);
        editorState.sourceProfileRecord = sourceRecord || null;
        editorState.sourceProfileId = sourceRecord?.id || null;
        expandedTempSteps.clear();
        expandedPumpSteps.clear();
        expandedLimSteps.clear();
        expandedMaxSteps.clear();
        expandedExitSteps.clear();
        expandedReviewField = null;
        const titleDisplay = document.getElementById('editor-title-display');
        if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';
        renderStepCards();
        renderSettingsTab();
    }

    if (isNewProfile) {
        // Upload local file button
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'w-full h-[56px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold rounded-[12px] flex items-center justify-center gap-[10px] hover:opacity-90 transition-opacity';
        const uploadIcon = document.createElement('span');
        uploadIcon.innerHTML = `<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>`;
        const uploadText = document.createElement('span');
        uploadText.textContent = getTranslation('Upload Local File');
        uploadBtn.appendChild(uploadIcon);
        uploadBtn.appendChild(uploadText);
        uploadBtn.addEventListener('click', () => {
            let fileInput = document.getElementById('pe-upload-input');
            if (!fileInput) {
                fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.id = 'pe-upload-input';
                fileInput.accept = '.json';
                fileInput.style.display = 'none';
                document.body.appendChild(fileInput);
            }
            fileInput.value = '';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const parsed = JSON.parse(await file.text());
                    const validation = validateProfileStructure(parsed);
                    if (!validation.isValid) throw new Error(validation.errorMessage);
                    reloadEditorWithProfile(parsed, null);
                    showToast(`Loaded: ${parsed.title || 'Profile'}`, 2500, 'success');
                } catch (err) {
                    showToast(`Error: ${err.message}`, 4000, 'error');
                }
            };
            fileInput.click();
        });
        addFieldTo(middleCol, getTranslation('Upload Local File'), uploadBtn);

        // Import from share code
        const shareSection = document.createElement('div');
        shareSection.className = 'flex flex-col gap-[10px]';

        const shareRow = document.createElement('div');
        shareRow.className = 'flex gap-[10px]';

        const shareInput = document.createElement('input');
        shareInput.type = 'text';
        shareInput.maxLength = 4;
        shareInput.placeholder = 'ABCD';
        shareInput.className = 'flex-1 h-[56px] text-[22px] font-bold text-center tracking-[6px] bg-[var(--box-color)] border-2 border-[var(--border-color)] rounded-[12px] outline-none focus:border-[var(--mimoja-blue)]';
        shareInput.addEventListener('input', () => { shareInput.value = shareInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

        const shareImportBtn = document.createElement('button');
        shareImportBtn.textContent = getTranslation('Import');
        shareImportBtn.className = 'h-[56px] px-[24px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold rounded-[12px] hover:opacity-90 transition-opacity shrink-0';

        const shareStatus = document.createElement('p');
        shareStatus.className = 'text-[18px] text-[var(--low-contrast-white)] min-h-[24px]';

        shareImportBtn.addEventListener('click', async () => {
            const code = shareInput.value.trim();
            if (code.length !== 4) {
                shareStatus.textContent = getTranslation('Enter a 4-character code.');
                return;
            }
            shareImportBtn.disabled = true;
            shareImportBtn.textContent = getTranslation('Importing…');
            shareStatus.textContent = '';
            try {
                const vizSettings = await getPluginSettings('visualizer.reaplugin');
                const isConfigured = vizSettings?.Enabled !== false && !!(vizSettings?.Username && vizSettings?.Password);
                if (!isConfigured) {
                    shareStatus.innerHTML = 'No Visualizer account found. Go to <strong>Settings → Extensions → Visualizer</strong> to log in first.';
                    return;
                }
                const result = await callPluginEndpoint('visualizer.reaplugin', 'import', { shareCode: code });
                if (!result.success) {
                    const msg = result.error || 'Import failed';
                    const isAuthError = /credential|login|auth|unauthorized|password|username/i.test(msg);
                    shareStatus.innerHTML = isAuthError
                        ? `${msg} — Go to <strong>Settings → Extensions → Visualizer</strong> to log in.`
                        : msg;
                    return;
                }
                const { init: initPM, availableProfiles } = await import('./profileManager.js');
                await initPM();
                const rec = availableProfiles[result.profileId];
                if (!rec) throw new Error('Profile not found after import');
                reloadEditorWithProfile(rec.profile, rec);
                showToast(`Imported: ${rec.profile.title}`, 2500, 'success');
            } catch (err) {
                shareStatus.textContent = err.message;
            } finally {
                shareImportBtn.disabled = false;
                shareImportBtn.textContent = getTranslation('Import');
            }
        });

        shareRow.appendChild(shareInput);
        shareRow.appendChild(shareImportBtn);
        shareSection.appendChild(shareRow);
        shareSection.appendChild(shareStatus);
        addFieldTo(middleCol, getTranslation('Import from Share Code'), shareSection);
    }

    // ── Right column: Notes (tall textarea filling column height) ──

    const notesPreview = document.createElement('div');
    notesPreview.className = 'text-[22px] text-[var(--text-primary)] bg-[var(--box-color)] border-2 border-[var(--border-color)] rounded-[12px] px-[20px] py-[16px] cursor-pointer select-none overflow-y-auto flex-1 whitespace-pre-wrap leading-[1.5] hover:border-[var(--mimoja-blue)] transition-colors';
    function updateNotesPreview() {
        const text = editorState.profile.notes || '';
        if (text) {
            notesPreview.textContent = text;
            notesPreview.style.color = '';
        } else {
            notesPreview.textContent = getTranslation('Tap to edit notes\u2026');
            notesPreview.style.color = '#959595';
        }
    }
    updateNotesPreview();
    notesPreview.addEventListener('click', () => {
        openNotesModal(editorState.profile.notes || '', (newText) => {
            editorState.profile.notes = newText;
            updateNotesPreview();
        });
    });
    const notesWrapper = addFieldTo(rightCol, getTranslation('Notes'), notesPreview);
    notesWrapper.className = 'flex flex-col gap-[12px] flex-1';
}

// ─── Review Tab ─────────────────────────────────────────────────────────────

function describeStep(step, index) {
    const PROSE_CLASS = 'text-[20px] text-[var(--text-primary)] select-none';
    const PILL_ACTIVE   = 'text-[var(--button-primary-bg)] text-[20px] font-semibold cursor-pointer select-none inline-flex underline decoration-dashed underline-offset-[3px] px-[4px] rounded-[4px]';
    const TOGGLE_CLASS  = 'text-[var(--button-primary-bg)] text-[20px] font-semibold cursor-pointer select-none underline decoration-dashed underline-offset-[3px] px-[4px]';
    const BTN_CLASS     = 'bg-[var(--button-grey)] rounded-[18px] w-[40px] h-[40px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';

    function makeProseSpan(text) {
        const span = document.createElement('span');
        span.className = PROSE_CLASS;
        span.textContent = text;
        return span;
    }

    function makeToggle(initialText, onClick) {
        const span = document.createElement('span');
        span.className = TOGGLE_CLASS;
        span.textContent = initialText;
        span.addEventListener('click', () => { onClick(span); });
        return span;
    }

    function makeNumericSpinner(initialValue, step, unit, min, max, onCommit) {
        let value = initialValue;
        let collapseTimer = null;

        const wrapper = document.createElement('span');
        wrapper.style.display = 'inline-flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.position = 'relative';

        const valuePill = document.createElement('span');
        valuePill.className = PILL_ACTIVE;
        valuePill.textContent = `${roundTo(value, step)} ${unit}`;
        valuePill.addEventListener('mouseenter', () => { valuePill.style.backgroundColor = 'var(--button-grey)'; });
        valuePill.addEventListener('mouseleave', () => { valuePill.style.backgroundColor = ''; });

        const minusBtn = document.createElement('span');
        minusBtn.className = BTN_CLASS;
        minusBtn.textContent = '\u2212';
        minusBtn.style.position = 'absolute';
        minusBtn.style.right = '100%';
        minusBtn.style.top = '50%';
        minusBtn.style.transform = 'translateY(-50%)';
        minusBtn.style.marginRight = '4px';

        const plusBtn = document.createElement('span');
        plusBtn.className = BTN_CLASS;
        plusBtn.textContent = '+';
        plusBtn.style.position = 'absolute';
        plusBtn.style.left = '100%';
        plusBtn.style.top = '50%';
        plusBtn.style.transform = 'translateY(-50%)';
        plusBtn.style.marginLeft = '4px';

        function hideBtns() {
            minusBtn.style.display = 'none';
            plusBtn.style.display = 'none';
        }

        function showBtns() {
            minusBtn.style.display = '';
            plusBtn.style.display = '';
        }

        function updatePill() {
            valuePill.textContent = `${roundTo(value, step)} ${unit}`;
            valuePill.className = PILL_ACTIVE;
        }

        function collapse() {
            clearTimeout(collapseTimer);
            hideBtns();
            expandedReviewField = null;
            clearFocusOverlay();
        }

        function resetTimer() {
            clearTimeout(collapseTimer);
            collapseTimer = setTimeout(collapse, 2000);
        }

        function expand() {
            if (expandedReviewField) expandedReviewField.collapseFunc();
            showBtns();
            expandedReviewField = { collapseFunc: collapse };
            showFocusOverlay(wrapper, collapse);
            resetTimer();
        }

        // Click on value pill to expand/collapse
        let longPressTimer = null;
        let longPressFired = false;

        valuePill.addEventListener('pointerdown', () => {
            if (!expandedReviewField || expandedReviewField.collapseFunc !== collapse) return;
            longPressFired = false;
            longPressTimer = setTimeout(() => {
                longPressFired = true;
                value = 0;
                updatePill();
                onCommit(0);
                resetTimer();
            }, 600);
        });
        valuePill.addEventListener('pointerup', () => clearTimeout(longPressTimer));
        valuePill.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
        valuePill.addEventListener('pointercancel', () => clearTimeout(longPressTimer));

        valuePill.addEventListener('click', () => {
            if (longPressFired) { longPressFired = false; return; }
            if (expandedReviewField && expandedReviewField.collapseFunc === collapse) {
                if (shouldUseNumpad()) {
                    openNumpadForField(value, {
                        fieldType: 'pe-review',
                        title: unit.toUpperCase(),
                        unit, min, max,
                        label: `${min}\u2013${max}`
                    }, (val) => {
                        value = val;
                        valuePill.textContent = `${roundTo(value, step)} ${unit}`;
                        onCommit(value);
                        resetTimer();
                    });
                    return;
                }
                if (!inlineEditValue(valuePill, value, {
                    min, max, step, unit,
                    onCommit(val) {
                        value = val;
                        valuePill.textContent = `${roundTo(value, step)} ${unit}`;
                        onCommit(value);
                        resetTimer();
                    }
                })) collapse();
            } else {
                expand();
            }
        });

        minusBtn.addEventListener('click', () => {
            flashPlusMinusButton(minusBtn);
            value = roundTo(clamp(value - step, min, max), step);
            updatePill();
            onCommit(value);
            resetTimer();
        });

        plusBtn.addEventListener('click', () => {
            flashPlusMinusButton(plusBtn);
            value = roundTo(clamp(value + step, min, max), step);
            updatePill();
            onCommit(value);
            resetTimer();
        });

        // Always render all three nodes; ± hidden until expanded
        wrapper.appendChild(minusBtn);
        wrapper.appendChild(valuePill);
        wrapper.appendChild(plusBtn);
        hideBtns();

        return wrapper;
    }

    function makeLine(children) {
        const span = document.createElement('span');
        span.className = 'inline-flex items-center gap-[6px]';
        for (const child of children) {
            if (typeof child === 'string') {
                span.appendChild(makeProseSpan(child));
            } else {
                span.appendChild(child);
            }
        }
        return span;
    }

    const lines = [];
    const isFlow = step.pump !== 'pressure';

    // Line 1 — Temperature + sensor
    {
        let sensorValue = step.sensor || 'coffee';
        const sensorToggle = makeToggle(
            sensorValue === 'water' ? getTranslation('Water') : getTranslation('Coffee'),
            (span) => {
                sensorValue = sensorValue === 'coffee' ? 'water' : 'coffee';
                span.textContent = sensorValue === 'coffee' ? getTranslation('Coffee') : getTranslation('Water');
                editorState.profile.steps[index].sensor = sensorValue;
                renderReviewGraph();
            }
        );

        const tempSpinner = makeNumericSpinner(
            step.temperature ?? 93, 0.5, '\u00b0C', 0, 110,
            (val) => { editorState.profile.steps[index].temperature = val; renderReviewGraph(); }
        );

        lines.push(makeLine([sensorToggle, getTranslation('to'), tempSpinner]));
    }

    // Line 2 — Pump target
    {
        let transValue = step.transition || 'fast';
        const transToggle = makeToggle(
            transValue === 'fast' ? getTranslation('Quickly') : getTranslation('Slowly'),
            (span) => {
                transValue = transValue === 'fast' ? 'smooth' : 'fast';
                span.textContent = transValue === 'fast' ? getTranslation('Quickly') : getTranslation('Slowly');
                editorState.profile.steps[index].transition = transValue;
                renderReviewGraph();
            }
        );

        if (isFlow) {
            const flowSpinner = makeNumericSpinner(
                step.flow ?? 0, 0.1, 'mL/s', 0, 15,
                (val) => { editorState.profile.steps[index].flow = val; renderReviewGraph(); }
            );
            lines.push(makeLine([getTranslation('Ramp'), transToggle, getTranslation('to'), flowSpinner]));
        } else {
            const pressureSpinner = makeNumericSpinner(
                step.pressure ?? 0, 0.1, 'bar', 0, 16,
                (val) => { editorState.profile.steps[index].pressure = val; renderReviewGraph(); }
            );
            lines.push(makeLine([getTranslation('Ramp'), transToggle, getTranslation('to'), pressureSpinner]));
        }
    }

    // Line 3 — Limiter (only if non-zero)
    {
        const limValue = step.limiter?.value ?? 0;
        const limUnit  = isFlow ? 'bar' : 'mL/s';
        const limMax   = isFlow ? 16 : 15;
        if (limValue > 0) {
            const limSpinner = makeNumericSpinner(
                limValue, 0.1, limUnit, 0, limMax,
                (val) => {
                    if (!editorState.profile.steps[index].limiter) editorState.profile.steps[index].limiter = { value: val, range: 0.6 };
                    else editorState.profile.steps[index].limiter.value = val;
                    renderReviewGraph();
                }
            );
            lines.push(makeLine([getTranslation('Limit to'), limSpinner]));
        }
    }

    // Line 4 — Max (weight / seconds / volume)
    // Collapsed + all-zero  → "+ max" placeholder
    // Collapsed + any non-zero → "Up to [non-zero pills]"
    // Expanded → mainRow: non-zero pills  |  extraRow below: zero pills (no ± overlap)
    {
        const MAX_FIELDS = [
            { key: 'weight',  unit: 'g',   fStep: 1, fMax: 500 },
            { key: 'seconds', unit: 'sec', fStep: 1, fMax: 300 },
            { key: 'volume',  unit: 'ml',  fStep: 1, fMax: 500 },
        ];

        const vals = { weight: step.weight ?? 0, seconds: step.seconds ?? 0, volume: step.volume ?? 0 };
        let maxExpanded = false, activeMaxField = null, maxTimer = null;

        // ── Stable container (never destroyed) ───────────────────────────────
        const lineWrapper = document.createElement('span');
        lineWrapper.style.cssText = 'display:inline-flex;flex-direction:column;gap:4px;position:relative;';

        const mainRow = document.createElement('span');
        mainRow.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';

        const extraRow = document.createElement('span');
        extraRow.style.cssText = 'display:none;align-items:center;gap:6px;';

        lineWrapper.appendChild(mainRow);
        lineWrapper.appendChild(extraRow);

        // ── Static text nodes (moved, never recreated) ────────────────────────
        const upToText = document.createElement('span');
        upToText.className = PROSE_CLASS;
        upToText.textContent = getTranslation('Up to');

        const placeholder = document.createElement('span');
        placeholder.className = PILL_ACTIVE;
        placeholder.textContent = '+ max';
        placeholder.addEventListener('click', () => {
            if (expandedReviewField) expandedReviewField.collapseFunc();
            maxExpanded = true;
            activeMaxField = MAX_FIELDS[0].key; // activate first pill immediately
            expandedReviewField = { _isMax: true, collapseFunc: collapseMax };
            updateMaxDisplay();
            showFocusOverlay(lineWrapper, collapseMax);
            startMaxTimer();
        });

        // ── Pill elements (created once per field, moved between rows) ────────
        const pillEls = {};
        MAX_FIELDS.forEach(({ key, unit, fStep, fMax }) => {
            const pill = document.createElement('span');
            pill.className = PILL_ACTIVE;
            pill.style.position = 'relative';

            const minus = document.createElement('span');
            minus.className = BTN_CLASS;
            minus.textContent = '\u2212';
            minus.style.cssText = 'position:absolute;right:100%;top:50%;transform:translateY(-50%);margin-right:4px;display:none;';

            const textEl = document.createElement('span');
            textEl.textContent = `${vals[key]} ${unit}`;

            const plus = document.createElement('span');
            plus.className = BTN_CLASS;
            plus.textContent = '+';
            plus.style.cssText = 'position:absolute;left:100%;top:50%;transform:translateY(-50%);margin-left:4px;display:none;';

            pill.appendChild(minus);
            pill.appendChild(textEl);
            pill.appendChild(plus);

            pillEls[key] = { pill, minus, textEl, plus };

            // Long press → zero out
            let lpTimer = null, lpFired = false;
            pill.addEventListener('pointerdown', (e) => {
                if (e.target === minus || e.target === plus) return;
                if (activeMaxField !== key) return;
                lpFired = false;
                lpTimer = setTimeout(() => {
                    lpFired = true;
                    vals[key] = 0;
                    editorState.profile.steps[index][key] = 0;
                    textEl.textContent = `0 ${unit}`;
                    renderReviewGraph();
                    updateMaxDisplay();
                    startMaxTimer();
                }, 600);
            });
            pill.addEventListener('pointerup',     () => clearTimeout(lpTimer));
            pill.addEventListener('pointerleave',  () => clearTimeout(lpTimer));
            pill.addEventListener('pointercancel', () => clearTimeout(lpTimer));

            pill.addEventListener('click', (e) => {
                if (e.target === minus || e.target === plus) return;
                if (lpFired) { lpFired = false; return; }
                if (activeMaxField === key) {
                    if (shouldUseNumpad()) {
                        const MAX_CONFIGS = {
                            weight:  { fieldType: 'pe-max-weight',  title: 'MAX WEIGHT', unit: 'g',   min: 0, max: 500, label: '0\u2013500' },
                            seconds: { fieldType: 'pe-max-seconds', title: 'MAX TIME',   unit: 'sec', min: 0, max: 300, label: '0\u2013300' },
                            volume:  { fieldType: 'pe-max-volume',  title: 'MAX VOLUME', unit: 'ml',  min: 0, max: 500, label: '0\u2013500' },
                        };
                        openNumpadForField(vals[key], MAX_CONFIGS[key], (val) => {
                            vals[key] = val;
                            editorState.profile.steps[index][key] = val;
                            textEl.textContent = `${val} ${unit}`;
                            renderReviewGraph();
                            updateMaxDisplay();
                        });
                        startMaxTimer();
                        return;
                    }
                    if (!inlineEditValue(pill, vals[key], {
                        min: 0, max: fMax, step: fStep, unit,
                        onCommit(val) {
                            vals[key] = val;
                            editorState.profile.steps[index][key] = val;
                            textEl.textContent = `${val} ${unit}`;
                            renderReviewGraph();
                            updateMaxDisplay();
                        }
                    })) {
                        activeMaxField = null;
                        if (expandedReviewField && expandedReviewField._isMax) expandedReviewField = null;
                        updateMaxDisplay();
                    }
                } else {
                    if (expandedReviewField && !expandedReviewField._isMax) expandedReviewField.collapseFunc();
                    activeMaxField = key;
                    maxExpanded = true;
                    expandedReviewField = { _isMax: true, collapseFunc: collapseMax };
                    updateMaxDisplay();
                    showFocusOverlay(lineWrapper, collapseMax);
                    startMaxTimer();
                }
            });

            minus.addEventListener('click', (e) => {
                e.stopPropagation();
                flashPlusMinusButton(minus);
                const wasZero = vals[key] === 0;
                vals[key] = roundTo(clamp(vals[key] - fStep, 0, fMax), fStep);
                editorState.profile.steps[index][key] = vals[key];
                textEl.textContent = `${vals[key]} ${unit}`;
                renderReviewGraph();
                if (wasZero !== (vals[key] === 0)) updateMaxDisplay();
                startMaxTimer();
            });

            plus.addEventListener('click', (e) => {
                e.stopPropagation();
                flashPlusMinusButton(plus);
                const wasZero = vals[key] === 0;
                vals[key] = roundTo(clamp(vals[key] + fStep, 0, fMax), fStep);
                editorState.profile.steps[index][key] = vals[key];
                textEl.textContent = `${vals[key]} ${unit}`;
                renderReviewGraph();
                if (wasZero !== (vals[key] === 0)) updateMaxDisplay();
                startMaxTimer();
            });
        });

        function collapseMax() {
            clearTimeout(maxTimer);
            activeMaxField = null;
            maxExpanded = false;
            if (expandedReviewField && expandedReviewField._isMax) expandedReviewField = null;
            updateMaxDisplay();
            clearFocusOverlay();
        }

        function startMaxTimer() {
            clearTimeout(maxTimer);
            maxTimer = setTimeout(collapseMax, 2000);
        }

        // Move stable nodes between rows — no destroy/recreate, no event listener loss.
        // Option B: when editing, hide non-active non-zero siblings; show zero siblings to right.
        function updateMaxDisplay() {
            // Clear rows completely (removes transient wrappers like zeroGroup spans)
            mainRow.innerHTML = '';
            extraRow.innerHTML = '';
            extraRow.style.display = 'none';
            mainRow.style.gap = '6px';

            const anyNonZero = MAX_FIELDS.some(f => vals[f.key] > 0);

            // Collapsed + all zero → placeholder only
            if (!maxExpanded && !anyNonZero) {
                mainRow.style.gap = '6px';
                mainRow.appendChild(placeholder);
                return;
            }

            mainRow.appendChild(upToText);

            // Show/hide ± buttons
            MAX_FIELDS.forEach(({ key }) => {
                const ref = pillEls[key];
                ref.minus.style.display = activeMaxField === key ? '' : 'none';
                ref.plus.style.display  = activeMaxField === key ? '' : 'none';
            });

            if (activeMaxField !== null) {
                // Edit mode: active pill with ±, zero-value siblings grouped to right
                mainRow.style.gap = '52px';
                mainRow.appendChild(pillEls[activeMaxField].pill);
                const zeroSiblings = MAX_FIELDS.filter(f => f.key !== activeMaxField && vals[f.key] === 0);
                if (zeroSiblings.length > 0) {
                    const zeroGroup = document.createElement('span');
                    zeroGroup.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
                    zeroSiblings.forEach(f => zeroGroup.appendChild(pillEls[f.key].pill));
                    mainRow.appendChild(zeroGroup);
                }
            } else {
                // No active field: show all non-zero inline, zero pills in extraRow if expanded
                mainRow.style.gap = '6px';
                const zeroKeys = [];
                MAX_FIELDS.forEach(({ key }) => {
                    if (vals[key] > 0) {
                        mainRow.appendChild(pillEls[key].pill);
                    } else if (maxExpanded) {
                        zeroKeys.push(key);
                    }
                });
                if (zeroKeys.length > 0) {
                    zeroKeys.forEach(key => extraRow.appendChild(pillEls[key].pill));
                    extraRow.style.display = 'inline-flex';
                    extraRow.style.gap = '6px';
                }
            }
        }

        updateMaxDisplay();
        lines.push(lineWrapper);
    }

    // Line 4 — Exit condition
    {
        const exitDef = step.exit || { type: 'pressure', condition: 'over', value: 0 };
        let exitType = exitDef.type || 'pressure';
        let exitCond = exitDef.condition || 'over';
        let exitValue = exitDef.value ?? 0;

        if (exitType !== 'off' && exitValue !== 0) {
            const exitTypeToggle = makeToggle(
                exitType.charAt(0).toUpperCase() + exitType.slice(1),
                (span) => {
                    const nonOff = EXIT_TYPES.filter(t => t !== 'off');
                    const idx = nonOff.indexOf(exitType);
                    exitType = nonOff[(idx + 1) % nonOff.length];
                    span.textContent = exitType.charAt(0).toUpperCase() + exitType.slice(1);
                    if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                    else editorState.profile.steps[index].exit.type = exitType;
                    // Update the spinner's unit display — rebuild is simplest via re-render
                    renderReviewGraph();
                }
            );

            const exitCondToggle = makeToggle(
                exitCond.charAt(0).toUpperCase() + exitCond.slice(1),
                (span) => {
                    exitCond = exitCond === 'over' ? 'under' : 'over';
                    span.textContent = exitCond.charAt(0).toUpperCase() + exitCond.slice(1);
                    if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                    else editorState.profile.steps[index].exit.condition = exitCond;
                    renderReviewGraph();
                }
            );

            const exitSpinner = makeNumericSpinner(
                exitValue, EXIT_STEP_MAP[exitType], EXIT_UNIT_MAP[exitType], 0, EXIT_MAX_MAP[exitType],
                (val) => {
                    exitValue = val;
                    if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: val };
                    else editorState.profile.steps[index].exit.value = val;
                    renderReviewGraph();
                }
            );

            lines.push(makeLine([getTranslation('Move on if'), exitTypeToggle, getTranslation('is'), exitCondToggle, exitSpinner]));
        }
    }

    return lines;
}

function renderReviewGraph() {
    const profile = editorState.profile;
    const graphDiv = document.getElementById('review-graph');
    if (!graphDiv || typeof Plotly === 'undefined') return;

    const isDark = (localStorage.getItem('theme') || 'light') === 'dark';
    const stepMarkerColor = isDark ? '#7f8bbb' : '#7c7c7c';
    const tempLineColor = isDark ? '#AE6D73' : '#ff97a1';

    // Build step-target traces + step boundary markers
    const pressureX = [], pressureY = [], flowX = [], flowY = [], tempX = [], tempY = [];
    const stepShapes = [];
    let t = 0;
    for (const step of (profile.steps || [])) {
        const dur = (step.seconds && step.seconds > 0) ? step.seconds : 10;
        const startT = t;
        const endT = t + dur;

        // Step boundary vertical line (skip t=0)
        if (startT > 0) {
            stepShapes.push({
                type: 'line',
                x0: startT, x1: startT,
                y0: 0, y1: 1, yref: 'paper',
                line: { color: stepMarkerColor, width: 2, dash: 'longdash' },
            });
        }

        if (step.pump === 'pressure') {
            pressureX.push(startT, endT);
            pressureY.push(step.pressure ?? 0, step.pressure ?? 0);
            flowX.push(startT, endT);
            flowY.push(0, 0);
        } else {
            flowX.push(startT, endT);
            flowY.push(step.flow ?? 0, step.flow ?? 0);
            pressureX.push(startT, endT);
            pressureY.push(0, 0);
        }
        const tempScaled = ((step.temperature ?? 0) / 100) * 10;
        tempX.push(startT, endT);
        tempY.push(tempScaled, tempScaled);
        t = endT;
    }

    const traces = [
        { x: pressureX, y: pressureY, name: 'Pressure', mode: 'lines', line: { color: '#17c29a' }, hoverinfo: 'name' },
        { x: flowX,     y: flowY,     name: 'Flow',     mode: 'lines', line: { color: '#0358cf' }, hoverinfo: 'name' },
        { x: tempX,     y: tempY,     name: '\u00b0C',  mode: 'lines', line: { color: tempLineColor }, hoverinfo: 'name' },
    ];

    const layout = isDark ? {
        plot_bgcolor: '#0d0e14',
        paper_bgcolor: '#0d0e14',
        font: { color: '#606579', size: 16 },
        autosize: true,
        margin: { l: 50, r: 50, t: 20, b: 40, pad: 0 },
        showlegend: false,
        shapes: stepShapes,
        xaxis: { gridcolor: '#3D4255', linecolor: '#606579', tickcolor: '#606579', fixedrange: true },
        yaxis: { gridcolor: '#3D4255', linecolor: '#606579', tickcolor: '#606579', range: [0, 10], dtick: 1, fixedrange: true },
    } : {
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        font: { color: '#959595', size: 16 },
        autosize: true,
        margin: { l: 50, r: 50, t: 20, b: 40, pad: 0 },
        showlegend: false,
        shapes: stepShapes,
        xaxis: { gridcolor: '#E0E0E0', linecolor: '#959595', tickcolor: '#959595', fixedrange: true },
        yaxis: { gridcolor: '#E0E0E0', linecolor: '#959595', tickcolor: '#959595', range: [0, 10], dtick: 1, fixedrange: true },
    };

    Plotly.react(graphDiv, traces, layout, { responsive: true, displayModeBar: false });
}

function renderReviewTab() {
    // Collapse any open review spinner since DOM is being rebuilt
    if (expandedReviewField) { expandedReviewField.collapseFunc(); expandedReviewField = null; }

    const profile = editorState.profile;
    if (!profile) return;

    // ── Steps list ──────────────────────────────────────────────────────────
    const stepsList = document.getElementById('review-steps-list');
    if (stepsList) {
        stepsList.innerHTML = '';
        const steps = profile.steps || [];
        const half = Math.ceil(steps.length / 2);

        const leftCol = document.createElement('div');
        leftCol.className = 'flex flex-col gap-[20px] flex-1';
        const rightCol = document.createElement('div');
        rightCol.className = 'flex flex-col gap-[20px] flex-1';

        steps.forEach((step, i) => {
            const row = document.createElement('div');
            row.className = 'flex flex-col gap-[6px] text-[var(--text-primary)]';

            const nameRow = document.createElement('div');
            nameRow.className = 'flex items-center justify-between';

            const nameEl = document.createElement('p');
            nameEl.className = 'font-semibold text-[20px] leading-[1.3]';
            nameEl.textContent = `${i + 1}: ${step.name || 'Step'}`;

            const nameActions = document.createElement('div');
            nameActions.className = 'flex items-center gap-[4px]';

            const reviewDeleteBtn = document.createElement('button');
            reviewDeleteBtn.type = 'button';
            reviewDeleteBtn.className = 'pe-step-action-btn w-[36px] h-[36px] flex items-center justify-center text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
            reviewDeleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>';
            reviewDeleteBtn.setAttribute('aria-label', 'Delete step');
            reviewDeleteBtn.addEventListener('click', () => {
                editorState.profile.steps.splice(i, 1);
                renderStepCards();
                renderReviewTab();
            });

            const reviewInsertBtn = document.createElement('button');
            reviewInsertBtn.type = 'button';
            reviewInsertBtn.className = 'pe-step-action-btn w-[36px] h-[36px] flex items-center justify-center text-[var(--mimoja-blue)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
            reviewInsertBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>';
            reviewInsertBtn.setAttribute('aria-label', 'Insert step after');
            reviewInsertBtn.addEventListener('click', () => {
                editorState.profile.steps.splice(i + 1, 0, makeNewStep());
                renderStepCards();
                renderReviewTab();
            });

            nameActions.appendChild(reviewDeleteBtn);
            nameActions.appendChild(reviewInsertBtn);
            nameRow.appendChild(nameEl);
            nameRow.appendChild(nameActions);
            row.appendChild(nameRow);

            const bulletCol = document.createElement('ul');
            bulletCol.className = 'flex flex-col gap-[6px] list-disc list-inside text-[20px]';
            for (const lineEl of describeStep(step, i)) {
                const li = document.createElement('li');
                li.appendChild(lineEl);
                bulletCol.appendChild(li);
            }
            row.appendChild(bulletCol);
            (i < half ? leftCol : rightCol).appendChild(row);
        });

        stepsList.appendChild(leftCol);
        stepsList.appendChild(rightCol);
    }

    // ── Settings list ───────────────────────────────────────────────────────
    const settingsList = document.getElementById('review-settings-list');
    if (settingsList) {
        settingsList.innerHTML = '';
        const s = (label, val) => {
            const li = document.createElement('li');
            li.innerHTML = `${label} <span class="font-semibold text-[var(--button-primary-bg)]">${val}</span>`;
            settingsList.appendChild(li);
        };
        const appendRow = (label, pillEl) => {
            const li = document.createElement('li');
            li.append(`${label} `);
            li.appendChild(pillEl);
            settingsList.appendChild(li);
        };

        if (profile.tank_temperature != null) {
            appendRow(getTranslation('Preheat water tank at'), createSettingPill({
                value: profile.tank_temperature, step: 1, unit: '\u00b0C', min: 0, max: 110,
                fieldType: 'pe-tank-temp', title: 'TANK TEMPERATURE',
                onCommit: (v) => { editorState.profile.tank_temperature = v; }
            }));
        }
        if (profile.target_volume_count_start != null) {
            const steps = profile.steps || [];
            appendRow(getTranslation('Track water volume after step'), createSettingPill({
                value: profile.target_volume_count_start, step: 1, unit: '', min: 0, max: Math.max(steps.length, 1),
                fieldType: 'pe-vol-count-start', title: 'STEP NUMBER',
                format: (v) => `${Math.round(v)}`,
                onCommit: (v) => { editorState.profile.target_volume_count_start = Math.round(v); }
            }));
        }
        if (profile.target_weight != null && profile.target_weight > 0) {
            appendRow(getTranslation('Stop at weight'), createSettingPill({
                value: profile.target_weight, step: 0.1, unit: 'g', min: 0, max: 1000,
                fieldType: 'pe-target-weight', title: 'TARGET WEIGHT',
                onCommit: (v) => { editorState.profile.target_weight = v; }
            }));
        }
        if (profile.target_volume != null && profile.target_volume > 0) {
            appendRow(getTranslation('Stop at volume'), createSettingPill({
                value: profile.target_volume, step: 1, unit: 'ml', min: 0, max: 1000,
                fieldType: 'pe-target-volume', title: 'TARGET VOLUME',
                onCommit: (v) => { editorState.profile.target_volume = v; }
            }));
        }
        if (profile.beverage_type) s(getTranslation('Beverage type'), profile.beverage_type);
    }

    // ── Graph preview ───────────────────────────────────────────────────────
    renderReviewGraph();
}

// ─── Tab Management ─────────────────────────────────────────────────────────

function setActiveTab(tabIndex) {
    editorState.activeTab = tabIndex;

    // Update tab buttons
    document.querySelectorAll('.editor-tab-btn').forEach((btn) => {
        const idx = parseInt(btn.dataset.tab, 10);
        if (idx === tabIndex) {
            btn.className = 'editor-tab-btn font-bold px-[28px] h-[44px] rounded-[44px] transition-colors text-[20px] tracking-wide bg-[var(--button-primary-bg)] text-white';
        } else {
            btn.className = 'editor-tab-btn font-bold px-[28px] h-[44px] rounded-[44px] transition-colors text-[20px] tracking-wide text-[var(--button-primary-bg)] bg-transparent';
        }
    });

    // Show/hide panels
    for (let i = 0; i < TAB_COUNT; i++) {
        const panel = document.getElementById(`editor-tab-panel-${i}`);
        if (panel) {
            panel.classList.toggle('hidden', i !== tabIndex);
        }
    }

    if (tabIndex === 2) renderReviewTab();
}

// ─── Title Editing ──────────────────────────────────────────────────────────

function initTitleEditing() {
    const display = document.getElementById('editor-title-display');
    const input = document.getElementById('editor-title-input');

    if (!display || !input) return;

    function startEditing() {
        display.classList.add('hidden');
        input.classList.remove('hidden');
        input.value = editorState.profile.title || '';
        input.focus();
        input.select();
    }

    function stopEditing() {
        const val = input.value.trim();
        if (val) {
            editorState.profile.title = val;
            display.textContent = val;
        }
        input.classList.add('hidden');
        display.classList.remove('hidden');
    }

    display.addEventListener('click', startEditing);

    input.addEventListener('blur', stopEditing);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = editorState.profile.title || ''; input.blur(); }
    });
}

// ─── Save / Cancel ──────────────────────────────────────────────────────────

// Prompt user whether to overwrite an existing KV profile or save as new.
// Returns { action: 'overwrite' | 'new' | 'cancel', title? }. Anchored near
// the top of the viewport so the soft keyboard (overlays-content, no resize)
// does not cover the input.
function promptOverwriteOrSaveAs(currentTitle, suggestedNewTitle) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pe-save-dialog rounded-[16px] bg-[var(--box-color)] p-0 border border-[var(--border-color)] max-w-[520px] w-[90vw] shadow-2xl';
        dlg.style.marginTop = '8vh';
        dlg.style.marginBottom = 'auto';

        dlg.innerHTML = `
            <div class="flex flex-col gap-[16px] p-[24px]">
                <h3 class="text-[24px] font-bold text-[var(--text-primary)]">${getTranslation('Save profile')}</h3>
                <p class="text-[20px] text-[var(--text-primary)]">${getTranslation('How would you like to save changes to')} <span class="font-semibold">"${currentTitle}"</span>?</p>
                <label class="text-[18px] text-[var(--text-primary)] flex flex-col gap-[6px]">
                    <span>${getTranslation('New profile name (for "Save As New")')}</span>
                    <input type="text" inputmode="text" autocomplete="off" class="w-full px-[12px] py-[10px] text-[20px] rounded-[8px] border border-[var(--border-color)] bg-[var(--box-color)] text-[var(--text-primary)] outline-none focus:border-[var(--mimoja-blue)]" />
                </label>
                <div class="flex justify-end gap-[10px] mt-[8px] flex-wrap">
                    <button type="button" data-act="cancel" class="px-[18px] py-[10px] rounded-[10px] bg-[var(--button-grey)] text-[var(--text-primary)] text-[20px] font-semibold cursor-pointer">${getTranslation('Cancel')}</button>
                    <button type="button" data-act="new" class="px-[18px] py-[10px] rounded-[10px] bg-[var(--button-grey)] text-[var(--text-primary)] text-[20px] font-semibold cursor-pointer">${getTranslation('Save As New')}</button>
                    <button type="button" data-act="overwrite" class="px-[18px] py-[10px] rounded-[10px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold cursor-pointer">${getTranslation('Overwrite')}</button>
                </div>
            </div>
        `;

        const input = dlg.querySelector('input');
        input.value = suggestedNewTitle;

        function done(result) {
            try { dlg.close(); } catch (_) {}
            dlg.remove();
            resolve(result);
        }

        dlg.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.act;
                if (act === 'cancel') return done({ action: 'cancel' });
                if (act === 'overwrite') return done({ action: 'overwrite' });
                const title = input.value.trim();
                if (!title) {
                    input.focus();
                    return;
                }
                done({ action: 'new', title });
            });
        });

        // ESC / backdrop cancel
        dlg.addEventListener('cancel', (e) => {
            e.preventDefault();
            done({ action: 'cancel' });
        });

        document.body.appendChild(dlg);
        dlg.showModal();
        // Don't autofocus — would pop the keyboard immediately. User taps the
        // input when they want to rename.
    });
}

// Presentation fields don't feed the execution hash — REA treats a change to
// only these as a metadata update (same id). Everything else is execution.
const PRESENTATION_FIELDS = ['title', 'author', 'notes'];
function executionChanged(orig, edited) {
    const strip = p => {
        const c = { ...p };
        PRESENTATION_FIELDS.forEach(k => delete c[k]);
        return JSON.stringify(c);
    };
    return strip(orig) !== strip(edited);
}

async function saveProfile() {
    if (!editorState.profile.title?.trim()) {
        showToast('Profile needs a name', 3000, 'error');
        return;
    }
    if (!editorState.profile.steps?.length) {
        showToast('Add at least one step', 3000, 'error');
        return;
    }

    try {
        const { updateProfile, uploadProfileWithParent } = await import('./api.js');
        const { availableProfiles, remapFavorite } = await import('./profileManager.js');

        // No-op save guard — if the profile is byte-identical to its source,
        // skip writing a new KV record. Prevents duplicating a default the user
        // opened but didn't actually modify.
        const sourceProfileJson = editorState.sourceProfileRecord?.profile
            ? JSON.stringify(editorState.sourceProfileRecord.profile)
            : null;
        if (sourceProfileJson && sourceProfileJson === JSON.stringify(editorState.profile)) {
            showToast('No changes to save', 2000, 'info');
            if (editorState.sourceProfileId) {
                sessionStorage.setItem('lastEditedProfileKey', editorState.sourceProfileId);
            }
            setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 500);
            return;
        }

        // Overwrite-or-save-as prompt: only when editing an existing non-default
        // profile with changes and the title hasn't been edited yet. Defaults
        // fork on execution change (separate path), and a renamed title already
        // signals "save as new".
        const src = editorState.sourceProfileRecord;
        const isExistingUserProfile = !!src && !src.isDefault;
        const sourceTitleOrig = (src?.profile?.title || '').trim();
        const currentTitleNow = editorState.profile.title.trim();
        if (isExistingUserProfile && sourceTitleOrig && currentTitleNow === sourceTitleOrig) {
            const existingTitlesForSuggest = new Set(
                Object.values(availableProfiles).map(r => r.profile?.title).filter(Boolean)
            );
            let n = 2;
            let suggested = `${sourceTitleOrig} (${n})`;
            while (existingTitlesForSuggest.has(suggested)) {
                n++;
                suggested = `${sourceTitleOrig} (${n})`;
            }
            const choice = await promptOverwriteOrSaveAs(sourceTitleOrig, suggested);
            if (choice.action === 'cancel') return;
            if (choice.action === 'new') {
                editorState.profile.title = choice.title;
                const titleDisplay = document.getElementById('editor-title-display');
                if (titleDisplay) titleDisplay.textContent = choice.title;
                // titleChanged below will now be true → forces new KV entry.
            }
            // 'overwrite' → fall through unchanged → updates in place.
        }

        // Title change at save = user intent to save as a brand-new profile.
        const sourceTitle = (src?.profile?.title || '').trim();
        const currentTitle = editorState.profile.title.trim();
        const titleChanged = sourceTitle && currentTitle !== sourceTitle;

        // Decide before stripping legacy fields (source still carries them too,
        // so the comparison is apples-to-apples).
        const execChanged = !src || executionChanged(src.profile, editorState.profile);

        // Auto-suffix title only when minting a NEW record (a save-as, a fresh
        // profile, or a default forked on execution change). An in-place PUT can
        // keep its own title, so exclude self from the collision set.
        const willCreateNew = !src || titleChanged || (src.isDefault && execChanged);
        const existingTitles = new Set(
            Object.values(availableProfiles)
                .filter(r => r.id !== src?.id)
                .map(r => r.profile?.title)
                .filter(Boolean)
        );
        let finalTitle = editorState.profile.title.trim();
        if (willCreateNew && existingTitles.has(finalTitle)) {
            let n = 2;
            while (existingTitles.has(`${finalTitle} (${n})`)) n++;
            finalTitle = `${finalTitle} (${n})`;
            editorState.profile.title = finalTitle;
            const titleDisplay = document.getElementById('editor-title-display');
            if (titleDisplay) titleDisplay.textContent = finalTitle;
        }

        // Legacy-field stripping + REA Profile-model adaptation happens at the
        // api.js write boundary (sanitizeProfileForRea), covering every path.

        // Save routing (REA versioning model):
        //  - default + execution change → POST fork (PUT would be rejected); the
        //    default stays as the parent/reset point.
        //  - new profile or explicit save-as → POST (parentId links the source).
        //  - otherwise → PUT in place; the server keeps the id on a
        //    presentation-only change or rehashes it (deleting the old) on a
        //    user execution change.
        let saved;
        if (src?.isDefault && execChanged) {
            saved = await uploadProfileWithParent(editorState.profile, src.id);
        } else if (!src || titleChanged) {
            saved = await uploadProfileWithParent(editorState.profile, src?.id ?? null);
        } else {
            saved = await updateProfile(src.id, editorState.profile);
        }

        const oldId = editorState.sourceProfileId;
        availableProfiles[saved.id] = saved;

        // Only an in-place user PUT replaces the old hash — follow the favorite then.
        if (oldId && oldId !== saved.id && !src?.isDefault && !titleChanged) {
            delete availableProfiles[oldId];
            await remapFavorite(oldId, saved.id);
        }

        // Rebind editor to the saved record so repeat saves update in place.
        editorState.sourceProfileRecord = saved;
        editorState.sourceProfileId = saved.id;

        // Hint to selector so it pre-selects the profile we just edited.
        sessionStorage.setItem('lastEditedProfileKey', saved.id);

        showToast('Profile saved!', 2000, 'success');
        setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 1000);
    } catch (err) {
        console.error('Profile save failed:', err);
        showToast(`Save failed: ${err.message}`, 4000, 'error');
    }
}

async function cancelEditor() {
    if (_isNewProfileSession && _hasImportedInSession) {
        const msg = getTranslation('Discard the imported profile? This cannot be undone.');
        if (!confirm(msg)) return;
    }
    if (_isNewProfileSession && _sessionImportedIds.length > 0) {
        try {
            const { deleteProfile } = await import('./api.js');
            const { availableProfiles } = await import('./profileManager.js');
            for (const id of _sessionImportedIds) {
                try { await deleteProfile(id); } catch (_) {}
                delete availableProfiles[id];
            }
        } catch (_) {}
    }
    loadPage('index.html');
}


// ─── Init ───────────────────────────────────────────────────────────────────

export async function initializeProfileEditor() {
    console.log('[ProfileEditor] initializeProfileEditor called');
    console.log('[ProfileEditor] window.__pendingEditProfile=', window.__pendingEditProfile);
    console.log('[ProfileEditor] typeof window.__pendingEditProfile=', typeof window.__pendingEditProfile);

    // 1. Read pending profile from window global (set by profile_selector.js)
    const profileRecord = window.__pendingEditProfile;
    if (!profileRecord) {
        console.warn('[ProfileEditor] No profile data on window.__pendingEditProfile — aborting.');
        showToast('No profile data found. Returning to selector.', 3000, 'error');
        setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 1000);
        return;
    }
    console.log('[ProfileEditor] Got profile:', profileRecord?.profile?.title);
    window.__pendingEditProfile = null;

    // 2. Deep copy
    editorState.sourceProfileRecord = profileRecord;
    editorState.sourceProfileId = profileRecord.id;
    editorState.profile = deepCopy(profileRecord.profile);
    // Normalize legacy step shape: prior versions persisted exit.type of
    // 'weight' / 'time' / 'off' (not in Rea spec) and stored both flow and
    // pressure on every step. Coerce on load so the UI never reads undefined
    // EXIT_UNIT_MAP entries and the saved record converges on the spec shape.
    if (Array.isArray(editorState.profile.steps)) {
        for (const step of editorState.profile.steps) {
            if (step.pump === 'flow') delete step.pressure;
            else if (step.pump === 'pressure') delete step.flow;
            if (step.limiter && step.limiter.value === 0) step.limiter = null;
            if (step.exit && step.exit.type !== 'pressure' && step.exit.type !== 'flow') {
                step.exit = null;
            }
        }
    }
    editorState.activeTab = 0;
    _isNewProfileSession = !profileRecord.id;
    _sessionImportedIds = [];
    _hasImportedInSession = false;
    expandedTempSteps.clear();
    expandedPumpSteps.clear();
    expandedLimSteps.clear();
    expandedMaxSteps.clear();
    expandedExitSteps.clear();
    expandedReviewField = null;

    // 3. Populate title
    const titleDisplay = document.getElementById('editor-title-display');
    if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';

    // 4. Render tabs
    setActiveTab(0);
    renderStepCards();
    renderSettingsTab();

    // 5. Wire event listeners
    initTitleEditing();

    // Tab buttons
    document.querySelectorAll('.editor-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            setActiveTab(parseInt(btn.dataset.tab, 10));
        });
    });

    // Save / Cancel
    const saveBtn = document.getElementById('editor-save-btn');
    const cancelBtn = document.getElementById('editor-cancel-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveProfile);
    if (cancelBtn) cancelBtn.addEventListener('click', cancelEditor);

    console.log('Profile Editor: Initialization complete.');
}
