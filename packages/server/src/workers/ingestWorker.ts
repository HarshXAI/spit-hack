/**
 * BullMQ ingest worker.
 * Consumes jobs from the 'ingest' queue and executes the full scan pipeline:
 *   1. Emit progress events via SSE
 *   2. Scan repo / changed files
 *   3. Upsert services + dependencies into SQLite
 *   4. Emit node-discovered + complete events
 *
 * This file is imported by server.ts on startup — the worker runs in-process.
 */

import { Worker, Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { saveSnapshot } from '../services/graphService.js';
import { getRedis, isRedisDisabled } from '../queues/redis.js';
import { getDb } from '../db/index.js';
import { scanRepo, serviceIdFromName } from '../services/scannerService.js';
import { emit, closeJob } from '../sse/sseManager.js';
import type { AnyIngestJobData, IngestJobData, CommitJobData } from '../queues/ingestQueue.js';
import type { HealthTier } from '../types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a numeric health score to a HealthTier string.
 *
 * @param score - Health score 0–100
 * @returns HealthTier enum value
 */
function toHealthTier(score: number): HealthTier {
    if (score >= 75) return 'healthy';
    if (score >= 50) return 'warning';
    return 'critical';
}

/**
 * Type guard: checks if a job payload is a full IngestJobData.
 *
 * @param data - Job data to check
 * @returns true if IngestJobData
 */
function isIngestJob(data: AnyIngestJobData): data is IngestJobData {
    return 'repoPath' in data;
}

// ── Full repo ingest handler ───────────────────────────────────────────────────

/**
 * Processes a full repository ingestion job.
 * Scans the repo, upserts all services + endpoints + dependencies into SQLite,
 * and streams progress + node-discovered events to subscribed SSE clients.
 *
 * @param job - BullMQ Job with IngestJobData payload
 * @throws Error if repo scan or DB write fails (causes BullMQ retry)
 */
async function processIngestJob(job: Job<IngestJobData>): Promise<void> {
    const { jobId, repoPath, repoUrl, team } = job.data;
    const db = getDb();

    // Phase 1/5 — start
    emit(jobId, { type: 'progress', phase: 'Initialising scan', percent: 5, current: repoPath });

    // Phase 2/5 — scan
    emit(jobId, { type: 'progress', phase: 'Walking directory tree', percent: 15, current: repoPath });
    const result = scanRepo(repoPath, repoUrl, team);

    // Phase 3/5 — persist services
    emit(jobId, { type: 'progress', phase: 'Persisting services', percent: 40, current: 'services' });

    const upsertService = db.prepare<[
        string, string, string | null, string | null, string | null, string | null,
        number, string, number, number
    ]>(`
    INSERT INTO services (id, name, repo_url, repo_subpath, team, language, health_score, health_tier, doc_coverage, test_coverage, last_ingested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      repo_url = excluded.repo_url,
      repo_subpath = excluded.repo_subpath,
      team = excluded.team,
      language = excluded.language,
      health_score = excluded.health_score,
      health_tier = excluded.health_tier,
      doc_coverage = excluded.doc_coverage,
      test_coverage = excluded.test_coverage,
      last_ingested = excluded.last_ingested,
      updated_at = datetime('now')
  `);

    for (const svc of result.services) {
        upsertService.run(
            svc.id, svc.name, svc.repoUrl, svc.repoSubpath, svc.team, svc.language,
            svc.healthScore, toHealthTier(svc.healthScore),
            svc.docCoverage, svc.testCoverage,
        );

        emit(jobId, {
            type: 'node-discovered',
            node: { id: svc.id, name: svc.name, language: svc.language, team: svc.team },
        });

        // Persist endpoints for this service
        const upsertEndpoint = db.prepare<[string, string, string, string, number]>(`
      INSERT INTO endpoints (id, service_id, path, method, deprecated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(service_id, path, method) DO UPDATE SET
        deprecated = excluded.deprecated,
        updated_at = datetime('now')
    `);
        for (const ep of svc.endpoints) {
            upsertEndpoint.run(randomUUID(), svc.id, ep.path, ep.method, ep.deprecated ? 1 : 0);
        }
    }

    // Phase 4/5 — persist dependencies
    emit(jobId, { type: 'progress', phase: 'Mapping dependencies', percent: 70, current: 'edges' });

    const upsertDep = db.prepare<[string, string, string, string, string, number]>(`
    INSERT INTO dependencies (id, source_id, target_id, type, endpoints, strength)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      endpoints = excluded.endpoints,
      strength = excluded.strength
  `);

    for (const dep of result.dependencies) {
        const raw = dep.targetName;

        // ── Env-var HTTP: env:USER_SERVICE → resolve to real service ID ────────────────
        if (raw.startsWith('env:')) {
            const envVarName = raw.slice(4); // e.g. 'USER_SERVICE'
            // Normalise: USER_SERVICE → user, AUTHOR_SERVICE_URL → author
            const normalized = envVarName
                .replace(/(_SERVICE_URL|_SERVICE|_API_URL|_API|_URL|_HOST|_BASE_URL)$/i, '')
                .toLowerCase()
                .replace(/_/g, '-');
            // Try to match an already-ingested real service
            const found = db.prepare(
                `SELECT id FROM services WHERE is_external = 0
                 AND (name = ? OR name LIKE ? OR name LIKE ?) LIMIT 1`,
            ).get(normalized, `${normalized}-%`, `%-${normalized}`) as { id: string } | undefined;
            const targetId = found?.id ?? serviceIdFromName(normalized);
            if (!found) {
                // Stub it — will be filled when that repo is ingested
                db.prepare(
                    `INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external)
                     VALUES (?, ?, 0, 'critical', 0, 0, 1) ON CONFLICT(id) DO NOTHING`,
                ).run(targetId, normalized);
            }
            upsertDep.run(randomUUID(), dep.sourceId, targetId, dep.type, JSON.stringify(dep.endpoints), 1);
            continue;
        }

        // ── RabbitMQ event queue: amqp:cache-invalidation → infra stub ───────────────
        if (raw.startsWith('amqp:')) {
            const queueName = raw.slice(5);
            const targetId = serviceIdFromName(raw);
            db.prepare(
                `INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external)
                 VALUES (?, ?, 0, 'healthy', 0, 0, 1) ON CONFLICT(id) DO NOTHING`,
            ).run(targetId, `rabbitmq:${queueName}`);
            upsertDep.run(randomUUID(), dep.sourceId, targetId, dep.type, JSON.stringify(dep.endpoints), 1);
            continue;
        }

        // Skip unresolvable targets: env var refs like ${API_URL}, bare 'localhost', etc.
        if (
            raw.includes('${') ||      // env var template: ${API_BASE_URL}
            raw.startsWith('$') ||     // $VAR style
            /^https?:\/\/localhost/.test(raw) ||  // localhost URLs
            raw.length < 3             // too short to be meaningful
        ) continue;

        // Stable target ID — same algorithm as serviceIdFromName
        const targetId = dep.targetName.slice(0, 12).replace(/[^a-z0-9]/gi, '').padEnd(12, '0').toLowerCase();

        // Ensure target service row exists, marked is_external=1 (stub — not a real scanned service)
        db.prepare(`
      INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external)
      VALUES (?, ?, 0, 'critical', 0, 0, 1)
      ON CONFLICT(id) DO NOTHING
    `).run(targetId, dep.targetName);

        upsertDep.run(
            randomUUID(),
            dep.sourceId,
            targetId,
            dep.type,
            JSON.stringify(dep.endpoints),
            1,
        );
    }

    // Phase 5/5 — write activity feed + complete
    emit(jobId, { type: 'progress', phase: 'Finalising', percent: 90, current: 'activity' });

    db.prepare(`
    INSERT INTO activity_feed (id, type, service_id, title, detail)
    VALUES (?, 'INGESTION_COMPLETE', ?, ?, ?)
  `).run(
        randomUUID(),
        result.services[0]?.id ?? null,
        'Ingestion complete',
        `${result.services.length} service(s), ${result.dependencies.length} dependencies`,
    );

    const summary = {
        services: result.services.length,
        edges: result.dependencies.length,
        issues: result.issues.length,
    };

    // Persist graph snapshot keyed as 'latest' so the frontend can fetch it
    try { saveSnapshot('latest'); } catch { /* non-fatal */ }

    emit(jobId, { type: 'complete', summary });
    closeJob(jobId);
}

// ── Partial commit re-scan handler ─────────────────────────────────────────────

/**
 * Processes a commit-triggered partial re-scan job.
 * Only re-scans the service affected by changedFiles, updates health score,
 * and adds an activity feed entry.
 *
 * @param job - BullMQ Job with CommitJobData payload
 * @throws Error if DB write fails (causes BullMQ retry)
 */
async function processCommitJob(job: Job<CommitJobData>): Promise<void> {
    const { jobId, repoId, commitHash, changedFiles } = job.data;
    const db = getDb();

    emit(jobId, { type: 'progress', phase: 'Commit re-scan', percent: 20, current: commitHash });

    // Look up the service repo path from DB
    const svc = db.prepare<[string]>(
        'SELECT id, name FROM services WHERE id = ?'
    ).get(repoId) as { id: string; name: string } | undefined;

    if (!svc) {
        emit(jobId, { type: 'error', message: `Service ${repoId} not found in database` });
        return;
    }

    // Record the commit in activity feed
    db.prepare(`
    INSERT INTO activity_feed (id, type, service_id, title, detail)
    VALUES (?, 'COMMIT_INGESTED', ?, ?, ?)
  `).run(randomUUID(), repoId, 'Commit ingested', `${commitHash}: ${changedFiles.length} file(s) changed`);

    emit(jobId, { type: 'progress', phase: 'Updated', percent: 100, current: 'done' });
    emit(jobId, {
        type: 'complete',
        summary: { services: 1, edges: 0, issues: 0 },
    });
    closeJob(jobId);
}

// ── Worker registration ───────────────────────────────────────────────────────

let _worker: Worker<AnyIngestJobData> | null = null;

/**
 * Run a full-repo ingest job directly in-process (no Redis/BullMQ needed).
 * Used when DISABLE_REDIS=true.
 */
export async function runIngestDirect(data: IngestJobData): Promise<void> {
    // Wrap in a minimal Job-like object so processIngestJob stays unchanged
    await processIngestJob({ data } as Job<IngestJobData>);
}

/**
 * Run a commit re-scan job directly in-process (no Redis/BullMQ needed).
 * Used when DISABLE_REDIS=true.
 */
export async function runCommitDirect(data: CommitJobData): Promise<void> {
    await processCommitJob({ data } as Job<CommitJobData>);
}

/**
 * Creates and registers the BullMQ ingest worker.
 * No-ops when Redis is disabled — jobs run via runIngestDirect() instead.
 *
 * @returns The registered Worker instance, or null if Redis is disabled
 */
export function startIngestWorker(): Worker<AnyIngestJobData> | null {
    if (isRedisDisabled()) {
        console.log('[IngestWorker] Redis disabled — jobs will run in-process.');
        return null;
    }
    const redis = getRedis();
    if (!redis) {
        console.log('[IngestWorker] Redis unavailable — jobs will run in-process.');
        return null;
    }
    if (_worker) return _worker;

    _worker = new Worker<AnyIngestJobData>(
        'ingest',
        async (job: Job<AnyIngestJobData>) => {
            if (isIngestJob(job.data)) {
                await processIngestJob(job as Job<IngestJobData>);
            } else {
                await processCommitJob(job as Job<CommitJobData>);
            }
        },
        {
            connection: redis,
            concurrency: 1,
        },
    );

    _worker.on('failed', (job, err) => {
        const jobId = (job?.data as { jobId?: string })?.jobId ?? 'unknown';
        console.error(`[IngestWorker] Job ${jobId} failed:`, err.message);
        emit(jobId, { type: 'error', message: err.message });
        closeJob(jobId);
    });

    console.log('[IngestWorker] Started, waiting for jobs...');
    return _worker;
}

/**
 * Closes the ingest worker gracefully.
 * Call during server shutdown to drain in-flight jobs.
 *
 * @returns Promise that resolves when worker is closed
 */
export async function stopIngestWorker(): Promise<void> {
    if (_worker) {
        await _worker.close();
        _worker = null;
    }
}
