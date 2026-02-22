/**
 * KA-CHOW SQLite schema.
 * All CREATE TABLE statements live here.
 * Called once by db/index.ts on first startup and by test-helpers in tests.
 *
 * Rule: Never DROP or ALTER tables directly — write a migration in
 * packages/server/src/db/migrations/ instead.
 */

import type Database from 'better-sqlite3';

/**
 * All table names in the KA-CHOW schema.
 * Used by tests to assert every table was created.
 */
export const TABLES = [
    'services',
    'dependencies',
    'incidents',
    'endpoints',
    'impact_analyses',
    'adrs',
    'healing_prs',
    'qa_sessions',
    'activity_feed',
    'snapshots',
] as const;

export type TableName = (typeof TABLES)[number];

/**
 * Runs all DDL statements against the provided database instance.
 * Uses CREATE TABLE IF NOT EXISTS — idempotent and safe to call multiple times.
 *
 * @param db - An initialised better-sqlite3 Database instance
 * @returns void
 * @throws If SQLite reports a syntax or constraint error in the DDL
 */
export function runMigrations(db: Database.Database): void {
    db.exec(`
    -- ── SERVICES (graph nodes) ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS services (
      id            TEXT PRIMARY KEY,           -- slug: 'auth-service'
      name          TEXT NOT NULL,              -- 'Auth Service'
      repo_url      TEXT,                       -- github.com/org/auth-service
      repo_subpath  TEXT,                       -- subdir within monorepo e.g. 'services/blog'
      team          TEXT,                       -- 'platform'
      language      TEXT,                       -- 'typescript'
      health_score  INTEGER DEFAULT 100,        -- 0-100
      health_tier   TEXT    DEFAULT 'healthy',  -- healthy/warning/critical
      doc_coverage  INTEGER DEFAULT 0,          -- % documented
      test_coverage INTEGER DEFAULT 0,          -- % tested
      is_external   INTEGER DEFAULT 0,          -- 1 = unresolved external dep, not a real service
      last_commit   TEXT,                       -- ISO timestamp
      last_ingested TEXT,                       -- ISO timestamp
      created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT    DEFAULT CURRENT_TIMESTAMP
    );

    -- ── DEPENDENCIES (graph edges) ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS dependencies (
      id         TEXT PRIMARY KEY,
      source_id  TEXT REFERENCES services(id),
      target_id  TEXT REFERENCES services(id),
      type       TEXT NOT NULL,             -- REST/Event/gRPC/DB
      endpoints  TEXT,                      -- JSON array of endpoint strings
      strength   INTEGER DEFAULT 1,         -- call frequency weight
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_id, target_id, type)    -- one edge per direction+type pair
    );

    -- ── INCIDENTS ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS incidents (
      id          TEXT PRIMARY KEY,
      service_id  TEXT REFERENCES services(id),
      severity    TEXT NOT NULL,            -- P0/P1/P2/P3
      title       TEXT NOT NULL,
      root_cause  TEXT,
      status      TEXT DEFAULT 'open',      -- open/resolved/postmortem
      occurred_at TEXT NOT NULL,
      resolved_at TEXT,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── ENDPOINTS ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS endpoints (
      id         TEXT PRIMARY KEY,
      service_id TEXT REFERENCES services(id),
      method     TEXT NOT NULL,             -- GET/POST/PUT/DELETE
      path       TEXT NOT NULL,             -- /api/v1/users/:id
      deprecated INTEGER DEFAULT 0,         -- 0 or 1
      has_spec   INTEGER DEFAULT 0,         -- OpenAPI spec exists
      consumers  TEXT,                      -- JSON array of service ids
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(service_id, path, method)      -- one row per service+route+verb
    );

    -- ── IMPACT ANALYSES ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS impact_analyses (
      id           TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL,           -- deprecation/schema-change/delete
      trigger_ref  TEXT NOT NULL,           -- endpoint or schema name
      service_id   TEXT REFERENCES services(id),
      affected     TEXT NOT NULL,           -- JSON: [{id, name, impact_type}]
      risk_score   REAL NOT NULL,           -- 0.0-10.0
      confidence   REAL NOT NULL,           -- 0.0-1.0
      precedent    TEXT,                    -- historical match description
      status       TEXT DEFAULT 'pending',  -- pending/reviewed/actioned
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── ADR DRAFTS ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS adrs (
      id           TEXT PRIMARY KEY,
      analysis_id  TEXT REFERENCES impact_analyses(id),
      title        TEXT NOT NULL,
      context      TEXT NOT NULL,
      decision     TEXT NOT NULL,
      consequences TEXT NOT NULL,
      status       TEXT DEFAULT 'draft',    -- draft/approved/rejected
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── SELF-HEALING PRs ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS healing_prs (
      id            TEXT PRIMARY KEY,
      service_id    TEXT REFERENCES services(id),
      issue_type    TEXT NOT NULL,          -- missing-retry/no-error-handling/etc
      patch         TEXT NOT NULL,          -- the actual code diff
      explanation   TEXT NOT NULL,
      github_pr_url TEXT,
      github_pr_num INTEGER,
      status        TEXT DEFAULT 'open',    -- open/merged/closed
      created_at    TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Q&A HISTORY ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS qa_sessions (
      id            TEXT PRIMARY KEY,
      question      TEXT NOT NULL,
      answer        TEXT NOT NULL,
      citations     TEXT NOT NULL,          -- JSON array of {file, line, snippet}
      related_nodes TEXT NOT NULL,          -- JSON array of service ids
      created_at    TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── ACTIVITY FEED ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS activity_feed (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,             -- commit/health-drop/pr-opened/etc
      service_id TEXT,
      title      TEXT NOT NULL,
      detail     TEXT,
      severity   TEXT DEFAULT 'info',       -- info/warning/critical
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── GRAPH SNAPSHOTS (brownie points — Phase 2) ──────────────────
    CREATE TABLE IF NOT EXISTS snapshots (
      id         TEXT PRIMARY KEY,
      version    TEXT NOT NULL UNIQUE,      -- git tag, 'latest', or ISO timestamp
      nodes      TEXT NOT NULL,             -- JSON: GraphNode[]
      edges      TEXT NOT NULL,             -- JSON: GraphEdge[]
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
