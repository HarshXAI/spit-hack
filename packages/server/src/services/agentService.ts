/**
 * AI Agent Service — Phase 10: Deep Analysis Engine.
 *
 * Dispatches specialised LLM agents in parallel to deeply analyse every file
 * in a scanned repository. Each agent has a single focus:
 *
 *   1. DB-Agent           — databases, ORMs, schemas, migrations
 *   2. Routing-Agent      — API routes, middleware, auth guards
 *   3. Dependency-Agent   — inter-service calls, env-vars, SDKs
 *   4. Infra-Agent        — Terraform, Docker, K8s, cloud resources
 *   5. CICD-Agent         — pipelines, deployment stages, secrets
 *   6. Schema-Agent       — data models, validation, DTOs, Protobufs
 *   7. Security-Agent     — auth, secrets, RBAC, vulnerabilities
 *   8. Test-Agent         — test suites, coverage, fixtures, mocks
 *
 * An Orchestrator agent receives all sub-agent outputs and produces:
 *   - Rich knowledge graph (nodes, edges, metadata)
 *   - Architecture layers with real evidence
 *   - Self-healing suggestions with file:line references
 *   - Data-flow diagram
 *
 * Everything is persisted so the frontend can render a proper knowledge graph.
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { serviceIdFromName, walkSourceFiles } from './scannerService.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini'; // fast + cheap for sub-agents
const ORCHESTRATOR_MODEL = 'gpt-4o'; // smarter for synthesis
const MAX_FILE_CHARS = 6000; // per-file content cap sent to agents
const MAX_FILES_PER_AGENT = 30; // max files an agent will read per service
const AGENT_TIMEOUT_MS = 60_000; // 60s per agent call

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    'venv', '.venv', 'env', '.env', 'coverage', '.nyc_output', 'vendor',
    'target', 'out', '.gradle', '.idea', '.vscode', 'bin', 'obj',
    '.terraform', 'terraform.tfstate.d',
]);

const SOURCE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.java', '.kt', '.rs', '.rb',
    '.cs', '.swift', '.scala', '.ex', '.exs',
    '.tf', '.hcl', '.yaml', '.yml', '.toml', '.json',
    '.sql', '.prisma', '.graphql', '.gql', '.proto',
    '.sh', '.bash', '.zsh',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentFinding {
    type: string;         // e.g. 'database', 'route', 'dependency', 'secret', etc.
    name: string;         // short label
    detail: string;       // rich description
    file?: string;        // file path relative to service root
    line?: number;        // line number
    severity?: 'info' | 'warning' | 'critical';
    metadata?: Record<string, unknown>;
}

export interface AgentResult {
    agentName: string;
    serviceId: string;
    serviceName: string;
    findings: AgentFinding[];
    summary: string;
    durationMs: number;
}

export interface KnowledgeEdge {
    sourceId: string;
    targetId: string;
    sourceName: string;
    targetName: string;
    edgeType: string;     // REST, DB, Event, gRPC, Import, Infra, etc.
    label: string;        // human-readable edge label
    evidence: string;     // file:line evidence
    endpoints: string[];
    strength: number;     // 1-5
}

export interface KnowledgeNode {
    id: string;
    name: string;
    type: string;         // service, database, queue, cache, storage, infra, cicd
    language: string;
    description: string;
    techStack: string[];  // e.g. ['FastAPI', 'SQLAlchemy', 'PostgreSQL']
    endpoints: string[];
    databases: string[];
    healthIssues: string[];
    metadata: Record<string, unknown>;
}

export interface OrchestratorResult {
    nodes: KnowledgeNode[];
    edges: KnowledgeEdge[];
    architecture: {
        layers: Array<{ name: string; services: string[]; description: string }>;
        dataFlows: Array<{ from: string; to: string; data: string; protocol: string }>;
    };
    selfHealingSuggestions: Array<{
        serviceId: string;
        serviceName: string;
        issue: string;
        suggestion: string;
        file?: string;
        line?: number;
        severity: 'info' | 'warning' | 'critical';
    }>;
    summary: string;
}

export interface DeepAnalysisResult {
    analysisId: string;
    agentResults: AgentResult[];
    orchestratorResult: OrchestratorResult;
    totalDurationMs: number;
    servicesAnalyzed: number;
    totalFindings: number;
}

// ── File reading helpers ──────────────────────────────────────────────────────

function walkAllFiles(dir: string, maxDepth = 8, depth = 0): string[] {
    if (depth > maxDepth || !fs.existsSync(dir)) return [];
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...walkAllFiles(full, maxDepth, depth + 1));
            } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
                results.push(full);
            }
        }
    } catch { /* permission denied etc. */ }
    return results;
}

function readFileSafe(filePath: string, maxChars = MAX_FILE_CHARS): string {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.length <= maxChars) return content;
        return content.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars, total ${content.length}]`;
    } catch {
        return '';
    }
}

function filterFilesForAgent(files: string[], serviceDir: string, patterns: RegExp[]): Array<{ rel: string; content: string }> {
    const matched = files
        .filter((f) => {
            const rel = path.relative(serviceDir, f).toLowerCase();
            const ext = path.extname(f);
            return patterns.some((p) => p.test(rel) || p.test(path.basename(f)) || p.test(ext));
        })
        .slice(0, MAX_FILES_PER_AGENT);

    return matched.map((f) => ({
        rel: path.relative(serviceDir, f),
        content: readFileSafe(f),
    }));
}

// ── OpenAI client ─────────────────────────────────────────────────────────────

function getOpenAI(): OpenAI {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'your_openai_key_here') {
        throw new Error('OPENAI_API_KEY not set or still placeholder. Set it in .env');
    }
    return new OpenAI({ apiKey, timeout: AGENT_TIMEOUT_MS });
}

async function callAgent(
    systemPrompt: string,
    userContent: string,
    model = MODEL,
): Promise<Record<string, unknown>> {
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 4000,
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return { error: 'Failed to parse agent response', raw };
    }
}

// ── Agent definitions ─────────────────────────────────────────────────────────

interface AgentDef {
    name: string;
    filePatterns: RegExp[];
    systemPrompt: string;
}

const AGENTS: AgentDef[] = [
    {
        name: 'db-agent',
        filePatterns: [
            /model|schema|migration|prisma|entity|orm|database|db|sequelize|typeorm|knex|drizzle|sqlalchemy|alembic|sql/i,
            /\.sql$/, /\.prisma$/, /\.graphql$/, /\.gql$/,
        ],
        systemPrompt: `You are a Database Analysis Agent. You deeply analyze source code to find:
- Database connections (PostgreSQL, MySQL, MongoDB, Redis, SQLite, DynamoDB, etc.)
- ORM models and schemas (Prisma, TypeORM, Sequelize, SQLAlchemy, Mongoose, Drizzle, etc.)
- Migration files and their purposes
- Database relationships (foreign keys, joins, references)
- Connection strings, pool settings, read replicas
- Caching layers (Redis, Memcached)

Return JSON with this exact structure:
{
  "databases": [{"name": "...", "type": "postgres|mysql|mongo|redis|sqlite|dynamodb", "connectionInfo": "...", "file": "...", "line": 0}],
  "models": [{"name": "...", "fields": ["field:type", ...], "relationships": ["hasMany:OtherModel", ...], "file": "...", "line": 0}],
  "migrations": [{"name": "...", "description": "...", "file": "..."}],
  "caches": [{"name": "...", "type": "redis|memcached|in-memory", "file": "..."}],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'routing-agent',
        filePatterns: [
            /route|router|controller|handler|endpoint|api|view|middleware|guard|interceptor|pipe|main|app|server|index/i,
            /\.py$/, /\.ts$/, /\.js$/, /\.go$/, /\.java$/,
        ],
        systemPrompt: `You are a Routing & API Analysis Agent. You deeply analyze source code to find:
- All HTTP routes/endpoints (method, path, handler)
- Middleware chains (auth, logging, rate limiting, CORS)
- Authentication & authorization guards
- Request/response schemas and validation
- WebSocket endpoints
- GraphQL resolvers and queries
- gRPC service definitions
- Route grouping and versioning (v1, v2)

Return JSON with this exact structure:
{
  "routes": [{"method": "GET|POST|PUT|DELETE|PATCH|WS", "path": "/api/...", "handler": "functionName", "auth": true|false, "middleware": ["..."], "file": "...", "line": 0}],
  "middleware": [{"name": "...", "type": "auth|logging|ratelimit|cors|validation|error", "appliedTo": "global|route-specific", "file": "...", "line": 0}],
  "websockets": [{"path": "...", "events": ["..."], "file": "..."}],
  "graphql": [{"type": "query|mutation|subscription", "name": "...", "file": "..."}],
  "apiVersioning": {"strategy": "path|header|none", "versions": ["v1", "v2"]},
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'dependency-agent',
        filePatterns: [
            /service|client|sdk|http|fetch|axios|request|grpc|amqp|kafka|nats|rabbit|queue|event|publish|subscribe|emit|consume|producer|consumer|import|require/i,
            /package\.json$/, /requirements\.txt$/, /pyproject\.toml$/, /go\.mod$/, /Cargo\.toml$/, /pom\.xml$/, /build\.gradle$/,
            /\.env/, /\.env\.example/, /config/i,
        ],
        systemPrompt: `You are a Dependency & Inter-Service Communication Agent. You deeply analyze source code to find:
- HTTP calls to other services (REST, fetch, axios, httpx, requests)
- Environment variable-based service URLs
- Message queue connections (RabbitMQ, Kafka, NATS, SQS, EventBridge)
- gRPC client connections
- Database connections to shared databases
- Third-party API integrations (Stripe, AWS, Twilio, etc.)
- Internal package/module imports
- Shared libraries and utilities

Return JSON with this exact structure:
{
  "serviceCalls": [{"target": "service-name-or-url", "protocol": "REST|gRPC|GraphQL", "method": "GET|POST|...", "path": "/api/...", "file": "...", "line": 0}],
  "messagingConnections": [{"broker": "rabbitmq|kafka|nats|sqs|eventbridge", "topics": ["..."], "role": "producer|consumer|both", "file": "...", "line": 0}],
  "envVarDependencies": [{"varName": "...", "purpose": "service-url|db-connection|api-key|config", "resolvedValue": "...", "file": "...", "line": 0}],
  "thirdPartyAPIs": [{"name": "...", "sdk": "...", "purpose": "...", "file": "..."}],
  "sharedLibraries": [{"name": "...", "version": "...", "purpose": "..."}],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'infra-agent',
        filePatterns: [
            /terraform|\.tf$|docker|compose|kubernetes|k8s|helm|deploy|infrastructure|\.hcl$|kustomize|ansible|pulumi/i,
            /Dockerfile/, /Makefile/, /\.yaml$/, /\.yml$/,
        ],
        systemPrompt: `You are an Infrastructure Analysis Agent. You deeply analyze code to find:
- Terraform resources, providers, modules, variables, outputs
- Docker configurations (Dockerfile stages, compose services, networks, volumes)
- Kubernetes manifests (deployments, services, ingresses, configmaps, secrets)
- Cloud provider resources (AWS, GCP, Azure — specific services used)
- Networking: load balancers, CDN, DNS, VPNs, security groups
- Storage: S3 buckets, EFS, block storage
- Monitoring infrastructure: Prometheus, Grafana, Datadog, CloudWatch

Return JSON with this exact structure:
{
  "terraform": {"providers": ["aws", "..."], "resources": [{"type": "aws_rds_instance", "name": "...", "file": "...", "line": 0}], "modules": [{"name": "...", "source": "...", "file": "..."}], "variables": [{"name": "...", "type": "...", "default": "..."}]},
  "docker": {"services": [{"name": "...", "image": "...", "ports": ["..."], "depends_on": ["..."], "file": "..."}], "networks": ["..."], "volumes": ["..."]},
  "kubernetes": {"resources": [{"kind": "...", "name": "...", "namespace": "...", "file": "..."}]},
  "cloudResources": [{"provider": "aws|gcp|azure", "service": "RDS|S3|Lambda|...", "name": "...", "config": "...", "file": "..."}],
  "monitoring": [{"tool": "prometheus|grafana|datadog|cloudwatch", "config": "...", "file": "..."}],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'cicd-agent',
        filePatterns: [
            /\.github|workflow|ci|cd|pipeline|jenkins|travis|circle|gitlab|azure-pipeline|deploy|release|action/i,
            /\.ya?ml$/,
            /Makefile/,
        ],
        systemPrompt: `You are a CI/CD Pipeline Analysis Agent. You deeply analyze code to find:
- GitHub Actions workflows (triggers, jobs, steps, secrets used)
- GitLab CI pipelines
- Jenkins/Travis/CircleCI configurations
- Deployment stages (dev, staging, production)
- Build steps (lint, test, build, deploy)
- Secrets and environment variables used in CI
- Deployment targets (AWS, Vercel, Netlify, K8s, Docker registry)
- Release strategies (blue-green, canary, rolling)
- Dependency update automation (Dependabot, Renovate)

Return JSON with this exact structure:
{
  "pipelines": [{"name": "...", "platform": "github-actions|gitlab-ci|jenkins|...", "trigger": "push|pr|schedule|manual", "file": "..."}],
  "stages": [{"pipeline": "...", "name": "...", "steps": ["lint", "test", "build", "deploy"], "environment": "dev|staging|prod"}],
  "deploymentTargets": [{"target": "aws-ecs|k8s|vercel|netlify|docker-registry|...", "environment": "...", "pipeline": "..."}],
  "secretsUsed": [{"name": "...", "usedIn": "...", "purpose": "..."}],
  "automations": [{"type": "dependabot|renovate|auto-merge|...", "config": "...", "file": "..."}],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'schema-agent',
        filePatterns: [
            /model|schema|type|interface|dto|entity|struct|class|proto|validation|zod|joi|yup|pydantic|marshmallow|avro/i,
            /\.proto$/, /\.graphql$/, /\.gql$/, /\.prisma$/, /\.json$/, /\.avro$/,
        ],
        systemPrompt: `You are a Data Schema & Model Analysis Agent. You deeply analyze code to find:
- Data models and their fields (types, required/optional, defaults)
- Validation schemas (Zod, Joi, Yup, Pydantic, Marshmallow)
- Protobuf message definitions
- GraphQL type definitions
- TypeScript interfaces and types that represent API contracts
- Database entity definitions
- DTO (Data Transfer Object) patterns
- Schema relationships and references between models

Return JSON with this exact structure:
{
  "models": [{"name": "...", "type": "class|interface|schema|protobuf|graphql", "fields": [{"name": "...", "type": "...", "required": true, "default": null}], "relationships": [{"type": "hasMany|belongsTo|hasOne|references", "target": "..."}], "file": "...", "line": 0}],
  "validations": [{"name": "...", "library": "zod|joi|yup|pydantic|...", "validates": "...", "file": "...", "line": 0}],
  "apiContracts": [{"name": "...", "type": "request|response|event", "schema": "...", "file": "..."}],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'security-agent',
        filePatterns: [
            /auth|security|permission|rbac|jwt|token|secret|encrypt|decrypt|password|hash|cors|csrf|helmet|rate|guard|policy|middleware/i,
            /\.env/, /config/i,
            /\.ts$/, /\.py$/, /\.js$/, /\.go$/, /\.java$/,
        ],
        systemPrompt: `You are a Security Analysis Agent. You deeply analyze code to find:
- Authentication mechanisms (JWT, OAuth, session, API keys, mTLS)
- Authorization patterns (RBAC, ABAC, middleware guards)
- Hardcoded secrets, API keys, or credentials in source code
- Password handling (hashing, salting, bcrypt, argon2)
- Input validation gaps (SQL injection, XSS, command injection risks)
- CORS configuration issues
- Rate limiting configuration
- Security headers (Helmet, CSP)
- Encryption at rest and in transit

Return JSON with this exact structure:
{
  "authentication": [{"method": "jwt|oauth|session|apikey|mtls", "implementation": "...", "file": "...", "line": 0}],
  "authorization": [{"type": "rbac|abac|middleware|decorator", "roles": ["..."], "file": "...", "line": 0}],
  "hardcodedSecrets": [{"type": "api-key|password|token|connection-string", "file": "...", "line": 0, "severity": "critical"}],
  "inputValidation": [{"location": "...", "validated": true|false, "library": "...", "file": "...", "line": 0}],
  "securityHeaders": [{"header": "...", "configured": true|false, "file": "..."}],
  "encryption": [{"type": "at-rest|in-transit|hashing", "algorithm": "...", "file": "..."}],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
    {
        name: 'test-agent',
        filePatterns: [
            /test|spec|__test__|fixture|mock|stub|fake|e2e|integration|unit|conftest|pytest|jest|vitest|mocha|cypress|playwright/i,
            /\.test\.|\.spec\.|_test\.|_spec\./,
        ],
        systemPrompt: `You are a Test & Quality Analysis Agent. You deeply analyze code to find:
- Test files and their types (unit, integration, e2e)
- Test frameworks used (Jest, Vitest, Mocha, Pytest, Go test, JUnit)
- Test coverage (if config or reports exist)
- Test fixtures, mocks, and stubs
- Missing test coverage areas
- E2E test scenarios
- Performance/load tests
- Test utilities and helpers

Return JSON with this exact structure:
{
  "testSuites": [{"name": "...", "type": "unit|integration|e2e|performance", "framework": "jest|vitest|pytest|...", "testCount": 0, "file": "..."}],
  "coverage": {"configured": true|false, "tool": "istanbul|c8|coverage.py|...", "threshold": 0},
  "mocks": [{"name": "...", "targets": ["..."], "file": "..."}],
  "fixtures": [{"name": "...", "purpose": "...", "file": "..."}],
  "missingCoverage": ["area that should be tested but isn't"],
  "issues": [{"issue": "...", "severity": "info|warning|critical", "file": "...", "line": 0}],
  "summary": "one paragraph summary"
}`,
    },
];

// ── Run single agent against a service ────────────────────────────────────────

async function runAgentForService(
    agent: AgentDef,
    serviceDir: string,
    serviceId: string,
    serviceName: string,
    allFiles: string[],
): Promise<AgentResult> {
    const start = Date.now();

    const relevantFiles = filterFilesForAgent(allFiles, serviceDir, agent.filePatterns);

    if (relevantFiles.length === 0) {
        return {
            agentName: agent.name,
            serviceId,
            serviceName,
            findings: [],
            summary: `No relevant files found for ${agent.name}`,
            durationMs: Date.now() - start,
        };
    }

    const fileBlock = relevantFiles
        .map((f) => `=== FILE: ${f.rel} ===\n${f.content}`)
        .join('\n\n');

    const userContent = `Analyze the following files from service "${serviceName}" (directory: ${serviceDir}).
Return structured JSON as described in your instructions.

${fileBlock}`;

    try {
        const response = await callAgent(agent.systemPrompt, userContent);

        // Convert the raw JSON to typed findings
        const findings: AgentFinding[] = [];

        // Extract findings from the agent response based on its structure
        for (const [key, val] of Object.entries(response)) {
            if (key === 'summary' || key === 'issues') continue;
            if (Array.isArray(val)) {
                for (const item of val as Record<string, unknown>[]) {
                    findings.push({
                        type: key,
                        name: (item.name ?? item.method ?? item.type ?? key) as string,
                        detail: JSON.stringify(item),
                        file: (item.file as string) ?? undefined,
                        line: (item.line as number) ?? undefined,
                        severity: 'info',
                        metadata: item,
                    });
                }
            } else if (val && typeof val === 'object') {
                // Nested objects like terraform.resources, docker.services
                for (const [subKey, subVal] of Object.entries(val as Record<string, unknown>)) {
                    if (Array.isArray(subVal)) {
                        for (const item of subVal as Record<string, unknown>[]) {
                            findings.push({
                                type: `${key}.${subKey}`,
                                name: (item.name ?? item.type ?? subKey) as string,
                                detail: JSON.stringify(item),
                                file: (item.file as string) ?? undefined,
                                line: (item.line as number) ?? undefined,
                                severity: 'info',
                                metadata: item,
                            });
                        }
                    }
                }
            }
        }

        // Add issues as findings with severity
        const issues = response.issues as Array<{ issue: string; severity: string; file?: string; line?: number }> ?? [];
        for (const iss of issues) {
            findings.push({
                type: 'issue',
                name: iss.issue,
                detail: iss.issue,
                file: iss.file,
                line: iss.line,
                severity: (iss.severity as 'info' | 'warning' | 'critical') ?? 'warning',
            });
        }

        return {
            agentName: agent.name,
            serviceId,
            serviceName,
            findings,
            summary: (response.summary as string) ?? `${agent.name} analysis complete`,
            durationMs: Date.now() - start,
        };
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'Agent call failed';
        console.error(`[Agent:${agent.name}] Error for ${serviceName}:`, msg);
        return {
            agentName: agent.name,
            serviceId,
            serviceName,
            findings: [{
                type: 'error',
                name: 'Agent Error',
                detail: msg,
                severity: 'warning',
            }],
            summary: `Agent error: ${msg}`,
            durationMs: Date.now() - start,
        };
    }
}

// ── Orchestrator: synthesize all agent outputs ────────────────────────────────

async function runOrchestrator(
    agentResults: AgentResult[],
    serviceInfos: Array<{ id: string; name: string; language: string; dir: string }>,
): Promise<OrchestratorResult> {
    const agentSummaries = agentResults
        .filter((r) => r.findings.length > 0)
        .map((r) => ({
            agent: r.agentName,
            service: r.serviceName,
            serviceId: r.serviceId,
            findingCount: r.findings.length,
            summary: r.summary,
            keyFindings: r.findings.slice(0, 15).map((f) => ({
                type: f.type, name: f.name, detail: f.detail?.slice(0, 300),
                file: f.file, severity: f.severity,
            })),
        }));

    const serviceList = serviceInfos.map((s) => `${s.name} (${s.id}) — ${s.language} at ${s.dir}`).join('\n');

    const userContent = `You are the Orchestrator Agent for KA-CHOW, a knowledge graph platform for microservice architectures.

You are given the outputs from 8 specialized analysis agents that have deeply read every file in a repository.
Your job is to synthesize their findings into:

1. **Knowledge Graph Nodes** — every significant entity (services, databases, queues, caches, infra, CI/CD pipelines, external APIs)
2. **Knowledge Graph Edges** — every connection between entities with evidence (which file/line proves this connection)
3. **Architecture Layers** — organize services into layers (INGRESS, CORE, DOMAIN, INFRA, DATA, CICD) with evidence
4. **Data Flow Diagram** — how data moves through the system (from: X, to: Y, data: "what", protocol: "how")
5. **Self-Healing Suggestions** — concrete issues with file:line references and fix suggestions

SERVICES IN THIS REPOSITORY:
${serviceList}

AGENT ANALYSIS RESULTS:
${JSON.stringify(agentSummaries, null, 1)}

IMPORTANT RULES:
- Every edge MUST have evidence (file and line where the connection is proven)
- Service IDs must use the IDs provided in the service list above
- For infrastructure/database/queue nodes that don't have IDs, generate a descriptive one like "postgres-main" or "redis-cache"
- Strength should be 1-5 based on how strong the coupling is
- Include ALL connections you can infer, even implicit ones (e.g. shared database = coupling)
- Self-healing suggestions should be actionable with specific file references

Return JSON with this exact structure:
{
  "nodes": [{"id": "...", "name": "...", "type": "service|database|queue|cache|storage|infra|cicd|external-api", "language": "...", "description": "one sentence", "techStack": ["..."], "endpoints": ["/api/..."], "databases": ["..."], "healthIssues": ["..."], "metadata": {}}],
  "edges": [{"sourceId": "...", "targetId": "...", "sourceName": "...", "targetName": "...", "edgeType": "REST|DB|Event|gRPC|Import|Infra|Deploy|Monitor", "label": "human readable", "evidence": "file:line", "endpoints": ["/api/..."], "strength": 3}],
  "architecture": {
    "layers": [{"name": "INGRESS|CORE|DOMAIN|INFRA|DATA|CICD", "services": ["service-name", ...], "description": "..."}],
    "dataFlows": [{"from": "...", "to": "...", "data": "what data", "protocol": "REST|gRPC|Kafka|SQL|..."}]
  },
  "selfHealingSuggestions": [{"serviceId": "...", "serviceName": "...", "issue": "...", "suggestion": "...", "file": "...", "line": 0, "severity": "info|warning|critical"}],
  "summary": "overall architecture summary paragraph"
}`;

    try {
        const response = await callAgent(
            'You are an expert software architect who synthesizes analysis results into a comprehensive knowledge graph. Always return valid JSON matching the requested structure.',
            userContent,
            ORCHESTRATOR_MODEL,
        );
        return response as unknown as OrchestratorResult;
    } catch (error) {
        console.error('[Orchestrator] Error:', error);
        // Return a minimal valid result
        return {
            nodes: serviceInfos.map((s) => ({
                id: s.id, name: s.name, type: 'service', language: s.language,
                description: `Service ${s.name}`, techStack: [], endpoints: [],
                databases: [], healthIssues: [], metadata: {},
            })),
            edges: [],
            architecture: { layers: [], dataFlows: [] },
            selfHealingSuggestions: [],
            summary: 'Orchestrator failed — using basic service list',
        };
    }
}

// ── Main entry point: Deep Analysis ──────────────────────────────────────────

export async function runDeepAnalysis(
    repoPath: string,
    serviceRoots: Array<{ id: string; name: string; language: string; dir: string }>,
    teamId?: string,
): Promise<DeepAnalysisResult> {
    const analysisId = randomUUID();
    const startTime = Date.now();

    console.log(`[Agents] Starting deep analysis ${analysisId} for ${serviceRoots.length} services...`);

    // Phase 1: Run all agents in parallel across all services
    const agentPromises: Promise<AgentResult>[] = [];

    for (const svc of serviceRoots) {
        const allFiles = walkAllFiles(svc.dir);
        console.log(`[Agents]   ${svc.name}: ${allFiles.length} files`);

        for (const agent of AGENTS) {
            agentPromises.push(
                runAgentForService(agent, svc.dir, svc.id, svc.name, allFiles),
            );
        }
    }

    // Also run infra + cicd agents on the repo root (for repo-level files)
    const repoRootFiles = walkAllFiles(repoPath, 3); // shallow for root-level
    const repoAgents = AGENTS.filter((a) => ['infra-agent', 'cicd-agent'].includes(a.name));
    for (const agent of repoAgents) {
        agentPromises.push(
            runAgentForService(agent, repoPath, 'repo-root', path.basename(repoPath), repoRootFiles),
        );
    }

    console.log(`[Agents] Dispatching ${agentPromises.length} agent calls in parallel...`);
    const agentResults = await Promise.allSettled(agentPromises);

    const successfulResults: AgentResult[] = agentResults
        .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
        .map((r) => r.value);

    const failedCount = agentResults.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
        console.warn(`[Agents] ${failedCount} agent calls failed`);
    }

    const totalFindings = successfulResults.reduce((sum, r) => sum + r.findings.length, 0);
    console.log(`[Agents] Phase 1 complete: ${successfulResults.length} agents returned ${totalFindings} findings`);

    // Phase 2: Orchestrator synthesizes everything
    console.log(`[Agents] Running orchestrator...`);
    const orchestratorResult = await runOrchestrator(successfulResults, serviceRoots);
    console.log(`[Agents] Orchestrator complete: ${orchestratorResult.nodes.length} nodes, ${orchestratorResult.edges.length} edges`);

    const result: DeepAnalysisResult = {
        analysisId,
        agentResults: successfulResults,
        orchestratorResult,
        totalDurationMs: Date.now() - startTime,
        servicesAnalyzed: serviceRoots.length,
        totalFindings,
    };

    // Phase 3: Persist to DB
    persistAnalysis(result, teamId);

    console.log(`[Agents] Deep analysis ${analysisId} complete in ${result.totalDurationMs}ms`);
    return result;
}

// ── DB persistence ────────────────────────────────────────────────────────────

function persistAnalysis(result: DeepAnalysisResult, teamId?: string): void {
    const db = getDb();

    // Tables already created by schema.ts runMigrations() — no dynamic DDL needed.

    // Store agent results
    const insertAgent = db.prepare(`
        INSERT INTO agent_analyses (id, analysis_id, agent_name, service_id, service_name, findings, summary, duration_ms, team_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const ar of result.agentResults) {
        insertAgent.run(
            randomUUID(), result.analysisId, ar.agentName,
            ar.serviceId, ar.serviceName,
            JSON.stringify(ar.findings), ar.summary, ar.durationMs,
            teamId ?? null,
        );
    }

    // Store orchestrator result (knowledge graph)
    db.prepare(`
        INSERT INTO knowledge_graph (id, analysis_id, nodes, edges, architecture, self_healing, summary, team_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        randomUUID(), result.analysisId,
        JSON.stringify(result.orchestratorResult.nodes),
        JSON.stringify(result.orchestratorResult.edges),
        JSON.stringify(result.orchestratorResult.architecture),
        JSON.stringify(result.orchestratorResult.selfHealingSuggestions),
        result.orchestratorResult.summary,
        teamId ?? null,
    );

    // Now the crucial part: update the REAL graph with the agent-discovered edges
    const orch = result.orchestratorResult;

    // Upsert infrastructure/external nodes the orchestrator discovered
    const upsertSvc = db.prepare(`
        INSERT INTO services (id, name, health_score, health_tier, doc_coverage, test_coverage, is_external, language)
        VALUES (?, ?, ?, ?, 0, 0, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            language = excluded.language,
            updated_at = datetime('now')
    `);

    for (const node of orch.nodes) {
        if (node.type !== 'service') {
            // This is an infra/db/queue/cache node — upsert as external
            const nodeId = serviceIdFromName(node.id);
            const tier = node.healthIssues.length > 0 ? 'warning' : 'healthy';
            upsertSvc.run(nodeId, node.name, node.healthIssues.length > 0 ? 60 : 90, tier, node.language || 'infra');
        }
    }

    // Upsert edges
    const upsertDep = db.prepare(`
        INSERT INTO dependencies (id, source_id, target_id, type, endpoints, strength)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, target_id, type) DO UPDATE SET
            endpoints = excluded.endpoints,
            strength = MAX(strength, excluded.strength),
            created_at = datetime('now')
    `);

    for (const edge of orch.edges) {
        const sourceId = edge.sourceId.length === 12 ? edge.sourceId : serviceIdFromName(edge.sourceId);
        const targetId = edge.targetId.length === 12 ? edge.targetId : serviceIdFromName(edge.targetId);

        // Make sure source and target exist
        const srcExists = db.prepare('SELECT 1 FROM services WHERE id = ?').get(sourceId);
        const tgtExists = db.prepare('SELECT 1 FROM services WHERE id = ?').get(targetId);

        if (!srcExists) {
            upsertSvc.run(sourceId, edge.sourceName, 50, 'warning', 'unknown');
        }
        if (!tgtExists) {
            upsertSvc.run(targetId, edge.targetName, 50, 'warning', 'unknown');
        }

        try {
            upsertDep.run(
                randomUUID(), sourceId, targetId, edge.edgeType,
                JSON.stringify(edge.endpoints), edge.strength,
            );
        } catch { /* duplicate — ignore */ }
    }

    // Store self-healing suggestions in healing_prs
    const insertHealing = db.prepare(`
        INSERT INTO healing_prs (id, service_id, issue_type, patch, explanation, status)
        VALUES (?, ?, ?, '', ?, 'detected')
        ON CONFLICT DO NOTHING
    `);

    for (const suggestion of orch.selfHealingSuggestions) {
        const svcId = suggestion.serviceId.length === 12
            ? suggestion.serviceId
            : serviceIdFromName(suggestion.serviceId);
        const svcExists = db.prepare('SELECT 1 FROM services WHERE id = ?').get(svcId);
        if (svcExists) {
            insertHealing.run(
                randomUUID(), svcId,
                suggestion.issue.slice(0, 50).replace(/\s+/g, '-').toLowerCase(),
                `${suggestion.issue}\n\nSuggestion: ${suggestion.suggestion}${suggestion.file ? `\nFile: ${suggestion.file}${suggestion.line ? `:${suggestion.line}` : ''}` : ''}`,
            );
        }
    }

    // Add activity feed entry
    db.prepare(`
        INSERT INTO activity_feed (id, type, title, detail, severity, team_id)
        VALUES (?, 'DEEP_ANALYSIS', ?, ?, 'info', ?)
    `).run(
        randomUUID(),
        `Deep analysis complete: ${orch.nodes.length} nodes, ${orch.edges.length} edges`,
        `${result.agentResults.length} agents analyzed ${result.servicesAnalyzed} services in ${(result.totalDurationMs / 1000).toFixed(1)}s. Found ${result.totalFindings} findings.`,
        teamId ?? null,
    );
}

// ── Get latest knowledge graph from DB ────────────────────────────────────────

export function getLatestKnowledgeGraph(teamId?: string): OrchestratorResult | null {
    const db = getDb();

    const query = teamId
        ? `SELECT nodes, edges, architecture, self_healing, summary
           FROM knowledge_graph WHERE team_id = ? ORDER BY created_at DESC LIMIT 1`
        : `SELECT nodes, edges, architecture, self_healing, summary
           FROM knowledge_graph ORDER BY created_at DESC LIMIT 1`;

    const row = (teamId
        ? db.prepare(query).get(teamId)
        : db.prepare(query).get()
    ) as {
        nodes: string; edges: string; architecture: string;
        self_healing: string; summary: string;
    } | undefined;

    if (!row) return null;

    try {
        return {
            nodes: JSON.parse(row.nodes),
            edges: JSON.parse(row.edges),
            architecture: JSON.parse(row.architecture),
            selfHealingSuggestions: JSON.parse(row.self_healing),
            summary: row.summary,
        };
    } catch {
        return null;
    }
}

// ── Get agent analysis history ────────────────────────────────────────────────

export function getAgentAnalyses(analysisId?: string, teamId?: string): Array<{
    agentName: string;
    serviceName: string;
    findingCount: number;
    summary: string;
    durationMs: number;
    createdAt: string;
}> {
    const db = getDb();

    let query: string;
    let params: unknown[];

    if (analysisId && teamId) {
        query = `SELECT agent_name, service_name, findings, summary, duration_ms, created_at FROM agent_analyses WHERE analysis_id = ? AND team_id = ? ORDER BY created_at DESC`;
        params = [analysisId, teamId];
    } else if (analysisId) {
        query = `SELECT agent_name, service_name, findings, summary, duration_ms, created_at FROM agent_analyses WHERE analysis_id = ? ORDER BY created_at DESC`;
        params = [analysisId];
    } else if (teamId) {
        query = `SELECT agent_name, service_name, findings, summary, duration_ms, created_at FROM agent_analyses WHERE team_id = ? ORDER BY created_at DESC LIMIT 100`;
        params = [teamId];
    } else {
        query = `SELECT agent_name, service_name, findings, summary, duration_ms, created_at FROM agent_analyses ORDER BY created_at DESC LIMIT 100`;
        params = [];
    }

    const rows = db.prepare(query).all(...params) as Array<{ agent_name: string; service_name: string; findings: string; summary: string; duration_ms: number; created_at: string }>;

    return rows.map((r) => ({
        agentName: r.agent_name,
        serviceName: r.service_name,
        findingCount: (() => { try { return JSON.parse(r.findings).length; } catch { return 0; } })(),
        summary: r.summary,
        durationMs: r.duration_ms,
        createdAt: r.created_at,
    }));
}
