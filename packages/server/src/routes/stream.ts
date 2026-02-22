/**
 * Real-time SSE stream routes — Phase 10.
 *
 * GET /api/stream/activity      — Live activity feed (left sidebar)
 * GET /api/stream/health        — Health score updates (every 30s)
 * GET /api/stream/notifications — PR opened, health drops, self-healing actions
 *
 * All streams use Server-Sent Events (SSE) — not WebSockets.
 * Each connection is kept alive with a heartbeat ping every 15s.
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { getSystemHealth } from '../services/graphService.js';

const router: ExpressRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sseHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();
}

function sseEvent(res: Response, data: unknown, eventName?: string): void {
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── GET /api/stream/activity ──────────────────────────────────────────────────

/**
 * Streams the live activity feed.
 * Sends current entries on connect, then polls for new ones every 30s.
 * Frontend: EventSource at this URL, updates left sidebar activity list.
 */
router.get('/activity', (req: Request, res: Response): void => {
    sseHeaders(res);

    const db = getDb();
    let lastRowId = 0;

    // Get the current max rowid
    const maxRow = db.prepare<[]>('SELECT MAX(rowid) AS maxid FROM activity_feed').get() as { maxid: number | null };
    lastRowId = maxRow?.maxid ?? 0;

    // Send current activity batch on connect (last 20)
    const initial = db.prepare<[]>(`
        SELECT af.rowid, af.id, af.type, af.service_id, af.title, af.detail,
               af.severity, af.created_at, s.name AS service_name
        FROM activity_feed af
        LEFT JOIN services s ON s.id = af.service_id
        ORDER BY af.created_at DESC LIMIT 20
    `).all() as Array<{
        rowid: number; id: string; type: string; service_id: string | null;
        title: string; detail: string | null; severity: string; created_at: string;
        service_name: string | null;
    }>;

    // Send in chronological order
    [...initial].reverse().forEach(row => {
        sseEvent(res, {
            id: row.id,
            type: row.type,
            serviceId: row.service_id,
            serviceName: row.service_name ?? 'System',
            title: row.title,
            detail: row.detail,
            severity: row.severity ?? 'info',
            createdAt: row.created_at,
        }, 'activity');
    });

    // Poll for new entries every 30s
    const poll = setInterval(() => {
        try {
            const newRows = db.prepare<[number]>(`
                SELECT af.rowid, af.id, af.type, af.service_id, af.title, af.detail,
                       af.severity, af.created_at, s.name AS service_name
                FROM activity_feed af
                LEFT JOIN services s ON s.id = af.service_id
                WHERE af.rowid > ?
                ORDER BY af.created_at ASC
            `).all(lastRowId) as typeof initial;

            for (const row of newRows) {
                sseEvent(res, {
                    id: row.id,
                    type: row.type,
                    serviceId: row.service_id,
                    serviceName: row.service_name ?? 'System',
                    title: row.title,
                    detail: row.detail,
                    severity: row.severity ?? 'info',
                    createdAt: row.created_at,
                }, 'activity');
                lastRowId = Math.max(lastRowId, row.rowid);
            }
        } catch { /* DB may be closed during shutdown */ }
    }, 30_000);

    // Heartbeat to keep connection alive through proxies
    const heartbeat = setInterval(() => {
        try { res.write(':ping\n\n'); } catch { /* client disconnected */ }
    }, 15_000);

    req.on('close', () => {
        clearInterval(poll);
        clearInterval(heartbeat);
    });
});

// ── GET /api/stream/health ────────────────────────────────────────────────────

/**
 * Streams health score updates every 30s.
 * Frontend: feeds the TopBar health ring.
 */
router.get('/health', (req: Request, res: Response): void => {
    sseHeaders(res);

    const sendHealth = () => {
        try {
            sseEvent(res, getSystemHealth(), 'health');
        } catch { /* DB closed */ }
    };

    // Send immediately on connect
    sendHealth();

    const interval = setInterval(sendHealth, 30_000);
    const heartbeat = setInterval(() => {
        try { res.write(':ping\n\n'); } catch { /* client disconnected */ }
    }, 15_000);

    req.on('close', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
    });
});

// ── GET /api/stream/notifications ────────────────────────────────────────────

/**
 * Streams notification events: PR opened, health drops, self-healing actions.
 * Frontend: notification bell dropdown in TopBar.
 */
router.get('/notifications', (req: Request, res: Response): void => {
    sseHeaders(res);

    const db = getDb();
    let lastRowId = 0;

    const maxRow = db.prepare<[]>('SELECT MAX(rowid) AS maxid FROM activity_feed').get() as { maxid: number | null };
    lastRowId = maxRow?.maxid ?? 0;

    const NOTIFY_TYPES = new Set(['HEALTH_DROP', 'PR_OPENED', 'HEALING_PR', 'P1_INCIDENT', 'INGESTION_COMPLETE']);

    const poll = setInterval(() => {
        try {
            const rows = db.prepare<[number]>(`
                SELECT af.rowid, af.id, af.type, af.service_id, af.title, af.detail, af.severity, af.created_at
                FROM activity_feed af WHERE af.rowid > ?
                ORDER BY af.created_at ASC
            `).all(lastRowId) as Array<{
                rowid: number; id: string; type: string; service_id: string | null;
                title: string; detail: string | null; severity: string; created_at: string;
            }>;

            for (const row of rows) {
                if (NOTIFY_TYPES.has(row.type)) {
                    sseEvent(res, {
                        id: row.id,
                        type: row.type,
                        serviceId: row.service_id,
                        title: row.title,
                        detail: row.detail,
                        severity: row.severity,
                        createdAt: row.created_at,
                    }, 'notification');
                }
                lastRowId = Math.max(lastRowId, row.rowid);
            }
        } catch { /* DB closed */ }
    }, 15_000);

    const heartbeat = setInterval(() => {
        try { res.write(':ping\n\n'); } catch { /* client disconnected */ }
    }, 15_000);

    req.on('close', () => {
        clearInterval(poll);
        clearInterval(heartbeat);
    });
});

export { router as streamRouter };
