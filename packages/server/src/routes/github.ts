/**
 * GitHub webhook handler.
 *
 * POST /api/github/webhook
 *
 * GitHub sends a signed POST on every push event.
 * We verify the HMAC-SHA256 signature using GITHUB_WEBHOOK_SECRET,
 * then enqueue a commit-triggered partial re-scan via ingestService.
 *
 * Register this webhook at:
 *   https://github.com/organizations/<org>/settings/hooks
 *   or per-repo at Settings → Webhooks
 *
 * Required env vars:
 *   GITHUB_WEBHOOK_SECRET  — must match the "Secret" field in GitHub's UI
 */

import { createHmac, timingSafeEqual } from 'crypto';
import express, { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { enqueueCommitIngest } from '../services/ingestService.js';

export const githubRouter: ExpressRouter = Router();

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verifies the X-Hub-Signature-256 header sent by GitHub.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param secret  - GITHUB_WEBHOOK_SECRET from env
 * @param payload - Raw request body as a Buffer
 * @param header  - Value of X-Hub-Signature-256 header
 * @returns true if the signature matches
 */
function verifySignature(secret: string, payload: Buffer, header: string | undefined): boolean {
    if (!header) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
    try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
    } catch {
        return false;
    }
}

// ── POST /api/github/webhook ──────────────────────────────────────────────────

/**
 * Receives GitHub push events and enqueues a commit-triggered re-scan.
 *
 * GitHub push payload shape (relevant fields only):
 *   { ref, after, repository: { id, full_name, clone_url }, commits: [{ id, added, removed, modified }] }
 */
githubRouter.post(
    '/webhook',
    // Capture raw body for HMAC verification BEFORE JSON parsing strips it.
    // We register this route with express.raw() so the body is a Buffer here.
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response): Promise<void> => {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;

        if (!secret) {
            console.error('[GitHub Webhook] GITHUB_WEBHOOK_SECRET is not set');
            res.status(500).json({ success: false, error: 'Webhook secret not configured' });
            return;
        }

        // ── Signature check ───────────────────────────────────────────────────────
        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        const rawBody = req.body as Buffer;

        if (!verifySignature(secret, rawBody, signature)) {
            console.warn('[GitHub Webhook] Invalid signature — request rejected');
            res.status(401).json({ success: false, error: 'Invalid webhook signature' });
            return;
        }

        // ── Parse payload ─────────────────────────────────────────────────────────
        let payload: {
            ref?: string;
            after?: string;
            repository?: { id?: number; full_name?: string; clone_url?: string };
            commits?: { id?: string; added?: string[]; removed?: string[]; modified?: string[] }[];
        };

        try {
            payload = JSON.parse(rawBody.toString('utf-8')) as typeof payload;
        } catch {
            res.status(400).json({ success: false, error: 'Could not parse JSON payload' });
            return;
        }

        // Only process push events (not tag deletions, etc.)
        const event = req.headers['x-github-event'];
        if (event !== 'push') {
            res.json({ success: true, data: { skipped: true, reason: `event '${String(event)}' not handled` } });
            return;
        }

        const commitHash = payload.after;
        const repoFullName = payload.repository?.full_name ?? 'unknown';
        const repoId = String(payload.repository?.id ?? '');

        if (!commitHash || commitHash === '0000000000000000000000000000000000000000') {
            // Branch deletion — nothing to scan
            res.json({ success: true, data: { skipped: true, reason: 'branch deletion event' } });
            return;
        }

        // Collect all changed files across every commit in this push
        const changedFiles = [
            ...new Set(
                (payload.commits ?? []).flatMap((c) => [
                    ...(c.added ?? []),
                    ...(c.modified ?? []),
                    ...(c.removed ?? []),
                ]),
            ),
        ];

        if (changedFiles.length === 0) {
            res.json({ success: true, data: { skipped: true, reason: 'no files changed' } });
            return;
        }

        // ── Enqueue re-scan ───────────────────────────────────────────────────────
        try {
            const result = await enqueueCommitIngest({ repoId, commitHash, changedFiles });
            console.log(`[GitHub Webhook] Enqueued commit job for ${repoFullName}@${commitHash.slice(0, 7)}`);
            res.status(201).json({ success: true, data: result });
        } catch (err) {
            const e = err as { statusCode?: number; message?: string };
            if (e.statusCode === 404) {
                // Repo not yet ingested — that's fine, just skip
                res.status(404).json({
                    success: false,
                    error: `Repository '${repoFullName}' (id: ${repoId}) not found in KA-CHOW. Run a full ingest first.`,
                });
                return;
            }
            console.error('[GitHub Webhook] Enqueue error:', e.message);
            res.status(500).json({ success: false, error: e.message ?? 'Internal error' });
        }
    },
);
