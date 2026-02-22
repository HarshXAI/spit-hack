/**
 * Manager intelligence service — Phase 8.
 * Provides VP-level health summaries via OpenAI, team breakdowns,
 * ADR decision history, and role-based onboarding paths.
 */

import OpenAI from 'openai';
import { getDb } from '../db/index.js';
import { getNodes, getEdges, getSystemHealth } from './graphService.js';

// ── Manager pulse ─────────────────────────────────────────────────────────────

export interface ManagerPulse {
    overallScore: number;
    plainEnglishSummary: string;
    topIssues: Array<{ serviceId: string; serviceName: string; healthScore: number; healthTier: string }>;
    teamBreakdown: Array<{ team: string; serviceCount: number; avgHealth: number; criticalCount: number }>;
}

/**
 * Returns a VP-level pulse summary using OpenAI for the plain-English description.
 */
export async function getManagerPulse(): Promise<ManagerPulse> {
    const health = getSystemHealth();
    const nodes = getNodes();
    const db = getDb();

    const criticalNames = nodes.filter(n => n.healthTier === 'critical').map(n => n.name);
    const warningNames = nodes.filter(n => n.healthTier === 'warning').map(n => n.name);

    let plainEnglishSummary = `System health is at ${health.overallScore}/100 with ${health.critical} critical and ${health.warning} warning services.`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
        try {
            const openai = new OpenAI({ apiKey });
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: `You are briefing a VP of Engineering. In exactly 2-3 sentences, summarize: Overall score ${health.overallScore}/100. Services: ${health.totalServices} total, ${health.critical} critical (${criticalNames.join(', ') || 'none'}), ${health.warning} warning (${warningNames.join(', ') || 'none'}), ${health.healthy} healthy. Be direct and action-oriented.`,
                }],
                temperature: 0.2,
                max_tokens: 150,
            });
            plainEnglishSummary = completion.choices[0]?.message?.content?.trim() ?? plainEnglishSummary;
        } catch {
            // Fallback to static summary
        }
    }

    const teams = db.prepare<[]>(`
        SELECT team,
               COUNT(*)                                                         AS svc_count,
               ROUND(AVG(health_score), 0)                                      AS avg_health,
               SUM(CASE WHEN health_tier = 'critical' THEN 1 ELSE 0 END)       AS critical_count
        FROM services WHERE is_external = 0
        GROUP BY team
        ORDER BY avg_health ASC
    `).all() as Array<{ team: string | null; svc_count: number; avg_health: number; critical_count: number }>;

    const topIssues = nodes
        .filter(n => n.healthTier !== 'healthy')
        .sort((a, b) => a.healthScore - b.healthScore)
        .slice(0, 5)
        .map(n => ({
            serviceId: n.id,
            serviceName: n.name,
            healthScore: n.healthScore,
            healthTier: n.healthTier,
        }));

    return {
        overallScore: health.overallScore,
        plainEnglishSummary,
        topIssues,
        teamBreakdown: teams.map(t => ({
            team: t.team ?? 'unassigned',
            serviceCount: t.svc_count,
            avgHealth: t.avg_health,
            criticalCount: t.critical_count,
        })),
    };
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export function getManagerTeams() {
    const db = getDb();
    return (db.prepare<[]>(`
        SELECT team,
               COUNT(*) AS svc_count,
               ROUND(AVG(health_score), 0) AS avg_health,
               SUM(CASE WHEN health_tier = 'critical' THEN 1 ELSE 0 END) AS critical_count
        FROM services WHERE is_external = 0
        GROUP BY team ORDER BY avg_health ASC
    `).all() as Array<{ team: string | null; svc_count: number; avg_health: number; critical_count: number }>)
        .map(t => ({
            team: t.team ?? 'unassigned',
            serviceCount: t.svc_count,
            avgHealth: t.avg_health,
            criticalCount: t.critical_count,
        }));
}

// ── Decisions (ADRs) ──────────────────────────────────────────────────────────

export function getManagerDecisions() {
    const db = getDb();
    return (db.prepare<[]>(`
        SELECT a.id, a.title, a.status, a.created_at,
               ia.trigger_ref, ia.risk_score, ia.trigger_type
        FROM adrs a
        JOIN impact_analyses ia ON ia.id = a.analysis_id
        ORDER BY a.created_at DESC LIMIT 20
    `).all() as Array<{
        id: string; title: string; status: string; created_at: string;
        trigger_ref: string; risk_score: number; trigger_type: string;
    }>).map(a => ({
        id: a.id,
        title: a.title,
        status: a.status,
        riskScore: a.risk_score,
        triggerRef: a.trigger_ref,
        triggerType: a.trigger_type,
        createdAt: a.created_at,
    }));
}

// ── Onboarding path ───────────────────────────────────────────────────────────

/**
 * Generates a role-specific onboarding learning path.
 * Orders services based on the engineer's role focus.
 */
export function getOnboardingPath(role: string) {
    const db = getDb();
    const nodes = getNodes();
    const edges = getEdges();

    const outDegree: Record<string, number> = {};
    for (const e of edges) {
        outDegree[e.sourceId] = (outDegree[e.sourceId] ?? 0) + 1;
    }

    let ordered = [...nodes];

    if (role === 'backend-engineer') {
        // High out-degree first (most connected / most impactful)
        ordered = ordered.sort((a, b) => (outDegree[b.id] ?? 0) - (outDegree[a.id] ?? 0));
    } else if (role === 'sre') {
        // Worst health first — focus on fires
        ordered = ordered.sort((a, b) => a.healthScore - b.healthScore);
    } else if (role === 'engineering-manager') {
        // By team, then by health
        ordered = ordered.sort((a, b) => {
            const teamCmp = (a.team ?? 'zzz').localeCompare(b.team ?? 'zzz');
            return teamCmp !== 0 ? teamCmp : a.healthScore - b.healthScore;
        });
    }

    return {
        role,
        steps: ordered.slice(0, 8).map((n, i) => {
            const svcRow = db.prepare<[string]>('SELECT repo_url FROM services WHERE id = ?').get(n.id) as { repo_url: string | null } | undefined;
            const endpoints = db.prepare<[string]>('SELECT method, path FROM endpoints WHERE service_id = ? LIMIT 5').all(n.id) as Array<{ method: string; path: string }>;
            const deps = edges.filter(e => e.sourceId === n.id).length;

            return {
                step: i + 1,
                serviceId: n.id,
                title: `Understand ${n.name}`,
                description: `${n.name} is a ${n.language ?? 'service'}${n.team ? ` owned by the ${n.team} team` : ''}. Health: ${n.healthScore}/100 (${n.healthTier}). Makes ${deps} downstream call(s).`,
                keyFiles: [
                    `${n.name}/src/index.${n.language === 'python' ? 'py' : 'ts'}`,
                    `${n.name}/src/routes.${n.language === 'python' ? 'py' : 'ts'}`,
                    `${n.name}/README.md`,
                ],
                starterTasks: [
                    `Read the ${n.name} README`,
                    ...(endpoints.length > 0 ? [`Trace a request to ${endpoints[0].method} ${endpoints[0].path}`] : []),
                    `Run the ${n.name} test suite`,
                    ...(svcRow?.repo_url ? [`Clone and build ${n.name} locally`] : []),
                ].slice(0, 3),
                repoUrl: svcRow?.repo_url ?? null,
                estimatedMinutes: 30 + deps * 5,
            };
        }),
    };
}
