/**
 * Impact Analysis Service — Phase 4.
 *
 * Deterministic BFS graph traversal that calculates blast radius when a
 * service endpoint is deprecated, deleted, or schema-changed.
 *
 * Algorithm (per brief):
 *   1. Find direct consumers (services with an edge whose endpoints[] contains
 *      the target endpoint, OR all services that depend on the target service)
 *   2. BFS outward to find transitive consumers
 *   3. Calculate risk score 0–10 from fan-out, criticality, fallback absence
 *   4. Look up historical precedent in impact_analyses table
 *   5. Return structured result — LLM explanation is optional / called from route
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';

// ── Request / Response shapes ─────────────────────────────────────────────────

export type ChangeType = 'deprecate' | 'schema-change' | 'delete';

export interface AnalyzeImpactInput {
    serviceId: string;
    changeType: ChangeType;
    targetEndpoint: string;   // e.g. '/api/v1/auth/refresh'
}

export interface AffectedService {
    serviceId: string;
    serviceName: string;
    healthTier: string;
    impactType: 'direct' | 'transitive';
    depth: number;           // BFS hops from origin
    callsEndpoint: boolean;  // does it call the specific endpoint?
}

export interface Precedent {
    analysisId: string;
    endpoint: string;
    changeType: string;
    affectedCount: number;
    riskScore: number;
    occurredAt: string;
}

export interface ImpactAnalysisResult {
    analysisId: string;
    serviceId: string;
    serviceName: string;
    changeType: ChangeType;
    targetEndpoint: string;
    directImpact: AffectedService[];
    indirectImpact: AffectedService[];
    riskScore: number;
    confidence: number;
    precedent: Precedent | null;
    summary: string;
    createdAt: string;
}

export interface AdrResult {
    adrId: string;
    analysisId: string;
    title: string;
    context: string;
    decision: string;
    consequences: string;
    alternatives: string;
    status: 'draft';
}

export interface ImpactHistoryItem {
    analysisId: string;
    serviceId: string;
    serviceName: string;
    changeType: string;
    targetEndpoint: string;
    riskScore: number;
    affectedCount: number;
    status: string;
    createdAt: string;
}

// ── Internal DB row types ─────────────────────────────────────────────────────

interface DepRow {
    source_id: string;
    target_id: string;
    endpoints: string | null;
}
interface ServiceRow {
    id: string;
    name: string;
    health_tier: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEndpoints(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const p: unknown = JSON.parse(raw);
        return Array.isArray(p) ? (p as string[]) : [];
    } catch { return []; }
}

/**
 * Checks whether any endpoint in the list matches the target.
 * Supports exact match and prefix match (e.g. '/auth' matches '/auth/refresh').
 */
function endpointMatches(list: string[], target: string): boolean {
    if (!target || target === '*') return list.length > 0;
    return list.some(
        (ep) => ep === target || ep.startsWith(target) || target.startsWith(ep),
    );
}

// ── Risk score calculation ────────────────────────────────────────────────────

/**
 * Calculates a risk score 0–10 for an impact analysis.
 *
 * Factors:
 *   - Number of direct consumers (up to 3 pts)
 *   - Transitive blast radius (up to 2 pts)
 *   - Critical/warning services affected (up to 2 pts)
 *   - Change type severity (delete > deprecate > schema-change) (up to 2 pts)
 *   - No historical precedent = unknown risk +1 pt
 */
function calculateRiskScore(
    direct: AffectedService[],
    transitive: AffectedService[],
    changeType: ChangeType,
    hasPrecedent: boolean,
): number {
    let score = 0;

    // Direct consumers
    score += Math.min(3, direct.length);

    // Transitive blast radius
    score += Math.min(2, Math.floor(transitive.length / 2));

    // Critical/warning services affected
    const allAffected = [...direct, ...transitive];
    const hasCritical = allAffected.some((s) => s.healthTier === 'critical');
    const hasWarning = allAffected.some((s) => s.healthTier === 'warning');
    if (hasCritical) score += 2;
    else if (hasWarning) score += 1;

    // Change type severity
    if (changeType === 'delete') score += 2;
    else if (changeType === 'deprecate') score += 1;
    else score += 0.5; // schema-change

    // Unknown risk premium
    if (!hasPrecedent) score += 1;

    return Math.min(10, Math.round(score * 10) / 10);
}

// ── Core BFS traversal ────────────────────────────────────────────────────────

/**
 * Performs BFS from `serviceId` following inbound dependency edges
 * (who depends on this service?).
 *
 * Returns direct (depth=1) and transitive (depth>1) consumers.
 */
function traverseConsumers(
    serviceId: string,
    targetEndpoint: string,
): { direct: AffectedService[]; transitive: AffectedService[] } {
    const db = getDb();

    // Build full inbound adjacency map: target_id → [source rows]
    const allDeps = db.prepare<[], DepRow>(
        'SELECT source_id, target_id, endpoints FROM dependencies',
    ).all();

    // Map: serviceId → {id, name, health_tier}
    const serviceMap = new Map<string, ServiceRow>(
        db.prepare<[], ServiceRow>('SELECT id, name, health_tier FROM services').all()
            .map((s) => [s.id, s]),
    );

    // Adjacency: who calls a given service?
    const inbound = new Map<string, DepRow[]>();
    for (const dep of allDeps) {
        if (!inbound.has(dep.target_id)) inbound.set(dep.target_id, []);
        inbound.get(dep.target_id)!.push(dep);
    }

    const direct: AffectedService[] = [];
    const transitive: AffectedService[] = [];
    const visited = new Set<string>([serviceId]);

    // BFS — queue items: { id, depth }
    const queue: Array<{ id: string; depth: number }> = [{ id: serviceId, depth: 0 }];

    while (queue.length > 0) {
        const { id: current, depth } = queue.shift()!;
        const callers = inbound.get(current) ?? [];

        for (const dep of callers) {
            const callerId = dep.source_id;
            if (visited.has(callerId)) continue;
            visited.add(callerId);

            const svc = serviceMap.get(callerId);
            const eps = parseEndpoints(dep.endpoints);
            const calls = endpointMatches(eps, targetEndpoint);

            const entry: AffectedService = {
                serviceId: callerId,
                serviceName: svc?.name ?? callerId,
                healthTier: svc?.health_tier ?? 'unknown',
                impactType: depth === 0 ? 'direct' : 'transitive',
                depth: depth + 1,
                callsEndpoint: calls,
            };

            if (depth === 0) {
                direct.push(entry);
            } else {
                transitive.push(entry);
            }

            queue.push({ id: callerId, depth: depth + 1 });
        }
    }

    return { direct, transitive };
}

// ── Historical precedent lookup ───────────────────────────────────────────────

function findPrecedent(
    serviceId: string,
    _targetEndpoint: string,
    _changeType: ChangeType,
): Precedent | null {
    const db = getDb();

    interface PrecedentRow {
        id: string; trigger_ref: string; trigger_type: string;
        affected: string; risk_score: number; created_at: string;
    }

    // Look for past analyses on the same service with a similar endpoint
    const row = db.prepare<[string], PrecedentRow>(`
    SELECT id, trigger_ref, trigger_type, affected, risk_score, created_at
    FROM impact_analyses
    WHERE service_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(serviceId);

    if (!row) return null;

    let affectedCount = 0;
    try {
        const parsed: unknown = JSON.parse(row.affected);
        affectedCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch { /* noop */ }

    return {
        analysisId: row.id,
        endpoint: row.trigger_ref,
        changeType: row.trigger_type,
        affectedCount,
        riskScore: row.risk_score,
        occurredAt: row.created_at,
    };
}

// ── Exported service functions ────────────────────────────────────────────────

/**
 * Runs a full impact analysis for a proposed change.
 * Persists result to impact_analyses table.
 *
 * @param input - serviceId, changeType, targetEndpoint
 * @returns ImpactAnalysisResult with direct + transitive blast radius
 * @throws { statusCode: 404, message } if service not found
 */
export function analyzeImpact(input: AnalyzeImpactInput, teamId?: string): ImpactAnalysisResult {
    const db = getDb();
    const { serviceId, changeType, targetEndpoint } = input;

    // Verify service exists
    const svc = db.prepare<[string], ServiceRow>(
        'SELECT id, name, health_tier FROM services WHERE id = ? AND is_external = 0',
    ).get(serviceId);

    if (!svc) {
        throw { statusCode: 404, message: `Service '${serviceId}' not found` };
    }

    const { direct, transitive } = traverseConsumers(serviceId, targetEndpoint);
    const precedent = findPrecedent(serviceId, targetEndpoint, changeType);
    const riskScore = calculateRiskScore(direct, transitive, changeType, precedent !== null);

    // Confidence: higher when we have more graph data
    const totalEdges = db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM dependencies').get()?.c ?? 0;
    const confidence = totalEdges > 10 ? 0.87 : totalEdges > 3 ? 0.72 : 0.55;

    // Build summary
    const totalAffected = direct.length + transitive.length;
    const summary = totalAffected === 0
        ? `No consumers found for ${targetEndpoint} on ${svc.name}. Safe to ${changeType}.`
        : `${direct.length} direct + ${transitive.length} transitive service(s) affected. Risk: ${riskScore}/10.`;

    // Persist to DB
    const analysisId = randomUUID();
    const allAffected = [
        ...direct.map((s) => ({ id: s.serviceId, name: s.serviceName, impact_type: s.impactType })),
        ...transitive.map((s) => ({ id: s.serviceId, name: s.serviceName, impact_type: s.impactType })),
    ];

    db.prepare(`
    INSERT INTO impact_analyses
      (id, trigger_type, trigger_ref, service_id, affected, risk_score, confidence, precedent, team_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        analysisId,
        changeType,
        targetEndpoint,
        serviceId,
        JSON.stringify(allAffected),
        riskScore,
        confidence,
        precedent ? JSON.stringify(precedent) : null,
        teamId ?? null,
    );

    // Write activity feed entry
    db.prepare(`
    INSERT INTO activity_feed (id, type, service_id, title, detail, severity, team_id)
    VALUES (?, 'IMPACT_ANALYSED', ?, ?, ?, ?, ?)
  `).run(
        randomUUID(),
        serviceId,
        `Impact analysis: ${changeType} ${targetEndpoint}`,
        summary,
        riskScore >= 7 ? 'critical' : riskScore >= 4 ? 'warning' : 'info',
        teamId ?? null,
    );

    const now = new Date().toISOString();
    return {
        analysisId,
        serviceId,
        serviceName: svc.name,
        changeType,
        targetEndpoint,
        directImpact: direct,
        indirectImpact: transitive,
        riskScore,
        confidence,
        precedent,
        summary,
        createdAt: now,
    };
}

/**
 * Generates an Architecture Decision Record from an existing impact analysis.
 * Uses deterministic template generation (LLM call can be layered on top later).
 *
 * @param analysisId - ID of a previously run impact analysis
 * @returns AdrResult or throws 404 if analysis not found
 */
export function generateAdr(analysisId: string): AdrResult {
    const db = getDb();

    interface AnalysisRow {
        id: string; trigger_type: string; trigger_ref: string;
        service_id: string; affected: string; risk_score: number;
        confidence: number; created_at: string;
    }
    interface SvcRow { name: string }

    const analysis = db.prepare<[string], AnalysisRow>(
        'SELECT * FROM impact_analyses WHERE id = ?',
    ).get(analysisId);

    if (!analysis) throw { statusCode: 404, message: `Analysis '${analysisId}' not found` };

    const svc = db.prepare<[string], SvcRow>(
        'SELECT name FROM services WHERE id = ?',
    ).get(analysis.service_id);

    let affected: { name: string }[] = [];
    try { affected = JSON.parse(analysis.affected) as { name: string }[]; } catch { /* noop */ }

    const affectedNames = affected.map((a) => a.name).join(', ') || 'none';
    const riskLabel = analysis.risk_score >= 7 ? 'HIGH' : analysis.risk_score >= 4 ? 'MEDIUM' : 'LOW';
    const svcName = svc?.name ?? analysis.service_id;
    const title = `ADR: ${analysis.trigger_type === 'deprecate' ? 'Deprecation' : analysis.trigger_type === 'delete' ? 'Deletion' : 'Schema change'} of ${analysis.trigger_ref} in ${svcName}`;

    const context = `On ${new Date(analysis.created_at).toDateString()}, a ${analysis.trigger_type} change ` +
        `was proposed for endpoint \`${analysis.trigger_ref}\` in service \`${svcName}\`. ` +
        `Impact analysis (id: ${analysis.id}) identified a risk score of ${analysis.risk_score}/10 (${riskLabel}) ` +
        `with ${analysis.confidence * 100}% confidence. Affected services: ${affectedNames}.`;

    const decision = analysis.risk_score >= 7
        ? `Do NOT proceed with this change until all ${affected.length} affected services have been updated ` +
        `and migration paths documented. Coordinate with owning teams.`
        : analysis.risk_score >= 4
            ? `Proceed with a phased rollout: deprecate first, allow 2 sprint migration window, then delete.`
            : `Low risk — proceed with standard PR review. Notify affected teams via Slack.`;

    const consequences = `Positive: reduces technical debt in ${svcName}. ` +
        `Negative: requires coordinated update across ${affected.length} service(s). ` +
        `Risk of regression if affected services are not updated before change is shipped.`;

    const alternatives = `1. Keep endpoint alive with deprecation warning header. ` +
        `2. Add backward-compatible alias at new path. ` +
        `3. Use feature flags to progressively migrate consumers.`;

    const adrId = randomUUID();
    db.prepare(`
    INSERT INTO adrs (id, analysis_id, title, context, decision, consequences, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(adrId, analysisId, title, context, decision, consequences);

    return { adrId, analysisId, title, context, decision, consequences, alternatives, status: 'draft' };
}

/**
 * Returns paginated impact analysis history.
 *
 * @param limit  - Max results to return (default 20)
 * @param offset - Pagination offset (default 0)
 */
export function getImpactHistory(limit = 20, offset = 0): ImpactHistoryItem[] {
    const db = getDb();

    interface HistRow {
        id: string; service_id: string; name: string; trigger_type: string;
        trigger_ref: string; risk_score: number; affected: string;
        status: string; created_at: string;
    }

    const rows = db.prepare<[number, number], HistRow>(`
    SELECT ia.id, ia.service_id, s.name, ia.trigger_type, ia.trigger_ref,
           ia.risk_score, ia.affected, ia.status, ia.created_at
    FROM impact_analyses ia
    LEFT JOIN services s ON s.id = ia.service_id
    ORDER BY ia.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

    return rows.map((r): ImpactHistoryItem => {
        let affectedCount = 0;
        try { affectedCount = (JSON.parse(r.affected) as unknown[]).length; } catch { /* noop */ }
        return {
            analysisId: r.id,
            serviceId: r.service_id,
            serviceName: r.name ?? r.service_id,
            changeType: r.trigger_type,
            targetEndpoint: r.trigger_ref,
            riskScore: r.risk_score,
            affectedCount,
            status: r.status,
            createdAt: r.created_at,
        };
    });
}
