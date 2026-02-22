/**
 * Self-healing routes — Phase 5.
 *
 * GET  /api/heal/queue           — Current healing issue queue
 * POST /api/heal/detect          — Detect issues in a service and enqueue
 * POST /api/heal/patch           — Generate GPT-4o patch for a healing item
 * POST /api/heal/pr              — Create real GitHub PR for a patch
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import {
    getHealingQueue,
    detectAndEnqueueIssues,
    generatePatch,
    createHealingPR,
    findOrCreateHealingEntry,
} from '../services/healingService.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

// ── GET /api/heal/queue ───────────────────────────────────────────────────────

router.get('/queue', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getHealingQueue()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get healing queue'));
    }
});

// ── POST /api/heal/detect ─────────────────────────────────────────────────────

const DetectSchema = z.object({
    serviceId: z.string().min(1, 'serviceId required'),
});

router.post('/detect', (req: Request, res: Response): void => {
    const parse = DetectSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const issues = detectAndEnqueueIssues(parse.data.serviceId);
        res.status(201).json(ok({ detected: issues.length, issues }));
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Detection failed';
        res.status(msg.includes('not found') ? 404 : 500).json(err(msg));
    }
});

// ── POST /api/heal/patch ──────────────────────────────────────────────────────

const PatchSchema = z.object({
    healingId: z.string().uuid('healingId must be a UUID'),
});

router.post('/patch', async (req: Request, res: Response): Promise<void> => {
    const parse = PatchSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const result = await generatePatch(parse.data.healingId);
        res.json(ok(result));
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Patch generation failed';
        res.status(msg.includes('not found') ? 404 : 500).json(err(msg));
    }
});

// ── POST /api/heal/pr ─────────────────────────────────────────────────────────

const PRSchema = z.object({
    healingId: z.string().uuid('healingId must be a UUID'),
    repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repoFullName must be owner/repo'),
});

router.post('/pr', async (req: Request, res: Response): Promise<void> => {
    const parse = PRSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const result = await createHealingPR(parse.data.healingId, parse.data.repoFullName);
        res.status(201).json(ok(result));
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'PR creation failed';
        const status = msg.includes('not found') ? 404 : msg.includes('not set') ? 503 : 500;
        res.status(status).json(err(msg));
    }
});

export { router as healingRouter };

// ── POST /api/heal/apply-fix ──────────────────────────────────────────────────
// Combined endpoint: find/create healing entry → generate patch → optionally open PR

const ApplyFixSchema = z.object({
    issueId: z.string().min(1, 'issueId required'),
    serviceId: z.string().min(1, 'serviceId required'),
    issueType: z.string().min(1, 'issueType required'),
    description: z.string().min(1, 'description required'),
    file: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
    openPR: z.boolean().default(false),
    repoFullName: z.string().optional(),     // e.g. "HarshXAI/vesper" — required if openPR=true
});

router.post('/apply-fix', async (req: Request, res: Response): Promise<void> => {
    console.log('[apply-fix] Received request:', JSON.stringify(req.body).slice(0, 200));
    const parse = ApplyFixSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const { serviceId, issueType, description, file, openPR, repoFullName } = parse.data;

        // Step 1: Find or create healing_prs entry
        const healingId = findOrCreateHealingEntry(serviceId, issueType, description);

        // Step 2: Generate GPT-4o patch
        const patch = await generatePatch(healingId);

        // Step 3: Optionally create GitHub PR (don't let PR failure kill the whole response)
        let prResult = null;
        let prError: string | null = null;
        if (openPR && repoFullName) {
            try {
                prResult = await createHealingPR(healingId, repoFullName);
            } catch (prErr) {
                prError = prErr instanceof Error ? prErr.message : 'PR creation failed';
                console.error('[apply-fix] PR creation failed:', prError);
            }
        }

        res.status(201).json(ok({
            healingId,
            patch,
            pr: prResult,
            prError,
            status: prResult ? 'pr-open' : prError ? 'patch-ready-pr-failed' : 'patch-ready',
        }));
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Fix generation failed';
        const status = msg.includes('not found') ? 404 : msg.includes('not set') ? 503 : 500;
        res.status(status).json(err(msg));
    }
});
