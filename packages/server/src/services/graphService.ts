/**
 * Graph read service — Phase 2.
 * Pure read queries against SQLite. No mutations here.
 * All write paths live in ingestWorker.ts.
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { computeLayout } from './graphLayout.js';
import type { HealthTier, EdgeType } from '../types/index.js';

// ── Response shapes ───────────────────────────────────────────────────────────

export interface GraphNode {
    id: string;
    name: string;
    healthScore: number;
    healthTier: HealthTier;
    team: string | null;
    language: string | null;
    connectionCount: number;
    x: number;
    y: number;
    isExternal?: boolean;
}

export interface GraphEdge {
    id: string;
    sourceId: string;
    targetId: string;
    type: EdgeType;
    endpoints: string[];
    strength: number;
}

export interface NodeEndpoint {
    id: string;
    method: string;
    path: string;
    deprecated: boolean;
    hasSpec: boolean;
}

export interface NodeIncident {
    id: string;
    severity: string;
    title: string;
    status: string;
    occurredAt: string;
    resolvedAt: string | null;
}

export interface NodeDependency {
    serviceId: string;
    serviceName: string;
    type: EdgeType;
    endpoints: string[];
    strength: number;
}

export interface NodeActivity {
    id: string;
    type: string;
    title: string;
    detail: string | null;
    createdAt: string;
}

export interface GraphNodeDetail {
    service: GraphNode & {
        repoUrl: string | null;
        docCoverage: number;
        testCoverage: number;
        lastIngested: string | null;
    };
    endpoints: NodeEndpoint[];
    incidents: NodeIncident[];
    dependsOn: NodeDependency[];
    dependedOnBy: NodeDependency[];
    recentActivity: NodeActivity[];
}

export interface SystemHealth {
    overallScore: number;
    totalServices: number;
    critical: number;
    warning: number;
    healthy: number;
    totalEdges: number;
    lastUpdated: string | null;
}

export interface GraphSnapshot {
    nodes: GraphNode[];
    edges: GraphEdge[];
    version: string;
    timestamp: string;
}

// ── Critical issues aggregate ─────────────────────────────────────────────────

export interface CriticalIssue {
    id: string;
    serviceId: string;
    serviceName: string;
    healthScore: number;
    healthTier: HealthTier;
    severity: 'critical' | 'warning' | 'info';
    category: string;          // 'security' | 'reliability' | 'performance' | 'quality'
    title: string;
    description: string;
    file: string | null;
    line: number | null;
    suggestedFix: string | null;
    source: 'agent' | 'healing' | 'incident';
}

// ── Internal DB row types ─────────────────────────────────────────────────────

interface ServiceRow {
    id: string; name: string; repo_url: string | null; team: string | null;
    language: string | null; health_score: number; health_tier: string;
    doc_coverage: number; test_coverage: number;
    last_ingested: string | null; connection_count: number;
}
interface DepRow {
    id: string; source_id: string; target_id: string; type: string;
    endpoints: string | null; strength: number;
}
interface EndpointRow {
    id: string; method: string; path: string; deprecated: number; has_spec: number;
}
interface IncidentRow {
    id: string; severity: string; title: string; status: string;
    occurred_at: string; resolved_at: string | null;
}
interface ActivityRow {
    id: string; type: string; title: string; detail: string | null; created_at: string;
}
interface DepJoinRow extends DepRow { peer_id: string; peer_name: string; }
interface HealthRow {
    overall: number | null; total: number; critical: number; warning: number;
    healthy: number; last_updated: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses a JSON endpoints string stored in the DB into a string array.
 * Returns an empty array on any parse error.
 *
 * @param raw - JSON string from the DB or null
 * @returns Parsed string array
 */
function parseEndpoints(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
        return [];
    }
}

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Returns all service nodes with computed layout coordinates and connection counts.
 * When teamName is supplied only that team's services + their external references are returned.
 * Used by GET /api/graph/nodes.
 *
 * @param teamName - Optional team name to filter services by
 * @returns Array of GraphNode objects sorted by health score descending
 */
export function getNodes(teamName?: string): GraphNode[] {
    const db = getDb();

    const nodeQuery = db.prepare<unknown[], ServiceRow>(`
    SELECT
      s.id, s.name, s.team, s.language, s.health_score, s.health_tier,
      s.repo_url, s.doc_coverage, s.test_coverage, s.last_ingested,
      (SELECT COUNT(*) FROM dependencies WHERE source_id = s.id) +
      (SELECT COUNT(*) FROM dependencies WHERE target_id = s.id) AS connection_count
    FROM services s
    WHERE s.is_external = 0 AND s.team = ?
    ORDER BY s.health_score DESC
  `);

    const allNodesQuery = db.prepare<[], ServiceRow>(`
    SELECT
      s.id, s.name, s.team, s.language, s.health_score, s.health_tier,
      s.repo_url, s.doc_coverage, s.test_coverage, s.last_ingested,
      (SELECT COUNT(*) FROM dependencies WHERE source_id = s.id) +
      (SELECT COUNT(*) FROM dependencies WHERE target_id = s.id) AS connection_count
    FROM services s
    WHERE s.is_external = 0
    ORDER BY s.health_score DESC
  `);

    // Internal services — fall back to all if no nodes match the requested team
    let rows: ServiceRow[];
    if (teamName) {
        rows = nodeQuery.all(teamName);
        if (rows.length === 0) rows = allNodesQuery.all();
    } else {
        rows = allNodesQuery.all();
    }

    const internalIds = rows.map(r => r.id);
    const idPlaceholders = internalIds.length ? internalIds.map(() => '?').join(',') : "''";

    // External nodes that are referenced by the (filtered) internal services
    const externalRows = db.prepare<unknown[], ServiceRow>(`
    SELECT
      s.id, s.name, s.team, s.language, s.health_score, s.health_tier,
      s.repo_url, s.doc_coverage, s.test_coverage, s.last_ingested,
      (SELECT COUNT(*) FROM dependencies WHERE source_id = s.id) +
      (SELECT COUNT(*) FROM dependencies WHERE target_id = s.id) AS connection_count
    FROM services s
    WHERE s.is_external = 1
      AND (
        EXISTS (SELECT 1 FROM dependencies WHERE target_id = s.id AND source_id IN (${idPlaceholders}))
        OR EXISTS (SELECT 1 FROM dependencies WHERE source_id = s.id AND target_id IN (${idPlaceholders}))
      )
    ORDER BY s.name
  `).all(...internalIds, ...internalIds);

    const edgeRows = db.prepare<[], { source_id: string; target_id: string }>(
        'SELECT source_id, target_id FROM dependencies',
    ).all();

    const layout = computeLayout(rows, edgeRows);

    // Position external nodes in a dedicated far-right column
    const EXT_X = 1350;
    const extStep = externalRows.length > 0 ? 700 / (externalRows.length + 1) : 350;

    const result: GraphNode[] = rows.map((r): GraphNode => ({
        id: r.id,
        name: r.name,
        healthScore: r.health_score,
        healthTier: r.health_tier as HealthTier,
        team: r.team,
        language: r.language,
        connectionCount: r.connection_count,
        x: layout.get(r.id)?.x ?? 700,
        y: layout.get(r.id)?.y ?? 350,
    }));

    externalRows.forEach((r, i) => {
        result.push({
            id: r.id,
            name: r.name,
            healthScore: r.health_score,
            healthTier: r.health_tier as HealthTier,
            team: r.team,
            language: r.language,
            connectionCount: r.connection_count,
            x: EXT_X,
            y: Math.round(extStep * (i + 1)),
            isExternal: true,
        });
    });

    return result;
}

/**
 * Returns all dependency edges in the graph.
 * When teamName is supplied only edges where at least one endpoint belongs to
 * that team are returned.
 * Used by GET /api/graph/edges.
 *
 * @param teamName - Optional team name to filter edges by
 * @returns Array of GraphEdge objects
 */
export function getEdges(teamName?: string): GraphEdge[] {
    const db = getDb();

    let rows: DepRow[];
    if (teamName) {
        rows = db.prepare<unknown[], DepRow>(`
            SELECT d.id, d.source_id, d.target_id, d.type, d.endpoints, d.strength
            FROM dependencies d
            WHERE d.source_id IN (SELECT id FROM services WHERE team = ?)
               OR d.target_id IN (SELECT id FROM services WHERE team = ?)
        `).all(teamName, teamName);
        // Fall back to all edges if the team has no matching services
        if (rows.length === 0) {
            rows = db.prepare<[], DepRow>(
                'SELECT id, source_id, target_id, type, endpoints, strength FROM dependencies',
            ).all();
        }
    } else {
        rows = db.prepare<[], DepRow>(
            'SELECT id, source_id, target_id, type, endpoints, strength FROM dependencies',
        ).all();
    }

    return rows.map((r): GraphEdge => ({
        id: r.id,
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.type as EdgeType,
        endpoints: parseEndpoints(r.endpoints),
        strength: r.strength,
    }));
}

/**
 * Returns full detail for a single service node.
 * Includes endpoints, incidents, inbound/outbound dependencies, and recent activity.
 * Used by GET /api/graph/node/:id.
 *
 * @param id - Service node ID
 * @returns GraphNodeDetail or null if not found
 */
export function getNodeDetail(id: string): GraphNodeDetail | null {
    const db = getDb();

    const svcRow = db.prepare<[string], ServiceRow & { repo_url: string | null }>(`
    SELECT s.*,
      (SELECT COUNT(*) FROM dependencies WHERE source_id = s.id) +
      (SELECT COUNT(*) FROM dependencies WHERE target_id = s.id) AS connection_count
    FROM services s WHERE s.id = ?
  `).get(id);

    if (!svcRow) return null;

    const edgeRows = db.prepare<[], { source_id: string; target_id: string }>(
        'SELECT source_id, target_id FROM dependencies',
    ).all();
    const layout = computeLayout(
        db.prepare<[], { id: string }>('SELECT id FROM services').all(),
        edgeRows,
    );

    const endpoints = db.prepare<[string], EndpointRow>(
        'SELECT id, method, path, deprecated, has_spec FROM endpoints WHERE service_id = ?',
    ).all(id);

    const incidents = db.prepare<[string], IncidentRow>(`
    SELECT id, severity, title, status, occurred_at, resolved_at
    FROM incidents WHERE service_id = ? ORDER BY occurred_at DESC LIMIT 10
  `).all(id);

    const dependsOn = db.prepare<[string], DepJoinRow>(`
    SELECT d.id, d.source_id, d.target_id, d.type, d.endpoints, d.strength,
           s.id as peer_id, s.name as peer_name
    FROM dependencies d JOIN services s ON s.id = d.target_id
    WHERE d.source_id = ?
  `).all(id);

    const dependedOnBy = db.prepare<[string], DepJoinRow>(`
    SELECT d.id, d.source_id, d.target_id, d.type, d.endpoints, d.strength,
           s.id as peer_id, s.name as peer_name
    FROM dependencies d JOIN services s ON s.id = d.source_id
    WHERE d.target_id = ?
  `).all(id);

    const recentActivity = db.prepare<[string], ActivityRow>(`
    SELECT id, type, title, detail, created_at FROM activity_feed
    WHERE service_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(id);

    return {
        service: {
            id: svcRow.id, name: svcRow.name,
            healthScore: svcRow.health_score, healthTier: svcRow.health_tier as HealthTier,
            team: svcRow.team, language: svcRow.language,
            connectionCount: svcRow.connection_count,
            x: layout.get(id)?.x ?? 700, y: layout.get(id)?.y ?? 350,
            repoUrl: svcRow.repo_url, docCoverage: svcRow.doc_coverage,
            testCoverage: svcRow.test_coverage, lastIngested: svcRow.last_ingested,
        },
        endpoints: endpoints.map((e): NodeEndpoint => ({
            id: e.id, method: e.method, path: e.path,
            deprecated: e.deprecated === 1, hasSpec: e.has_spec === 1,
        })),
        incidents: incidents.map((i): NodeIncident => ({
            id: i.id, severity: i.severity, title: i.title, status: i.status,
            occurredAt: i.occurred_at, resolvedAt: i.resolved_at,
        })),
        dependsOn: dependsOn.map((d): NodeDependency => ({
            serviceId: d.peer_id, serviceName: d.peer_name,
            type: d.type as EdgeType, endpoints: parseEndpoints(d.endpoints),
            strength: d.strength,
        })),
        dependedOnBy: dependedOnBy.map((d): NodeDependency => ({
            serviceId: d.peer_id, serviceName: d.peer_name,
            type: d.type as EdgeType, endpoints: parseEndpoints(d.endpoints),
            strength: d.strength,
        })),
        recentActivity: recentActivity.map((a): NodeActivity => ({
            id: a.id, type: a.type, title: a.title, detail: a.detail, createdAt: a.created_at,
        })),
    };
}

/**
 * Aggregates critical issues from three sources:
 *   1. Agent KG — healthIssues per node + selfHealingSuggestions
 *   2. healing_prs table — issues detected by self-healing agents
 *   3. incidents table — open incidents
 *
 * Returns a flat CriticalIssue[] sorted by severity (critical → warning → info).
 */
export function getCriticalIssues(): CriticalIssue[] {
    const db = getDb();
    const issues: CriticalIssue[] = [];

    // ── 1) Agent Knowledge Graph health issues + self-healing ─────────────────

    // Service lookup for enrichment
    const svcMap = new Map<string, { name: string; healthScore: number; healthTier: HealthTier }>();
    const svcRows = db.prepare<[], { id: string; name: string; health_score: number; health_tier: string }>(
        'SELECT id, name, health_score, health_tier FROM services WHERE is_external = 0',
    ).all();
    for (const s of svcRows) svcMap.set(s.id, { name: s.name, healthScore: s.health_score, healthTier: s.health_tier as HealthTier });

    // Also build a name→id reverse lookup (agent KG uses service names, not IDs)
    const nameToId = new Map<string, string>();
    for (const s of svcRows) nameToId.set(s.name.toLowerCase(), s.id);

    // Read the latest agent KG from knowledge_graph table
    const kgRow = db.prepare<[], { nodes: string; self_healing: string }>(
        `SELECT nodes, self_healing FROM knowledge_graph ORDER BY created_at DESC LIMIT 1`,
    ).get();

    if (kgRow) {
        try {
            const kgNodes = JSON.parse(kgRow.nodes) as Array<{
                id?: string; name: string; healthIssues?: string[];
            }>;
            const selfHealing = JSON.parse(kgRow.self_healing) as Array<{
                serviceId?: string; serviceName: string; severity: string;
                issue: string; suggestion: string; file: string; line: number;
            }>;

            // Per-node health issues
            for (const n of kgNodes) {
                const svcId = n.id ?? nameToId.get(n.name.toLowerCase());
                const svc = svcId ? svcMap.get(svcId) : undefined;
                for (const issue of n.healthIssues ?? []) {
                    const severity = classifySeverity(issue);
                    issues.push({
                        id: `agent-hi-${svcId ?? n.name}-${issues.length}`,
                        serviceId: svcId ?? n.name,
                        serviceName: svc?.name ?? n.name,
                        healthScore: svc?.healthScore ?? 0,
                        healthTier: svc?.healthTier ?? 'warning',
                        severity,
                        category: classifyCategory(issue),
                        title: issue.length > 80 ? issue.slice(0, 77) + '…' : issue,
                        description: issue,
                        file: null,
                        line: null,
                        suggestedFix: null,
                        source: 'agent',
                    });
                }
            }

            // Self-healing suggestions (richer — include file/line/fix)
            for (const sh of selfHealing) {
                const svcId = sh.serviceId ?? nameToId.get(sh.serviceName.toLowerCase());
                const svc = svcId ? svcMap.get(svcId) : undefined;
                issues.push({
                    id: `agent-sh-${svcId ?? sh.serviceName}-${issues.length}`,
                    serviceId: svcId ?? sh.serviceName,
                    serviceName: svc?.name ?? sh.serviceName,
                    healthScore: svc?.healthScore ?? 0,
                    healthTier: svc?.healthTier ?? 'warning',
                    severity: (sh.severity === 'critical' || sh.severity === 'warning' || sh.severity === 'info')
                        ? sh.severity : 'warning',
                    category: classifyCategory(sh.issue),
                    title: sh.issue.length > 80 ? sh.issue.slice(0, 77) + '…' : sh.issue,
                    description: sh.issue,
                    file: sh.file || null,
                    line: sh.line || null,
                    suggestedFix: sh.suggestion || null,
                    source: 'agent',
                });
            }
        } catch { /* ignore malformed KG */ }
    }

    // ── 2) healing_prs — detected self-healing issues ─────────────────────────

    interface HealingRow {
        id: string; service_id: string; issue_type: string; explanation: string;
        status: string;
    }
    const healingRows = db.prepare<[], HealingRow>(
        `SELECT id, service_id, issue_type, explanation, status
         FROM healing_prs WHERE status IN ('detected', 'open')`,
    ).all();
    for (const h of healingRows) {
        const svc = svcMap.get(h.service_id);
        // Avoid duplicate if agent KG already has the same issue text
        const dup = issues.some(i => i.serviceId === h.service_id && i.description === h.explanation);
        if (!dup) {
            issues.push({
                id: `heal-${h.id}`,
                serviceId: h.service_id,
                serviceName: svc?.name ?? h.service_id,
                healthScore: svc?.healthScore ?? 0,
                healthTier: svc?.healthTier ?? 'warning',
                severity: classifySeverity(h.issue_type + ' ' + h.explanation),
                category: classifyCategory(h.issue_type),
                title: h.issue_type,
                description: h.explanation,
                file: null,
                line: null,
                suggestedFix: null,
                source: 'healing',
            });
        }
    }

    // ── 3) Open incidents ─────────────────────────────────────────────────────

    const incidentRows = db.prepare<[], {
        id: string; service_id: string; severity: string; title: string;
        status: string; occurred_at: string;
    }>(
        `SELECT id, service_id, severity, title, status, occurred_at
         FROM incidents WHERE status != 'resolved' ORDER BY occurred_at DESC LIMIT 30`,
    ).all();
    for (const inc of incidentRows) {
        const svc = svcMap.get(inc.service_id);
        issues.push({
            id: `inc-${inc.id}`,
            serviceId: inc.service_id,
            serviceName: svc?.name ?? inc.service_id,
            healthScore: svc?.healthScore ?? 0,
            healthTier: svc?.healthTier ?? 'warning',
            severity: inc.severity === 'critical' ? 'critical' : inc.severity === 'warning' ? 'warning' : 'info',
            category: 'reliability',
            title: inc.title,
            description: `${inc.title} — ${inc.status} since ${inc.occurred_at}`,
            file: null,
            line: null,
            suggestedFix: null,
            source: 'incident',
        });
    }

    // ── Sort: critical first, then warning, then info ─────────────────────────
    const ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    issues.sort((a, b) => (ORDER[a.severity] ?? 2) - (ORDER[b.severity] ?? 2));

    return issues;
}

// Heuristic severity from free-text
function classifySeverity(text: string): 'critical' | 'warning' | 'info' {
    const t = text.toLowerCase();
    if (/hardcoded.*(key|secret|password|token)|sql.?inject|xss|remote.?code|auth.?bypass|critical/i.test(t)) return 'critical';
    if (/missing.*header|no.*(rate.?limit|input.?valid|error.?hand)|warning|deprecated/i.test(t)) return 'warning';
    return 'info';
}

// Heuristic category from free-text
function classifyCategory(text: string): string {
    const t = text.toLowerCase();
    if (/secur|key|secret|token|inject|xss|auth|password|cors|header/i.test(t)) return 'security';
    if (/perf|latency|cache|throughput|slow|memory|cpu/i.test(t)) return 'performance';
    if (/reliab|error.?hand|circuit|retry|timeout|crash|incident|health/i.test(t)) return 'reliability';
    return 'quality';
}

/**
 * Returns aggregate health metrics for the entire system.
 * Used by GET /api/graph/health — polled every 30s by the frontend.
 *
 * @returns SystemHealth object with score breakdown
 */
export function getSystemHealth(): SystemHealth {
    const db = getDb();

    const row = db.prepare<[], HealthRow>(`
    SELECT
      ROUND(AVG(health_score), 1)                                        AS overall,
      COUNT(*)                                                            AS total,
      SUM(CASE WHEN health_tier = 'critical' THEN 1 ELSE 0 END)         AS critical,
      SUM(CASE WHEN health_tier = 'warning'  THEN 1 ELSE 0 END)         AS warning,
      SUM(CASE WHEN health_tier = 'healthy'  THEN 1 ELSE 0 END)         AS healthy,
      MAX(last_ingested)                                                  AS last_updated
    FROM services
    WHERE is_external = 0
  `).get();

    const edgeCount = (db.prepare<[], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM dependencies`
    ).get()?.cnt) ?? 0;

    return {
        overallScore: row?.overall ?? 0,
        totalServices: row?.total ?? 0,
        critical: row?.critical ?? 0,
        warning: row?.warning ?? 0,
        healthy: row?.healthy ?? 0,
        totalEdges: edgeCount,
        lastUpdated: row?.last_updated ?? null,
    };
}

/**
 * Retrieves a stored graph snapshot by version string.
 * Version 'latest' returns the most recently saved snapshot.
 * Used by GET /api/graph/snapshot/:version.
 *
 * @param version - Git tag, ISO timestamp string, or 'latest'
 * @returns GraphSnapshot or null if not found
 */
export function getSnapshot(version: string): GraphSnapshot | null {
    const db = getDb();

    let row: { nodes: string; edges: string; version: string; created_at: string } | undefined;

    if (version === 'latest') {
        row = db.prepare(
            'SELECT nodes, edges, version, created_at FROM snapshots ORDER BY created_at DESC LIMIT 1',
        ).get() as typeof row;
    } else {
        row = db.prepare(
            'SELECT nodes, edges, version, created_at FROM snapshots WHERE version = ?',
        ).get(version) as typeof row;
    }

    if (!row) return null;

    try {
        return {
            nodes: JSON.parse(row.nodes) as GraphNode[],
            edges: JSON.parse(row.edges) as GraphEdge[],
            version: row.version,
            timestamp: row.created_at,
        };
    } catch {
        return null;
    }
}

/**
 * Saves the current graph state as a named snapshot.
 * Called by the ingest worker after a successful full scan.
 *
 * @param version - Snapshot version label (git tag or ISO timestamp)
 * @returns void
 */
export function saveSnapshot(version: string): void {
    const db = getDb();
    const nodes = getNodes();
    const edges = getEdges();

    db.prepare(`
    INSERT INTO snapshots (id, version, nodes, edges)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET
      nodes = excluded.nodes,
      edges = excluded.edges,
      created_at = datetime('now')
  `).run(randomUUID(), version, JSON.stringify(nodes), JSON.stringify(edges));
}
