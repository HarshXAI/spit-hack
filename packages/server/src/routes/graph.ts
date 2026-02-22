/**
 * Graph router — Phase 2 read-only endpoints.
 *
 *   GET /api/graph/nodes               → all service nodes with layout coords
 *   GET /api/graph/edges               → all dependency edges
 *   GET /api/graph/node/:id            → full node detail for sidebar panel
 *   GET /api/graph/health              → system-wide health aggregate (30-s poll)
 *   GET /api/graph/snapshot/:version   → snapshot at a specific version/tag
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import {
    getNodes,
    getEdges,
    getNodeDetail,
    getSystemHealth,
    getSnapshot,
    getCriticalIssues,
} from '../services/graphService.js';

export const graphRouter: ExpressRouter = Router();

// ── GET /nodes ────────────────────────────────────────────────────────────────
graphRouter.get('/nodes', (req: Request, res: Response) => {
    try {
        const team = typeof req.query.team === 'string' && req.query.team ? req.query.team : undefined;
        const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
        const nodes = getNodes(team, teamId);
        res.json({ success: true, data: nodes, meta: { count: nodes.length } });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ success: false, error: message });
    }
});

// ── GET /edges ────────────────────────────────────────────────────────────────
graphRouter.get('/edges', (req: Request, res: Response) => {
    try {
        const team = typeof req.query.team === 'string' && req.query.team ? req.query.team : undefined;
        const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
        const edges = getEdges(team, teamId);
        res.json({ success: true, data: edges, meta: { count: edges.length } });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ success: false, error: message });
    }
});

// ── GET /health ───────────────────────────────────────────────────────────────
graphRouter.get('/health', (req: Request, res: Response) => {
    try {
        const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
        const health = getSystemHealth(teamId);
        res.json({ success: true, data: health });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ success: false, error: message });
    }
});

// ── GET /snapshot/:version ────────────────────────────────────────────────────
graphRouter.get('/snapshot/:version', (req: Request, res: Response) => {
    const { version } = req.params;

    if (!version || version.trim().length === 0) {
        res.status(400).json({ success: false, error: 'version is required' });
        return;
    }

    try {
        const snapshot = getSnapshot(version);
        if (!snapshot) {
            res.status(404).json({
                success: false,
                error: `Snapshot '${version}' not found`,
            });
            return;
        }
        res.json({ success: true, data: snapshot });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ success: false, error: message });
    }
});

// ── GET /critical-issues ──────────────────────────────────────────────────────
graphRouter.get('/critical-issues', (req: Request, res: Response) => {
    try {
        const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
        const issues = getCriticalIssues(teamId);
        res.json({ success: true, data: issues, meta: { count: issues.length } });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ success: false, error: message });
    }
});

// ── GET /node/:id  (most specific last) ──────────────────────────────────────
graphRouter.get('/node/:id', (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id || id.trim().length === 0) {
        res.status(400).json({ success: false, error: 'id is required' });
        return;
    }

    try {
        const detail = getNodeDetail(id);
        if (!detail) {
            res.status(404).json({
                success: false,
                error: `Service node '${id}' not found`,
            });
            return;
        }
        res.json({ success: true, data: detail });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ success: false, error: message });
    }
});
