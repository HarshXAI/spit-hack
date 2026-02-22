/**
 * BullMQ ingest queue definition.
 * All repository ingestion jobs are enqueued here and processed by ingestWorker.ts.
 */

import { Queue } from 'bullmq';
import { getRedis, isRedisDisabled } from './redis.js';

/** Payload for a full repo ingest job. */
export interface IngestJobData {
    jobId: string;
    repoPath: string;
    repoUrl?: string;
    team?: string;
}

/** Payload for a commit-triggered partial re-scan job. */
export interface CommitJobData {
    jobId: string;
    repoId: string;
    commitHash: string;
    changedFiles: string[];
}

export type AnyIngestJobData = IngestJobData | CommitJobData;

let _ingestQueue: Queue<AnyIngestJobData> | null = null;

/**
 * Returns (and lazily creates) the ingest BullMQ queue.
 * Returns null when Redis is disabled — callers should run jobs in-process instead.
 *
 * @returns BullMQ Queue for ingestion jobs, or null if Redis is disabled
 */
export function getIngestQueue(): Queue<AnyIngestJobData> | null {
    if (isRedisDisabled()) return null;
    const redis = getRedis();
    if (!redis) return null;
    if (!_ingestQueue) {
        _ingestQueue = new Queue<AnyIngestJobData>('ingest', {
            connection: redis,
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'exponential', delay: 3000 },
                removeOnComplete: { count: 100 },
                removeOnFail: { count: 50 },
            },
        });
    }
    return _ingestQueue;
}

/**
 * Closes the ingest queue connection.
 * Call during graceful server shutdown.
 *
 * @returns Promise that resolves when queue is closed
 */
export async function closeIngestQueue(): Promise<void> {
    if (_ingestQueue) {
        await _ingestQueue.close();
        _ingestQueue = null;
    }
}
