# KA-CHOW Pitch Master Doc

This document consolidates both folders in the workspace:
- kachowpackage (CLI + backend + Python agents)
- precision-canvas (React frontend)

It is structured for pitching: clear narrative, product value, architecture, and demo flow.

---

## 1) One-Liner
KA-CHOW is a drop-in CLI that scans your engineering system, builds a living knowledge graph of services and dependencies, and delivers live impact analysis, Q&A, and self-healing actions through a cinematic UI (including AR/VR visualization).

## 2) The Problem
Engineering systems are distributed across repos, teams, docs, and tribal knowledge. Breakages occur when a change silently ripples across services. The most expensive incidents are not caused by missing code; they are caused by missing context.

## 3) The Solution
KA-CHOW installs via a single command, ingests code and dependencies, and keeps a graph of services, endpoints, incidents, and risks updated in real time. It then exposes that intelligence through:
- A live knowledge graph UI
- Impact analysis and ADR generation
- Q&A with citations
- Self-healing fixes with optional GitHub PRs
- Team onboarding and executive health summaries
- AR/VR 3D visualization for architecture exploration

---

## 4) Product Experience (User Journey)
1. Install and ingest
   - Run `npx kachow init` in any repo
   - Auto-detects services, generates kachow.config.yaml, starts the server, opens the UI
2. Explore the knowledge graph
   - Interactive graph, real-time health, edges by protocol, service ownership
3. Ask the system questions
   - Q&A terminal highlights relevant nodes and shows file citations
4. Simulate a change
   - Impact analysis shows blast radius, risk score, and confidence
5. Fix issues
   - Self-healing suggestions generate patches and optionally open a PR
6. Share architecture
   - Flow view, dependency matrix, blueprint view
   - AR/VR viewer via QR code for mobile
7. Onboard and manage teams
   - Role-based onboarding path and manager pulse summary

---

## 5) System Architecture (Monorepo Overview)

### Workspace layout
- kachowpackage
  - packages/cli
  - packages/server
  - packages/frontend (pointer to precision-canvas)
  - packages/python-agents
- precision-canvas
  - React frontend (Vite, Tailwind, shadcn-ui)
  - AR/VR 3D visualization (Three.js)

### 5.1 CLI (packages/cli)
The CLI is the entry point for onboarding and operational commands.

Commands
- `kachow init` — auto-detects repos, creates config, starts server, triggers ingest, opens UI
- `kachow serve` — starts server without re-ingest
- `kachow scan --path <repo>` — ingest a specific repo
- `kachow health` — prints system health
- `kachow onboard --role <role>` — prints onboarding path
- `kachow blueprint --service <id>` — prints service blueprint
- `kachow reset --force` — deletes local DB
- `kachow analyze --pr <num> --repo <owner/repo>` — CI impact analysis mode

Config
- `kachow.config.yaml` supports:
  - project metadata
  - repo list and language
  - standards (OpenAPI, README, error handling, test coverage)
  - integrations (GitHub, Slack, Jira, Confluence)
  - LLM keys and model selection

### 5.2 Backend (packages/server)
Node.js + TypeScript + Express API server, backed by SQLite and BullMQ.

Core backend subsystems
- Ingestion engine (scans repos, builds graph)
- Graph read APIs (nodes, edges, health, snapshots)
- Impact analysis (blast radius, risk scoring)
- Q&A (LLM-driven with graph context)
- Self-healing (GPT-4o patch generation, optional PR creation)
- Webhooks and CI analysis
- Manager + onboarding APIs
- Architecture flow and blueprint APIs
- SSE streams (activity, health, notifications)

### 5.3 Python Agents (packages/python-agents)
Python AST scanning and dependency analysis used during ingestion.

Capabilities
- Scan imports and HTTP calls
- Detect missing error handling
- Build directed dependency graph with NetworkX
- Emit health signals for backend scoring

### 5.4 Frontend (precision-canvas)
React interface for the full product experience.

Major UI surfaces
- Knowledge graph canvas with animated nodes and edge flows
- Architecture view (flow, matrix, blueprint)
- Impact analysis overlay
- Q&A terminal with citations
- Agent insights panel (architecture, services, self-heal, summary)
- Critical issues dialog and issue detail drawer
- Onboarding experience (welcome, guided tour, role selection, checklist)
- Team join code flow
- AR/VR view via QR code

---

## 6) Data Model (SQLite)
Key tables implemented in `packages/server/src/db/schema.ts`:
- services, dependencies, endpoints
- impact_analyses, adrs
- healing_prs
- qa_sessions
- incidents, activity_feed
- snapshots
- teams, team_members

---

## 7) API Surface (Grouped by Domain)

Ingest and scanning
- POST /api/ingest/repo
- GET /api/ingest/status/:jobId (SSE)
- POST /api/ingest/commit
- POST /api/ingest/github
- GET /api/scanner/status
- POST /api/scanner/scan
- DELETE /api/scanner/reset
- POST /api/agents/analyze
- GET /api/agents/knowledge-graph
- GET /api/agents/analyses
- GET /api/agents/status

Graph and health
- GET /api/graph/nodes
- GET /api/graph/edges
- GET /api/graph/node/:id
- GET /api/graph/health
- GET /api/graph/snapshot/:version
- GET /api/graph/critical-issues

Q&A
- POST /api/qa/query
- GET /api/qa/history
- GET /api/qa/suggestions

Impact analysis
- POST /api/impact/analyze
- POST /api/impact/adr
- GET /api/impact/history

Self-healing
- GET /api/heal/queue
- POST /api/heal/detect
- POST /api/heal/patch
- POST /api/heal/pr
- POST /api/heal/apply-fix

Manager and onboarding
- GET /api/manager/pulse
- GET /api/manager/teams
- POST /api/manager/teams
- DELETE /api/manager/teams/:id
- POST /api/manager/teams/:id/regen
- POST /api/manager/teams/join
- POST /api/manager/teams/:id/members
- GET /api/manager/decisions
- GET /api/onboarding/path/:role

Architecture
- GET /api/architecture/flow
- GET /api/architecture/blueprint/:serviceId
- POST /api/architecture/propose

Webhooks and CI
- POST /api/webhooks/github
- POST /api/ci/analyze-pr
- GET /api/ci/status/:prNumber
- POST /api/github/webhook (legacy)

Notifications
- POST /api/notifications/slack
- POST /api/notifications/jira

Real-time streams (SSE)
- GET /api/stream/activity
- GET /api/stream/health
- GET /api/stream/notifications

---

## 8) Frontend Feature Map (precision-canvas)

Knowledge Graph
- Animated node entrance sequence
- Edge types by protocol (REST, gRPC, event, DB, storage, deploy)
- Drag, pan, zoom
- Critical issue highlighting
- QA-driven node highlight

Architecture View
- Flow view (layered services)
- Dependency matrix
- Service blueprint view

Impact Analysis
- Change type selection
- API-driven risk scoring
- Ripple visualization of affected services
- Precedent recall

Q&A Terminal
- Suggested questions
- Typewriter answer effect
- Inline citations
- Relevant node highlighting

Agent Insights Panel
- Architecture layers and data flows
- Service-level deep analysis
- Self-healing suggestions
- Executive summary tab

Onboarding & Teams
- Welcome screen and guided tour
- Role selection and onboarding checklist
- Team join code modal

Critical Issues
- Aggregated issues from agents, incidents, and healing queue
- Issue detail drawer with fix and notification actions

AR/VR Experience
- 3D graph visualization (Three.js)
- Mobile AR mode with device orientation
- QR code generator for sharing AR viewer

---

## 9) Tech Stack

Backend and CLI
- Node.js + TypeScript
- Express
- SQLite (better-sqlite3)
- BullMQ + Redis (background jobs)
- OpenAI SDK (GPT-4o)
- GitHub REST APIs and webhooks
- Slack + Jira integrations

Python agents
- Python 3
- networkx
- astunparse

Frontend
- React + TypeScript + Vite
- Tailwind CSS + shadcn-ui
- TanStack Query
- Three.js (3D/AR)
- qrcode.react

---

## 10) Demo Script (Pitch Flow)
1. Run CLI: `npx kachow init`
2. Watch ingestion and auto-open UI
3. Show knowledge graph with health ring
4. Open Q&A, ask a risk question
5. Trigger impact analysis and show ripple
6. Open Agent Insights panel for deep findings
7. Use Apply Fix to generate a patch
8. Open Architecture view (flow + blueprint)
9. Open AR View and show QR code

---

## 11) Differentiators
- Full-system knowledge graph rather than single-repo tooling
- Impact analysis before a breaking change reaches production
- Self-healing code generation with optional PR automation
- Live visualization, onboarding, and AR/VR exploration
- Integrated manager pulse and team workflow

---

## 12) What Exists Right Now (Based on Code)
- CLI with init, serve, scan, health, onboarding, blueprint, analyze, reset
- Backend routes for all major phases
- SQLite schema and data persistence
- Python AST scanner + dependency analyzer
- Frontend UI with graph, Q&A, impact analysis, onboarding, agent insights, AR/VR
- API adapter on frontend that targets the backend

---

## 13) How to Run Locally

Backend
- From kachowpackage:
  - `pnpm --filter @kachow/server dev`

CLI
- From kachowpackage:
  - `pnpm --filter @kachow/cli exec tsx src/index.ts init`

Frontend
- From precision-canvas:
  - `bun dev` or `npm run dev`

---

## 14) Appendix: Key Files

kachowpackage
- `packages/cli/src/index.ts` — CLI commands and flow
- `packages/cli/src/config.ts` — config schema and env interpolation
- `packages/server/src/app.ts` — Express app + routes
- `packages/server/src/server.ts` — server entry + workers
- `packages/server/src/db/schema.ts` — SQLite schema
- `packages/python-agents/src/scanner.py` — AST scanner
- `packages/python-agents/src/analyzer.py` — dependency graph builder

precision-canvas
- `src/pages/Index.tsx` — main experience and routing
- `src/components/KnowledgeGraph.tsx` — graph UI
- `src/components/ArchitectureView.tsx` — architecture views
- `src/components/ImpactAnalysis.tsx` — impact UI
- `src/components/QATerminal.tsx` — Q&A terminal
- `src/components/AgentInsightsPanel.tsx` — deep analysis UI
- `src/components/ArchViz3DViewer.tsx` — 3D AR/VR graph
- `src/pages/ARViewer.tsx` — AR viewer page
- `src/components/ARQRGenerator.tsx` — QR generator
- `src/lib/api.ts` — API client adapter

---

If you want this turned into slides, a one-page summary, or a demo script with exact cues, say the word.
