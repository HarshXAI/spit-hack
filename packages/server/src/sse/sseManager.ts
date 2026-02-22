/**
 * SSE (Server-Sent Events) manager for real-time job progress.
 * Maintains a registry of active SSE response streams keyed by jobId.
 * Workers call emit() to push events; routes call subscribe() to register clients.
 */

import { Response } from 'express';

/** All SSE event types the ingest pipeline emits. */
export type SseEventType = 'progress' | 'node-discovered' | 'complete' | 'error' | 'heartbeat';

export interface SseProgressEvent {
    type: 'progress';
    phase: string;
    percent: number;
    current: string;
}

export interface SseNodeEvent {
    type: 'node-discovered';
    node: {
        id: string;
        name: string;
        language: string | null;
        team: string | null;
    };
}

export interface SseCompleteEvent {
    type: 'complete';
    summary: { services: number; edges: number; issues: number };
}

export interface SseErrorEvent {
    type: 'error';
    message: string;
}

export interface SseHeartbeatEvent {
    type: 'heartbeat';
}

export type SseEvent =
    | SseProgressEvent
    | SseNodeEvent
    | SseCompleteEvent
    | SseErrorEvent
    | SseHeartbeatEvent;

// ── Registry ──────────────────────────────────────────────────────────────────

/** Map from jobId → array of connected SSE response streams. */
const clients = new Map<string, Response[]>();

/**
 * Registers an Express Response as an SSE stream for the given jobId.
 * Sets appropriate headers and schedules a heartbeat ping every 15s.
 * Cleans up when the client disconnects.
 *
 * @param jobId - The ingestion job UUID
 * @param res - Express Response to use as SSE stream
 */
export function subscribe(jobId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Initial comment to establish connection
    res.write(': connected\n\n');

    const existing = clients.get(jobId) ?? [];
    clients.set(jobId, [...existing, res]);

    // Heartbeat every 15s (per brief)
    const heartbeat = setInterval(() => {
        emit(jobId, { type: 'heartbeat' });
    }, 15_000);

    res.on('close', () => {
        clearInterval(heartbeat);
        const list = clients.get(jobId) ?? [];
        const filtered = list.filter((r) => r !== res);
        if (filtered.length === 0) {
            clients.delete(jobId);
        } else {
            clients.set(jobId, filtered);
        }
    });
}

/**
 * Emits a typed SSE event to all clients subscribed to the given jobId.
 * If no clients are connected (e.g., worker runs before client connects),
 * the event is silently dropped — clients get the final state on reconnect.
 *
 * @param jobId - Target job UUID
 * @param event - Typed SSE event to emit
 */
export function emit(jobId: string, event: SseEvent): void {
    const list = clients.get(jobId);
    if (!list || list.length === 0) return;

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of list) {
        try {
            res.write(payload);
        } catch {
            // Client disconnected mid-write — ignore, cleanup handled by close event
        }
    }
}

/**
 * Returns the number of active SSE clients for a given job.
 * Used by tests to assert connections.
 *
 * @param jobId - Target job UUID
 * @returns Number of connected clients
 */
export function clientCount(jobId: string): number {
    return clients.get(jobId)?.length ?? 0;
}

/**
 * Closes all SSE connections for a job and removes from registry.
 * Called after a job reaches terminal state (complete or error).
 *
 * @param jobId - Target job UUID
 */
export function closeJob(jobId: string): void {
    const list = clients.get(jobId);
    if (!list) return;
    for (const res of list) {
        try {
            res.end();
        } catch {
            // Already closed
        }
    }
    clients.delete(jobId);
}
