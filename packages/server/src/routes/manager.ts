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

// ── GET /api/manager/teams/:id/prs ───────────────────────────────────────────
// Fetch open pull requests from GitHub for the team's configured repo.

interface GHLabel { name: string }
interface GHUser { login: string }
interface GHReviewer { login: string }
interface GHTeamReviewer { name: string }

/** Shape returned by the list endpoint — does NOT include changed_files */
interface GHPullRequestList {
    number: number;
    title: string;
    html_url: string;
    state: string;
    draft?: boolean;
    merged_at: string | null;
    created_at: string;
    body: string | null;
    user: GHUser | null;
    labels: GHLabel[];
    requested_reviewers: GHReviewer[];
    requested_teams: GHTeamReviewer[];
}

/** Shape returned by the single PR endpoint — includes changed_files, additions, deletions */
interface GHPullRequestDetail extends GHPullRequestList {
    changed_files: number;
    additions: number;
    deletions: number;
    commits: number;
    comments: number;
    review_comments: number;
}

router.get('/teams/:id/prs', async (req: Request, res: Response): Promise<void> => {
    try {
        const teams = getTeams();
        const team = teams.find(t => t.id === req.params.id);

        if (!team || !team.repo || team.repo === '—') {
            res.json(ok([]));
            return;
        }

        // Parse github.com/owner/repo URL
        const match = /github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(team.repo);
        if (!match) {
            res.json(ok([]));
            return;
        }
        const [, owner, repo] = match;

        const token = process.env.GITHUB_TOKEN;
        const headers: Record<string, string> = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'kachow-server/1.0',
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // ── Step 1: Fetch PR lists (open + recently merged) ───────────────────
        const [openRes, closedRes] = await Promise.all([
            fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20&sort=updated&direction=desc`, { headers }),
            fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&per_page=10&sort=updated&direction=desc`, { headers }),
        ]);

        if (!openRes.ok) {
            const errText = await openRes.text().catch(() => '');
            console.warn(`[PRs] GitHub API error ${openRes.status} for ${owner}/${repo}: ${errText}`);
            res.json(ok([]));
            return;
        }

        const rawOpen = (await openRes.json()) as GHPullRequestList[];
        const rawClosed = closedRes.ok ? ((await closedRes.json()) as GHPullRequestList[]) : [];
        const rawPRs = [...rawOpen, ...rawClosed.filter(p => p.merged_at !== null).slice(0, 5)];

        if (rawPRs.length === 0) {
            res.json(ok([]));
            return;
        }

        // ── Step 2: Fetch individual PR details in parallel to get changed_files
        // The list endpoint does NOT return changed_files — only the detail endpoint does.
        const detailResults = await Promise.allSettled(
            rawPRs.map(pr =>
                fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`, { headers })
                    .then(r => r.ok ? r.json() as Promise<GHPullRequestDetail> : Promise.reject(new Error(`${r.status}`)))
                    .catch(() => null),  // fall back to null on any failure — don't crash the whole list
            ),
        );

        const now = Date.now();
        const mapped = rawPRs.map((pr, idx) => {
            const detail = detailResults[idx]?.status === 'fulfilled'
                ? (detailResults[idx] as PromiseFulfilledResult<GHPullRequestDetail | null>).value
                : null;

            // Use real values from the detail endpoint; fall back gracefully
            const changedFiles = detail?.changed_files ?? 0;
            const additions    = detail?.additions    ?? 0;
            const deletions    = detail?.deletions    ?? 0;
            const commits      = detail?.commits      ?? 0;
            const linesChanged = additions + deletions;

            const reviewersCount = (pr.requested_reviewers?.length ?? 0) + (pr.requested_teams?.length ?? 0);
            const labels = (pr.labels ?? []).map(l => l.name);

            // ── Risk scoring using real file/line counts ──────────────────────
            const hasHighLabel  = labels.some(l => /high.?risk|breaking|major|critical/i.test(l));
            const hasMedLabel   = labels.some(l => /medium.?risk|refactor|deprecat/i.test(l));
            const isLargeChange = changedFiles > 10 || linesChanged > 300;
            const isMedChange   = changedFiles >= 3  || linesChanged >= 50 || commits > 3;

            const risk: 'low' | 'medium' | 'high' =
                hasHighLabel || isLargeChange
                    ? 'high'
                    : hasMedLabel || isMedChange || reviewersCount > 0
                        ? 'medium'
                        : 'low';

            const status: 'open' | 'review' | 'merged' =
                pr.merged_at         ? 'merged' :
                reviewersCount > 0 || pr.draft ? 'review' : 'open';

            const diffMs = now - new Date(pr.created_at).getTime();
            const diffMins = Math.floor(diffMs / 60_000);
            const timeAgo =
                diffMins < 60   ? `${diffMins}m ago` :
                diffMins < 1440 ? `${Math.floor(diffMins / 60)}h ago` :
                                  `${Math.floor(diffMins / 1440)}d ago`;

            return {
                id: `#${pr.number}`,
                number: pr.number,
                title: pr.title,
                author: pr.user?.login ?? 'unknown',
                status,
                time: timeAgo,
                reviewers: reviewersCount,
                risk,
                url: pr.html_url,
                labels,
                body: (pr.body ?? '').slice(0, 500),
                isDraft: pr.draft ?? false,
                changedFiles,
                additions,
                deletions,
                commits,
            };
        });

        res.json(ok(mapped));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to fetch PRs'));
    }
});

// ── POST /api/manager/teams/:id/prs/:prNumber/approve ────────────────────────
// Submit an APPROVE review on a GitHub PR in real-time.

router.post('/teams/:id/prs/:prNumber/approve', async (req: Request, res: Response): Promise<void> => {
    try {
        const teams = getTeams();
        const team = teams.find(t => t.id === req.params.id);

        if (!team || !team.repo || team.repo === '—') {
            res.status(404).json(err('Team or repo not found'));
            return;
        }

        const match = /github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(team.repo);
        if (!match) {
            res.status(400).json(err('Invalid repo URL format — expected github.com/owner/repo'));
            return;
        }
        const [, owner, repo] = match;

        const prNumber = parseInt(req.params.prNumber, 10);
        if (isNaN(prNumber) || prNumber <= 0) {
            res.status(400).json(err('Invalid PR number'));
            return;
        }

        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            res.status(503).json(err('GITHUB_TOKEN not configured on the server'));
            return;
        }

        const reviewRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
            {
                method: 'POST',
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'Authorization': `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                    'User-Agent': 'kachow-server/1.0',
                },
                body: JSON.stringify({
                    event: 'APPROVE',
                    body: 'Approved via KA-CHOW Manager Dashboard ✅',
                }),
            },
        );

        if (!reviewRes.ok) {
            const errText = await reviewRes.text().catch(() => '');
            console.warn(`[PR Approve] GitHub API ${reviewRes.status} for ${owner}/${repo}#${prNumber}: ${errText}`);

            // Parse the GitHub error for a clean user-facing message
            let ghMessage = '';
            try { ghMessage = (JSON.parse(errText) as { message?: string }).message ?? ''; } catch { ghMessage = errText; }

            let userMessage: string;
            if (reviewRes.status === 403) {
                if (ghMessage.toLowerCase().includes('resource not accessible')) {
                    userMessage = 'Your GITHUB_TOKEN lacks the required permission to submit PR reviews. ' +
                        'If using a fine-grained PAT, enable \'Pull requests: Read and write\' for this repo. ' +
                        'If using a classic PAT, ensure the \'repo\' scope is checked. ' +
                        'Visit https://github.com/settings/tokens to update your token.';
                } else {
                    userMessage = `GitHub returned 403 Forbidden — ${ghMessage || 'permission denied'}.`;
                }
            } else if (reviewRes.status === 422) {
                userMessage = `Cannot review this PR — ${ghMessage || 'the PR may already be reviewed or you are the author'}.`;
            } else {
                userMessage = `GitHub returned ${reviewRes.status} — ${ghMessage || errText}`;
            }

            res.status(reviewRes.status).json(err(userMessage));
            return;
        }

        const review = await reviewRes.json() as { id: number; state: string; html_url: string };
        console.log(`[PR Approve] Approved ${owner}/${repo}#${prNumber} — review id ${review.id}`);
        res.json(ok({ approved: true, reviewId: review.id, state: review.state, url: review.html_url }));
    } catch (e) {
        console.error('[PR Approve] Unexpected error:', e);
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to approve PR'));
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

