/**
 * Architecture diagram service — Phase 9.
 * Detects service layers (INGRESS → CORE → DOMAIN → INFRA) from
 * graph topology and name patterns. Powers the flow view and blueprint panel.
 */

import { getDb } from '../db/index.js';
import { getNodes, getEdges } from './graphService.js';
import type { GraphNode } from './graphService.js';

// ── Layer detection ───────────────────────────────────────────────────────────

type LayerName = 'INGRESS' | 'CORE' | 'DOMAIN' | 'INFRA';

const LAYER_PATTERNS: Record<LayerName, string[]> = {
    INGRESS: ['gateway', 'api-gateway', 'nginx', 'proxy', 'cdn', 'frontend', 'ui', 'web', 'client', 'edge', 'load-balancer', 'lb'],
    CORE: ['auth', 'user', 'session', 'identity', 'permission', 'role', 'account', 'core'],
    DOMAIN: ['order', 'payment', 'product', 'inventory', 'notification', 'email', 'blog', 'author', 'post', 'comment',
        'evaluator', 'ingestion', 'processing', 'analytics', 'search', 'recommendation', 'workflow', 'report'],
    INFRA: ['database', 'cache', 'redis', 'queue', 'rabbitmq', 'kafka', 'storage', 's3', 'ml', 'model', 'pipeline',
        'terraform', 'infra', 'monitoring', 'grafana', 'prometheus', 'orchestration', 'airflow', 'dag',
        'logging', 'tracing', 'observability', 'deploy', 'ci-cd'],
};

function detectLayer(node: GraphNode, inDegree: number, outDegree: number): LayerName {
    const lower = node.name.toLowerCase();
    for (const [layer, patterns] of Object.entries(LAYER_PATTERNS) as [LayerName, string[]][]) {
        if (patterns.some(p => lower.includes(p))) return layer;
    }
    // Topology heuristic: many outbound = more upstream, many inbound = more downstream
    if (outDegree > 2 && outDegree >= inDegree * 1.5) return 'CORE';
    if (inDegree > 2 && inDegree >= outDegree * 1.5) return 'INFRA';
    return 'DOMAIN';
}

// ── Flow API ──────────────────────────────────────────────────────────────────

export interface ArchitectureLayer {
    name: LayerName;
    services: GraphNode[];
}

export interface ArchitectureFlow {
    layers: ArchitectureLayer[];
    edges: Array<{
        sourceId: string;
        targetId: string;
        type: string;
        endpoints: string[];
    }>;
}

/**
 * Returns services organized into architectural layers for the flow diagram.
 * Layers: INGRESS → CORE → DOMAIN → INFRA
 */
export function getArchitectureFlow(): ArchitectureFlow {
    const nodes = getNodes();
    const edges = getEdges();

    const inDegree: Record<string, number> = {};
    const outDegree: Record<string, number> = {};

    for (const e of edges) {
        outDegree[e.sourceId] = (outDegree[e.sourceId] ?? 0) + 1;
        inDegree[e.targetId] = (inDegree[e.targetId] ?? 0) + 1;
    }

    const buckets: Record<LayerName, GraphNode[]> = {
        INGRESS: [], CORE: [], DOMAIN: [], INFRA: [],
    };

    for (const node of nodes) {
        const layer = detectLayer(node, inDegree[node.id] ?? 0, outDegree[node.id] ?? 0);
        buckets[layer].push(node);
    }

    return {
        layers: (['INGRESS', 'CORE', 'DOMAIN', 'INFRA'] as LayerName[])
            .filter(l => buckets[l].length > 0)
            .map(l => ({ name: l, services: buckets[l] })),
        edges: edges.map(e => ({
            sourceId: e.sourceId,
            targetId: e.targetId,
            type: e.type,
            endpoints: e.endpoints,
        })),
    };
}

// ── Blueprint API ─────────────────────────────────────────────────────────────

export interface StandardsCheck {
    standard: string;
    passing: boolean;
    violation?: string;
}

export interface ServiceBlueprint {
    service: GraphNode & { repoUrl: string | null; docCoverage: number; testCoverage: number };
    endpoints: Array<{ method: string; path: string; deprecated: boolean; hasSpec: boolean }>;
    dependsOn: Array<{ serviceId: string; serviceName: string; type: string; endpoints: string[] }>;
    dependedOnBy: Array<{ serviceId: string; serviceName: string; type: string }>;
    incidents: Array<{ severity: string; title: string; status: string; occurredAt: string }>;
    docCoverage: number;
    standardsCompliance: StandardsCheck[];
}

/**
 * Returns a complete blueprint for a single service.
 * Includes endpoints, dependencies, incidents, and standards compliance checks.
 *
 * @param serviceId - The service's ID
 * @returns ServiceBlueprint or null if not found
 */
export function getServiceBlueprint(serviceId: string): ServiceBlueprint | null {
    const db = getDb();
    const nodes = getNodes();
    const edges = getEdges();

    const node = nodes.find(n => n.id === serviceId);
    if (!node) return null;

    const svcRow = db.prepare<[string]>(
        'SELECT repo_url, doc_coverage, test_coverage FROM services WHERE id = ?',
    ).get(serviceId) as { repo_url: string | null; doc_coverage: number; test_coverage: number } | undefined;

    const endpoints = db.prepare<[string]>(`
        SELECT method, path, deprecated, has_spec FROM endpoints WHERE service_id = ?
    `).all(serviceId) as Array<{ method: string; path: string; deprecated: number; has_spec: number }>;

    const dependsOn = edges
        .filter(e => e.sourceId === serviceId)
        .map(e => {
            const target = nodes.find(n => n.id === e.targetId);
            return {
                serviceId: e.targetId,
                serviceName: target?.name ?? e.targetId,
                type: e.type,
                endpoints: e.endpoints,
            };
        });

    const dependedOnBy = edges
        .filter(e => e.targetId === serviceId)
        .map(e => {
            const src = nodes.find(n => n.id === e.sourceId);
            return {
                serviceId: e.sourceId,
                serviceName: src?.name ?? e.sourceId,
                type: e.type,
            };
        });

    const incidents = db.prepare<[string]>(`
        SELECT severity, title, status, occurred_at FROM incidents
        WHERE service_id = ? ORDER BY occurred_at DESC LIMIT 10
    `).all(serviceId) as Array<{ severity: string; title: string; status: string; occurred_at: string }>;

    const hasOpenApi = endpoints.some(e => e.has_spec === 1);
    const hasDeprecated = endpoints.some(e => e.deprecated === 1);
    const docCoverage = svcRow?.doc_coverage ?? 0;
    const testCoverage = svcRow?.test_coverage ?? 0;

    const standardsCompliance: StandardsCheck[] = [
        {
            standard: 'Has HTTP endpoints',
            passing: endpoints.length > 0,
            violation: endpoints.length === 0 ? 'No endpoints registered' : undefined,
        },
        {
            standard: 'OpenAPI spec present',
            passing: hasOpenApi,
            violation: !hasOpenApi ? 'No OpenAPI spec found for any endpoint' : undefined,
        },
        {
            standard: 'No deprecated endpoints in use',
            passing: !hasDeprecated,
            violation: hasDeprecated
                ? endpoints.filter(e => e.deprecated).map(e => `${e.method} ${e.path}`).join(', ')
                : undefined,
        },
        {
            standard: 'Health score ≥ 50',
            passing: node.healthScore >= 50,
            violation: node.healthScore < 50 ? `Score is ${node.healthScore}/100` : undefined,
        },
        {
            standard: 'Team assigned',
            passing: !!node.team,
            violation: !node.team ? 'No team owner assigned' : undefined,
        },
        {
            standard: 'Test coverage ≥ 50%',
            passing: testCoverage >= 50,
            violation: testCoverage < 50 ? `Coverage at ${testCoverage}%` : undefined,
        },
    ];

    return {
        service: {
            ...node,
            repoUrl: svcRow?.repo_url ?? null,
            docCoverage,
            testCoverage,
        },
        endpoints: endpoints.map(e => ({
            method: e.method,
            path: e.path,
            deprecated: e.deprecated === 1,
            hasSpec: e.has_spec === 1,
        })),
        dependsOn,
        dependedOnBy,
        incidents: incidents.map(i => ({
            severity: i.severity,
            title: i.title,
            status: i.status,
            occurredAt: i.occurred_at,
        })),
        docCoverage,
        standardsCompliance,
    };
}
