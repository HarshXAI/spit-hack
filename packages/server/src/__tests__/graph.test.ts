/**
 * graph.test.ts — Phase 2 integration tests.
 * All 5 graph read endpoints are exercised against an in-memory SQLite database
 * seeded with deterministic fixture data.
 *
 * BullMQ / Redis are NOT involved — these routes are pure read-only.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../app.js';
import { getTestDb, clearTestDB, closeTestDb } from '../db/test-helpers.js';

// ── Seed helpers ──────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

/** IDs used across multiple tests */
const SVC_GATEWAY = 'svc-gateway';
const SVC_AUTH = 'svc-auth';
const SVC_DB = 'svc-db';
const DEP_GW_AUTH = 'dep-gw-auth';
const DEP_AUTH_DB = 'dep-auth-db';

function seedGraph(): void {
    const db = getTestDb();

    // 3 services: INGRESS → CORE → INFRA
    db.prepare(`
    INSERT OR IGNORE INTO services
      (id, name, repo_url, team, language, health_score, health_tier,
       doc_coverage, test_coverage, last_ingested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(SVC_GATEWAY, 'api-gateway', 'https://github.com/co/gateway',
        'platform', 'TypeScript', 92, 'healthy', 80, 75, NOW);

    db.prepare(`
    INSERT OR IGNORE INTO services
      (id, name, repo_url, team, language, health_score, health_tier,
       doc_coverage, test_coverage, last_ingested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(SVC_AUTH, 'auth-service', 'https://github.com/co/auth',
        'security', 'Go', 60, 'warning', 50, 60, NOW);

    db.prepare(`
    INSERT OR IGNORE INTO services
      (id, name, repo_url, team, language, health_score, health_tier,
       doc_coverage, test_coverage, last_ingested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(SVC_DB, 'postgres-svc', null, 'infra', null, 30, 'critical', 10, 20, NOW);

    // 2 edges: gateway → auth → db
    db.prepare(`
    INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(DEP_GW_AUTH, SVC_GATEWAY, SVC_AUTH, 'REST', JSON.stringify(['/auth/verify']), 3);

    db.prepare(`
    INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(DEP_AUTH_DB, SVC_AUTH, SVC_DB, 'DB', JSON.stringify([]), 1);

    // 2 endpoints on auth-service
    db.prepare(`
    INSERT OR IGNORE INTO endpoints (id, service_id, method, path, deprecated, has_spec, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), SVC_AUTH, 'GET', '/auth/verify', 0, 1, NOW);

    db.prepare(`
    INSERT OR IGNORE INTO endpoints (id, service_id, method, path, deprecated, has_spec, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), SVC_AUTH, 'POST', '/auth/login', 0, 1, NOW);

    // 1 incident on auth-service
    db.prepare(`
    INSERT OR IGNORE INTO incidents (id, service_id, severity, title, status, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), SVC_AUTH, 'P2', 'High latency spike', 'resolved', NOW);

    // 1 activity feed entry
    db.prepare(`
    INSERT OR IGNORE INTO activity_feed (id, type, service_id, title, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), 'INGESTION_COMPLETE', SVC_AUTH, 'Ingestion complete', '1 service');
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeAll(() => {
    getTestDb(); // ensure schema is initialised
});

beforeEach(() => {
    clearTestDB();
    seedGraph();
});

afterAll(() => {
    clearTestDB();
    closeTestDb();
});

// ── GET /api/graph/nodes ──────────────────────────────────────────────────────

describe('GET /api/graph/nodes', () => {
    it('returns 200 with an array of nodes', async () => {
        const res = await request(app).get('/api/graph/nodes');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.meta.count).toBe(3);
    });

    it('each node has the required shape', async () => {
        const res = await request(app).get('/api/graph/nodes');
        const node = res.body.data[0] as {
            id: string; name: string; healthScore: number; healthTier: string;
            connectionCount: number; x: number; y: number;
        };
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('name');
        expect(typeof node.healthScore).toBe('number');
        expect(['healthy', 'warning', 'critical']).toContain(node.healthTier);
        expect(typeof node.connectionCount).toBe('number');
        expect(typeof node.x).toBe('number');
        expect(typeof node.y).toBe('number');
    });

    it('gateway has connectionCount of 1 (1 outbound)', async () => {
        const res = await request(app).get('/api/graph/nodes');
        const gw = res.body.data.find((n: { id: string }) => n.id === SVC_GATEWAY);
        expect(gw).toBeDefined();
        expect(gw.connectionCount).toBe(1);
    });

    it('auth-service has connectionCount of 2 (1 in + 1 out)', async () => {
        const res = await request(app).get('/api/graph/nodes');
        const auth = res.body.data.find((n: { id: string }) => n.id === SVC_AUTH);
        expect(auth).toBeDefined();
        expect(auth.connectionCount).toBe(2);
    });

    it('nodes are sorted by health score descending', async () => {
        const res = await request(app).get('/api/graph/nodes');
        const scores: number[] = res.body.data.map((n: { healthScore: number }) => n.healthScore);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });
});

// ── GET /api/graph/edges ──────────────────────────────────────────────────────

describe('GET /api/graph/edges', () => {
    it('returns 200 with an array of edges', async () => {
        const res = await request(app).get('/api/graph/edges');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.meta.count).toBe(2);
    });

    it('each edge has the required shape', async () => {
        const res = await request(app).get('/api/graph/edges');
        const edge = res.body.data[0] as {
            id: string; sourceId: string; targetId: string;
            type: string; endpoints: string[]; strength: number;
        };
        expect(edge).toHaveProperty('id');
        expect(edge).toHaveProperty('sourceId');
        expect(edge).toHaveProperty('targetId');
        expect(edge).toHaveProperty('type');
        expect(Array.isArray(edge.endpoints)).toBe(true);
        expect(typeof edge.strength).toBe('number');
    });

    it('gateway→auth edge has type REST and correct endpoint list', async () => {
        const res = await request(app).get('/api/graph/edges');
        const edge = res.body.data.find((e: { id: string }) => e.id === DEP_GW_AUTH);
        expect(edge).toBeDefined();
        expect(edge.type).toBe('REST');
        expect(edge.endpoints).toContain('/auth/verify');
    });
});

// ── GET /api/graph/health ─────────────────────────────────────────────────────

describe('GET /api/graph/health', () => {
    it('returns 200 with system health shape', async () => {
        const res = await request(app).get('/api/graph/health');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const h = res.body.data as {
            overallScore: number; totalServices: number;
            critical: number; warning: number; healthy: number;
            lastUpdated: string | null;
        };
        expect(typeof h.overallScore).toBe('number');
        expect(h.totalServices).toBe(3);
        expect(h.critical).toBe(1);
        expect(h.warning).toBe(1);
        expect(h.healthy).toBe(1);
    });

    it('overall score is the average of the three health scores', async () => {
        const res = await request(app).get('/api/graph/health');
        const { overallScore } = res.body.data as { overallScore: number };
        // (92 + 60 + 30) / 3 = 60.7
        expect(overallScore).toBeCloseTo(60.7, 1);
    });
});

// ── GET /api/graph/node/:id ───────────────────────────────────────────────────

describe('GET /api/graph/node/:id', () => {
    it('returns 200 with full detail for a known node', async () => {
        const res = await request(app).get(`/api/graph/node/${SVC_AUTH}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.service.id).toBe(SVC_AUTH);
    });

    it('node detail includes endpoints', async () => {
        const res = await request(app).get(`/api/graph/node/${SVC_AUTH}`);
        const { endpoints } = res.body.data as { endpoints: { method: string; path: string }[] };
        expect(endpoints.length).toBe(2);
        const paths = endpoints.map((e) => e.path);
        expect(paths).toContain('/auth/verify');
        expect(paths).toContain('/auth/login');
    });

    it('node detail includes dependsOn and dependedOnBy', async () => {
        const res = await request(app).get(`/api/graph/node/${SVC_AUTH}`);
        const { dependsOn, dependedOnBy } = res.body.data as {
            dependsOn: { serviceId: string }[];
            dependedOnBy: { serviceId: string }[];
        };
        expect(dependsOn.length).toBe(1);
        expect(dependsOn[0].serviceId).toBe(SVC_DB);
        expect(dependedOnBy.length).toBe(1);
        expect(dependedOnBy[0].serviceId).toBe(SVC_GATEWAY);
    });

    it('node detail includes incidents', async () => {
        const res = await request(app).get(`/api/graph/node/${SVC_AUTH}`);
        const { incidents } = res.body.data as { incidents: { title: string }[] };
        expect(incidents.length).toBe(1);
        expect(incidents[0].title).toBe('High latency spike');
    });

    it('node detail includes recentActivity', async () => {
        const res = await request(app).get(`/api/graph/node/${SVC_AUTH}`);
        const { recentActivity } = res.body.data as { recentActivity: { type: string }[] };
        expect(recentActivity.length).toBeGreaterThan(0);
        expect(recentActivity[0].type).toBe('INGESTION_COMPLETE');
    });

    it('returns 404 for an unknown node id', async () => {
        const res = await request(app).get('/api/graph/node/no-such-service');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('gateway node has no inbound dependencies (dependedOnBy is empty)', async () => {
        const res = await request(app).get(`/api/graph/node/${SVC_GATEWAY}`);
        const { dependedOnBy } = res.body.data as { dependedOnBy: unknown[] };
        expect(dependedOnBy.length).toBe(0);
    });
});

// ── GET /api/graph/snapshot/:version ─────────────────────────────────────────

describe('GET /api/graph/snapshot/:version', () => {
    it('returns 404 when no snapshot exists yet', async () => {
        const res = await request(app).get('/api/graph/snapshot/latest');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    it('returns a stored snapshot after one is saved', async () => {
        const db = getTestDb();
        db.prepare(`
      INSERT OR IGNORE INTO snapshots (id, version, nodes, edges)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), 'v1.0.0', JSON.stringify([{ id: 'n1' }]), JSON.stringify([]));

        const res = await request(app).get('/api/graph/snapshot/v1.0.0');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.version).toBe('v1.0.0');
        expect(Array.isArray(res.body.data.nodes)).toBe(true);
        expect(Array.isArray(res.body.data.edges)).toBe(true);
    });

    it('returns 404 for an unknown version', async () => {
        const res = await request(app).get('/api/graph/snapshot/not-a-real-tag');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });
});
