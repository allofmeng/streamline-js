import { getValueFromStore, setValueInStore, getShots } from './api.js';

let numpadModalInitialized = false;
let currentInputElement = null;
let currentValue = '0';
let originalValue = '0';
let previousValues = [];
let onConfirmCallback = null;

async function getPreviousValues(fieldType) {
    try {
        const values = await getValueFromStore('numpad', `previous-values-${fieldType}`);
        return values || [];
    } catch (error) {
        console.log('[Numpad] Error getting previous values:', error);
        return [];
    }
}

async function savePreviousValue(fieldType, value) {
    try {
        const existing = await getPreviousValues(fieldType);
        const newList = [value, ...existing.filter(v => v !== value)].slice(0, 8);
        await setValueInStore('numpad', `previous-values-${fieldType}`, newList);
    } catch (error) {
        console.log('[Numpad] Error saving previous value:', error);
    }
}

async function getValuesFromShotHistory(fieldType, limit = 8) {
    try {
        const response = await getShots({ limit: 20 });
        
        // Handle paginated response: { shots: [...], total: X }
        // or direct array response
        let shots = [];
        if (Array.isArray(response)) {
            shots = response;
        } else if (response && Array.isArray(response.shots)) {
            shots = response.shots;
        } else {
            console.log('[Numpad] Unexpected shots response format:', response);
            return [];
        }
        
        const values = [];
        shots.forEach(shot => {
            const workflow = shot.workflow || {};
            if (fieldType === 'dose-in' && workflow.doseData?.doseIn) {
                values.push(workflow.doseData.doseIn.toString());
            } else if (fieldType === 'drink-out' && workflow.doseData?.drinkOut) {
                values.push(workflow.doseData.drinkOut.toString());
            } else if (fieldType === 'grind' && workflow.grinderData?.setting) {
                values.push(workflow.grinderData.setting.toString());
            }
        });
        return [...new Set(values)].slice(0, limit);
    } catch (error) {
        console.log('[Numpad] Error getting shot history:', error);
        return [];
    }
}

// Mobile/tablet detection - can be overridden for testing
function shouldUseNumpad() {
    // Check for explicit override (useful for testing)
    if (window._forceNumpadMobile !== undefined) {
        return window._forceNumpadMobile;
    }
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Check if it's a touch device
    const isTouchDevice = 'ontouchstart' in window || 
                          navigator.maxTouchPoints > 0 ||
                          window.matchMedia('(pointer: coarse)').matches;
    
    // Check for Firefox responsive design mode (width < 1024 or narrow height)
    const isNarrowViewport = width < 1024 || height < 900;
    
    // Desktop: large screen (≥1200px × ≥900px) AND no touch AND normal viewport
    const isDesktop = width >= 1200 && height >= 900 && !isTouchDevice && !isNarrowViewport;
    
    // Return true unless it's definitely a desktop
    return !isDesktop;
}

// Debug function to test the modal - call this in browser console
window.testNumpadModal = function(force = true) {
    window._forceNumpadMobile = force;
    if (force) {
        initializeNumpadModal();
        
        const valueElements = [
            { id: 'dose-in-value', type: 'dose-in' },
            { id: 'drink-out-value', type: 'drink-out' },
            { id: 'temp-value', type: 'temperature' },
            { id: 'grind-value', type: 'grind' },
            { id: 'steam-duration-value', type: 'steam-duration' },
            { id: 'steam-flow-value', type: 'steam-flow' },
            { id: 'flush-value', type: 'flush' },
            { id: 'hot-water-vol-value', type: 'hot-water-vol' },
            { id: 'hot-water-temp-value', type: 'hot-water-temp' }
        ];
        
        valueElements.forEach(({ id, type }) => {
            const el = document.getElementById(id);
            if (!el) return;
            
            el.style.cursor = 'pointer';
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentValue = el.textContent.replace(/[^0-9.]/g, '') || '0';
                
                const mockInput = {
                    value: currentValue,
                    dispatchEvent: (event) => {
                        if (event.type === 'change' || event.type === 'input') {
                            const newVal = mockInput.value;
                            el.textContent = type === 'temperature' ? `${newVal}°c` : 
                                            type === 'grind' ? newVal : 
                                            type === 'steam-duration' ? `${newVal}s` :
                                            type === 'steam-flow' ? newVal :
                                            type === 'flush' ? `${newVal}s` :
                                            type === 'hot-water-vol' ? `${newVal}ml` :
                                            type === 'hot-water-temp' ? `${newVal}°c` :
                                            `${newVal}g`;
                        }
                    }
                };
                
                openModal(mockInput, { previousValues: [], fieldType: type });
            });
        });
    }
};

function createModalHTML() {
    const overlay = document.createElement('div');
    overlay.id = 'numpad-modal-overlay';
    overlay.className = 'numpad-modal-overlay';
    
    overlay.innerHTML = `
        <div class="numpad-modal-container">
            <div class="numpad-modal-scaled-inner">
                <div class="numpad-modal-header">
                    <span class="numpad-modal-title">DOSE</span>
                    <div class="numpad-modal-actions ml-auto">
                        <button class="numpad-modal-cancel w-60 py-10 rounded-[90px] inline-flex justify-center items-center gap-2.5" id="numpad-cancel">CANCEL</button>
                        <button class="numpad-modal-confirm w-[369px] py-10 bg-[#385a92] rounded-[90px] inline-flex justify-center items-center gap-2.5" id="numpad-confirm">CONFIRM</button>
                    </div>
                </div>
                
                <div class="numpad-modal-header-divider"></div>
                
                <div class="numpad-modal-content">
                    <div class="numpad-modal-left">
                        <div class="numpad-modal-input-section">
                            <span class="numpad-modal-input-label">Input value between 1–120</span>
                            <div class="numpad-modal-input-box">
                                <div class="numpad-modal-input-border"></div>
                                <div class="numpad-modal-input-cursor"></div>
                                <span class="numpad-modal-input-value" id="numpad-display-value">0g</span>
                            </div>
                        </div>
                        
                        <div class="numpad-previous-divider"></div>
                        
                        <div class="numpad-modal-previous-values" id="numpad-previous-values-container" style="display: none;">
                            <div class="numpad-modal-previous-container" style="width: 750px; height: 370px;">
                                <div class="numpad-modal-previous-title">Previous Values</div>
                                <div class="numpad-modal-previous-grid" id="numpad-previous-grid"></div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="numpad-modal-divider"></div>
                    
                    <div class="numpad-modal-right">
                        <div class="numpad-modal-numpad">
                            <button class="numpad-modal-numpad-btn" data-number="1">1</button>
                            <button class="numpad-modal-numpad-btn" data-number="2">2</button>
                            <button class="numpad-modal-numpad-btn" data-number="3">3</button>
                            <button class="numpad-modal-numpad-btn" data-number="4">4</button>
                            <button class="numpad-modal-numpad-btn" data-number="5">5</button>
                            <button class="numpad-modal-numpad-btn" data-number="6">6</button>
                            <button class="numpad-modal-numpad-btn" data-number="7">7</button>
                            <button class="numpad-modal-numpad-btn" data-number="8">8</button>
                            <button class="numpad-modal-numpad-btn" data-number="9">9</button>
                            <button class="numpad-modal-numpad-btn numpad-decimal" data-action="decimal">.</button>
                            <button class="numpad-modal-numpad-btn" data-number="0">0</button>
                            <button class="numpad-modal-numpad-btn numpad-delete" data-action="delete">
                                <svg viewBox="0 0 54.8076 43.5" class="delete-icon-small">
                                    <path d="M49.9746 0C52.644 0 54.8076 2.16461 54.8076 4.83398V38.667C54.8074 41.3362 52.6439 43.5 49.9746 43.5H15.6025C14.3529 43.4999 13.1907 42.8565 12.5283 41.7969L0.799805 23.0312L0 21.75L0.799805 20.4697L12.5283 1.7041C13.1907 0.644322 14.3528 0.000123843 15.6025 0H49.9746ZM5.69922 21.75L16.2715 38.667H49.9746V4.83398H16.2715L5.69922 21.75ZM37.3906 12.791C38.3343 11.8474 39.8648 11.8475 40.8086 12.791C41.752 13.7348 41.7522 15.2653 40.8086 16.209L34.6631 22.3535L40.8086 28.499C41.752 29.4428 41.7522 30.9733 40.8086 31.917C39.8649 32.8607 38.3344 32.8604 37.3906 31.917L31.2451 25.7715L25.1006 31.917C24.1569 32.8607 22.6264 32.8604 21.6826 31.917C20.7391 30.9732 20.7389 29.4427 21.6826 28.499L27.8271 22.3535L21.6826 16.209C20.739 15.2652 20.7389 13.7347 21.6826 12.791C22.6264 11.8473 24.1568 11.8474 25.1006 12.791L31.2451 18.9355L37.3906 12.791Z" fill="#121212" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    // Attempt to move modal inside scaled-content for proper scaling
    const scaledContent = document.getElementById('scaled-content');
    if (scaledContent && overlay.parentElement === document.body) {
        scaledContent.appendChild(overlay);
    }
    
    return overlay;
}

function updateDisplay() {
    console.log('[Numpad] updateDisplay called, currentValue:', currentValue, 'currentFieldType:', currentFieldType);
    const displayElement = document.getElementById('numpad-display-value');
    const cursorElement = document.querySelector('.numpad-modal-input-cursor');
    if (displayElement) {
        const config = fieldConfig[currentFieldType] || fieldConfig['dose-in'];
        displayElement.textContent = currentValue + config.unit;
        
        // Position cursor after the text
        if (cursorElement && displayElement) {
            requestAnimationFrame(() => {
                const textWidth = displayElement.getBoundingClientRect().width;
                const containerWidth = displayElement.parentElement.getBoundingClientRect().width;
                const containerCenter = containerWidth / 2;
                const cursorLeft = containerCenter + textWidth / 2 + 4;
                cursorElement.style.left = cursorLeft + 'px';
                cursorElement.style.right = 'auto';
            });
        }
    } else {
        console.log('[Numpad] ERROR: displayElement not found!');
    }
}

function handleNumberClick(num) {
    console.log('[Numpad] handleNumberClick called with:', num, 'currentValue before:', currentValue);
    if (currentValue === '0' || currentValue === '') {
        currentValue = num;
    } else if (currentValue.length < 5) {
        currentValue = currentValue + num;
    }
    console.log('[Numpad] handleNumberClick currentValue after:', currentValue);
    updateDisplay();
}

function handleDecimalClick() {
    if (!currentValue.includes('.') && currentValue.length < 5) {
        currentValue = currentValue + '.';
        updateDisplay();
    }
}

function handleBackspace() {
    if (currentValue.length > 0) {
        currentValue = currentValue.slice(0, -1);
        if (currentValue === '' || currentValue === '-') {
            currentValue = '0';
        }
        updateDisplay();
    }
}

function handlePreviousValue(value) {
    currentValue = value;
    updateDisplay();
}

function renderPreviousValues() {
    const container = document.getElementById('numpad-previous-values-container');
    const grid = document.getElementById('numpad-previous-grid');
    
    if (!previousValues || previousValues.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    grid.innerHTML = '';
    
    previousValues.forEach(value => {
        const btn = document.createElement('button');
        btn.className = 'numpad-modal-previous-btn';
        btn.textContent = value;
        btn.addEventListener('click', () => handlePreviousValue(value));
        grid.appendChild(btn);
    });
}

function getDesignScale() {
    const scaledContent = document.getElementById('scaled-content');
    if (!scaledContent) return 1;
    
    const style = window.getComputedStyle(scaledContent);
    const transform = style.transform;
    
    if (transform && transform !== 'none') {
        const match = transform.match(/matrix\(([^)]+)\)/);
        if (match) {
            return parseFloat(match[1].split(',')[0]) || 1;
        }
    }
    return 1;
}

let currentFieldType = 'dose-in';

const fieldConfig = {
    'dose-in': { title: 'DOSE', unit: 'g', defaultValue: '20', label: 'Input value between 1–120' },
    'drink-out': { title: 'DRINK OUT', unit: 'g', defaultValue: '40', label: 'Input value between 1–200' },
    'temperature': { title: 'TEMPERATURE', unit: '°c', defaultValue: '93', label: 'Input value between 70–110' },
    'grind': { title: 'GRIND', unit: '', defaultValue: '1.0', label: 'Input value between 0.1–10.0' },
    'steam-duration': { title: 'STEAM DURATION', unit: 's', defaultValue: '30', label: 'Input value between 1–120' },
    'steam-flow': { title: 'STEAM FLOW', unit: 'ml/s', defaultValue: '1.0', label: 'Input value between 0.1–10.0' },
    'flush': { title: 'FLUSH', unit: 's', defaultValue: '5', label: 'Input value between 1–60' },
    'hot-water-vol': { title: 'HOT WATER VOL', unit: 'ml', defaultValue: '50', label: 'Input value between 1–500' },
    'hot-water-temp': { title: 'HOT WATER TEMP', unit: '°c', defaultValue: '85', label: 'Input value between 70–110' }
};

function getFieldDisplayValue(value, fieldType) {
    const config = fieldConfig[fieldType] || fieldConfig['dose-in'];
    return value + config.unit;
}

async function openModal(inputElement, options = {}) {
    console.log('[Numpad] openModal called', { fieldType: options.fieldType, inputElement });
    if (!numpadModalInitialized) {
        console.log('[Numpad] Initializing numpad modal...');
        initializeNumpadModal();
    }
    
    currentInputElement = inputElement;
    currentFieldType = options.fieldType || 'dose-in';
    
    const config = fieldConfig[currentFieldType] || fieldConfig['dose-in'];
    const inputValue = inputElement.value || inputElement.getAttribute('data-default') || config.defaultValue;
    // Remove any existing units for editing
    currentValue = inputValue.replace(/[g°c]/g, '').trim() || config.defaultValue;
    originalValue = currentValue;
    
    console.log('[Numpad] currentValue set to:', currentValue);
    
    // Update modal title and label
    const titleEl = document.querySelector('.numpad-modal-title');
    if (titleEl) {
        titleEl.textContent = config.title;
    }
    
    const labelEl = document.querySelector('.numpad-modal-input-label');
    if (labelEl) {
        labelEl.textContent = config.label;
    }
    
    // Load previous values
    let storedValues = await getPreviousValues(currentFieldType);
    
    // If no stored values and field supports shot history, get from shots
    if (storedValues.length === 0 && ['dose-in', 'drink-out', 'grind'].includes(currentFieldType)) {
        storedValues = await getValuesFromShotHistory(currentFieldType);
    }
    
    previousValues = storedValues.length > 0 ? storedValues : (options.previousValues || []);
    onConfirmCallback = options.onConfirm || null;
    
    const overlay = document.getElementById('numpad-modal-overlay');
    overlay.classList.add('active');
    
    // Apply the same scaling logic as the main content to the modal
    // Calculate scale specifically for modal to fill viewport
    const designWidth = 1920;
    const designHeight = 1200;
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    // Calculate scale to fit viewport while maintaining aspect ratio (same logic as scaling.js)
    const screenAspectRatio = screenWidth / screenHeight;
    const designAspectRatio = designWidth / designHeight;

    let modalScale;
    if (screenAspectRatio > designAspectRatio) {
        // Screen is wider - scale based on height
        modalScale = screenHeight / designHeight;
    } else {
        // Screen is taller - scale based on width
        modalScale = screenWidth / designWidth;
    }

    // The modal container uses CSS width: 100%, height: 100% to fill viewport
    // No scale transform needed - container already fills 1280x800
    // The scaling.js handles main content, modal fills viewport naturally
    
    console.log('[Numpad] Modal uses viewport size directly:', screenWidth, 'x', screenHeight);
    
    // Get the container for event listeners later
    const container = overlay.querySelector('.numpad-modal-container');
    
    // Apply scale to inner content wrapper only (not container - it inherits parent scale)
    const designScale = getDesignScale();
    const innerContent = container?.querySelector('.numpad-modal-scaled-inner');
    if (innerContent && designScale !== 1) {
        innerContent.style.transform = `scale(${designScale})`;
        innerContent.style.transformOrigin = 'top left';
        console.log('[DEBUG] Applied scale to inner wrapper:', designScale);
    }
    
    // DEBUG: Log viewport dimensions when modal opens
    console.log('[DEBUG] Numpad Modal Opened');
    console.log('[DEBUG] window.innerWidth:', window.innerWidth, 'window.innerHeight:', window.innerHeight);
    console.log('[DEBUG] screen.width:', screen.width, 'screen.height:', screen.height);
    console.log('[DEBUG] screen.availWidth:', screen.availWidth, 'screen.availHeight:', screen.availHeight);
    console.log('[DEBUG] window.devicePixelRatio:', window.devicePixelRatio);
    console.log('[DEBUG] Calculated physical pixels:', screen.width * window.devicePixelRatio, 'x', screen.height * window.devicePixelRatio);
    console.log('[DEBUG] document.documentElement.clientWidth:', document.documentElement.clientWidth, 'clientHeight:', document.documentElement.clientHeight);
    
    // Log modal container dimensions after it's rendered
    requestAnimationFrame(() => {
        const modalContainer = overlay.querySelector('.numpad-modal-container');
        if (modalContainer) {
            const rect = modalContainer.getBoundingClientRect();
            console.log('[DEBUG] Modal container rect - width:', rect.width, 'height:', rect.height);
            console.log('[DEBUG] Modal container offsetWidth:', modalContainer.offsetWidth, 'offsetHeight:', modalContainer.offsetHeight);
        }
        
        // Log inner wrapper dimensions
        if (innerContent) {
            const innerRect = innerContent.getBoundingClientRect();
            const innerComputed = window.getComputedStyle(innerContent);
            console.log('[DEBUG] Inner wrapper rect - width:', innerRect.width, 'height:', innerRect.height);
            console.log('[DEBUG] Inner wrapper transform:', innerComputed.transform);
            console.log('[DEBUG] getDesignScale() returned:', designScale);
        }
        
        // Log scaled-content transform
        const scaledContent = document.getElementById('scaled-content');
        if (scaledContent) {
            console.log('[DEBUG] scaled-content transform:', scaledContent.style.transform);
        }

        // Log viewport dimensions
        const viewport = document.getElementById('scaling-container');
        if (viewport) {
            console.log('[DEBUG] scaling-container style - width:', viewport.style.width, 'height:', viewport.style.height);
        }
    });
    
    // Prevent OS keyboard by preventing focus on any element
    // Keep focus prevention but make touchstart selective to not block button clicks
    // Reuse the container variable from earlier
    const preventFocus = (e) => {
        e.preventDefault();
        e.stopPropagation();
        return false;
    };
    container.addEventListener('focus', preventFocus, true);
    container.addEventListener('focusin', preventFocus, true);
    
    // Only prevent touchstart on input-like elements, not buttons
    const preventTouchKeyboard = (e) => {
        const tagName = e.target.tagName;
        // Only prevent default on input/textarea to block OS keyboard
        // Allow clicks on buttons (BUTTON tag or elements with onclick/role=button)
        if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    };
    container.addEventListener('touchstart', preventTouchKeyboard, { passive: false });
    // Note: mousedown is intentionally NOT prevented to allow button clicks
    
    // Store reference to remove listeners later
    container._numpadPreventFocus = preventFocus;
    container._numpadPreventTouch = preventTouchKeyboard;
    
    renderPreviousValues();
    updateDisplay();
    
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    const overlay = document.getElementById('numpad-modal-overlay');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    
    // Clean up keyboard prevention listeners
    const container = overlay.querySelector('.numpad-modal-container');
    if (container) {
        if (container._numpadPreventFocus) {
            const preventFocus = container._numpadPreventFocus;
            container.removeEventListener('focus', preventFocus, true);
            container.removeEventListener('focusin', preventFocus, true);
            delete container._numpadPreventFocus;
        }
        if (container._numpadPreventTouch) {
            const preventTouchKeyboard = container._numpadPreventTouch;
            container.removeEventListener('touchstart', preventTouchKeyboard, { passive: false });
            delete container._numpadPreventTouch;
        }
    }
}

function handleCancel() {
    currentValue = originalValue;
    closeModal();
}

function handleConfirm() {
    const finalValue = currentValue === '0' ? '' : currentValue;
    console.log('[Numpad] handleConfirm called, finalValue:', finalValue, 'currentInputElement:', currentInputElement);
    
    if (currentInputElement) {
        console.log('[Numpad] Setting input element value to:', finalValue);
        currentInputElement.value = finalValue;
        currentInputElement.dispatchEvent(new Event('change', { bubbles: true }));
        currentInputElement.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        console.log('[Numpad] ERROR: currentInputElement is null!');
    }
    
    // Save to previous values
    savePreviousValue(currentFieldType, finalValue);
    
    if (onConfirmCallback) {
        onConfirmCallback(finalValue);
    }
    
    closeModal();
}

function initializeNumpadModal() {
    if (numpadModalInitialized) return;
    
    console.log('[Numpad] initializeNumpadModal called - creating modal HTML');
    createModalHTML();
    
    console.log('[Numpad] Attaching event listeners...');
    const closeBtn = document.getElementById('numpad-modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', handleCancel);
    }
    document.getElementById('numpad-cancel').addEventListener('click', handleCancel);
    document.getElementById('numpad-confirm').addEventListener('click', handleConfirm);
    
    const numpadButtons = document.querySelectorAll('.numpad-modal-numpad-btn[data-number]');
    console.log('[Numpad] Found numpad buttons:', numpadButtons.length);
    
    numpadButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            console.log('[Numpad] Button clicked:', button.getAttribute('data-number'));
            const number = button.getAttribute('data-number');
            handleNumberClick(number);
        });
    });
    
    document.querySelector('.numpad-modal-numpad-btn[data-action="decimal"]').addEventListener('click', handleDecimalClick);
    document.querySelector('.numpad-modal-numpad-btn[data-action="delete"]').addEventListener('click', handleBackspace);
    
    const overlay = document.getElementById('numpad-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            handleCancel();
        }
    });
    
    numpadModalInitialized = true;
    console.log('[Numpad] Initialization complete');
}

function attachToNumericInputs(selector = 'input[type="number"]', options = {}) {
    if (!shouldUseNumpad()) return;
    
    const inputs = document.querySelectorAll(selector);
    
    inputs.forEach(input => {
        if (input.hasAttribute('data-numpad-attached')) return;
        
        input.setAttribute('data-numpad-attached', 'true');
        
        input.addEventListener('focus', (e) => {
            e.preventDefault();
            openModal(input, {
                previousValues: options.previousValues || [],
                onConfirm: options.onConfirm || null
            });
        });
        
        input.addEventListener('click', (e) => {
            openModal(input, {
                previousValues: options.previousValues || [],
                onConfirm: options.onConfirm || null
            });
        });
        
        input.readOnly = true;
        input.style.cursor = 'pointer';
    });
}

function initNumpadModal() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isNarrowViewport = width < 1024 || height < 900;
    const shouldUse = shouldUseNumpad();
    
    console.log('[NumpadModal] Debug - width:', width, 'height:', height, 'isTouch:', isTouchDevice, 'isNarrow:', isNarrowViewport, 'shouldUseNumpad:', shouldUse);
    
    if (shouldUse) {
        initializeNumpadModal();
    }
}

// Expose for manual testing in browser console
window.initNumpadModal = initNumpadModal;
window.openNumpadModal = openModal;

export { initNumpadModal, attachToNumericInputs, openModal, shouldUseNumpad, initializeNumpadModal };
