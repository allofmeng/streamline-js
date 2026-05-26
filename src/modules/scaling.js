let isInitialScaleDone = false; // module-level: only first initScaling call adds .scaled

export function initScaling() {
    const viewport = document.getElementById('scaling-container');
    const content = document.getElementById('scaled-content');
    const designWidth = 1920;
    const designHeight = 1200;

    // Detect if device is mobile
    function isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

    // Check if in portrait orientation
    function isPortrait() {
        return window.innerHeight > window.innerWidth;
    }

    // Show/hide rotation prompt for mobile portrait mode
    function updateRotationPrompt() {
        const isMobile = isMobileDevice();
        const portrait = isPortrait();
        const toastContainer = document.getElementById('fullscreen-toast-container');

        if (!toastContainer) return;

        // Show prompt only on mobile devices in portrait mode
        // Don't show if user has dismissed it in this session
        const shouldShow = isMobile && portrait && !sessionStorage.getItem('rotationPromptDismissed');

        if (shouldShow && toastContainer.style.display !== 'grid') {
            // Update the toast content for rotation prompt
            const alertBox = toastContainer.querySelector('.alert');
            const heading = alertBox?.querySelector('h3');
            // Use a more reliable selector for the message div
            const messageDiv = alertBox?.querySelector('div[class*="text-"][style*="font-size"]') ||
                              alertBox?.querySelectorAll('div')[1]?.querySelector('div') ||
                              alertBox?.querySelector('.text-\\[9px\\]');
            const buttonContainer = alertBox?.querySelector('.flex.gap-2');

            if (heading) heading.textContent = 'Rotate Your Device';
            if (messageDiv) messageDiv.textContent = 'For the best experience, please rotate to landscape mode.';

            // Update buttons - Rotate button + Remind Later button
            if (buttonContainer) {
                buttonContainer.innerHTML = `
                    <button id="toast-rotate-btn" class="btn btn-primary btn-sm text-white" data-i18n-key="Rotate">Rotate</button>
                    <button id="toast-rotate-remind-btn" class="btn btn-ghost btn-sm" data-i18n-key="Remind Later">Remind Later</button>
                `;

                // Add click handlers
                setTimeout(() => {
                    // Rotate button handler
                    const rotateBtn = document.getElementById('toast-rotate-btn');
                    if (rotateBtn) {
                        rotateBtn.onclick = async () => {
                            try {
                                // Try to use Screen Orientation API
                                if (screen.orientation && screen.orientation.lock) {
                                    await screen.orientation.lock('landscape');
                                    toastContainer.style.display = 'none';
                                } else {
                                    // Fallback: Show instructions if API not supported
                                    alert('Auto-rotation not supported on this device. Please physically rotate your device to landscape mode.');
                                }
                            } catch (error) {
                                // If rotation fails, show helpful message
                                console.warn('Screen rotation failed:', error);
                                alert('Please physically rotate your device to landscape mode.');
                            }
                        };
                    }

                    // Remind Later button handler
                    const remindBtn = document.getElementById('toast-rotate-remind-btn');
                    if (remindBtn) {
                        remindBtn.onclick = () => {
                            toastContainer.style.display = 'none';
                            sessionStorage.setItem('rotationPromptDismissed', 'true');
                        };
                    }
                }, 0);
            }

            toastContainer.style.display = 'grid';
        } else if (!shouldShow && toastContainer.style.display === 'grid') {
            // Hide if conditions no longer met (user rotated or dismissed)
            toastContainer.style.display = 'none';
        }
    }

    function updateScale() {
        if (!viewport || !content) return;

        // Get actual viewport dimensions
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;

        // DEBUG: Log scaling calculations
        // console.log('[DEBUG] updateScale called');
        // console.log('[DEBUG] screenWidth:', screenWidth, 'screenHeight:', screenHeight);
        // console.log('[DEBUG] designWidth:', designWidth, 'designHeight:', designHeight);

        // Calculate aspect ratios
        const screenAspectRatio = screenWidth / screenHeight;
        const designAspectRatio = designWidth / designHeight;

        let scale;
        if (screenAspectRatio > designAspectRatio) {
            // Screen is wider than design - scale based on height
            scale = screenHeight / designHeight;
        } else {
            // Screen is taller than design - scale based on width
            scale = screenWidth / designWidth;
        }

        // Explicitly set content dimensions to original design dimensions
        content.style.width = `${designWidth}px`;
        content.style.height = `${designHeight}px`;

        // Option A: only apply user zoom when the base scale < 1.0
        // (i.e. UI is already smaller than designed — small/tablet screens).
        // Large screens already have readable text; zooming them would clip with no benefit.
        const uiZoom = parseFloat(localStorage.getItem('uiZoom') || '1.0');
        scale = scale * uiZoom;

        // Cap at 2.0x to prevent excessive scale on very high-DPI displays
        const maxScale = 2.0;
        if (scale > maxScale) scale = maxScale;

        let offsetX, offsetY;
        if (uiZoom > 1.0) {
            // Option D: anchor top-left when zoomed — right/bottom overflow instead of all-sides clip.
            // The left sidebar (primary controls) always stays fully visible.
            offsetX = 0;
            offsetY = 0;
            // Option C: allow scroll so no content is permanently inaccessible when zoomed.
            // On tablets this enables touch-scroll/pan to reach the chart and data panels.
            viewport.style.overflow = 'auto';
        } else {
            // Default: center the content, clip overflow (no scrollbars)
            const scaledWidth = designWidth * scale;
            const scaledHeight = designHeight * scale;
            offsetX = (screenWidth - scaledWidth) / 2;
            offsetY = (screenHeight - scaledHeight) / 2;
            viewport.style.overflow = 'hidden';
        }

        content.style.transformOrigin = 'top left';
        content.style.transform = `scale(${scale}) translate(${offsetX / scale}px, ${offsetY / scale}px)`;

        viewport.style.width = `${screenWidth}px`;
        viewport.style.height = `${screenHeight}px`;
        viewport.style.margin = '0';

        document.dispatchEvent(new CustomEvent('streamline:scaleupdate', { detail: { scale } }));
    }

    // Initial scaling with a slight delay to ensure the browser has settled the viewport dimensions
    // This is especially important for web views that might adjust dimensions after initial load
    setTimeout(() => {
        updateScale();
        
        // Double-check scaling after a bit more time to handle edge cases where the viewport
        // dimensions might still be adjusting (especially in fullscreen web views)
        setTimeout(() => {
            updateScale();
            // Reveal content after initial scaling is complete
            if (content && !isInitialScaleDone) {
                isInitialScaleDone = true;
                requestAnimationFrame(() => {
                    content.classList.add('scaled');
                });
            }
        }, 300);
    }, 100);
    
    // Add resize listener with debounce to prevent excessive recalculations
    let resizeTimer;
    const onResize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            updateScale();
            updateRotationPrompt();
            setTimeout(updateScale, 200);
        }, 150);
    };
    window.addEventListener('resize', onResize);

    // visualViewport fires reliably on iOS/Android when the soft keyboard appears/hides,
    // which doesn't always trigger window.resize in tablet WebViews.
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
    }
    
    // Also listen for orientation changes which can affect viewport dimensions
    window.addEventListener('orientationchange', () => {
        console.log('Orientation change event detected');
        // Multiple updates with increasing delays to handle Firefox and other browsers
        // that may take time to report correct viewport dimensions
        setTimeout(() => {
            console.log('First scale update after orientation change');
            updateScale();
            updateRotationPrompt();
        }, 200);
        
        setTimeout(() => {
            console.log('Second scale update after orientation change');
            updateScale();
        }, 500);
        
        setTimeout(() => {
            console.log('Final scale update after orientation change');
            updateScale();
        }, 800);
    });
    
    // Listen for fullscreen change events which might affect scaling
    document.addEventListener('fullscreenchange', () => {
        setTimeout(() => {
            updateScale();
            updateRotationPrompt(); // Check if rotation prompt should be shown/hidden
        }, 100); // Allow time for fullscreen transition to complete
    });
    
    // Listen for webkit-specific fullscreen change events (Safari)
    document.addEventListener('webkitfullscreenchange', () => {
        setTimeout(() => {
            updateScale();
            updateRotationPrompt(); // Check if rotation prompt should be shown/hidden
        }, 100); // Allow time for fullscreen transition to complete
    });
    
    // Initial rotation prompt check (after a delay to ensure DOM is ready)
    setTimeout(updateRotationPrompt, 500);
}