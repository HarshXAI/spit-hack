/**
 * schema.test.ts
 * Phase 0 gating test — asserts every table in the KA-CHOW schema was created
 * correctly inside an in-memory SQLite database.
 *
 * Per the brief: this test must pass before any Phase 1 work begins.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { getTestDb, clearTestDB, closeTestDb } from '../db/test-helpers';
import { TABLES } from '../db/schema';

// Row shape returned by sqlite_master
interface SqliteMasterRow {
    name: string;
}

// Row shape returned by PRAGMA table_info
interface ColumnInfo {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
}

// Convenience: query all user-created table names
function getTableNames(db: Database.Database): string[] {
    return (
        db
            .prepare(
                `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            )
            .all() as SqliteMasterRow[]
    ).map((r) => r.name);
}

// Convenience: query column names for a specific table
function getColumnNames(db: Database.Database, table: string): string[] {
    return (
        db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
    ).map((c) => c.name);
}

describe('Database Schema — Phase 0', () => {
    let db: Database.Database;

    beforeAll(() => {
        db = getTestDb();
    });

    afterAll(() => {
        clearTestDB();
        closeTestDb();
    });

    // ── Table existence ─────────────────────────────────────────────────────────

    it('creates all 10 required tables', () => {
        const existing = getTableNames(db);
        for (const table of TABLES) {
            expect(existing, `Expected table "${table}" to exist`).toContain(table);
        }
    });

    // ── services columns ────────────────────────────────────────────────────────

    it('services table has the correct columns', () => {
        const cols = getColumnNames(db, 'services');
        expect(cols).toContain('id');
        expect(cols).toContain('name');
        expect(cols).toContain('repo_url');
        expect(cols).toContain('team');
        expect(cols).toContain('language');
        expect(cols).toContain('health_score');
        expect(cols).toContain('health_tier');
        expect(cols).toContain('doc_coverage');
        expect(cols).toContain('test_coverage');
        expect(cols).toContain('last_commit');
        expect(cols).toContain('last_ingested');
        expect(cols).toContain('created_at');
        expect(cols).toContain('updated_at');
    });

    // ── dependencies columns ────────────────────────────────────────────────────

    it('dependencies table has the correct columns', () => {
        const cols = getColumnNames(db, 'dependencies');
        expect(cols).toContain('id');
        expect(cols).toContain('source_id');
        expect(cols).toContain('target_id');
        expect(cols).toContain('type');
        expect(cols).toContain('endpoints');
        expect(cols).toContain('strength');
    });

    // ── incidents columns ───────────────────────────────────────────────────────

    it('incidents table has the correct columns', () => {
        const cols = getColumnNames(db, 'incidents');
        expect(cols).toContain('id');
        expect(cols).toContain('service_id');
        expect(cols).toContain('severity');
        expect(cols).toContain('title');
        expect(cols).toContain('status');
        expect(cols).toContain('occurred_at');
    });

    // ── impact_analyses columns ─────────────────────────────────────────────────

    it('impact_analyses table has the correct columns', () => {
        const cols = getColumnNames(db, 'impact_analyses');
        expect(cols).toContain('trigger_type');
        expect(cols).toContain('trigger_ref');
        expect(cols).toContain('affected');
        expect(cols).toContain('risk_score');
        expect(cols).toContain('confidence');
    });

    // ── Read / Write round-trips ────────────────────────────────────────────────

    it('can insert and retrieve a service', () => {
        const now = new Date().toISOString();
        db.prepare(
            `INSERT OR REPLACE INTO services (id, name, health_score, health_tier, last_ingested)
       VALUES (?, ?, ?, ?, ?)`,
        ).run('test-auth', 'Auth Service', 91, 'healthy', now);

        const row = db
            .prepare(`SELECT * FROM services WHERE id = ?`)
            .get('test-auth') as { name: string; health_score: number; health_tier: string } | undefined;

        expect(row).toBeDefined();
        expect(row?.name).toBe('Auth Service');
        expect(row?.health_score).toBe(91);
        expect(row?.health_tier).toBe('healthy');
    });

    it('can insert a dependency and retrieve it', () => {
        // Ensure parent services exist first
        const now = new Date().toISOString();
        db.prepare(
            `INSERT OR IGNORE INTO services (id, name, health_score, health_tier, last_ingested)
       VALUES (?, ?, ?, ?, ?)`,
        ).run('svc-a', 'Service A', 80, 'healthy', now);
        db.prepare(
            `INSERT OR IGNORE INTO services (id, name, health_score, health_tier, last_ingested)
       VALUES (?, ?, ?, ?, ?)`,
        ).run('svc-b', 'Service B', 75, 'warning', now);

        db.prepare(
            `INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
       VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('dep-test', 'svc-a', 'svc-b', 'REST', JSON.stringify(['/api/data']), 2);

        const dep = db
            .prepare(`SELECT * FROM dependencies WHERE id = ?`)
            .get('dep-test') as { source_id: string; target_id: string; type: string } | undefined;

        expect(dep).toBeDefined();
        expect(dep?.source_id).toBe('svc-a');
        expect(dep?.target_id).toBe('svc-b');
        expect(dep?.type).toBe('REST');
    });

    it('returns empty array when no services exist', () => {
        clearTestDB();
        const rows = db.prepare(`SELECT * FROM services`).all();
        expect(rows).toEqual([]);
    });

    // ── All remaining tables exist (spot check) ─────────────────────────────────

    it.each([
        'endpoints',
        'adrs',
        'healing_prs',
        'qa_sessions',
        'activity_feed',
        'snapshots',
    ])('table "%s" exists and is queryable', (table) => {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        expect(Array.isArray(rows)).toBe(true);
    });
});
