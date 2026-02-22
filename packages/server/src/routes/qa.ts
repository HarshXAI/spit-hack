/**
 * Q&A routes — Phase 3.
 *
 * POST /api/qa/query        — Ask a question about the architecture
 * GET  /api/qa/history      — Retrieve past Q&A sessions
 * GET  /api/qa/suggestions  — Dynamic follow-up question suggestions
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import { queryKnowledgeGraph, getQAHistory, getQASuggestions } from '../services/qaService.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

const QuerySchema = z.object({
    question: z.string().min(3, 'Question must be at least 3 characters').max(500),
});

// ── POST /api/qa/query ────────────────────────────────────────────────────────

/**
 * Ask a natural language question about the architecture.
 * Builds graph-aware context and calls OpenAI GPT-4o.
 *
 * @param req.body.question - The engineer's question
 * @returns QAResult with answer, citations, related node IDs, suggestions
 */
router.post('/query', async (req: Request, res: Response): Promise<void> => {
    const parse = QuerySchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const result = await queryKnowledgeGraph(parse.data.question);
        res.json(ok(result));
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Q&A query failed';
        res.status(500).json(err(msg));
    }
});

// ── GET /api/qa/history ───────────────────────────────────────────────────────

/**
 * Returns the last 20 Q&A interactions.
 */
router.get('/history', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getQAHistory()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to fetch history'));
    }
});

// ── GET /api/qa/suggestions ───────────────────────────────────────────────────

/**
 * Returns dynamic question suggestions based on current graph state.
 * Used to populate the Q&A terminal suggestion chips on load.
 */
router.get('/suggestions', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getQASuggestions()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to fetch suggestions'));
    }
});

export { router as qaRouter };
