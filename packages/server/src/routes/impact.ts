/**
 * Impact analysis routes — Phase 4.
 *
 *   POST /api/impact/analyze    — run blast-radius BFS for a proposed change
 *   POST /api/impact/adr        — generate ADR from a prior analysis
 *   GET  /api/impact/history    — paginated list of past analyses
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { z, ZodError } from 'zod';
import {
    analyzeImpact,
    generateAdr,
    getImpactHistory,
    type ChangeType,
} from '../services/impactService.js';

export const impactRouter: ExpressRouter = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const AnalyzeSchema = z.object({
    serviceId: z.string().min(1, 'serviceId is required'),
    changeType: z.enum(['deprecate', 'schema-change', 'delete']),
    targetEndpoint: z.string().min(1, 'targetEndpoint is required'),
});

const AdrSchema = z.object({
    analysisId: z.string().uuid('analysisId must be a valid UUID'),
});

// ── POST /api/impact/analyze ──────────────────────────────────────────────────

/**
 * Run blast-radius impact analysis for a proposed endpoint change.
 *
 * Body: { serviceId, changeType, targetEndpoint }
 * Returns: full ImpactAnalysisResult with directImpact, indirectImpact, riskScore
 */
impactRouter.post('/analyze', (req: Request, res: Response): void => {
    try {
        const input = AnalyzeSchema.parse(req.body);
        const result = analyzeImpact({
            serviceId: input.serviceId,
            changeType: input.changeType as ChangeType,
            targetEndpoint: input.targetEndpoint,
        });
        res.status(201).json({ success: true, data: result });
    } catch (err) {
        if (err instanceof ZodError) {
            res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Validation error' });
            return;
        }
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 404) {
            res.status(404).json({ success: false, error: e.message });
            return;
        }
        const msg = err instanceof Error ? err.message : 'Internal error';
        res.status(500).json({ success: false, error: msg });
    }
});

// ── POST /api/impact/adr ──────────────────────────────────────────────────────

/**
 * Generate an Architecture Decision Record from an existing impact analysis.
 *
 * Body: { analysisId }
 * Returns: AdrResult with title, context, decision, consequences, alternatives
 */
impactRouter.post('/adr', (req: Request, res: Response): void => {
    try {
        const { analysisId } = AdrSchema.parse(req.body);
        const adr = generateAdr(analysisId);
        res.status(201).json({ success: true, data: adr });
    } catch (err) {
        if (err instanceof ZodError) {
            res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Validation error' });
            return;
        }
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 404) {
            res.status(404).json({ success: false, error: e.message });
            return;
        }
        const msg = err instanceof Error ? err.message : 'Internal error';
        res.status(500).json({ success: false, error: msg });
    }
});

// ── GET /api/impact/history ───────────────────────────────────────────────────

/**
 * Returns paginated impact analysis history, newest first.
 *
 * Query params: limit (default 20), offset (default 0)
 */
impactRouter.get('/history', (req: Request, res: Response): void => {
    try {
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
        const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
        const history = getImpactHistory(limit, offset);
        res.json({ success: true, data: history, meta: { count: history.length, limit, offset } });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Internal error';
        res.status(500).json({ success: false, error: msg });
    }
});
