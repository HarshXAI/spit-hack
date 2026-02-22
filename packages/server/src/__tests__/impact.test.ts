/**
 * impact.test.ts — Phase 4 integration tests.
 * Tests all 3 impact analysis endpoints against in-memory SQLite.
 * Seeds a 4-service graph: gateway → auth → db, with a separate isolated node.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../app.js';
import { getTestDb, clearTestDB, closeTestDb } from '../db/test-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const SVC_GATEWAY = 'svc-gw-001';
const SVC_AUTH = 'svc-auth-001';
const SVC_PAYMENT = 'svc-pay-001';
const SVC_DB = 'svc-db-001';
const SVC_ISOLATED = 'svc-iso-001';

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedImpactGraph(): void {
    const db = getTestDb();

    const insertSvc = db.prepare(`
    INSERT OR IGNORE INTO services
      (id, name, team, language, health_score, health_tier, doc_coverage, test_coverage, last_ingested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    insertSvc.run(SVC_GATEWAY, 'api-gateway', 'platform', 'TypeScript', 90, 'healthy', 80, 75, NOW);
    insertSvc.run(SVC_AUTH, 'auth-service', 'security', 'Go', 65, 'warning', 50, 60, NOW);
    insertSvc.run(SVC_PAYMENT, 'payment-api', 'payments', 'TypeScript', 82, 'healthy', 70, 80, NOW);
    insertSvc.run(SVC_DB, 'postgres-svc', 'infra', null, 30, 'critical', 10, 20, NOW);
    insertSvc.run(SVC_ISOLATED, 'orphan-svc', 'unknown', null, 40, 'critical', 0, 0, NOW);

    // gateway → auth  (calls /auth/refresh)
    db.prepare(`
    INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), SVC_GATEWAY, SVC_AUTH, 'REST', JSON.stringify(['/auth/refresh']), 5);

    // payment-api → auth  (calls /auth/verify)
    db.prepare(`
    INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), SVC_PAYMENT, SVC_AUTH, 'REST', JSON.stringify(['/auth/verify', '/auth/refresh']), 2);

    // auth → db
    db.prepare(`
    INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), SVC_AUTH, SVC_DB, 'DB', JSON.stringify([]), 1);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(() => { getTestDb(); });
beforeEach(() => { clearTestDB(); seedImpactGraph(); });
afterAll(() => { clearTestDB(); closeTestDb(); });

// ── POST /api/impact/analyze ──────────────────────────────────────────────────

describe('POST /api/impact/analyze', () => {
    it('returns 201 with blast radius for a real endpoint', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH,
            changeType: 'deprecate',
            targetEndpoint: '/auth/refresh',
        });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        const d = res.body.data;
        expect(d.analysisId).toMatch(/^[0-9a-f-]{36}$/);
        expect(d.serviceId).toBe(SVC_AUTH);
        expect(d.changeType).toBe('deprecate');
        expect(d.targetEndpoint).toBe('/auth/refresh');
    });

    it('identifies gateway as direct consumer of /auth/refresh', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'deprecate', targetEndpoint: '/auth/refresh',
        });
        const direct: { serviceId: string; callsEndpoint: boolean }[] = res.body.data.directImpact;
        const gw = direct.find((s) => s.serviceId === SVC_GATEWAY);
        expect(gw).toBeDefined();
        expect(gw!.callsEndpoint).toBe(true);
    });

    it('identifies payment-api as direct consumer of /auth/refresh', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'delete', targetEndpoint: '/auth/refresh',
        });
        const direct: { serviceId: string }[] = res.body.data.directImpact;
        expect(direct.some((s) => s.serviceId === SVC_PAYMENT)).toBe(true);
    });

    it('returns empty directImpact for a service with no consumers', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_ISOLATED, changeType: 'delete', targetEndpoint: '/any',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.directImpact).toHaveLength(0);
        expect(res.body.data.indirectImpact).toHaveLength(0);
    });

    it('riskScore is higher for delete than deprecate', async () => {
        const [del, dep] = await Promise.all([
            request(app).post('/api/impact/analyze').send({
                serviceId: SVC_AUTH, changeType: 'delete', targetEndpoint: '/auth/refresh',
            }),
            request(app).post('/api/impact/analyze').send({
                serviceId: SVC_AUTH, changeType: 'deprecate', targetEndpoint: '/auth/refresh',
            }),
        ]);
        expect(del.body.data.riskScore).toBeGreaterThanOrEqual(dep.body.data.riskScore);
    });

    it('persists to history — GET /history returns the analysis', async () => {
        await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'deprecate', targetEndpoint: '/auth/refresh',
        });
        const hist = await request(app).get('/api/impact/history');
        expect(hist.body.data.length).toBeGreaterThan(0);
        expect(hist.body.data[0].serviceId).toBe(SVC_AUTH);
    });

    it('returns 404 for an unknown serviceId', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: 'no-such-svc', changeType: 'deprecate', targetEndpoint: '/x',
        });
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when serviceId is missing', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            changeType: 'deprecate', targetEndpoint: '/x',
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid changeType', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'explode', targetEndpoint: '/x',
        });
        expect(res.status).toBe(400);
    });

    it('returns 400 when targetEndpoint is missing', async () => {
        const res = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'delete',
        });
        expect(res.status).toBe(400);
    });
});

// ── POST /api/impact/adr ──────────────────────────────────────────────────────

describe('POST /api/impact/adr', () => {
    it('generates an ADR from a valid analysisId', async () => {
        const analyse = await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'deprecate', targetEndpoint: '/auth/refresh',
        });
        const { analysisId } = analyse.body.data as { analysisId: string };

        const res = await request(app).post('/api/impact/adr').send({ analysisId });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        const adr = res.body.data;
        expect(adr.adrId).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof adr.title).toBe('string');
        expect(typeof adr.context).toBe('string');
        expect(typeof adr.decision).toBe('string');
        expect(typeof adr.consequences).toBe('string');
        expect(adr.status).toBe('draft');
    });

    it('returns 400 for a non-UUID analysisId', async () => {
        const res = await request(app).post('/api/impact/adr').send({ analysisId: 'not-a-uuid' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown analysisId', async () => {
        const res = await request(app).post('/api/impact/adr').send({
            analysisId: '00000000-0000-0000-0000-000000000000',
        });
        expect(res.status).toBe(404);
    });
});

// ── GET /api/impact/history ───────────────────────────────────────────────────

describe('GET /api/impact/history', () => {
    it('returns empty array when no analyses exist', async () => {
        const res = await request(app).get('/api/impact/history');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });

    it('returns analyses after one is created', async () => {
        await request(app).post('/api/impact/analyze').send({
            serviceId: SVC_AUTH, changeType: 'schema-change', targetEndpoint: '/auth/token',
        });
        const res = await request(app).get('/api/impact/history');
        expect(res.body.data.length).toBe(1);
        const item = res.body.data[0];
        expect(item).toHaveProperty('analysisId');
        expect(item).toHaveProperty('riskScore');
        expect(item).toHaveProperty('affectedCount');
        expect(item.changeType).toBe('schema-change');
    });

    it('respects limit and offset query params', async () => {
        // Create 3 analyses
        for (const ep of ['/a', '/b', '/c']) {
            await request(app).post('/api/impact/analyze').send({
                serviceId: SVC_AUTH, changeType: 'deprecate', targetEndpoint: ep,
            });
        }
        const page1 = await request(app).get('/api/impact/history?limit=2&offset=0');
        const page2 = await request(app).get('/api/impact/history?limit=2&offset=2');
        expect(page1.body.data.length).toBe(2);
        expect(page2.body.data.length).toBe(1);
    });
});
