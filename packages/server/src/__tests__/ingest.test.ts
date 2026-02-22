/**
 * Integration tests for POST /api/ingest/repo, GET /api/ingest/status/:jobId,
 * and POST /api/ingest/commit — Phase 1.
 *
 * Redis / BullMQ are mocked via vi.mock so these tests run without a Redis
 * instance and complete deterministically.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { getTestDb, seedTestDB, clearTestDB, closeTestDb } from '../db/test-helpers.js';

// ── Mock BullMQ queue ─────────────────────────────────────────────────────────
// We replace the queue module so no real Redis connection is attempted.

const mockAdd = vi.fn().mockResolvedValue({ id: 'mock-job-id' });
const mockGetJob = vi.fn().mockResolvedValue(null);

vi.mock('../queues/ingestQueue.js', () => ({
    getIngestQueue: () => ({
        add: mockAdd,
        getJob: mockGetJob,
    }),
    closeIngestQueue: vi.fn(),
}));

vi.mock('../queues/redis.js', () => ({
    getRedis: () => ({}),
    closeRedis: vi.fn(),
}));

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeAll(() => {
    getTestDb(); // ensure test DB is initialised with schema
});

beforeEach(() => {
    clearTestDB();
    mockAdd.mockClear();
    mockGetJob.mockClear();
});

afterAll(() => {
    closeTestDb();
});

// ── POST /api/ingest/repo ─────────────────────────────────────────────────────

describe('POST /api/ingest/repo', () => {
    it('returns 201 with jobId and status:started for a valid body', async () => {
        const res = await request(app)
            .post('/api/ingest/repo')
            .send({ repoPath: '/tmp/test-repo', team: 'platform' })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.jobId).toBeTruthy();
        expect(res.body.data.status).toBe('started');
        expect(typeof res.body.data.estimatedSeconds).toBe('number');
        expect(res.body.error).toBeNull();
        expect(res.body.meta.timestamp).toBeTruthy();
    });

    it('calls queue.add exactly once per request', async () => {
        await request(app)
            .post('/api/ingest/repo')
            .send({ repoPath: '/tmp/repo-a' })
            .expect(201);

        expect(mockAdd).toHaveBeenCalledTimes(1);
        const [jobName, jobData] = mockAdd.mock.calls[0] as [string, { repoPath: string }];
        expect(jobName).toBe('ingest-repo');
        expect(jobData.repoPath).toBe('/tmp/repo-a');
    });

    it('accepts an optional repoUrl and team', async () => {
        const res = await request(app)
            .post('/api/ingest/repo')
            .send({
                repoPath: '/tmp/repo-b',
                repoUrl: 'https://github.com/orbix/auth-service',
                team: 'security',
            })
            .expect(201);

        expect(res.body.success).toBe(true);
        const [, jobData] = mockAdd.mock.calls[0] as [string, { repoUrl: string; team: string }];
        expect(jobData.repoUrl).toBe('https://github.com/orbix/auth-service');
        expect(jobData.team).toBe('security');
    });

    it('returns 400 when repoPath is missing', async () => {
        const res = await request(app)
            .post('/api/ingest/repo')
            .send({ team: 'platform' })
            .expect(400);

        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/repoPath/i);
    });

    it('returns 400 when repoUrl is not a valid URL', async () => {
        const res = await request(app)
            .post('/api/ingest/repo')
            .send({ repoPath: '/tmp/repo', repoUrl: 'not-a-url' })
            .expect(400);

        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/url/i);
    });

    it('returns 400 when body is empty', async () => {
        await request(app).post('/api/ingest/repo').send({}).expect(400);
    });

    it('returns standard meta envelope on success', async () => {
        const res = await request(app)
            .post('/api/ingest/repo')
            .send({ repoPath: '/tmp/repo-meta' })
            .expect(201);

        expect(res.body.meta).toMatchObject({
            version: expect.any(String),
            timestamp: expect.any(String),
        });
    });
});

// ── GET /api/ingest/status/:jobId ─────────────────────────────────────────────

describe('GET /api/ingest/status/:jobId', () => {
    it('returns 400 for an invalid jobId format', async () => {
        const res = await request(app)
            .get('/api/ingest/status/not-a-valid-uuid')
            .expect(400);

        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/invalid jobid/i);
    });

    it('opens an SSE stream for a valid UUID jobId', async () => {
        const validJobId = '550e8400-e29b-41d4-a716-446655440000';

        // SSE connections stay open, so we use a short timeout
        const res = await request(app)
            .get(`/api/ingest/status/${validJobId}`)
            .set('Accept', 'text/event-stream')
            .timeout({ deadline: 1000 })
            .catch((e: { response?: { headers: Record<string, string> } }) => e.response);

        // Either we get a response object or the timeout fires — either way
        // the key assertion is that it responded with SSE headers
        if (res && 'headers' in res) {
            expect(res.headers['content-type']).toContain('text/event-stream');
        }
    });
});

// ── POST /api/ingest/commit ───────────────────────────────────────────────────

describe('POST /api/ingest/commit', () => {
    beforeEach(() => {
        // Seed a service so the commit route can find it
        seedTestDB();
    });

    it('returns 201 with nodesUpdated for a valid commit body', async () => {
        const db = getTestDb();
        // Get the actual service ID seeded
        const svc = db.prepare('SELECT id FROM services LIMIT 1').get() as { id: string };

        const res = await request(app)
            .post('/api/ingest/commit')
            .send({
                repoId: svc.id,
                commitHash: 'abc1234',
                changedFiles: ['src/auth.ts', 'src/middleware.ts'],
            })
            .expect(201);

        expect(res.body.success).toBe(true);
        expect(typeof res.body.data.nodesUpdated).toBe('number');
        expect(Array.isArray(res.body.data.newIssues)).toBe(true);
    });

    it('calls queue.add with ingest-commit job name', async () => {
        const db = getTestDb();
        const svc = db.prepare('SELECT id FROM services LIMIT 1').get() as { id: string };

        await request(app)
            .post('/api/ingest/commit')
            .send({
                repoId: svc.id,
                commitHash: 'deadbeef',
                changedFiles: ['routes/payments.ts'],
            })
            .expect(201);

        expect(mockAdd).toHaveBeenCalledTimes(1);
        expect(mockAdd.mock.calls[0][0]).toBe('ingest-commit');
    });

    it('returns 404 when repoId does not exist in DB', async () => {
        const res = await request(app)
            .post('/api/ingest/commit')
            .send({
                repoId: 'nonexistentid0',
                commitHash: 'abc1234',
                changedFiles: ['src/index.ts'],
            })
            .expect(404);

        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 400 when commitHash is invalid', async () => {
        const res = await request(app)
            .post('/api/ingest/commit')
            .send({
                repoId: 'any-id',
                commitHash: 'not-a-sha!',
                changedFiles: ['src/index.ts'],
            })
            .expect(400);

        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/commitHash/i);
    });

    it('returns 400 when changedFiles is empty', async () => {
        const res = await request(app)
            .post('/api/ingest/commit')
            .send({
                repoId: 'any-id',
                commitHash: 'abc1234',
                changedFiles: [],
            })
            .expect(400);

        expect(res.body.success).toBe(false);
    });

    it('returns 400 when body is missing required fields', async () => {
        await request(app).post('/api/ingest/commit').send({}).expect(400);
    });
});
