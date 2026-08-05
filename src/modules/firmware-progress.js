// Firmware upload progress — NDJSON framing + event normalisation.
//
// POST /api/v1/machine/firmware answers with a newline-delimited JSON stream:
// one `erasing` event when the operation starts, zero or more `uploading` events
// in ~1% increments, then `done` (CRC verification passed) or `error` with
// progress -1.0. Erase and CRC verification emit no intermediate percentages, so
// the stream goes quiet for a stretch at both ends of the upload — a bar that
// only moves on `uploading` looks hung there. Hence the phase, not just the
// percentage, drives the UI.
//
// A final `uploading` may report 1.0 (or near it) BEFORE verification: 100% is
// not success. Only `done` is.
//
// Chunk boundaries are not line boundaries, so the caller keeps a buffer across
// reads — that framing is what splitNdjson does.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

/** Recognised stream phases, in the order they occur. */
export const FIRMWARE_PHASES = ['erasing', 'uploading', 'done', 'error'];

/**
 * Frame one decoded chunk into whole JSON lines.
 * @param {string} buffer leftover from the previous call ('' to start)
 * @param {string} chunk newly decoded text ('' on the final flush)
 * @param {boolean} atEnd true on the last read — flushes any unterminated line
 * @returns {{events: object[], rest: string}} parsed objects and the new buffer
 */
export function splitNdjson(buffer, chunk, atEnd = false) {
    const lines = (buffer + chunk).split('\n');
    const rest = atEnd ? '' : lines.pop();
    const events = [];
    for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        try {
            events.push(JSON.parse(text));
        } catch {
            // A malformed line is not worth aborting a firmware upload over.
            // ponytail: dropped silently; the phase machine just sees one fewer tick.
        }
    }
    return { events, rest };
}

/**
 * Normalise one stream event to { phase, progress }.
 *
 * The phase key is read defensively: this endpoint's payload shape is documented
 * by its event NAMES rather than by a schema, so accept the usual spellings
 * instead of betting the update UI on one of them.
 *
 * @param {object} event
 * @returns {{phase: string|null, progress: number|null}} phase null = unrecognised
 */
export function normalizeFirmwareEvent(event) {
    if (!event || typeof event !== 'object') return { phase: null, progress: null };

    const named = [event.event, event.phase, event.status, event.state]
        .find(v => typeof v === 'string' && FIRMWARE_PHASES.includes(v.toLowerCase()));
    const phase = named ? named.toLowerCase() : null;

    const raw = typeof event.progress === 'number' ? event.progress : null;
    // -1.0 is the error sentinel, not a percentage.
    const progress = raw === null || raw < 0 ? null : Math.min(raw, 1);

    return { phase, progress };
}

/**
 * Fold an event into the running UI state. Percent is monotonic: the erase and
 * verification phases carry no percentage, so they hold the last known one
 * rather than snapping the bar back to 0.
 *
 * @param {{phase: string|null, percent: number, error: string|null}} state
 * @param {object} event raw stream event
 */
export function advanceFirmwareState(state, event) {
    const { phase, progress } = normalizeFirmwareEvent(event);
    if (!phase) return state;
    return {
        phase,
        percent: progress !== null ? Math.round(progress * 100)
            : phase === 'done' ? 100
            : state.percent,
        error: phase === 'error' ? (event.message || event.error || 'Firmware update failed') : null,
    };
}

/** Starting state for advanceFirmwareState. */
export const initialFirmwareState = { phase: null, percent: 0, error: null };
