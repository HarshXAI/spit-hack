/**
 * Manager + Onboarding routes — Phase 8.
 *
 * GET    /api/manager/pulse               — VP-level health summary
 * GET    /api/manager/teams               — List all managed teams (with members)
 * POST   /api/manager/teams               — Create a new team → returns join code
 * DELETE /api/manager/teams/:id           — Delete a team
 * POST   /api/manager/teams/:id/regen     — Regenerate join code
 * POST   /api/manager/teams/join          — Engineer enters 6-digit code → team info
 * POST   /api/manager/teams/:id/members   — Add a member to a team
 * GET    /api/manager/decisions           — ADR decision queue
 * GET    /api/onboarding/path/:role       — Role-specific learning path
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import {
    getManagerPulse,
    getManagerTeams,
    getManagerDecisions,
    getOnboardingPath,
    getTeams,
    createTeam,
    deleteTeam,
    regenTeamCode,
    joinTeamByCode,
    addTeamMember,
} from '../services/managerService.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

const VALID_ROLES = ['backend-engineer', 'sre', 'engineering-manager'] as const;
const RoleSchema = z.enum(VALID_ROLES);

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
        res.json(ok(getTeams()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get teams'));
    }
});

// ── POST /api/manager/teams ───────────────────────────────────────────────────

const CreateTeamSchema = z.object({
    name: z.string().min(1).max(100),
    repo: z.string().max(300).optional(),
    description: z.string().max(500).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

router.post('/teams', (req: Request, res: Response): void => {
    const parse = CreateTeamSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join(', ')));
        return;
    }
    try {
        res.status(201).json(ok(createTeam(parse.data)));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to create team'));
    }
});

// ── POST /api/manager/teams/join ──────────────────────────────────────────────
// Must be defined BEFORE /:id routes to avoid 'join' matching as an id.

const JoinSchema = z.object({
    joinCode: z.string().regex(/^\d{6}$/, 'joinCode must be a 6-digit number'),
    memberName: z.string().min(1).max(100).optional(),
    memberRole: z.string().max(100).optional(),
});

router.post('/teams/join', (req: Request, res: Response): void => {
    const parse = JoinSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join(', ')));
        return;
    }
    try {
        const team = joinTeamByCode(parse.data.joinCode);
        if (!team) {
            res.status(404).json(err('Join code not found. Ask your manager for the correct code.'));
            return;
        }
        // Optionally register the member if name is supplied
        if (parse.data.memberName) {
            addTeamMember(team.id, { name: parse.data.memberName, role: parse.data.memberRole });
            // Refresh team to include new member
            const updated = joinTeamByCode(parse.data.joinCode);
            res.json(ok(updated));
            return;
        }
        res.json(ok(team));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to join team'));
    }
});

// ── DELETE /api/manager/teams/:id ─────────────────────────────────────────────

router.delete('/teams/:id', (req: Request, res: Response): void => {
    try {
        deleteTeam(req.params.id);
        res.json(ok({ deleted: true }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to delete team'));
    }
});

// ── POST /api/manager/teams/:id/regen ────────────────────────────────────────

router.post('/teams/:id/regen', (req: Request, res: Response): void => {
    try {
        const newCode = regenTeamCode(req.params.id);
        res.json(ok({ joinCode: newCode }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to regen code'));
    }
});

// ── POST /api/manager/teams/:id/members ──────────────────────────────────────

const AddMemberSchema = z.object({
    name: z.string().min(1).max(100),
    role: z.string().max(100).optional(),
});

router.post('/teams/:id/members', (req: Request, res: Response): void => {
    const parse = AddMemberSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join(', ')));
        return;
    }
    try {
        const member = addTeamMember(req.params.id, parse.data);
        res.status(201).json(ok(member));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to add member'));
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

router.get(['/onboarding/path/:role', '/path/:role'], (req: Request, res: Response): void => {
    const rawRole = req.params.role;
    const normalised = ROLE_ALIASES[rawRole] ?? rawRole;
    const parse = RoleSchema.safeParse(normalised);
    if (!parse.success) {
        res.status(400).json(err(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`));
        return;
    }

    try {
        res.json(ok(getOnboardingPath(parse.data)));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get onboarding path'));
    }
});

// ── GET /api/manager/teams (legacy alias) ────────────────────────────────────

router.get('/teams-breakdown', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getManagerTeams()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get teams'));
    }
});

export { router as managerRouter };

