/**
 * Scanner routes.
 *
 * GET    /api/scanner/status  — DB stats (service counts, last scan)
 * POST   /api/scanner/scan    — Sync monorepo scan → persist to DB, return summary
 * DELETE /api/scanner/reset   — Wipe all scanned data (ready for fresh import)
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { scanMonorepo, serviceIdFromName } from '../services/scannerService.js';
import { getDb } from '../db/index.js';
import { saveSnapshot } from '../services/graphService.js';
import { ok, err } from '../types/index.js';
import type { HealthTier } from '../types/index.js';

const router: ExpressRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function toHealthTier(score: number): HealthTier {
    if (score >= 75) return 'healthy';
    if (score >= 50) return 'warning';
    return 'critical';
}

function count(sql: string): number {
    const db = getDb();
    return (db.prepare(sql).get() as { c: number }).c;
}

// ── GET /api/scanner/status ───────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response): void => {
    try {
        const db = getDb();
        const lastScan = (db.prepare(
            `SELECT MAX(last_ingested) as ts FROM services WHERE is_external = 0`,
        ).get() as { ts: string | null }).ts;

        const services = (db.prepare(
            `SELECT id, name, language, health_tier, health_score, team, repo_url FROM services WHERE is_external = 0 ORDER BY health_score ASC`,
        ).all() as Array<{ id: string; name: string; language: string; health_tier: string; health_score: number; team: string | null; repo_url: string | null }>);

        res.json(ok({
            totalServices: count(`SELECT COUNT(*) as c FROM services WHERE is_external = 0`),
            externalStubs: count(`SELECT COUNT(*) as c FROM services WHERE is_external = 1`),
            dependencies: count(`SELECT COUNT(*) as c FROM dependencies`),
            endpoints: count(`SELECT COUNT(*) as c FROM endpoints`),
            healthy: count(`SELECT COUNT(*) as c FROM services WHERE health_tier = 'healthy'  AND is_external = 0`),
            warning: count(`SELECT COUNT(*) as c FROM services WHERE health_tier = 'warning'  AND is_external = 0`),
            critical: count(`SELECT COUNT(*) as c FROM services WHERE health_tier = 'critical' AND is_external = 0`),
            lastScan,
            services,
        }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get scanner status'));
    }
});

// ── DELETE /api/scanner/reset ─────────────────────────────────────────────────

router.delete('/reset', (_req: Request, res: Response): void => {
    try {
        const db = getDb();
        // Wipe in FK-safe order
        db.exec(`
            DELETE FROM activity_feed;
            DELETE FROM qa_sessions;
            DELETE FROM healing_prs;
            DELETE FROM adrs;
            DELETE FROM impact_analyses;
            DELETE FROM endpoints;
            DELETE FROM dependencies;
            DELETE FROM services;
            DELETE FROM snapshots;
            DELETE FROM incidents;
        `);
        res.json(ok({ cleared: true, message: 'All data cleared — ready for fresh scan.' }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to reset database'));
    }
});

// ── POST /api/scanner/scan ────────────────────────────────────────────────────

const ScanBodySchema = z.object({
    repoPath: z.string().min(1, 'repoPath is required'),
    repoUrl: z.string().url('repoUrl must be a valid URL').optional(),
    team: z.string().optional(),
    teamId: z.string().optional(),
});

router.post('/scan', async (req: Request, res: Response): Promise<void> => {
    const parse = ScanBodySchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(
            parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
        ));
        return;
    }

    const { repoPath, repoUrl, team, teamId } = parse.data;

    try {
        // Run full monorepo scan (sync)
        const result = scanMonorepo(repoPath, repoUrl, team);
        const db = getDb();

        // ── Persist services ──────────────────────────────────────────────────
        const upsertService = db.prepare(`
            INSERT INTO services
              (id, name, repo_url, repo_subpath, team, team_id, language, health_score, health_tier,
               doc_coverage, test_coverage, last_commit, last_ingested)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              name          = excluded.name,
              repo_url      = excluded.repo_url,
              repo_subpath  = excluded.repo_subpath,
              team          = excluded.team,
              team_id       = excluded.team_id,
              language      = excluded.language,
              health_score  = excluded.health_score,
              health_tier   = excluded.health_tier,
              doc_coverage  = excluded.doc_coverage,
              test_coverage = excluded.test_coverage,
              last_commit   = excluded.last_commit,
              last_ingested = excluded.last_ingested,
              updated_at    = datetime('now')
        `);

        const upsertEndpoint = db.prepare(`
            INSERT INTO endpoints (id, service_id, path, method, deprecated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(service_id, path, method) DO UPDATE SET
              deprecated = excluded.deprecated,
              updated_at = datetime('now')
        `);

        const upsertDep = db.prepare(`
            INSERT INTO dependencies (id, source_id, target_id, type, endpoints, strength)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, target_id, type) DO UPDATE SET
              endpoints = excluded.endpoints,
              strength  = strength + 1
        `);

        const upsertStub = db.prepare(`
            INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external)
            VALUES (?, ?, 0, 'critical', 0, 0, 1)
            ON CONFLICT(id) DO NOTHING
        `);

        for (const svc of result.services) {
            upsertService.run(
                svc.id, svc.name, svc.repoUrl, svc.repoSubpath, svc.team ?? team ?? null,
                teamId ?? null,
                svc.language,
                svc.healthScore, toHealthTier(svc.healthScore),
                svc.docCoverage, svc.testCoverage, svc.lastCommit,
            );
            for (const ep of svc.endpoints) {
                upsertEndpoint.run(randomUUID(), svc.id, ep.path, ep.method, ep.deprecated ? 1 : 0);
            }
        }

        // ── Persist dependencies ──────────────────────────────────────────────
        for (const dep of result.dependencies) {
            const raw = dep.targetName;
            let targetId: string;

            if (raw.startsWith('env:')) {
                // env:USER_SERVICE → normalise → match real service
                const envVar = raw.slice(4);
                const name = envVar
                    .replace(/(_SERVICE_URL|_SERVICE|_API_URL|_API|_URL|_HOST|_BASE_URL)$/i, '')
                    .toLowerCase().replace(/_/g, '-');
                const found = db.prepare(
                    `SELECT id FROM services WHERE is_external = 0
                     AND (name = ? OR name LIKE ? OR name LIKE ?) LIMIT 1`,
                ).get(name, `${name}-%`, `%-${name}`) as { id: string } | undefined;
                targetId = found?.id ?? serviceIdFromName(name);
                if (!found) upsertStub.run(targetId, name);

            } else if (raw.startsWith('amqp:') || raw.startsWith('kafka:') || raw.startsWith('nats:')) {
                targetId = serviceIdFromName(raw);
                const label = raw.replace('amqp:', 'rabbitmq:').replace('nats:', 'nats:');
                db.prepare(
                    `INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external, language)
                     VALUES (?, ?, 100, 'healthy', 0, 0, 1, 'infra')
                     ON CONFLICT(id) DO NOTHING`,
                ).run(targetId, label);

            } else if (raw.startsWith('infra:')) {
                targetId = serviceIdFromName(raw);
                db.prepare(
                    `INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external, language)
                     VALUES (?, ?, 100, 'healthy', 0, 0, 1, 'infra')
                     ON CONFLICT(id) DO NOTHING`,
                ).run(targetId, raw.slice(6));

            } else if (
                raw.includes('${') || raw.startsWith('$') ||
                /^https?:\/\/localhost/.test(raw) || raw.length < 3
            ) {
                continue;

            } else {
                // Try to match an ingested service by name or id
                const norm = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
                const found = db.prepare(
                    `SELECT id FROM services WHERE is_external = 0
                     AND (id = ? OR name = ? OR name LIKE ?) LIMIT 1`,
                ).get(norm, norm, `%${norm}%`) as { id: string } | undefined;
                targetId = found?.id ?? norm.slice(0, 12).padEnd(12, '0');
                if (!found) upsertStub.run(targetId, raw);
            }

            // Skip self-loops
            if (targetId === dep.sourceId) continue;

            try {
                upsertDep.run(
                    randomUUID(), dep.sourceId, targetId, dep.type,
                    JSON.stringify(dep.endpoints), 1,
                );
            } catch { /* duplicate edge — ignore */ }
        }

        // ── Activity feed + snapshot ──────────────────────────────────────────
        db.prepare(`
            INSERT INTO activity_feed (id, type, service_id, title, detail)
            VALUES (?, 'SCAN_COMPLETE', ?, 'Scan complete', ?)
        `).run(
            randomUUID(),
            result.services[0]?.id ?? null,
            `${result.services.length} services · ${result.dependencies.length} deps · ${result.issues.length} issues`,
        );

        try { saveSnapshot('latest'); } catch { /* non-fatal */ }

        res.json(ok({
            scanned: result.services.length,
            dependencies: result.dependencies.length,
            issueCount: result.issues.length,
            issues: result.issues.slice(0, 20),   // cap so response stays small
            services: result.services.map((s) => ({
                id: s.id,
                name: s.name,
                language: s.language,
                health: s.healthScore,
                tier: toHealthTier(s.healthScore),
                subpath: s.repoSubpath,
            })),
        }));

    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Scan failed';
        console.error('[Scanner] scan error:', msg);
        res.status(500).json(err(msg));
    }
});

export { router as scannerRouter };
