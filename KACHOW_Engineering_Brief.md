⚡ KA-CHOW

Engineering Master Brief

For Copilot  ·  Backend Implementation  ·  Phase-by-Phase API Build Plan

Version 1.0  ·  Tech Stack: Node.js + TypeScript + Python (venv)  ·  LLMs: Claude + GPT-4o

WHO IS READING THIS

This document is a brief for GitHub Copilot (claude-sonnet-4.6 model) acting as the sole backend engineer.

Every instruction is written as if briefing a senior engineer on their first day.

Copilot must follow rules exactly, build one API at a time, test before moving on.

When in doubt: ask. Never assume. Never skip tests. Never install Python packages globally.

1.  PRODUCT VISION — WHAT WE ARE BUILDING
KA-CHOW is an NPM package that installs into any repository and immediately begins building a living knowledge graph of the entire engineering system. It ingests code, APIs, git history, incidents, and documentation. It exposes a React frontend (already built in Lovable) served by a Node.js backend, and communicates with external systems via GitHub, Slack, Jira, and Confluence integrations.

The package ships as a single CLI command. Engineers run it once. It does everything else autonomously.

bash

# Install and run

npx kachow init

# What happens next (automated):

# 1. Scans all repos defined in kachow.config.yaml

# 2. Builds knowledge graph (nodes = services, edges = dependencies)

# 3. Calculates health scores per service

# 4. Starts Express server at localhost:3000

# 5. Opens browser to the React frontend

# 6. Registers GitHub webhooks

# 7. Connects Slack / Jira / Confluence if configured

THE DEMO SCENARIO — February 14th Incident

Company: Orbix (fintech). Valentine's Day. 40% monthly transaction volume.

11:47am — POST /auth/refresh deprecated. 7 services depended on it. Nobody knew.

6 hours of silent failures. $2.3M lost.

KA-CHOW would have caught this at PR merge time with cross-repo impact analysis.

Every API we build must serve this story. Keep it in mind always.

2.  REPOSITORY STRUCTURE
The package is a monorepo. Frontend is already built (Lovable export). Backend is what we build here.

kachow/

├── packages/

│   ├── cli/                    # npx kachow entry point

│   │   ├── src/

│   │   │   ├── index.ts        # CLI commands (init, scan, serve)

│   │   │   └── config.ts       # kachow.config.yaml reader

│   │   └── package.json

│   │

│   ├── server/                 # Express API server

│   │   ├── src/

│   │   │   ├── app.ts          # Express setup

│   │   │   ├── routes/         # All API routes

│   │   │   ├── services/       # Business logic

│   │   │   ├── agents/         # LLM agentic workflows

│   │   │   ├── scanners/       # Code scanning logic

│   │   │   ├── webhooks/       # GitHub/Slack webhook handlers

│   │   │   └── db/             # SQLite schema + queries

│   │   └── package.json

│   │

│   ├── frontend/               # React app (exported from Lovable)

│   │   └── dist/               # Built static files served by Express

│   │

│   └── python-agents/          # Python-based AST scanners

│       ├── venv/               # NEVER install globally

│       ├── requirements.txt

│       └── src/

│           ├── scanner.py      # AST code scanner

│           └── analyzer.py     # Dependency analyzer

│

├── kachow.config.yaml          # User config file

├── package.json                # Root workspace

└── turbo.json                  # Turborepo build config

3.  TECH STACK — EVERY TOOL AND WHY
Layer

Technology + Reason

CLI Entry

Node.js + Commander.js — universal, npx works everywhere

API Server

Express.js + TypeScript — fast to write, typed, familiar

Database

SQLite via better-sqlite3 — zero setup, file-based, fast

Knowledge Graph DB

SQLite with adjacency list — nodes + edges tables

Frontend Serving

Express serves React /dist as static files

Code Scanning (JS/TS)

TypeScript compiler API + custom AST walker

Code Scanning (Python)

Python AST module — ALWAYS in venv, never global

LLM — Q&A + Analysis

Claude claude-sonnet-4-6 via Anthropic SDK

LLM — Code Generation

GPT-4o via OpenAI SDK (self-healing patches)

GitHub Integration

Octokit REST + webhooks via @octokit/webhooks

Slack Integration

Slack Bolt SDK for Node.js

Jira Integration

Jira REST API v3 via axios

Confluence Integration

Confluence REST API v2 via axios

Real-time to Frontend

Server-Sent Events (SSE) — simpler than WS

Task Queue

BullMQ + Redis — for background scanning jobs

Testing

Vitest for unit + supertest for API integration tests

Package Manager

pnpm workspaces — fast, disk efficient

Build

Turborepo — parallel builds across packages

4.  COPILOT OPERATING RULES — NON-NEGOTIABLE
These rules govern every line of code Copilot writes. No exceptions. No shortcuts.

4.1  Environment Rules
🐍  PYTHON: ALWAYS USE VENV

NEVER install Python packages globally. Always: cd packages/python-agents && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt. If you are about to run pip install without activating venv first — STOP and activate it.

📦  NODE: USE PNPM NOT NPM

All Node.js package operations use pnpm. Never use npm install. Use: pnpm add <package> --filter @kachow/server. Every new dependency must be added to the correct package's package.json, never the root.

🔑  ENV VARS: NEVER HARDCODE SECRETS

API keys, tokens, webhook secrets live in .env files only. Use dotenv. .env is in .gitignore. If you see a hardcoded key in any file — stop and move it to .env immediately.

🗄️  DATABASE: MIGRATIONS ONLY

Never modify the SQLite schema by dropping and recreating tables. Write migration files in packages/server/src/db/migrations/. Each migration has an up() and down() function.

4.2  Code Quality Rules
✅  TEST BEFORE MOVING TO NEXT API

Each API endpoint must have: (1) a Vitest unit test for the service logic, (2) a supertest integration test for the route, (3) a manual curl test that Copilot runs and shows the output. If any test fails — fix it before touching the next API.

📝  TYPESCRIPT STRICT MODE

tsconfig.json has strict: true. No 'any' types without a comment explaining why. All function parameters and return types must be explicitly typed. Use Zod for all request body validation.

🔒  ERROR HANDLING ON EVERY EXTERNAL CALL

Every call to GitHub API, Slack, Jira, Confluence, Anthropic, OpenAI must be wrapped in try/catch with typed error handling. Never let an integration failure crash the server. Return structured errors: { error: true, code: 'GITHUB_UNAVAILABLE', message: string }

📏  FILE SIZE LIMIT

No single file exceeds 300 lines. If a file approaches 300 lines — split it. Services go in /services/, helpers in /utils/, types in /types/. One concern per file.

💬  COMMENT EVERY FUNCTION

Every exported function has a JSDoc comment with: @param types, @returns type, @throws conditions, and a one-line description. This is how the knowledge graph documents itself.

4.3  API Contract Rules
📬  STANDARD RESPONSE ENVELOPE

Every API response uses this exact shape: { success: boolean, data: T | null, error: string | null, meta: { timestamp: string, version: string } }. Never return raw data without this envelope.

🔢  HTTP STATUS CODES

200 = success with data. 201 = created. 400 = bad request (validation). 401 = unauthorized. 404 = not found. 409 = conflict. 422 = unprocessable (semantic error). 500 = server error. Never return 200 for errors.

⚡  BUILD ONE API AT A TIME

The workflow is: (1) Read the API spec from this document. (2) Write the route. (3) Write the service. (4) Write the tests. (5) Run tests. (6) Show curl output. (7) Only then ask for the next API. Never build two APIs simultaneously.

5.  DATABASE SCHEMA — COMPLETE
All data lives in a single SQLite file: kachow.db in the project root. Never in memory only.

5.1  Core Tables
sql

-- SERVICES (graph nodes)

CREATE TABLE services (

  id          TEXT PRIMARY KEY,          -- slug: 'auth-service'

  name        TEXT NOT NULL,             -- 'Auth Service'

  repo_url    TEXT,                      -- github.com/org/auth-service

  team        TEXT,                      -- 'platform'

  language    TEXT,                      -- 'typescript'

  health_score INTEGER DEFAULT 100,      -- 0-100

  health_tier TEXT DEFAULT 'healthy',    -- healthy/warning/critical

  doc_coverage INTEGER DEFAULT 0,        -- % documented

  test_coverage INTEGER DEFAULT 0,       -- % tested

  last_commit  TEXT,                     -- ISO timestamp

  last_ingested TEXT,                    -- ISO timestamp

  created_at  TEXT DEFAULT CURRENT_TIMESTAMP

  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP

);

-- DEPENDENCIES (graph edges)

CREATE TABLE dependencies (

  id          TEXT PRIMARY KEY,

  source_id   TEXT REFERENCES services(id),

  target_id   TEXT REFERENCES services(id),

  type        TEXT NOT NULL,             -- REST/Event/gRPC/DB

  endpoints   TEXT,                      -- JSON array of endpoint strings

  strength    INTEGER DEFAULT 1,         -- call frequency weight

  created_at  TEXT DEFAULT CURRENT_TIMESTAMP

);

-- INCIDENTS

CREATE TABLE incidents (

  id          TEXT PRIMARY KEY,

  service_id  TEXT REFERENCES services(id),

  severity    TEXT NOT NULL,             -- P0/P1/P2/P3

  title       TEXT NOT NULL,

  root_cause  TEXT,

  status      TEXT DEFAULT 'open',       -- open/resolved/postmortem

  occurred_at TEXT NOT NULL,

  resolved_at TEXT,

  created_at  TEXT DEFAULT CURRENT_TIMESTAMP

);

-- ENDPOINTS

CREATE TABLE endpoints (

  id          TEXT PRIMARY KEY,

  service_id  TEXT REFERENCES services(id),

  method      TEXT NOT NULL,             -- GET/POST/PUT/DELETE

  path        TEXT NOT NULL,             -- /api/v1/users/:id

  deprecated  INTEGER DEFAULT 0,         -- 0 or 1

  has_spec    INTEGER DEFAULT 0,         -- OpenAPI spec exists

  consumers   TEXT,                      -- JSON array of service ids

  created_at  TEXT DEFAULT CURRENT_TIMESTAMP

);

-- IMPACT ANALYSES

CREATE TABLE impact_analyses (

  id           TEXT PRIMARY KEY,

  trigger_type TEXT NOT NULL,            -- deprecation/schema-change/delete

  trigger_ref  TEXT NOT NULL,            -- endpoint or schema name

  service_id   TEXT REFERENCES services(id),

  affected     TEXT NOT NULL,            -- JSON: [{id, name, impact_type}]

  risk_score   REAL NOT NULL,            -- 0.0-10.0

  confidence   REAL NOT NULL,            -- 0.0-1.0

  precedent    TEXT,                     -- historical match description

  status       TEXT DEFAULT 'pending',   -- pending/reviewed/actioned

  created_at   TEXT DEFAULT CURRENT_TIMESTAMP

);

-- ADR DRAFTS

CREATE TABLE adrs (

  id           TEXT PRIMARY KEY,

  analysis_id  TEXT REFERENCES impact_analyses(id),

  title        TEXT NOT NULL,

  context      TEXT NOT NULL,

  decision     TEXT NOT NULL,

  consequences TEXT NOT NULL,

  status       TEXT DEFAULT 'draft',     -- draft/approved/rejected

  created_at   TEXT DEFAULT CURRENT_TIMESTAMP

);

-- SELF-HEALING PRs

CREATE TABLE healing_prs (

  id           TEXT PRIMARY KEY,

  service_id   TEXT REFERENCES services(id),

  issue_type   TEXT NOT NULL,            -- missing-retry/no-error-handling/etc

  patch        TEXT NOT NULL,            -- the actual code diff

  explanation  TEXT NOT NULL,

  github_pr_url TEXT,

  github_pr_num INTEGER,

  status       TEXT DEFAULT 'open',      -- open/merged/closed

  created_at   TEXT DEFAULT CURRENT_TIMESTAMP

);

-- Q&A HISTORY

CREATE TABLE qa_sessions (

  id           TEXT PRIMARY KEY,

  question     TEXT NOT NULL,

  answer       TEXT NOT NULL,

  citations    TEXT NOT NULL,            -- JSON array of {file, line, snippet}

  related_nodes TEXT NOT NULL,           -- JSON array of service ids

  created_at   TEXT DEFAULT CURRENT_TIMESTAMP

);

-- ACTIVITY FEED

CREATE TABLE activity_feed (

  id           TEXT PRIMARY KEY,

  type         TEXT NOT NULL,            -- commit/health-drop/pr-opened/etc

  service_id   TEXT,

  title        TEXT NOT NULL,

  detail       TEXT,

  severity     TEXT DEFAULT 'info',      -- info/warning/critical

  created_at   TEXT DEFAULT CURRENT_TIMESTAMP

);

6.  IMPLEMENTATION PHASES — BUILD IN THIS EXACT ORDER
Each phase is a complete unit. Finish it entirely, test it, then move to the next. Never start Phase N+1 while Phase N has failing tests.

PHASE 0  PROJECT SCAFFOLDING  -  2 hours

Set up the monorepo, install all dependencies, configure TypeScript, create the SQLite schema, set up the test runner. No APIs yet.

APIs to build: none — structure only

Phase 0 — Copilot Instructions
Create root package.json with pnpm workspaces: ['packages/*']
Create packages/cli/, packages/server/, packages/frontend/, packages/python-agents/
In packages/server/: pnpm add express typescript @types/express better-sqlite3 @types/better-sqlite3 zod dotenv cors
pnpm add -D vitest supertest @types/supertest tsx
Create tsconfig.json with strict: true, target: ES2022, module: NodeNext
Create packages/server/src/db/schema.ts — execute all CREATE TABLE statements
Create packages/server/src/db/index.ts — exports initialized DB singleton
Write ONE test: schema.test.ts — asserts all tables exist
Run: pnpm test — must pass before proceeding
Create packages/python-agents/venv and install: pip install ast-parser networkx
PHASE 1  INGESTION ENGINE — REPO SCANNER  -  4 hours

The brain that reads a repository and populates the graph. This is the most critical phase — everything else depends on it.

APIs to build: POST /api/ingest/repo  ·  GET /api/ingest/status  ·  POST /api/ingest/commit

Phase 1 — API Specs
POST /api/ingest/repo

Body: { repoPath: string, repoUrl?: string, team?: string }

Action: Scans the repo directory, discovers services, maps dependencies, calculates health

Returns: { jobId: string, status: 'started', estimatedSeconds: number }

Background: Runs scan in BullMQ job queue, updates DB incrementally

SSE: Emits progress events to /api/ingest/status/:jobId stream

GET /api/ingest/status/:jobId (SSE)

Type: Server-Sent Events stream

Events: { type: 'progress', phase: string, percent: number, current: string }

Events: { type: 'node-discovered', node: ServiceNode }

Events: { type: 'complete', summary: { services, edges, issues } }

Events: { type: 'error', message: string }

Frontend connects to this and drives the graph build animation

POST /api/ingest/commit

Body: { repoId: string, commitHash: string, changedFiles: string[] }

Action: Re-scans only affected services, updates health scores, adds activity feed entry

Called by: GitHub webhook handler (built in Phase 4)

Returns: { nodesUpdated: number, newIssues: Issue[] }

Phase 1 — Scanner Logic Detail
The scanner must detect these dependency types from source code:

HTTP calls: axios.get/post, fetch(), got(), request() — extract URL patterns, resolve to service
Imports: detect @company/package-name patterns — map to internal services
Event topics: kafkaProducer.send('topic'), consumer.subscribe('topic') — map to event edges
DB connections: DATABASE_URL env var, Prisma schema, Sequelize config — map to DB edges
gRPC: .proto file imports, grpc.loadPackageDefinition() calls
OpenAPI: detect openapi.yaml / swagger.json — extract all endpoint definitions
Phase 1 — Health Score Calculation
Health score = weighted average of these signals:

Signal

Weight + How to detect

Has OpenAPI/Swagger spec

25% — file exists in repo root or /docs

README.md exists and >200 chars

15% — file check + char count

Test coverage >70%

20% — parse coverage reports if present

No deprecated endpoints still being called

20% — cross-ref endpoints table

All external calls have try/catch

10% — AST analysis via Python scanner

No P1 incidents in last 30 days

10% — check incidents table

PHASE 2  GRAPH READ APIs  -  2 hours

The frontend reads the knowledge graph through these APIs. Pure reads — no mutations.

APIs to build: GET /api/graph/nodes  ·  GET /api/graph/edges  ·  GET /api/graph/node/:id  ·  GET /api/graph/health  ·  GET /api/graph/snapshot/:version

Phase 2 — API Specs
GET /api/graph/nodes

Returns: Array of all service nodes with health scores

Shape: { id, name, healthScore, healthTier, team, language, connectionCount, x?, y? }

connectionCount: computed from dependencies table (in + out)

x, y: optional layout hints for frontend positioning

GET /api/graph/edges

Returns: All dependency edges

Shape: { id, sourceId, targetId, type, endpoints[], strength }

type: REST | Event | gRPC | DB

GET /api/graph/node/:id

Returns: Full node detail for sidebar panel

Shape: { service, endpoints[], incidents[], dependsOn[], dependedOnBy[], recentActivity[] }

Used by: Node click handler in the frontend — populates the right slide-in panel

GET /api/graph/health

Returns: Aggregate system health for the topbar ring gauge

Shape: { overallScore, totalServices, critical, warning, healthy, lastUpdated }

Frontend polls this every 30 seconds to update ambient health indicator

GET /api/graph/snapshot/:version (BROWNIE POINTS)

Returns: Graph state at a specific git version/tag

Shape: { nodes[], edges[], version, timestamp }

Powers the timeline slider — dragging changes which snapshot the frontend renders

Snapshots built during ingestion from git log --tags

PHASE 3  Q&A ENGINE — LLM INTEGRATION  -  3 hours

The conversational brain. Uses Claude to answer questions about the codebase with citations to real files.

APIs to build: POST /api/qa/query  ·  GET /api/qa/history  ·  GET /api/qa/suggestions

Phase 3 — The LLM Context Architecture
This is the most technically nuanced phase. The Q&A is NOT a generic chatbot. It is a graph-aware RAG system.

For every question, Copilot must build this context before calling Claude:

typescript

// Context assembly for Claude prompt

const buildContext = async (question: string) => {

  // 1. Extract entity mentions from question

  const mentionedServices = extractServiceMentions(question, allServices);

  // 2. Get full graph context for mentioned services

  const graphContext = await getServiceSubgraph(mentionedServices);

  // 3. Get recent incidents related to mentioned services

  const incidents = await getRecentIncidents(mentionedServices, limit: 5);

  // 4. Get relevant endpoint definitions

  const endpoints = await getServiceEndpoints(mentionedServices);

  // 5. Get actual code snippets (file paths + line ranges)

  const codeSnippets = await getRelevantCodeSnippets(question, mentionedServices);

  // 6. Build structured prompt

  return buildPrompt({ question, graphContext, incidents, endpoints, codeSnippets });

};

POST /api/qa/query

Body: { question: string, sessionId?: string }

Action: Builds graph context, calls Claude claude-sonnet-4-6, returns cited answer

Returns: { answer: string, citations: [{file, line, snippet, serviceId}], relatedNodes: string[], sessionId }

CRITICAL: Answer must include inline citation markers like [1], [2]

CRITICAL: relatedNodes drives which graph nodes glow in the frontend

Model: claude-sonnet-4-6 via @anthropic-ai/sdk

Phase 3 — Claude Prompt Template
prompt

You are KA-CHOW, an engineering knowledge assistant.

You have access to a living knowledge graph of this engineering system.

Answer questions about the codebase with precision.

RULES:

- Every factual claim must cite a source file with [N] markers

- If you don't have evidence, say: 'I don't have data on this'

- Never speculate about code you haven't seen

- Keep answers under 300 words unless complexity demands more

SYSTEM GRAPH:

{{graphContext}}

RECENT INCIDENTS:

{{incidents}}

RELEVANT CODE SNIPPETS:

{{codeSnippets}}

CITATION SOURCES:

{{sourceList}}

QUESTION: {{question}}

Respond with JSON: { answer: string, citationIndices: number[], relatedServiceIds: string[] }

PHASE 4  IMPACT ANALYZER  -  3 hours

The blast radius engine. Given a proposed change, calculate which services break, how badly, and whether it's happened before.

APIs to build: POST /api/impact/analyze  ·  POST /api/impact/adr  ·  GET /api/impact/history

Phase 4 — Impact Algorithm
The impact analysis algorithm is a graph traversal with risk scoring. It is NOT an LLM call — it's deterministic graph analysis, with LLM used only for the explanation text.

typescript

// Impact analysis algorithm

const analyzeImpact = async (changeType: string, targetEndpoint: string, serviceId: string) => {

  // Step 1: Find direct consumers

  const directConsumers = await db.all(

    'SELECT * FROM dependencies WHERE target_id = ? AND endpoints LIKE ?',

    [serviceId, '%' + targetEndpoint + '%']

  );

  // Step 2: BFS traversal — find transitive consumers

  const visited = new Set([serviceId]);

  const queue = [...directConsumers.map(d => d.source_id)];

  const allAffected = [];

  while (queue.length) {

    const current = queue.shift();

    if (visited.has(current)) continue;

    visited.add(current);

    allAffected.push(current);

    const transitive = await db.all(

      'SELECT * FROM dependencies WHERE target_id = ?', [current]

    );

    queue.push(...transitive.map(d => d.source_id));

  }

  // Step 3: Risk score calculation

  const riskScore = calculateRiskScore({

    directCount: directConsumers.length,

    totalAffected: allAffected.length,

    hasTier0Services: allAffected.some(s => s.health_tier === 'critical'),

    hasNoFallback: checkFallbackAbsence(allAffected),

  });

  // Step 4: Check historical precedent

  const precedent = await findHistoricalPrecedent(targetEndpoint, changeType);

  // Step 5: Generate explanation via Claude

  const explanation = await generateImpactExplanation({

    change: { type: changeType, endpoint: targetEndpoint },

    affected: allAffected,

    riskScore,

    precedent,

  });

  return { directConsumers, allAffected, riskScore, confidence: 0.87, precedent, explanation };

};

POST /api/impact/analyze

Body: { serviceId: string, changeType: 'deprecate'|'schema-change'|'delete', targetEndpoint: string }

Action: BFS graph traversal + risk score + historical precedent check

Returns: { analysisId, directImpact[], indirectImpact[], riskScore, confidence, precedent, explanation }

Side effect: Writes to impact_analyses table, emits SSE event to manager UI

Also: The ripple animation in the frontend is driven by the order of directImpact[] array

POST /api/impact/adr

Body: { analysisId: string }

Action: Uses Claude to generate a formatted ADR document from the impact analysis

Returns: { adrId, title, context, decision, consequences, alternatives }

Stores in adrs table with status: 'draft'

Side effect: Appears in manager Decision Queue immediately

PHASE 5  SELF-HEALING ENGINE  -  4 hours

The autonomous fixer. Detects code issues, generates patches using GPT-4o, opens real GitHub PRs.

APIs to build: POST /api/heal/detect  ·  POST /api/heal/patch  ·  POST /api/heal/pr  ·  GET /api/heal/queue

Phase 5 — Issue Detection Patterns
Self-healing detects these specific patterns using AST analysis:

Issue Type

Detection Method + Auto-fix

Missing retry on external call

AST: axios/fetch call outside retry wrapper → Add exponential backoff

Missing try/catch on external call

AST: async call without surrounding try/catch → Wrap with typed catch

Deprecated endpoint still called

Cross-ref: endpoint.deprecated=1 AND dependencies.endpoints contains it → Add deprecation warning + migration comment

Missing OpenAPI spec

File check: no openapi.yaml → Generate spec from route definitions

Unhandled promise rejection

AST: .then() without .catch() → Add .catch() handler

No timeout on HTTP call

AST: axios call without timeout config → Add { timeout: 5000 }

POST /api/heal/pr

Body: { healingPrId: string }

Action: Takes generated patch from heal/patch, creates real GitHub PR via Octokit

Steps: (1) Create branch, (2) Commit patch file, (3) Open PR with description

PR description includes: issue type, affected service, link to KA-CHOW analysis

Returns: { prUrl, prNumber, branch }

CRITICAL: The GitHub PR must be real and openable during the demo

Phase 5 — GPT-4o Patch Generation Prompt
prompt

You are a senior software engineer generating a targeted code fix.

ISSUE: {{issueType}}

SERVICE: {{serviceName}}

FILE: {{filePath}}

CURRENT CODE (lines {{startLine}}-{{endLine}}):

{{currentCode}}

GENERATE:

1. The exact replacement code (same indentation, minimal changes)

2. A one-paragraph explanation of what you changed and why

3. Whether tests need updating (yes/no + what to change)

OUTPUT FORMAT: JSON only

{ patchedCode: string, explanation: string, testsNeedUpdate: boolean, testSuggestion: string }

RULES:

- Change ONLY what is necessary to fix the issue

- Preserve all existing functionality

- Do not add unnecessary dependencies

- The patch must be production-ready

PHASE 6  GITHUB WEBHOOKS + CI INTEGRATION  -  3 hours

The always-watching sentinel. Every PR, every push, every merge is intercepted and analyzed.

APIs to build: POST /api/webhooks/github  ·  POST /api/ci/analyze-pr  ·  GET /api/ci/status/:prNumber

Phase 6 — Webhook Event Handlers
POST /api/webhooks/github

Validates: X-Hub-Signature-256 header (GITHUB_WEBHOOK_SECRET env var)

Routes by event type:

  push → triggers POST /api/ingest/commit for changed files

  pull_request (opened/synchronize) → triggers POST /api/ci/analyze-pr

  pull_request (merged) → triggers full re-ingestion of affected services

  pull_request_review → updates PR status in healing_prs table

Always returns 200 immediately, processes async

POST /api/ci/analyze-pr

Body: { prNumber, repoFullName, headSha, changedFiles[], prDiff }

Action: Full impact analysis on PR changes, posts comment to GitHub PR

GitHub comment format: Service affected, blast radius count, risk score, historical precedent

If risk score > 7: Adds 'kachow-review-required' label to PR

Returns: { comment: string, riskScore, affected[], blocked: boolean }

DEMO MOMENT: This comment appears on a real GitHub PR during the demo

PHASE 7  SLACK + JIRA + CONFLUENCE INTEGRATIONS  -  3 hours

The communication layer. KA-CHOW intelligence surfaces in the tools engineers already use.

APIs to build: POST /api/integrations/slack/notify  ·  POST /api/integrations/jira/incident  ·  POST /api/integrations/confluence/sync

Phase 7 — Slack Notifications
Slack Alert Types

HEALTH DROP: Service health drops >20 points → #engineering-alerts channel

HIGH RISK PR: PR with risk score >7 opened → team's channel

SELF-HEALING PR: KA-CHOW opened a fix PR → team's channel

P1 INCIDENT: New P1 incident detected → #incidents channel

Each message: Service name, issue, risk score, link to KA-CHOW graph node

Use Slack Block Kit for rich formatting — not plain text

Jira Integration

When P1 incident created in KA-CHOW: Auto-create Jira ticket in configured project

Fields: Summary, Description (with graph context), Priority, Labels: ['kachow-detected']

Bidirectional: When Jira ticket resolved, update incident status in KA-CHOW DB

Config: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env

Confluence Integration

PULL: Read existing service pages from Confluence during ingestion

Compare: Confluence description vs. actual code behavior (via Claude)

Flag discrepancies as documentation health deductions

PUSH: When ADR approved in KA-CHOW, write to Confluence ADR space

Config: CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN in .env

PHASE 8  MANAGER APIs + ONBOARDING APIs  -  2 hours

The manager-facing intelligence and the new engineer onboarding path generator.

APIs to build: GET /api/manager/pulse  ·  GET /api/manager/teams  ·  GET /api/manager/decisions  ·  GET /api/onboarding/path/:role

GET /api/manager/pulse

Returns: { overallScore, plainEnglishSummary, topIssues[], teamBreakdown[] }

plainEnglishSummary: Generated by Claude from current health data

Prompt: 'You are briefing a VP of Engineering. In 3 sentences max, summarize the system health.'

Frontend: Large number + paragraph in manager left panel

GET /api/onboarding/path/:role

Role: backend-engineer | sre | engineering-manager

Returns: Ordered learning path for that role

Shape: { steps: [{ serviceId, title, description, keyFiles[], starterTasks[], estimatedMinutes }] }

keyFiles: Actual file paths from the ingested repo

starterTasks: GitHub Issues tagged 'good-first-issue' filtered by service

Powers the guided graph tour and the checklist in onboarding screen

PHASE 9  ARCHITECTURE DIAGRAM APIs  -  2 hours

The visual architecture intelligence — flow views, service blueprints, and AI-proposed architectures.

APIs to build: GET /api/architecture/flow  ·  GET /api/architecture/blueprint/:serviceId  ·  POST /api/architecture/propose

GET /api/architecture/flow

Returns: Services organized into layers for the flow diagram view

Shape: { layers: [{ name: string, services: Service[] }] }

Layer detection: INGRESS (API Gateway, CDN), CORE (Auth, Users), DOMAIN (Payments, Inventory), INFRA

Layer is detected from: service name patterns, dependency direction (in-degree vs out-degree)

GET /api/architecture/blueprint/:serviceId

Returns: Complete blueprint for a single service

Shape: { service, endpoints[], dependsOn[], dependedOnBy[], incidents[], docCoverage, standardsCompliance[] }

standardsCompliance: Array of { standard, passing, violation? } objects

Powers the 'Service Blueprint' view in the architecture screen

POST /api/architecture/propose (BROWNIE POINTS)

Body: { requirement: string } — natural language requirement

Example: 'Add a recommendation engine that reads user history and calls notification service'

Action: Claude generates proposed service design, integration points, tech stack

Returns: { proposedService: { name, dependencies[], techStack, folderStructure, adraft } }

Frontend: Renders proposed service as dashed-border node on the graph canvas

PHASE 10  REAL-TIME SSE + ACTIVITY FEED  -  2 hours

The live nervous system. Everything that happens in the backend surfaces to the frontend in real-time.

APIs to build: GET /api/stream/activity  ·  GET /api/stream/health  ·  GET /api/stream/notifications

Server-Sent Events Architecture

All real-time updates use SSE — not WebSockets. Simpler, HTTP-based, works through proxies.

GET /api/stream/activity — scrolling feed in left sidebar, new events every 30s

GET /api/stream/health — health score updates, polled every 30s by frontend health ring

GET /api/stream/notifications — PR opened, health drops, self-healing actions

Each SSE connection held open with heartbeat ping every 15s

Frontend EventSource API connects to these on page load

7.  CLI COMMANDS — THE PACKAGE INTERFACE
These are the commands available when someone installs KA-CHOW. They must be simple, memorable, and self-explanatory.

bash

# Initialize KA-CHOW in a repository

npx kachow init

# → reads kachow.config.yaml

# → runs full ingestion

# → starts server at localhost:3000

# → opens browser

# Scan a specific repo path

npx kachow scan --path ./services/auth-service

# Start the server without re-scanning

npx kachow serve

# Run in CI mode (no browser, JSON output only)

npx kachow analyze --pr <PR_NUMBER> --repo <owner/repo>

# Check health of current system

npx kachow health

# Open the onboarding flow for a new engineer

npx kachow onboard --role backend-engineer

# Generate architecture blueprint for a service

npx kachow blueprint --service auth-service

# Reset the knowledge database

npx kachow reset

7.1  kachow.config.yaml — Full Schema
yaml

# kachow.config.yaml

version: 1

project:

  name: 'Orbix Platform'

  description: 'Fintech microservices platform'

repos:

  - name: auth-service

    path: ./services/auth-service      # local path OR

    url: github.com/orbix/auth-service # remote URL

    team: platform

    language: typescript

  - name: payments-api

    path: ./services/payments-api

    team: payments

    language: python

standards:

  require_openapi_spec: true

  require_readme: true

  require_error_handling: true

  min_test_coverage: 70

  require_retry_on_external_calls: true

integrations:

  github:

    token: ${GITHUB_TOKEN}

    webhook_secret: ${GITHUB_WEBHOOK_SECRET}

    block_high_risk_prs: true

    risk_score_threshold: 7

  slack:

    bot_token: ${SLACK_BOT_TOKEN}

    channels:

      alerts: '#engineering-alerts'

      incidents: '#incidents'

      team_platform: '#platform-team'

      team_payments: '#payments-team'

  jira:

    base_url: https://orbix.atlassian.net

    email: ${JIRA_EMAIL}

    token: ${JIRA_API_TOKEN}

    project_key: ENG

  confluence:

    base_url: https://orbix.atlassian.net/wiki

    token: ${CONFLUENCE_TOKEN}

    adr_space: ADRS

llm:

  anthropic_key: ${ANTHROPIC_API_KEY}

  openai_key: ${OPENAI_API_KEY}

  qa_model: claude-sonnet-4-6

  healing_model: gpt-4o

8.  TESTING STRATEGY
Every API has three test types. All must pass before Copilot proceeds to the next phase.

Test Type

What it tests + How to run

Unit (Vitest)

Service logic in isolation. Mock DB and external APIs. Run: pnpm test --filter @kachow/server

Integration (supertest)

Full HTTP request/response cycle with real SQLite test DB. Run: pnpm test:integration

Manual (curl)

Copilot runs actual curl command and pastes output in chat before proceeding

E2E (Phase 10 only)

Frontend → Backend full flow. Playwright test. Run: pnpm test:e2e

8.1  Example Test File Structure
typescript

// packages/server/src/routes/__tests__/graph.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import request from 'supertest';

import { app } from '../../app';

import { seedTestDB, clearTestDB } from '../../db/test-helpers';

describe('GET /api/graph/nodes', () => {

  beforeAll(async () => {

    await seedTestDB();  // Insert known test data

  });

  afterAll(async () => {

    await clearTestDB();

  });

  it('returns all service nodes with health scores', async () => {

    const res = await request(app).get('/api/graph/nodes');

    expect(res.status).toBe(200);

    expect(res.body.success).toBe(true);

    expect(res.body.data).toBeInstanceOf(Array);

    expect(res.body.data[0]).toHaveProperty('healthScore');

    expect(res.body.data[0]).toHaveProperty('healthTier');

  });

  it('returns 200 with empty array when no services ingested', async () => {

    await clearTestDB();

    const res = await request(app).get('/api/graph/nodes');

    expect(res.status).toBe(200);

    expect(res.body.data).toEqual([]);

  });

});

9.  FRONTEND INTEGRATION — HOW LOVABLE CONNECTS TO BACKEND
The frontend (built in Lovable) will be exported as a React app. The Express server serves it as static files AND provides all the APIs it calls.

Integration Architecture

In development: Frontend on port 5173 (Vite), Backend on port 3000. CORS enabled for localhost:5173

In production (demo): Express serves React /dist at root (/). All /api/* routes still work.

Frontend environment variable: VITE_API_BASE_URL=http://localhost:3000

All API calls from frontend use: fetch(`${import.meta.env.VITE_API_BASE_URL}/api/...`)

9.1  Frontend API Call Map — Which UI Action Calls Which API
UI Event

API Called

App loads

GET /api/graph/nodes + GET /api/graph/edges + GET /api/graph/health

Node clicked

GET /api/graph/node/:id

'/' pressed (Q&A)

POST /api/qa/query (streaming)

Timeline slider dragged

GET /api/graph/snapshot/:version

'Run Impact Analysis' clicked

POST /api/impact/analyze

'Generate ADR' clicked

POST /api/impact/adr

Notification bell clicked

GET /api/heal/queue

Manager page loads

GET /api/manager/pulse + GET /api/manager/teams + GET /api/manager/decisions

Architecture page loads

GET /api/architecture/flow

Service selected in blueprint

GET /api/architecture/blueprint/:serviceId

New Engineer Mode clicked

GET /api/onboarding/path/:role

Activity feed (left sidebar)

GET /api/stream/activity (SSE)

Health ring (topbar)

GET /api/stream/health (SSE, every 30s)

10.  HOW COPILOT MUST WORK — THE EXACT WORKFLOW
Read this section before writing any code. This is the operating procedure.

THE BUILD LOOP — Follow This For Every Single API

STEP 1: Read the API spec from this document completely before writing any code

STEP 2: Write the Zod validation schema for the request body

STEP 3: Write the service function with full TypeScript types and JSDoc

STEP 4: Write the Express route handler calling the service

STEP 5: Write the unit test for the service function

STEP 6: Write the integration test for the route

STEP 7: Run pnpm test — paste the output in chat

STEP 8: Run the manual curl command — paste the output in chat

STEP 9: Only after ALL tests pass — say 'Phase X API Y complete. Ready for next?'

STEP 10: Wait for confirmation before proceeding

WHEN COPILOT IS STUCK — Decision Tree

Can't figure out the AST parsing approach? → Use the Python scanner in venv, call it as a subprocess

GitHub API returning 403? → Check token scopes. Need: repo, pull_requests, issues, webhooks

SSE connection dropping? → Add heartbeat: setInterval(() => res.write(':ping\n\n'), 15000)

Claude API rate limit? → Add exponential backoff: 1s, 2s, 4s, 8s, max 32s

SQLite concurrency issue? → Use better-sqlite3 synchronous API — it handles concurrent reads fine

Test DB polluting real DB? → Use separate kachow-test.db file, set via TEST_DB_PATH env var

10.1  Environment Setup — First Commands To Run
bash

# 1. Clone / create the repo

git init kachow && cd kachow

# 2. Install pnpm globally (once only)

npm install -g pnpm

# 3. Create workspace structure

mkdir -p packages/{cli,server,frontend,python-agents}

# 4. Root package.json

echo '{"name":"kachow","private":true,"workspaces":["packages/*"]}'  > package.json

# 5. Install server dependencies

cd packages/server

pnpm init

pnpm add express typescript @types/express better-sqlite3 zod dotenv cors

pnpm add @anthropic-ai/sdk openai @octokit/rest @octokit/webhooks

pnpm add @slack/bolt bullmq axios yaml

pnpm add -D vitest supertest @types/supertest tsx @types/node

# 6. Python venv setup

cd ../python-agents

python3 -m venv venv

source venv/bin/activate  # On Windows: venv\Scripts\activate

pip install ast-parser networkx

deactivate

# 7. Create .env

cat > ../../.env << 'EOF'

ANTHROPIC_API_KEY=your_key_here

OPENAI_API_KEY=your_key_here

GITHUB_TOKEN=your_token_here

GITHUB_WEBHOOK_SECRET=your_secret_here

SLACK_BOT_TOKEN=your_token_here

PORT=3000

DB_PATH=./kachow.db

TEST_DB_PATH=./kachow-test.db

EOF

11.  DEMO READINESS CHECKLIST
Before the hackathon demo, every item on this list must be verified working. Copilot runs this checklist as the final phase.

P0 — MUST WORK OR DEMO FAILS

☐ npx kachow init on a real GitHub repo completes without errors

☐ Knowledge graph appears at localhost:3000 with real data from the repo

☐ Clicking any node opens the detail panel with real service info

☐ Q&A returns answers with real file:line citations

☐ Impact analysis ripple fires and shows correct affected services

☐ Self-healing PR opens on real GitHub and is visible at the URL

☐ GitHub webhook receives PR event and posts CI comment on the PR

☐ Manager view at /manager shows real health data

P1 — HIGH VALUE, SHOULD WORK

☐ Timeline slider changes graph to historical version

☐ Architecture flow view shows left-to-right service layers

☐ Onboarding tour plays correctly for backend-engineer role

☐ Slack sends health alert when service health drops

☐ ADR draft generated and appears in manager decision queue

☐ VSCode deep link opens correct file at correct line

☐ Activity feed in left sidebar shows live events

P2 — BROWNIE POINTS

☐ Architecture proposal from natural language creates dashed node on graph

☐ Confluence sync pulls existing docs and flags discrepancies

☐ Jira ticket auto-created when P1 incident detected

☐ Cross-repo impact analysis across multiple repos in kachow.config.yaml

KA-CHOW Engineering Brief v1.0  ·  Paste into any Copilot session to restore full context  ·  Built to win