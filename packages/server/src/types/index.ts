/**
 * KA-CHOW shared TypeScript types.
 * Every API response in the system must use ApiResponse<T>.
 * Import from here — never define the envelope shape inline.
 */

// ── Response envelope ─────────────────────────────────────────────────────────

/**
 * Standard API response envelope used by every route.
 * Shape: { success, data, error, meta }
 */
export interface ApiResponse<T = null> {
    success: boolean;
    data: T | null;
    error: string | null;
    meta: {
        timestamp: string;
        version: string;
    };
}

/**
 * Creates a successful API response with data.
 *
 * @param data - Payload to send to the client
 * @returns Populated ApiResponse with success: true
 */
export function ok<T>(data: T): ApiResponse<T> {
    return {
        success: true,
        data,
        error: null,
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };
}

/**
 * Creates an error API response.
 *
 * @param message - Human-readable error description
 * @returns Populated ApiResponse with success: false
 */
export function err(message: string): ApiResponse<null> {
    return {
        success: false,
        data: null,
        error: message,
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };
}

// ── Domain types ──────────────────────────────────────────────────────────────

export type HealthTier = 'healthy' | 'warning' | 'critical';
export type EdgeType = 'REST' | 'Event' | 'gRPC' | 'DB' | 'Storage' | 'Deploy';
export type IncidentSeverity = 'P0' | 'P1' | 'P2' | 'P3';
export type IncidentStatus = 'open' | 'resolved' | 'postmortem';
export type ImpactStatus = 'pending' | 'reviewed' | 'actioned';
export type AdrStatus = 'draft' | 'approved' | 'rejected';
export type HealingStatus = 'open' | 'merged' | 'closed';

/** Represents a single service node in the knowledge graph. */
export interface ServiceNode {
    id: string;
    name: string;
    repoUrl: string | null;
    team: string | null;
    language: string | null;
    healthScore: number;
    healthTier: HealthTier;
    docCoverage: number;
    testCoverage: number;
    lastCommit: string | null;
    lastIngested: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Represents a dependency edge between two services. */
export interface DependencyEdge {
    id: string;
    sourceId: string;
    targetId: string;
    type: EdgeType;
    endpoints: string[];
    strength: number;
    createdAt: string;
}

/** Represents an incident linked to a service. */
export interface Incident {
    id: string;
    serviceId: string;
    severity: IncidentSeverity;
    title: string;
    rootCause: string | null;
    status: IncidentStatus;
    occurredAt: string;
    resolvedAt: string | null;
    createdAt: string;
}

/** Represents a structured error returned from integration calls. */
export interface IntegrationError {
    error: true;
    code: string;
    message: string;
}
