/**
 * Manager + Onboarding routes — Phase 8.
 *
 * GET /api/manager/pulse        — VP-level health summary (OpenAI-generated prose)
 * GET /api/manager/teams        — Team breakdown with health stats
 * GET /api/manager/decisions    — ADR decision queue
 * GET /api/onboarding/path/:role — Role-specific learning path
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import {
    getManagerPulse,
    getManagerTeams,
    getManagerDecisions,
    getOnboardingPath,
} from '../services/managerService.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

const VALID_ROLES = ['backend-engineer', 'sre', 'engineering-manager'] as const;
const RoleSchema = z.enum(VALID_ROLES);

/** Short-form aliases accepted from the frontend (OnboardingChecklist uses 'backend', 'sre', 'manager'). */
const ROLE_ALIASES: Record<string, typeof VALID_ROLES[number]> = {
    'backend': 'backend-engineer',
    'frontend': 'backend-engineer',
    'fullstack': 'backend-engineer',
    'manager': 'engineering-manager',
    'eng-manager': 'engineering-manager',
    'devops': 'sre',
    'platform': 'sre',
};

// ── GET /api/manager/pulse ────────────────────────────────────────────────────

router.get('/pulse', async (_req: Request, res: Response): Promise<void> => {
    try {
        const pulse = await getManagerPulse();
        res.json(ok(pulse));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get manager pulse'));
    }
});

// ── GET /api/manager/teams ────────────────────────────────────────────────────

router.get('/teams', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getManagerTeams()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get teams'));
    }
});

// ── GET /api/manager/decisions ────────────────────────────────────────────────

router.get('/decisions', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getManagerDecisions()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get decisions'));
    }
});

// ── GET /api/onboarding/path/:role ────────────────────────────────────────────

// Both mounts: /api/manager/onboarding/path/:role  AND  /api/onboarding/path/:role
router.get(['/onboarding/path/:role', '/path/:role'], (req: Request, res: Response): void => {
    // Normalise aliases before validation
    const rawRole = req.params.role;
    const normalised = ROLE_ALIASES[rawRole] ?? rawRole;
    const parse = RoleSchema.safeParse(normalised);
    if (!parse.success) {
        res.status(400).json(err(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')} (aliases: ${Object.keys(ROLE_ALIASES).join(', ')})`));
        return;
    }

    try {
        res.json(ok(getOnboardingPath(parse.data)));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get onboarding path'));
    }
});

export { router as managerRouter };
