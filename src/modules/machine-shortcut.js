const INTERACTIVE_SELECTOR = 'a[href], button, dialog, input, select, summary, textarea, [contenteditable], [role]';

export function shouldHandleMachineShortcut(event, onMainPage, dialogOpen) {
    return Boolean(
        onMainPage &&
        !dialogOpen &&
        !event.defaultPrevented &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.target?.closest?.(INTERACTIVE_SELECTOR)
    );
}
