/**
 * Seed Service — auto-clones and scans a GitHub repo on server startup.
 *
 * Reads SEED_REPO_URL from env. If the local clone already exists it does a
 * `git pull` (fast-forward) so the graph stays fresh across restarts.
 *
 * The scan result is persisted into SQLite via the same upsert logic used by
 * POST /api/scanner/scan, so the graph + snapshot are immediately queryable.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { scanMonorepo, serviceIdFromName } from './scannerService.js';
import { getDb } from '../db/index.js';
import { saveSnapshot } from './graphService.js';
import type { HealthTier } from '../types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toHealthTier(score: number): HealthTier {
    if (score >= 75) return 'healthy';
    if (score >= 50) return 'warning';
    return 'critical';
}

/**
 * Derives a safe local directory name from a GitHub URL.
 * e.g. "https://github.com/HarshXAI/vesper" → "HarshXAI-vesper"
 */
function repoSlug(repoUrl: string): string {
    return repoUrl
        .replace(/https?:\/\/github\.com\//, '')
        .replace(/\.git$/, '')
        .replace(/\//g, '-');
}

/**
 * Clones or pulls the repo into <tmpDir>/kachow-seeds/<slug>.
 * Returns the absolute path to the local clone.
 */
function cloneOrPull(repoUrl: string): string {
    const slug = repoSlug(repoUrl);
    const seedsDir = path.join(os.tmpdir(), 'kachow-seeds');
    const cloneDir = path.join(seedsDir, slug);

    if (!fs.existsSync(seedsDir)) fs.mkdirSync(seedsDir, { recursive: true });

    if (fs.existsSync(path.join(cloneDir, '.git'))) {
        console.log(`[Seed] Pulling latest for ${slug}...`);
        try {
            execSync('git pull --ff-only', { cwd: cloneDir, stdio: 'pipe' });
        } catch {
            // Non-fast-forward or dirty — just continue with what we have
            console.warn('[Seed] git pull skipped (non-ff or dirty tree) — using existing clone.');
        }
    } else {
        console.log(`[Seed] Cloning ${repoUrl} → ${cloneDir}`);
        fs.mkdirSync(cloneDir, { recursive: true });
        execSync(`git clone --depth=1 "${repoUrl}" "${cloneDir}"`, { stdio: 'pipe' });
    }

    return cloneDir;
}

// ── Core reusable pipeline ────────────────────────────────────────────────────

export interface IngestFromUrlResult {
    services: number;
    deps: number;
    issues: number;
    repoUrl: string;
    teamId: string | null;
}

/**
 * Clones/pulls a GitHub repo, scans it, and upserts the result into SQLite.
 * Shared by `seedOnStartup()` (env-var driven) and the POST /api/ingest/github route.
 *
 * @param repoUrl   - Full GitHub HTTPS URL to clone/scan
 * @param teamName  - Optional team name to tag all ingested services with
 * @param teamId    - Optional team ID for multi-tenant scoping
 */
export async function ingestFromUrl(repoUrl: string, teamName?: string, teamId?: string): Promise<IngestFromUrlResult> {
    console.log(`\n[Seed] 🌱 Ingesting from ${repoUrl}${teamId ? ` (team: ${teamId})` : ''}`);

    const cloneDir = cloneOrPull(repoUrl);   // throws on git error

    const result = scanMonorepo(cloneDir, repoUrl);
    const db = getDb();

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
        INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external, team_id)
        VALUES (?, ?, 0, 'critical', 0, 0, 1, ?)
        ON CONFLICT(id) DO NOTHING
    `);

    for (const svc of result.services) {
        upsertService.run(
            svc.id, svc.name, svc.repoUrl, svc.repoSubpath, svc.team,
            teamId ?? null,
            svc.language,
            svc.healthScore, toHealthTier(svc.healthScore),
            svc.docCoverage, svc.testCoverage, svc.lastCommit,
        );
        for (const ep of svc.endpoints) {
            upsertEndpoint.run(randomUUID(), svc.id, ep.path, ep.method, ep.deprecated ? 1 : 0);
        }
    }

    for (const dep of result.dependencies) {
        const raw = dep.targetName;
        let targetId: string;

        if (raw.startsWith('env:')) {
            const envVar = raw.slice(4);
            const name = envVar
                .replace(/(_SERVICE_URL|_SERVICE|_API_URL|_API|_URL|_HOST|_BASE_URL)$/i, '')
                .toLowerCase().replace(/_/g, '-');
            const found = db.prepare(
                `SELECT id FROM services WHERE is_external = 0
                 AND (name = ? OR name LIKE ? OR name LIKE ?) LIMIT 1`,
            ).get(name, `${name}-%`, `%-${name}`) as { id: string } | undefined;
            targetId = found?.id ?? serviceIdFromName(name);
            if (!found) upsertStub.run(targetId, name, teamId ?? null);

        } else if (raw.startsWith('amqp:') || raw.startsWith('kafka:') || raw.startsWith('nats:')) {
            targetId = serviceIdFromName(raw);
            const label = raw.replace('amqp:', 'rabbitmq:');
            db.prepare(
                `INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external, language, team_id)
                 VALUES (?, ?, 100, 'healthy', 0, 0, 1, 'infra', ?)
                 ON CONFLICT(id) DO NOTHING`,
            ).run(targetId, label, teamId ?? null);

        } else if (raw.startsWith('infra:')) {
            targetId = serviceIdFromName(raw);
            db.prepare(
                `INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external, language, team_id)
                 VALUES (?, ?, 100, 'healthy', 0, 0, 1, 'infra', ?)
                 ON CONFLICT(id) DO NOTHING`,
            ).run(targetId, raw.slice(6), teamId ?? null);

        } else if (
            raw.includes('${') || raw.startsWith('$') ||
            /^https?:\/\/localhost/.test(raw) || raw.length < 3
        ) {
            continue;

        } else {
            const norm = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
            const found = db.prepare(
                `SELECT id FROM services WHERE is_external = 0
                 AND (id = ? OR name = ? OR name LIKE ?) LIMIT 1`,
            ).get(norm, norm, `%${norm}%`) as { id: string } | undefined;
            targetId = found?.id ?? norm.slice(0, 12).padEnd(12, '0');
            if (!found) upsertStub.run(targetId, raw, teamId ?? null);
        }

        if (targetId === dep.sourceId) continue;

        try {
            upsertDep.run(
                randomUUID(), dep.sourceId, targetId, dep.type,
                JSON.stringify(dep.endpoints), 1,
            );
        } catch { /* duplicate edge — ignore */ }
    }

    db.prepare(`
        INSERT INTO activity_feed (id, type, service_id, team_id, title, detail)
        VALUES (?, 'SCAN_COMPLETE', ?, ?, 'Ingest complete', ?)
    `).run(
        randomUUID(),
        result.services[0]?.id ?? null,
        teamId ?? null,
        `${result.services.length} services · ${result.dependencies.length} deps · ${result.issues.length} issues (source: ${repoUrl})`,
    );

    // If a teamName was supplied, stamp every ingested service with it
    if (teamName) {
        if (teamId) {
            db.prepare(`UPDATE services SET team = ? WHERE team_id = ?`).run(teamName, teamId);
        } else {
            db.prepare(`UPDATE services SET team = ? WHERE repo_url = ?`).run(teamName, repoUrl);
        }
        console.log(`[Seed] 🏷  Tagged all services from ${repoUrl} with team "${teamName}"`);
    }

    try { saveSnapshot('latest', teamId); } catch { /* non-fatal */ }

    console.log(`[Seed] ✅ Done — ${result.services.length} services, ${result.dependencies.length} deps, ${result.issues.length} issues`);
    return { services: result.services.length, deps: result.dependencies.length, issues: result.issues.length, repoUrl, teamId: teamId ?? null };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Called once after the server starts listening.
 * Reads SEED_REPO_URL, clones/pulls the repo, scans it, and persists the
 * result into the SQLite knowledge graph.
 *
 * If SEED_REPO_URL is not set, this is a silent no-op.
 * If the repo is already present and unchanged, the upserts are idempotent.
 */
export async function seedOnStartup(): Promise<void> {
    const repoUrl = process.env.SEED_REPO_URL;
    if (!repoUrl) return;
    try {
        await ingestFromUrl(repoUrl);
    } catch (e) {
        console.error('[Seed] Auto-seed failed:', e instanceof Error ? e.message : e);
    }
}
