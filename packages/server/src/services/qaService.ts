/**
 * Q&A Engine — Phase 3.
 * Graph-aware RAG using OpenAI GPT-4o.
 * Builds rich context from the knowledge graph, queries OpenAI,
 * and returns structured answers with file:line citations.
 */

import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/index.js';
import { getNodes, getEdges, getSystemHealth } from './graphService.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QACitation {
    file: string;
    line: number;
    snippet: string;
    url: string | null;
}

export interface QAResult {
    id: string;
    question: string;
    answer: string;
    citations: QACitation[];
    relatedNodes: string[];
    suggestions: string[];
}

export interface QAHistoryItem {
    id: string;
    question: string;
    answer: string;
    citations: QACitation[];
    relatedNodes: string[];
    createdAt: string;
}

// ── File-tree helpers ─────────────────────────────────────────────────────────

/** Walk a directory and return relative paths of source files (max 200). */
function walkSourceFiles(dir: string, base = dir, results: string[] = []): string[] {
    if (results.length >= 200) return results;
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir)) {
        if (['node_modules', '.git', 'dist', 'build', '.next'].includes(entry)) continue;
        const full = path.join(dir, entry);
        const rel = path.relative(base, full);
        try {
            if (fs.statSync(full).isDirectory()) {
                walkSourceFiles(full, base, results);
            } else if (/\.(ts|tsx|js|jsx|py|go|java)$/.test(entry)) {
                results.push(rel);
            }
        } catch { /* skip */ }
    }
    return results;
}

/**
 * Given a GPT-hallucinated file path (e.g. "src/routes.ts") and the real list
 * of files in the service directory, return the closest real match.
 * Strategy: exact → basename match → longest common-suffix match.
 */
function bestFileMatch(hallucinated: string, realFiles: string[]): string {
    if (realFiles.includes(hallucinated)) return hallucinated;
    const base = path.basename(hallucinated);           // e.g. "routes.ts"
    const baseName = base.replace(/\.[^.]+$/, '');      // e.g. "routes"
    const ext = path.extname(base);                     // e.g. ".ts"

    // 1. Exact basename match
    const exactBase = realFiles.filter(f => path.basename(f) === base);
    if (exactBase.length === 1) return exactBase[0];

    // 2. Same name, any extension (e.g. routes.js → routes.ts)
    const sameNameAnyExt = realFiles.filter(f => path.basename(f, path.extname(f)) === baseName);
    if (sameNameAnyExt.length === 1) return sameNameAnyExt[0];

    // 3. Filename contains the base name (e.g. "routes" → "routes/blog.ts")
    const contains = realFiles.filter(f => {
        const parts = f.split('/');
        return parts.some(p => p.replace(/\.[^.]+$/, '') === baseName);
    });
    if (contains.length >= 1) return contains[0];

    // 4. Any file with matching extension, prefer shortest path
    const sameExt = realFiles.filter(f => path.extname(f) === ext)
        .sort((a, b) => a.length - b.length);
    return sameExt[0] ?? hallucinated;
}


/**
 * Builds a rich textual context from the current knowledge graph.
 * Includes service health, dependencies, endpoints, incidents, and recent activity.
 */
function buildGraphContext(): string {
    const nodes = getNodes();
    const edges = getEdges();
    const health = getSystemHealth();
    const db = getDb();

    const serviceLines = nodes.map(n => {
        const outEdges = edges.filter(e => e.sourceId === n.id);
        const inEdges = edges.filter(e => e.targetId === n.id);

        const incidents = db.prepare<[string]>(`
            SELECT severity, title FROM incidents
            WHERE service_id = ? AND status = 'open'
            ORDER BY occurred_at DESC LIMIT 3
        `).all(n.id) as Array<{ severity: string; title: string }>;

        const endpoints = db.prepare<[string]>(`
            SELECT method, path FROM endpoints WHERE service_id = ? LIMIT 8
        `).all(n.id) as Array<{ method: string; path: string }>;

        const allNodes = nodes;
        const calls = outEdges.map(e => {
            const target = allNodes.find(x => x.id === e.targetId);
            const ep = e.endpoints.slice(0, 2).join(', ');
            return `→ ${target?.name ?? e.targetId} via ${e.type}${ep ? ` [${ep}]` : ''}`;
        });
        const calledBy = inEdges.map(e => {
            const src = allNodes.find(x => x.id === e.sourceId);
            return `← ${src?.name ?? e.sourceId} (${e.type})`;
        });

        const incidentStr = incidents.map(i => `[${i.severity}] ${i.title}`).join('; ') || 'none';
        const epStr = endpoints.map(e => `${e.method} ${e.path}`).join(', ') || 'none';

        const svcRow = db.prepare<[string]>(
            `SELECT repo_url, repo_subpath FROM services WHERE id = ? LIMIT 1`
        ).get(n.id) as { repo_url: string | null; repo_subpath: string | null } | undefined;

        // Build real file list for this service
        let fileListStr = '';
        if (svcRow?.repo_url) {
            // Reconstruct local path from repo_url and repo_subpath
            // We stored repoPath in the ingest job but not in DB — infer from /tmp or known prefixes
            const knownBases = ['/tmp', '/Users'];
            const repoName = svcRow.repo_url.split('/').pop() ?? '';
            let serviceDir: string | null = null;
            for (const base of knownBases) {
                const candidate = svcRow.repo_subpath
                    ? path.join(base, repoName, svcRow.repo_subpath)
                    : path.join(base, repoName);
                if (fs.existsSync(candidate)) { serviceDir = candidate; break; }
                // Also try under /tmp directly
                const candidate2 = svcRow.repo_subpath
                    ? path.join('/tmp', `${repoName}*`, svcRow.repo_subpath)
                    : null;
                if (candidate2 && fs.existsSync(candidate2)) { serviceDir = candidate2; break; }
            }
            // Brute-force find in /tmp if name matches
            if (!serviceDir) {
                try {
                    const tmpDirs = fs.readdirSync('/tmp').filter(d => d.startsWith(repoName.replace(/[-_]/g, '-').slice(0, 12)));
                    for (const d of tmpDirs) {
                        const p2 = svcRow.repo_subpath ? path.join('/tmp', d, svcRow.repo_subpath) : path.join('/tmp', d);
                        if (fs.existsSync(p2)) { serviceDir = p2; break; }
                    }
                } catch { /* ignore */ }
            }
            if (serviceDir) {
                const files = walkSourceFiles(serviceDir).slice(0, 30);
                if (files.length) fileListStr = `\n  Source files: ${files.join(', ')}`;
            }
        }

        return [
            `SERVICE: ${n.name}`,
            `  id=${n.id} | health=${n.healthScore}/100 (${n.healthTier}) | lang=${n.language ?? 'unknown'} | team=${n.team ?? 'unassigned'}`,
            `  Endpoints: ${epStr}`,
            `  Calls: ${calls.join(', ') || 'none'}`,
            `  Called by: ${calledBy.join(', ') || 'none'}`,
            `  Open incidents: ${incidentStr}`,
            fileListStr,
        ].filter(Boolean).join('\n');
    }).join('\n\n');

    const recentActivity = db.prepare<[]>(`
        SELECT type, title, detail, created_at FROM activity_feed
        ORDER BY created_at DESC LIMIT 15
    `).all() as Array<{ type: string; title: string; detail: string | null; created_at: string }>;

    const activityStr = recentActivity
        .map(a => `[${a.created_at}] ${a.type}: ${a.title}${a.detail ? ` — ${a.detail}` : ''}`)
        .join('\n');

    return [
        '=== SYSTEM HEALTH ===',
        `Overall: ${health.overallScore}/100 | Services: ${health.totalServices} | Edges: ${health.totalEdges}`,
        `Critical: ${health.critical} | Warning: ${health.warning} | Healthy: ${health.healthy}`,
        '',
        '=== SERVICES ===',
        serviceLines || 'No services ingested yet.',
        '',
        '=== RECENT ACTIVITY ===',
        activityStr || 'No recent activity.',
    ].join('\n');
}

// ── Main query function ───────────────────────────────────────────────────────

/**
 * Queries the knowledge graph using OpenAI GPT-4o.
 * Builds graph context, constructs prompt, and returns structured answer with citations.
 *
 * @param question - Natural language question from the engineer
 * @returns QAResult with answer, citations, related nodes, and follow-up suggestions
 */
export async function queryKnowledgeGraph(question: string): Promise<QAResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY not set. Add it to .env to use Q&A.');
    }

    const openai = new OpenAI({ apiKey });
    const context = buildGraphContext();
    const db = getDb();

    const prompt = `You are KA-CHOW, an AI assistant embedded in a living knowledge graph for engineering teams.
You have real-time visibility into this system's microservice architecture.

${context}

Answer the engineer's question with precision. Reference actual service names, health scores, and dependency chains from the context above.

RESPOND WITH ONLY VALID JSON — no markdown, no explanation outside the JSON:
{
  "answer": "3-5 sentence answer referencing specific services by name with concrete details",
  "citations": [
    {
      "file": "path/from/service-name/realistic-filename.ts",
      "line": <realistic line number 1-300>,
      "snippet": "relevant code pattern or config that supports the answer"
    }
  ],
  "relatedNodes": ["exact-service-id-from-context"],
  "suggestions": ["Follow-up question 1?", "Follow-up question 2?", "Follow-up question 3?"]
}

Rules:
- citations: use ONLY the exact file paths listed under "Source files" for that service (e.g. if source files lists "src/routes/blog.ts" use "blog-service/src/routes/blog.ts"). Do NOT invent paths.
- relatedNodes: use EXACT service id strings from the SERVICE lines above (e.g. "def53e95f1fc")
- suggestions: 3 highly relevant follow-up questions
- Be specific and actionable. Do not make up metrics not in the context.

Engineer's question: ${question}`;

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500,
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let parsed: {
        answer?: string;
        citations?: QACitation[];
        relatedNodes?: string[];
        suggestions?: string[];
    } = {};

    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = { answer: raw };
    }

    const rawCitations: Omit<QACitation, 'url'>[] = (parsed.citations ?? []).slice(0, 5);

    // ── Resolve citations: correct hallucinated paths + build URLs ─────────────
    //
    // Strategy:
    //   1. Find the service row by name/id so we have repo_url + repo_subpath
    //   2. Reconstruct the local directory by scanning known clone locations
    //   3. Fuzzy-match the GPT-hallucinated file path against real files on disk
    //   4. Build a correct GitHub URL using repo_url + repo_subpath (relative)
    //   5. Also build a vscode:// URL so the frontend can open the file locally

    /** Try to find the local clone directory for a given repo_url + repo_subpath */
    function findLocalServiceDir(repoUrl: string | null, subpath: string | null): string | null {
        if (!repoUrl) return null;
        const repoName = repoUrl.split('/').pop() ?? '';
        // Check common clone locations
        const baseDirs = ['/tmp', '/private/tmp', '/Users'];
        for (const base of baseDirs) {
            try {
                if (base === '/Users') {
                    // Don't walk all of /Users — skip for now
                    continue;
                }
                const entries = fs.readdirSync(base);
                for (const entry of entries) {
                    if (!entry.toLowerCase().includes(repoName.toLowerCase().slice(0, 8))) continue;
                    const repoRoot = path.join(base, entry);
                    const candidate = subpath ? path.join(repoRoot, subpath) : repoRoot;
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                        return candidate;
                    }
                }
            } catch { /* skip */ }
        }
        return null;
    }

    const citations: QACitation[] = rawCitations.map((cite) => {
        const parts = cite.file.split('/');
        let serviceName = parts[0];
        let gptFilePath = parts.slice(1).join('/');

        // Find the service row by name/id
        const candidates = [
            serviceName,
            serviceName.replace(/[-_]service$/i, ''),
            serviceName.replace(/[-_]svc$/i, ''),
        ];
        let row: { repo_url: string | null; repo_subpath: string | null; name: string } | undefined;
        for (const c of candidates) {
            row = db.prepare<[string, string]>(
                `SELECT repo_url, repo_subpath, name FROM services WHERE name = ? OR id = ? LIMIT 1`
            ).get(c, c) as typeof row;
            if (row) break;
        }
        if (!row) {
            row = db.prepare<[string]>(
                `SELECT repo_url, repo_subpath, name FROM services WHERE name LIKE ? LIMIT 1`
            ).get(`%${serviceName.replace(/[-_]service$/i, '')}%`) as typeof row;
        }

        // Fallback: GPT returned a bare path without service prefix (e.g. "src/vesper_ingestion/db/repo.py")
        // Try matching path segments against service names or repo_subpaths
        if (!row) {
            const allSvcs = db.prepare(
                `SELECT repo_url, repo_subpath, name FROM services WHERE is_external = 0`
            ).all() as Array<{ repo_url: string | null; repo_subpath: string | null; name: string }>;

            const fullPath = cite.file;
            for (const svc of allSvcs) {
                // Check if repo_subpath appears in the file path
                if (svc.repo_subpath && fullPath.includes(svc.repo_subpath.split('/').pop() ?? '___')) {
                    row = svc;
                    // The gptFilePath in this case IS the full path (since no service prefix matched)
                    gptFilePath = fullPath;
                    serviceName = svc.name;
                    break;
                }
                // Check if service name appears in the file path
                if (fullPath.toLowerCase().includes(svc.name.toLowerCase().replace(/-/g, '_'))) {
                    row = svc;
                    gptFilePath = fullPath;
                    serviceName = svc.name;
                    break;
                }
            }
        }

        // Fuzzy-correct the file path against real files on disk
        let correctedFilePath = gptFilePath;
        const serviceDir = findLocalServiceDir(row?.repo_url ?? null, row?.repo_subpath ?? null);
        if (serviceDir) {
            const realFiles = walkSourceFiles(serviceDir);
            correctedFilePath = bestFileMatch(gptFilePath, realFiles);
        }

        // Build the repo-relative file path for GitHub URL
        // repo_subpath is now the correct relative path (e.g. "frontends/ops-ui")
        const repoRelativePath = row?.repo_subpath
            ? `${row.repo_subpath}/${correctedFilePath}`
            : correctedFilePath;

        // GitHub URL: https://github.com/Org/Repo/blob/main/frontends/ops-ui/components/X.tsx#L45
        const url = row?.repo_url && correctedFilePath
            ? `${row.repo_url.replace(/\/+$/, '')}/blob/main/${repoRelativePath}#L${cite.line}`
            : null;

        // Update cite.file to reflect the corrected path
        const correctedCiteFile = `${serviceName}/${correctedFilePath}`;
        return { ...cite, file: correctedCiteFile, url };
    });

    const result: QAResult = {
        id: randomUUID(),
        question,
        answer: parsed.answer ?? 'Unable to generate answer. Please try again.',
        citations,
        relatedNodes: parsed.relatedNodes ?? [],
        suggestions: (parsed.suggestions ?? []).slice(0, 3),
    };

    // Persist to history
    db.prepare(`
        INSERT INTO qa_sessions (id, question, answer, citations, related_nodes)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        result.id,
        result.question,
        result.answer,
        JSON.stringify(result.citations),
        JSON.stringify(result.relatedNodes),
    );

    return result;
}

// ── History ───────────────────────────────────────────────────────────────────

/**
 * Returns the last 20 Q&A interactions from the database.
 */
export function getQAHistory(): QAHistoryItem[] {
    const db = getDb();
    const rows = db.prepare<[]>(`
        SELECT id, question, answer, citations, related_nodes, created_at
        FROM qa_sessions ORDER BY created_at DESC LIMIT 20
    `).all() as Array<{
        id: string; question: string; answer: string;
        citations: string; related_nodes: string; created_at: string;
    }>;

    return rows.map(r => ({
        id: r.id,
        question: r.question,
        answer: r.answer,
        citations: (() => { try { return JSON.parse(r.citations); } catch { return []; } })(),
        relatedNodes: (() => { try { return JSON.parse(r.related_nodes); } catch { return []; } })(),
        createdAt: r.created_at,
    }));
}

// ── Suggestions ───────────────────────────────────────────────────────────────

/**
 * Returns dynamic Q&A suggestions based on the current graph state.
 * Surfaces questions relevant to unhealthy services and detected patterns.
 */
export function getQASuggestions(): string[] {
    const db = getDb();
    const nodes = db.prepare<[]>(`
        SELECT name, health_tier, team FROM services
        WHERE is_external = 0 ORDER BY health_score ASC LIMIT 5
    `).all() as Array<{ name: string; health_tier: string; team: string | null }>;

    const suggestions: string[] = [];

    for (const n of nodes) {
        if (n.health_tier === 'critical') {
            suggestions.push(`Why is ${n.name} in critical state?`);
        } else if (n.health_tier === 'warning') {
            suggestions.push(`What's causing the warning in ${n.name}?`);
        }
    }

    // Generic high-value questions
    suggestions.push('Which service has the highest blast radius if it goes down?');
    suggestions.push('What dependencies could trigger a cascade failure?');
    suggestions.push('Which services are missing error handling?');
    suggestions.push('What is the current overall system risk?');

    // Deduplicate and limit
    return [...new Set(suggestions)].slice(0, 5);
}
