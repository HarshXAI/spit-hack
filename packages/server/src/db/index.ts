/**
 * KA-CHOW database singleton.
 * Returns the same better-sqlite3 instance for the lifetime of the process.
 * In test mode (NODE_ENV=test) uses TEST_DB_PATH (defaults to :memory:).
 */

import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './schema.js';

let _db: Database.Database | null = null;

/**
 * Returns the initialised SQLite database singleton.
 * Creates the database file and runs all migrations on first call.
 * Subsequent calls return the same cached instance.
 *
 * @returns The better-sqlite3 Database instance
 * @throws If the database file cannot be created or migrations fail
 */
export function getDb(): Database.Database {
    if (_db) return _db;

    const isTest = process.env.NODE_ENV === 'test';
    const dbPath = isTest
        ? (process.env.TEST_DB_PATH ?? ':memory:')
        : (process.env.DB_PATH ?? path.resolve(process.cwd(), 'kachow.db'));

    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');

    runMigrations(_db);

    return _db;
}

/**
 * Closes the database connection and clears the singleton.
 * Must be called on graceful shutdown and in test afterAll hooks.
 *
 * @returns void
 */
export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}
