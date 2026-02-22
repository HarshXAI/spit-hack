/**
 * Ingest routes — Phase 1.
 *
 * POST  /api/ingest/repo        — Enqueue full repo scan
 * GET   /api/ingest/status/:id  — SSE stream for job progress
 * POST  /api/ingest/commit      — Enqueue commit-triggered partial re-scan
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  IngestRepoSchema,
  IngestCommitSchema,
  enqueueRepoIngest,
  enqueueCommitIngest,
} from '../services/ingestService.js';
import { subscribe } from '../sse/sseManager.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

// ── POST /api/ingest/repo ─────────────────────────────────────────────────────

/**
 * Enqueue a full repository scan.
 * Returns a jobId immediately; progress is streamed via SSE on /api/ingest/status/:jobId.
 *
 * @param req.body - { repoPath, repoUrl?, team? }
 * @returns 201 with { jobId, status, estimatedSeconds }
 */
router.post('/repo', async (req: Request, res: Response): Promise<void> => {
  // Validate body
  const parseResult = IngestRepoSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json(err(formatZodError(parseResult.error)));
    return;
  }

  try {
    const result = await enqueueRepoIngest(parseResult.data);
    res.status(201).json(ok(result));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to enqueue ingestion job';
    res.status(500).json(err(message));
  }
});

// ── GET /api/ingest/status/:jobId ─────────────────────────────────────────────

/**
 * SSE stream for ingestion job progress.
 * Keeps the HTTP connection open and emits typed events until the job completes.
 * Client uses EventSource API to connect.
 *
 * @param req.params.jobId - UUID of the ingestion job
 * @returns SSE stream of progress events
 */
router.get('/status/:jobId', async (req: Request, res: Response): Promise<void> => {
  const { jobId } = req.params;

  if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    res.status(400).json(err('Invalid jobId format'));
    return;
  }

  // Optional: check job exists in queue — if not yet started worker may not have it
  // We allow connection regardless; worker emits events when it starts
  subscribe(jobId, res);
  // subscribe() keeps the connection open — do NOT call res.end() here
});

// ── POST /api/ingest/commit ───────────────────────────────────────────────────

/**
 * Enqueue a commit-triggered partial re-scan.
 * Called by GitHub webhook handler (Phase 6) when a push event fires.
 *
 * @param req.body - { repoId, commitHash, changedFiles[] }
 * @returns 201 with { nodesUpdated, newIssues[] }
 */
router.post('/commit', async (req: Request, res: Response): Promise<void> => {
  const parseResult = IngestCommitSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json(err(formatZodError(parseResult.error)));
    return;
  }

  try {
    const result = await enqueueCommitIngest(parseResult.data);
    res.status(201).json(ok(result));
  } catch (e) {
    // Check for our custom 404 object
    if (typeof e === 'object' && e !== null && 'statusCode' in e) {
      const typed = e as { statusCode: number; message: string };
      res.status(typed.statusCode).json(err(typed.message));
      return;
    }
    const message = e instanceof Error ? e.message : 'Failed to enqueue commit ingest';
    res.status(500).json(err(message));
  }
});

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Formats a ZodError into a single human-readable string.
 *
 * @param error - ZodError to format
 * @returns Comma-separated field error messages
 */
function formatZodError(error: ZodError): string {
  return error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

export { router as ingestRouter };
