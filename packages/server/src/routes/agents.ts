/**
 * Agent routes — Phase 10: Deep Analysis Engine.
 *
 * POST   /api/agents/analyze        — Trigger deep analysis on a repo
 * GET    /api/agents/knowledge-graph — Get latest knowledge graph
 * GET    /api/agents/analyses        — Get agent analysis history
 * GET    /api/agents/status          — Quick status check
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { runDeepAnalysis, getLatestKnowledgeGraph, getAgentAnalyses } from '../services/agentService.js';
import { scanMonorepo, serviceIdFromName } from '../services/scannerService.js';
import { saveSnapshot } from '../services/graphService.js';
import { getDb } from '../db/index.js';
import { ok, err } from '../types/index.js';
import type { HealthTier } from '../types/index.js';

const router: ExpressRouter = Router();

// ── POST /api/agents/analyze ──────────────────────────────────────────────────

const AnalyzeBodySchema = z.object({
    repoPath: z.string().min(1, 'repoPath is required'),
    repoUrl: z.string().url().optional(),
    team: z.string().optional(),
});

router.post('/analyze', async (req: Request, res: Response): Promise<void> => {
    const parse = AnalyzeBodySchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(
            parse.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
        ));
        return;
    }

    const { repoPath, repoUrl, team } = parse.data;

    try {
        // Step 1: Run the normal scanner first to discover services
        console.log('[Agents] Step 1: Running scanner...');
        const scanResult = scanMonorepo(repoPath, repoUrl, team);

        // Persist scanner results to DB (same as scanner route)
        const db = getDb();
        const toTier = (s: number): HealthTier => s >= 75 ? 'healthy' : s >= 50 ? 'warning' : 'critical';

        const upsertService = db.prepare(`
            INSERT INTO services (id, name, repo_url, repo_subpath, team, language,
              health_score, health_tier, doc_coverage, test_coverage, last_commit, last_ingested)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, repo_url=excluded.repo_url, repo_subpath=excluded.repo_subpath,
              team=excluded.team, language=excluded.language, health_score=excluded.health_score,
              health_tier=excluded.health_tier, doc_coverage=excluded.doc_coverage,
              test_coverage=excluded.test_coverage, last_commit=excluded.last_commit,
              last_ingested=excluded.last_ingested, updated_at=datetime('now')
        `);
        const upsertEndpoint = db.prepare(`
            INSERT INTO endpoints (id, service_id, path, method, deprecated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(service_id, path, method) DO UPDATE SET deprecated=excluded.deprecated, updated_at=datetime('now')
        `);

        for (const svc of scanResult.services) {
            upsertService.run(
                svc.id, svc.name, svc.repoUrl, svc.repoSubpath, svc.team ?? team ?? null,
                svc.language, svc.healthScore, toTier(svc.healthScore),
                svc.docCoverage, svc.testCoverage, svc.lastCommit,
            );
            for (const ep of svc.endpoints) {
                upsertEndpoint.run(randomUUID(), svc.id, ep.path, ep.method, ep.deprecated ? 1 : 0);
            }
        }

        // Build service roots for deep analysis
        const serviceRoots = scanResult.services
            .filter((s) => s.language !== 'infra') // skip infra stubs from scanner
            .map((s) => ({
                id: s.id,
                name: s.name,
                language: s.language,
                dir: s.repoPath,
            }));

        if (serviceRoots.length === 0) {
            res.status(400).json(err('No services found to analyze. Run /api/scanner/scan first.'));
            return;
        }

        // Step 2: Run deep analysis with LLM agents
        console.log(`[Agents] Step 2: Deep analysis on ${serviceRoots.length} services...`);
        const analysisResult = await runDeepAnalysis(repoPath, serviceRoots);

        // Save a fresh snapshot
        try { saveSnapshot('latest'); } catch { /* non-fatal */ }

        res.json(ok({
            analysisId: analysisResult.analysisId,
            servicesAnalyzed: analysisResult.servicesAnalyzed,
            totalFindings: analysisResult.totalFindings,
            knowledgeGraph: {
                nodes: analysisResult.orchestratorResult.nodes.length,
                edges: analysisResult.orchestratorResult.edges.length,
                layers: analysisResult.orchestratorResult.architecture.layers.length,
                dataFlows: analysisResult.orchestratorResult.architecture.dataFlows.length,
                selfHealingSuggestions: analysisResult.orchestratorResult.selfHealingSuggestions.length,
            },
            agentBreakdown: analysisResult.agentResults.map((r) => ({
                agent: r.agentName,
                service: r.serviceName,
                findings: r.findings.length,
                durationMs: r.durationMs,
            })),
            totalDurationMs: analysisResult.totalDurationMs,
            summary: analysisResult.orchestratorResult.summary,
        }));
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Deep analysis failed';
        console.error('[Agents] Error:', msg);
        res.status(500).json(err(msg));
    }
});

// ── GET /api/agents/knowledge-graph ───────────────────────────────────────────

router.get('/knowledge-graph', (_req: Request, res: Response): void => {
    try {
        const kg = getLatestKnowledgeGraph();
        if (!kg) {
            res.json(ok({
                nodes: [], edges: [],
                architecture: { layers: [], dataFlows: [] },
                selfHealingSuggestions: [],
                summary: 'No deep analysis has been run yet. POST /api/agents/analyze to start.',
            }));
            return;
        }
        res.json(ok(kg));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get knowledge graph'));
    }
});

// ── GET /api/agents/analyses ──────────────────────────────────────────────────

router.get('/analyses', (req: Request, res: Response): void => {
    try {
        const analysisId = req.query.analysisId as string | undefined;
        const analyses = getAgentAnalyses(analysisId);
        res.json(ok(analyses));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get analyses'));
    }
});

// ── GET /api/agents/status ────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response): void => {
    try {
        const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_key_here');
        const kg = getLatestKnowledgeGraph();
        res.json(ok({
            openaiConfigured: hasKey,
            hasKnowledgeGraph: !!kg,
            nodeCount: kg?.nodes.length ?? 0,
            edgeCount: kg?.edges.length ?? 0,
            agents: [
                'db-agent', 'routing-agent', 'dependency-agent', 'infra-agent',
                'cicd-agent', 'schema-agent', 'security-agent', 'test-agent',
            ],
        }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get status'));
    }
});

export { router as agentRouter };
