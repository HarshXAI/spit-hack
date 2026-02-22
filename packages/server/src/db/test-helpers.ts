/**
 * KA-CHOW test database helpers.
 * Delegates to the shared getDb() singleton so test code and production routes
 * always operate on the same in-memory SQLite instance.
 * Never import from this file in production code.
 */

import Database from 'better-sqlite3';
import { getDb, closeDb } from './index.js';

/**
 * Returns the shared in-memory test database (same instance used by routes).
 * Migrations are run automatically on first call via getDb().
 *
 * @returns The better-sqlite3 Database instance for tests
 */
export function getTestDb(): Database.Database {
    return getDb();
}

/**
 * Inserts a minimal set of seed data so integration tests have something to read.
 * Safe to call multiple times — uses INSERT OR IGNORE.
 *
 * @returns void
 */
export function seedTestDB(): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
        `INSERT OR IGNORE INTO services
       (id, name, health_score, health_tier, team, language, last_ingested)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('auth-service', 'Auth Service', 91, 'healthy', 'platform', 'typescript', now);

    db.prepare(
        `INSERT OR IGNORE INTO services
       (id, name, health_score, health_tier, team, language, last_ingested)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('inventory-service', 'Inventory Service', 34, 'critical', 'supply-chain', 'typescript', now);

    db.prepare(
        `INSERT OR IGNORE INTO dependencies (id, source_id, target_id, type, endpoints, strength)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('dep-1', 'auth-service', 'inventory-service', 'REST', JSON.stringify(['/api/stock']), 3);
}

/**
 * Deletes all rows from every table in reverse dependency order.
 * Call in afterEach / afterAll to keep tests isolated.
 *
 * @returns void
 */
export function clearTestDB(): void {
    const db = getDb();
    // Delete in reverse FK order to avoid constraint violations
    const tables = [
        'activity_feed',
        'qa_sessions',
        'healing_prs',
        'adrs',
        'impact_analyses',
        'endpoints',
        'incidents',
        'dependencies',
        'services',
    ];
    for (const table of tables) {
        db.prepare(`DELETE FROM ${table}`).run();
    }
}

/**
 * Closes the shared database connection.
 * Call in afterAll to release the in-memory SQLite instance.
 *
 * @returns void
 */
export function closeTestDb(): void {
    closeDb();
}
