/**
 * Unit tests for scannerService.ts — Phase 1.
 * Tests health score calculation, dependency detection, and endpoint detection
 * against real temporary directories (no mocks — scanner uses fs directly).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    calculateHealthScore,
    detectDependencies,
    detectEndpoints,
    serviceIdFromName,
    scanRepo,
} from '../services/scannerService.js';

// ── Test fixture directory ────────────────────────────────────────────────────

let fixtureDir: string;

beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kachow-scanner-'));
});

afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** Creates a file inside the fixture directory and returns its path. */
function fixture(relPath: string, content: string): string {
    const full = path.join(fixtureDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
}

// ── serviceIdFromName ─────────────────────────────────────────────────────────

describe('serviceIdFromName', () => {
    it('returns a 12-char hex string', () => {
        const id = serviceIdFromName('auth-service');
        expect(id).toHaveLength(12);
        expect(id).toMatch(/^[0-9a-f]+$/);
    });

    it('is deterministic — same name gives same id', () => {
        expect(serviceIdFromName('payments')).toBe(serviceIdFromName('payments'));
    });

    it('produces different ids for different names', () => {
        expect(serviceIdFromName('auth')).not.toBe(serviceIdFromName('payments'));
    });
});

// ── calculateHealthScore ──────────────────────────────────────────────────────

describe('calculateHealthScore', () => {
    it('awards 0 for an empty directory', () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kachow-empty-'));
        try {
            const { score } = calculateHealthScore(emptyDir, []);
            // Empty: no openapi (0), no readme (0), no tests (0), no deprecated calls (+20), no bare calls (+10), +10 incidents = 40
            expect(score).toBe(40);
        } finally {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });

    it('awards 25pts for an openapi.yaml file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kachow-oa-'));
        try {
            const files = [path.join(dir, 'openapi.yaml')];
            fs.writeFileSync(files[0], 'openapi: 3.0.0', 'utf8');
            const { score } = calculateHealthScore(dir, files);
            expect(score).toBeGreaterThanOrEqual(25);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('awards 15pts for a README longer than 200 chars', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kachow-readme-'));
        try {
            const readmePath = path.join(dir, 'README.md');
            fs.writeFileSync(readmePath, 'A'.repeat(250), 'utf8');
            const files = [readmePath];
            const { score } = calculateHealthScore(dir, files);
            expect(score).toBeGreaterThanOrEqual(15);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('includes issue messages when signals fail', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kachow-issues-'));
        try {
            const { issues } = calculateHealthScore(dir, []);
            expect(issues.some((i) => /OpenAPI|Swagger/i.test(i))).toBe(true);
            expect(issues.some((i) => /README/i.test(i))).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── detectDependencies ────────────────────────────────────────────────────────

describe('detectDependencies', () => {
    it('detects axios HTTP calls', () => {
        const filePath = fixture('axios-test/index.ts', `
      import axios from 'axios';
      async function fetchUser() {
        return axios.get('https://api.example.com/users');
      }
    `);
        const deps = detectDependencies(path.dirname(filePath), 'svc-001', [filePath]);
        expect(deps.some((d) => d.type === 'REST' && d.targetUrl.includes('api.example.com'))).toBe(true);
    });

    it('detects kafka producer topics', () => {
        const filePath = fixture('kafka-test/producer.ts', `
      producer.send({ topic: 'payment-events', messages: [{ value: 'ok' }] });
    `);
        const deps = detectDependencies(path.dirname(filePath), 'svc-002', [filePath]);
        expect(deps.some((d) => d.type === 'Event' && d.targetName === 'kafka:payment-events')).toBe(true);
    });

    it('detects database connections', () => {
        const filePath = fixture('db-test/config.ts', `
      const db = new Prisma.Client({ datasource: process.env.DATABASE_URL });
    `);
        const deps = detectDependencies(path.dirname(filePath), 'svc-003', [filePath]);
        expect(deps.some((d) => d.type === 'DB')).toBe(true);
    });

    it('deduplicates repeated calls to the same target', () => {
        const filePath = fixture('dedup-test/service.ts', `
      axios.get('https://auth.internal/verify');
      axios.get('https://auth.internal/refresh');
    `);
        const deps = detectDependencies(path.dirname(filePath), 'svc-004', [filePath]);
        const restDeps = deps.filter((d) => d.type === 'REST' && d.targetName === 'auth.internal');
        expect(restDeps).toHaveLength(1);
    });

    it('returns empty array for a file with no external calls', () => {
        const filePath = fixture('clean-test/utils.ts', `
      export function add(a: number, b: number): number { return a + b; }
    `);
        const deps = detectDependencies(path.dirname(filePath), 'svc-005', [filePath]);
        expect(deps).toHaveLength(0);
    });
});

// ── detectEndpoints ───────────────────────────────────────────────────────────

describe('detectEndpoints', () => {
    it('detects Express GET and POST routes', () => {
        const filePath = fixture('routes-test/routes.ts', `
      router.get('/users', listUsers);
      router.post('/users', createUser);
      app.delete('/users/:id', deleteUser);
    `);
        const eps = detectEndpoints([filePath]);
        expect(eps.some((e) => e.method === 'GET' && e.path === '/users')).toBe(true);
        expect(eps.some((e) => e.method === 'POST' && e.path === '/users')).toBe(true);
        expect(eps.some((e) => e.method === 'DELETE' && e.path === '/users/:id')).toBe(true);
    });

    it('returns empty array for a file with no routes', () => {
        const filePath = fixture('no-routes-test/utils.ts', `
      export const PI = 3.14;
    `);
        const eps = detectEndpoints([filePath]);
        expect(eps).toHaveLength(0);
    });
});

// ── scanRepo ──────────────────────────────────────────────────────────────────

describe('scanRepo', () => {
    it('throws if repoPath does not exist', () => {
        expect(() => scanRepo('/non/existent/path/abc123')).toThrow(/does not exist/);
    });

    it('returns a scan result for the test fixture dir', () => {
        // Create a minimal package.json so we get a named service
        fixture('pkg/package.json', JSON.stringify({ name: 'test-service', version: '1.0.0' }));
        const pkgDir = path.join(fixtureDir, 'pkg');
        const result = scanRepo(pkgDir);
        expect(result.services).toHaveLength(1);
        expect(result.services[0].name).toBe('test-service');
        expect(result.services[0].id).toHaveLength(12);
        expect(result.services[0].healthScore).toBeGreaterThanOrEqual(0);
        expect(result.services[0].healthScore).toBeLessThanOrEqual(100);
    });

    it('scan result has issues array (even if empty)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kachow-scan-'));
        try {
            const result = scanRepo(dir);
            expect(Array.isArray(result.issues)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
