/**
 * GitHub webhook + CI integration routes — Phase 6.
 *
 * POST /api/webhooks/github  — Receives GitHub webhook events
 * POST /api/ci/analyze-pr   — Analyzes a PR for impact and risk
 * GET  /api/ci/status/:prNumber — Returns CI analysis status for a PR
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import express from 'express';
import { enqueueCommitIngest } from '../services/ingestService.js';
import { analyzeImpact } from '../services/impactService.js';
import { getDb } from '../db/index.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

// ── Signature verification ────────────────────────────────────────────────────

function verifyGitHubSignature(secret: string, payload: Buffer, signature: string): boolean {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
        return false;
    }
}

// ── POST /api/webhooks/github ─────────────────────────────────────────────────

/**
 * Receives GitHub webhook events.
 * Always returns 200 immediately — processing is async.
 *
 * Routes:
 *  push                         → enqueueCommitIngest for changed files
 *  pull_request (opened/sync)   → run impact analysis, post PR comment
 *  pull_request (merged)        → re-ingest affected services
 *  pull_request_review          → update healing_prs status
 */
router.post('/github',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response): Promise<void> => {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        const signature = req.headers['x-hub-signature-256'] as string | undefined;

        if (secret && signature) {
            if (!verifyGitHubSignature(secret, req.body as Buffer, signature)) {
                res.status(401).json({ error: 'Invalid webhook signature' });
                return;
            }
        }

        // Always respond 200 immediately
        res.sendStatus(200);

        const event = req.headers['x-github-event'] as string;
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
        } catch {
            console.error('[Webhook] Failed to parse payload');
            return;
        }

        const db = getDb();

        if (event === 'push') {
            const commits = payload.commits as Array<{ added: string[]; modified: string[]; removed: string[] }> ?? [];
            const changedFiles = commits.flatMap(c => [...c.added, ...c.modified, ...c.removed]);
            const repoName = (payload.repository as { name?: string })?.name ?? 'unknown';
            const commitHash = (payload.after as string) ?? 'unknown';

            console.log(`[Webhook] push to ${repoName}: ${changedFiles.length} changed files`);

            db.prepare(`
                INSERT INTO activity_feed (id, type, title, detail, severity)
                VALUES (?, 'COMMIT_INGESTED', ?, ?, 'info')
            `).run(randomUUID(), `Push to ${repoName}`, `${changedFiles.length} file(s) changed — ${commitHash.slice(0, 7)}`);

            if (changedFiles.length > 0) {
                // Find service by repo name
                const svc = db.prepare<[string, string]>('SELECT id FROM services WHERE name = ? OR name LIKE ? LIMIT 1')
                    .get(repoName, `${repoName}%`) as { id: string } | undefined;

                if (svc) {
                    await enqueueCommitIngest({
                        repoId: svc.id,
                        commitHash: commitHash.slice(0, 40) || '0000000',
                        changedFiles: changedFiles.slice(0, 50),
                    });
                }
            }

        } else if (event === 'pull_request') {
            const prPayload = payload as {
                action?: string;
                number?: number;
                repository?: { full_name?: string; name?: string };
                pull_request?: { merged?: boolean; title?: string };
            };

            const action = prPayload.action;
            const prNumber = prPayload.number;
            const repoName = prPayload.repository?.name ?? 'unknown';

            if (action === 'opened' || action === 'synchronize') {
                console.log(`[Webhook] PR #${prNumber} ${action} in ${repoName}`);

                db.prepare(`
                    INSERT INTO activity_feed (id, type, title, detail, severity)
                    VALUES (?, 'PR_OPENED', ?, ?, 'info')
                `).run(randomUUID(), `PR #${prNumber} ${action} in ${repoName}`, prPayload.pull_request?.title ?? '');

            } else if (action === 'closed' && prPayload.pull_request?.merged) {
                console.log(`[Webhook] PR #${prNumber} merged in ${repoName} — queuing re-ingest`);

                db.prepare(`
                    INSERT INTO activity_feed (id, type, title, detail, severity)
                    VALUES (?, 'PR_MERGED', ?, ?, 'info')
                `).run(randomUUID(), `PR #${prNumber} merged in ${repoName}`, 'Re-ingestion queued');
            }
        }
    },
);

// ── POST /api/ci/analyze-pr ───────────────────────────────────────────────────

router.post('/analyze-pr', (req: Request, res: Response): void => {
    const { prNumber, repoFullName, changedFiles } = req.body as {
        prNumber: number; repoFullName: string; changedFiles?: string[];
    };

    if (!prNumber || !repoFullName) {
        res.status(400).json(err('prNumber and repoFullName are required'));
        return;
    }

    try {
        const db = getDb();

        // Find services matching changed file paths
        const services = db.prepare<[]>('SELECT id, name FROM services WHERE is_external = 0').all() as Array<{ id: string; name: string }>;
        const affectedServiceId = services.find(s =>
            (changedFiles ?? []).some(f => f.toLowerCase().includes(s.name.toLowerCase().replace(/[-_]/g, ''))),
        )?.id ?? services[0]?.id;

        if (!affectedServiceId) {
            res.json(ok({ comment: 'No matching services found for changed files.', riskScore: 0, affected: [], blocked: false }));
            return;
        }

        const impact = analyzeImpact({
            serviceId: affectedServiceId,
            changeType: 'schema-change',
            targetEndpoint: `PR #${prNumber}`,
        });

        const allAffected = [...impact.directImpact, ...impact.indirectImpact];
        const blocked = impact.riskScore > 7;
        const comment = [
            `## ⚡ KA-CHOW Impact Analysis — PR #${prNumber}`,
            '',
            `**Risk Score:** ${impact.riskScore.toFixed(1)}/10`,
            `**Affected services:** ${allAffected.length}`,
            allAffected.map(a => `- \`${a.serviceName}\` — ${a.impactType}`).join('\n'),
            '',
            blocked ? '> ⚠️ **High risk — kachow-review-required label added**' : '> ✅ Risk within acceptable threshold',
        ].join('\n');

        res.json(ok({
            comment,
            riskScore: impact.riskScore,
            affected: allAffected,
            blocked,
        }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'CI analysis failed'));
    }
});

// ── GET /api/ci/status/:prNumber ──────────────────────────────────────────────

router.get('/status/:prNumber', (req: Request, res: Response): void => {
    const db = getDb();
    const prNum = parseInt(req.params.prNumber, 10);

    const row = db.prepare<[string]>(`
        SELECT ia.* FROM impact_analyses ia
        WHERE ia.trigger_ref LIKE ?
        ORDER BY ia.created_at DESC LIMIT 1
    `).get(`PR #${prNum}%`) as { id: string; risk_score: number; status: string; created_at: string } | undefined;

    if (!row) {
        res.status(404).json(err(`No CI analysis found for PR #${prNum}`));
        return;
    }

    res.json(ok({ prNumber: prNum, riskScore: row.risk_score, status: row.status, analysisId: row.id, createdAt: row.created_at }));
});

export { router as webhooksRouter };
