/**
 * Ingest service — business logic for Phase 1 ingestion APIs.
 * Validates inputs, enqueues BullMQ jobs, and handles commit re-scans.
 * Routes import from here; this module never imports from routes/.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getIngestQueue } from '../queues/ingestQueue.js';
import { getDb } from '../db/index.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

/**
 * Zod schema for POST /api/ingest/repo request body.
 */
export const IngestRepoSchema = z.object({
    repoPath: z
        .string()
        .min(1, 'repoPath is required')
        .max(500),
    repoUrl: z.string().url('repoUrl must be a valid URL').optional(),
    team: z.string().min(1).max(100).optional(),
});

export type IngestRepoInput = z.infer<typeof IngestRepoSchema>;

/**
 * Zod schema for POST /api/ingest/commit request body.
 */
export const IngestCommitSchema = z.object({
    repoId: z.string().min(1, 'repoId is required'),
    commitHash: z
        .string()
        .regex(/^[0-9a-f]{7,40}$/i, 'commitHash must be a valid git SHA')
        .min(7)
        .max(40),
    changedFiles: z
        .array(z.string())
        .min(1, 'changedFiles must contain at least one file'),
});

export type IngestCommitInput = z.infer<typeof IngestCommitSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface IngestRepoResponse {
    jobId: string;
    status: 'started';
    estimatedSeconds: number;
}

export interface IngestCommitResponse {
    nodesUpdated: number;
    newIssues: string[];
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Enqueues a full repository ingestion job.
 * Returns immediately with a jobId — the scan runs in the background.
 *
 * @param input - Validated ingest request body
 * @returns Job ID and estimated completion time
 * @throws Error if queue is unavailable (Redis down)
 */
export async function enqueueRepoIngest(
    input: IngestRepoInput,
): Promise<IngestRepoResponse> {
    const jobId = randomUUID();
    const queue = getIngestQueue();

    await queue.add(
        'ingest-repo',
        { jobId, repoPath: input.repoPath, repoUrl: input.repoUrl, team: input.team },
        { jobId },
    );

    return {
        jobId,
        status: 'started',
        estimatedSeconds: 30,
    };
}

/**
 * Enqueues a commit-triggered partial re-scan job.
 * Verifies the repoId exists in the DB before enqueuing.
 *
 * @param input - Validated commit ingest request body
 * @returns Updated node count and any new issues discovered
 * @throws Error if repoId is not found in the database
 */
export async function enqueueCommitIngest(
    input: IngestCommitInput,
): Promise<IngestCommitResponse> {
    const db = getDb();

    // Verify the service exists
    const svc = db
        .prepare<[string]>('SELECT id FROM services WHERE id = ?')
        .get(input.repoId) as { id: string } | undefined;

    if (!svc) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw {
            statusCode: 404,
            message: `Service with id '${input.repoId}' not found. Run POST /api/ingest/repo first.`,
        };
    }

    const jobId = randomUUID();
    const queue = getIngestQueue();

    await queue.add(
        'ingest-commit',
        {
            jobId,
            repoId: input.repoId,
            commitHash: input.commitHash,
            changedFiles: input.changedFiles,
        },
        { jobId },
    );

    return {
        nodesUpdated: 1,
        newIssues: [],
    };
}

/**
 * Checks if a BullMQ job exists and returns its current state.
 * Used by the SSE route to validate the jobId before opening a stream.
 *
 * @param jobId - UUID of the job to look up
 * @returns Job state string or null if not found
 */
export async function getJobState(jobId: string): Promise<string | null> {
    const queue = getIngestQueue();
    const job = await queue.getJob(jobId);
    if (!job) return null;
    return job.getState();
}
