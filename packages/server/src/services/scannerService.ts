/**
 * KA-CHOW Repository Scanner.
 *
 * Capabilities:
 *  \u2022 Monorepo awareness \u2014 discovers every service under services/, packages/, apps/, etc.
 *  \u2022 Multi-language      \u2014 TypeScript, JavaScript, Python, Go, Java, Rust, Ruby, PHP
 *  \u2022 Infrastructure      \u2014 Terraform resource detection, Docker Compose, Kubernetes
 *  \u2022 Health scoring      \u2014 OpenAPI, README, tests, CI/CD, Docker, linting, secrets
 *  \u2022 Endpoint detection  \u2014 Express, Fastify, Hapi, NestJS, Flask, FastAPI, Gin, Echo,
 *                          Spring MVC, Actix
 *  \u2022 Dependency mapping  \u2014 HTTP calls, env-var service refs, RabbitMQ, Kafka, gRPC, DB
 *  \u2022 Git metadata        \u2014 repo URL, subpath, last-commit timestamp per service
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

// \u2500\u2500 Public types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ScannedService {
    id: string;
    name: string;
    repoPath: string;
    repoUrl: string | null;
    repoSubpath: string | null;
    team: string | null;
    language: SupportedLanguage;
    healthScore: number;
    docCoverage: number;
    testCoverage: number;
    lastCommit: string | null;
    endpoints: ScannedEndpoint[];
    rawIssues: string[];
}

export interface ScannedEndpoint {
    path: string;
    method: string;
    deprecated: boolean;
    hasOpenApiSpec: boolean;
}

export interface ScannedDependency {
    sourceId: string;
    targetName: string;
    targetUrl: string;
    type: 'REST' | 'Event' | 'gRPC' | 'DB' | 'infra';
    endpoints: string[];
}

export interface ScanResult {
    services: ScannedService[];
    dependencies: ScannedDependency[];
    issues: string[];
}

export type SupportedLanguage =
    | 'typescript' | 'javascript'
    | 'python' | 'go' | 'java' | 'rust'
    | 'ruby' | 'php' | 'infra' | 'unknown';

// \u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    'venv', '.venv', 'env', '.env', 'coverage', '.nyc_output', 'vendor',
    'target', 'out', '.gradle', '.idea', '.vscode', 'bin', 'obj',
    'terraform.tfstate.d', '.terraform',
]);

const SOURCE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.java', '.kt', '.rs', '.rb', '.php',
]);

const SERVICE_MARKERS = [
    'package.json', 'go.mod', 'Cargo.toml', 'pom.xml',
    'build.gradle', 'build.gradle.kts', 'setup.py',
    'pyproject.toml', 'requirements.txt', 'Gemfile', 'composer.json',
];

const WORKSPACE_CONTAINER_NAMES = new Set([
    'services', 'packages', 'apps', 'microservices',
    'modules', 'libs', 'src', 'cmd', 'internal',
    'frontends', 'infrastructure', 'monitoring', 'orchestration',
    'data', 'scripts', 'deploy', 'deployments',
]);

const MONOREPO_ROOT_MARKERS = [
    'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json',
];

// \u2500\u2500 Regex patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const HTTP_CALL_RE = /(?:axios|got|request)\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*[`'""]([^`'"]+)[`'""]/g;
const FETCH_RE = /fetch\s*\(\s*[`'""]([^`'"\s]+)[`'""]/g;
const REQUESTS_RE = /requests\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*["']([^"\']+)["']/g;
const HTTPX_RE = /httpx\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*["']([^"\']+)["']/g;
const GO_HTTP_RE = /http\s*\.\s*(?:Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g;
const ENV_VAR_HTTP_RE = /(?:axios|got|request|fetch)\s*(?:\.\s*(?:get|post|put|patch|delete)\s*)?\(\s*`\s*\$\{process\.env\.([A-Za-z_]+)\}([^`]*)`/g;
const AMQP_LITERAL_RE = /channel\s*\.\s*(?:sendToQueue|publish|assertQueue|consume|bindQueue)\s*\(\s*[`'""]([^`'"]+)[`'""]/g;
const AMQP_VAR_RE = /channel\s*\.\s*(?:sendToQueue|publish|assertQueue|consume|bindQueue)\s*\(\s*(\w+)/g;
const AMQP_WRAPPER_RE = /(?:publish|send|enqueue)To(?:Queue|Topic|Exchange)\s*\(\s*[`'""]([^`'"]+)[`'""]/gi;
const KAFKA_PRODUCER_RE = /producer\.send\s*\(\s*\{\s*topic:\s*[`'""]([^`'"]+)[`'""]/g;
const KAFKA_CONSUMER_RE = /consumer\.subscribe\s*\(\s*\{\s*topics?:\s*[`'"\[[]([^`'"\]]+)[`'"]/g;
const NATS_RE = /nc\.publish\s*\(\s*[`'""]([^`'"]+)[`'""]/g;
const GRPC_RE = /loadPackageDefinition|\.proto[`'""]/g;
const DB_URL_RE = /DATABASE_URL|Prisma|Sequelize|createConnection|mongoose\.connect|psycopg2|asyncpg|sqlalchemy|GORM|diesel/g;

const EXPRESS_RE = /(?:router|app|fastify|server)\s*\.\s*(get|post|put|patch|delete|all|route)\s*\(\s*[`'""]([^`'"]+)[`'""]/gi;
const NESTJS_RE = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:[`'""]([^`'"]*)[`'"])?\s*\)/gi;
const FLASK_RE = /@(?:app|blueprint|bp|\w+_bp)\s*\.route\s*\(\s*[`'""]([^`'"]+)[`'""]/gi;
const FASTAPI_RE = /@(?:app|router|api_router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*[`'""]([^`'"]+)[`'""]/gi;
const GIN_RE = /(?:r|router|e|mux|v\d|api)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*"([^"]+)"/g;
const SPRING_RE = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?[`'""]([^`'"]+)[`'""]/gi;
const ACTIX_RE = /#\[\s*(get|post|put|patch|delete|options|head)\s*\(\s*"([^"]+)"\s*\)\s*\]/gi;
const HAPI_METHOD_RE = /method\s*:\s*[`'""]([A-Z]+)[`'""]/g;
const HAPI_PATH_RE = /path\s*:\s*[`'""]([^`'"]+)[`'""]/g;

// \u2500\u2500 Utility helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function walkDir(dir: string, maxDepth = 12, _depth = 0): string[] {
    if (_depth > maxDepth) return [];
    const results: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkDir(full, maxDepth, _depth + 1));
        } else {
            results.push(full);
        }
    }
    return results;
}

function readSafe(filePath: string): string {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

export function serviceIdFromName(name: string): string {
    return crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
}

function extractHostname(rawUrl: string): string {
    const cleaned = rawUrl.replace(/\$\{[^}]+\}/g, 'placeholder');
    try { return new URL(cleaned).hostname; } catch { return rawUrl.split('/')[0] ?? rawUrl; }
}

// \u2500\u2500 Git helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface GitInfo { gitRoot: string | null; repoUrl: string | null; }

function detectGitInfo(dir: string): GitInfo {
    try {
        const gitRoot = fs.realpathSync(
            execSync('git rev-parse --show-toplevel', { cwd: dir, stdio: 'pipe' }).toString().trim()
        );
        let repoUrl: string | null = null;
        try {
            repoUrl = execSync('git remote get-url origin', { cwd: dir, stdio: 'pipe' })
                .toString().trim()
                .replace(/\.git$/, '')
                .replace(/^git@([^:]+):(.+)$/, 'https://$1/$2');
        } catch { /* no remote */ }
        return { gitRoot, repoUrl };
    } catch { return { gitRoot: null, repoUrl: null }; }
}

function detectLastCommit(dir: string): string | null {
    try {
        return execSync('git log -1 --format="%ci" -- .', { cwd: dir, stdio: 'pipe' }).toString().trim() || null;
    } catch { return null; }
}

// \u2500\u2500 Language detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectLanguage(allFiles: string[]): SupportedLanguage {
    const exts = new Set(allFiles.map((f) => path.extname(f)));
    const bases = new Set(allFiles.map((f) => path.basename(f)));
    if (bases.has('tsconfig.json') || exts.has('.ts') || exts.has('.tsx')) return 'typescript';
    if (bases.has('package.json') || exts.has('.js') || exts.has('.jsx')) return 'javascript';
    if (bases.has('go.mod') || exts.has('.go')) return 'go';
    if (bases.has('Cargo.toml') || exts.has('.rs')) return 'rust';
    if (bases.has('pom.xml') || bases.has('build.gradle') || exts.has('.java') || exts.has('.kt')) return 'java';
    if (exts.has('.py') || bases.has('setup.py') || bases.has('pyproject.toml') || bases.has('requirements.txt')) return 'python';
    if (bases.has('Gemfile') || exts.has('.rb')) return 'ruby';
    if (bases.has('composer.json') || exts.has('.php')) return 'php';
    return 'unknown';
}

// \u2500\u2500 Health score \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function calculateHealthScore(
    serviceDir: string,
    allFiles: string[],
    repoRoot?: string,
): { score: number; docCoverage: number; testCoverage: number; issues: string[] } {
    // For CI/CD and Docker checks, also consider repo-root files
    const rootFiles = repoRoot && repoRoot !== serviceDir
        ? walkDir(repoRoot, 3).filter((f) => {
            const rel = path.relative(repoRoot, f);
            return rel.split(path.sep).length <= 3; // max 3 levels from root
        })
        : [];
    const issues: string[] = [];
    let score = 0;

    // 20 pts \u2014 OpenAPI/Swagger spec
    const hasOpenApi = allFiles.some((f) => {
        const b = path.basename(f).toLowerCase();
        return b.includes('openapi') || b.includes('swagger') || b === 'api.yaml' || b === 'api.json';
    });
    if (hasOpenApi) { score += 20; } else { issues.push('Missing OpenAPI/Swagger spec'); }

    // 15 pts \u2014 README >= 300 chars
    const readmeContent = readSafe(path.join(serviceDir, 'README.md'));
    const hasReadme = readmeContent.length >= 300;
    if (hasReadme) { score += 15; }
    else { issues.push(readmeContent.length === 0 ? 'Missing README.md' : 'README.md too short (<300 chars)'); }
    const docCoverage = hasOpenApi && hasReadme ? 100 : (hasOpenApi || hasReadme) ? 50 : 0;

    // 15 pts \u2014 test coverage
    let testCoverage = 0;
    let coverageFound = false;
    const coveragePaths = [
        path.join(serviceDir, 'coverage', 'coverage-summary.json'),
        path.join(serviceDir, 'coverage', 'coverage-final.json'),
    ];
    for (const cp of coveragePaths) {
        const raw = readSafe(cp);
        if (!raw) continue;
        try {
            const p: Record<string, { lines?: { pct?: number } }> = JSON.parse(raw);
            const pct = p['total']?.lines?.pct;
            if (pct !== undefined) { testCoverage = pct; coverageFound = true; break; }
        } catch { /* skip */ }
    }
    const hasTestDir = allFiles.some((f) => {
        const rel = path.relative(serviceDir, f);
        return /^(test|tests|__tests__|spec)[\\/]/.test(rel) || /\.(test|spec)\.[jt]sx?$/.test(f);
    });
    if (coverageFound) {
        if (testCoverage >= 70) { score += 15; }
        else { issues.push(`Test coverage ${testCoverage.toFixed(1)}% (need >=70%)`); }
    } else if (hasTestDir) { score += 8; testCoverage = 50; }
    else { issues.push('No tests detected'); }

    // 10 pts \u2014 no @deprecated markers
    const srcFiles = allFiles.filter((f) => SOURCE_EXTS.has(path.extname(f)));
    const hasDeprecated = srcFiles.some((f) => /@deprecated/.test(readSafe(f)));
    if (!hasDeprecated) { score += 10; } else { issues.push('Deprecated endpoint markers found'); }

    // 10 pts \u2014 CI/CD
    const ciCdCheck = (f: string, base: string) => {
        const rel = path.relative(base, f);
        return /^\.github[\\/]workflows[\\/].+\.ya?ml$/.test(rel) ||
            path.basename(f) === '.gitlab-ci.yml' ||
            path.basename(f) === 'Jenkinsfile' ||
            path.basename(f) === '.travis.yml' ||
            /^\.circleci[\\/]config\.ya?ml$/.test(rel) ||
            path.basename(f) === 'azure-pipelines.yml';
    };
    const hasCiCd = allFiles.some((f) => ciCdCheck(f, serviceDir)) ||
        rootFiles.some((f) => ciCdCheck(f, repoRoot!));
    if (hasCiCd) { score += 10; } else { issues.push('No CI/CD configuration detected'); }

    // 10 pts \u2014 Dockerfile / docker-compose
    const dockerCheck = (f: string) => {
        const b = path.basename(f);
        return b === 'Dockerfile' || b.startsWith('Dockerfile.') ||
            b === 'docker-compose.yml' || b === 'docker-compose.yaml';
    };
    const hasDocker = allFiles.some(dockerCheck) || rootFiles.some(dockerCheck);
    if (hasDocker) { score += 10; } else { issues.push('No Dockerfile or docker-compose found'); }

    // 10 pts \u2014 error handling on external calls
    const bareCallFiles = srcFiles.filter((f) => {
        const c = readSafe(f);
        return /^\s*(?:await\s+)?(?:fetch|axios)\s*\(/m.test(c) && !/try\s*\{/.test(c);
    });
    if (bareCallFiles.length === 0) { score += 10; }
    else { issues.push(`${bareCallFiles.length} file(s) with unprotected external calls`); }

    // 5 pts \u2014 linting config
    const hasLint = allFiles.some((f) => {
        const b = path.basename(f);
        return [
            '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml',
            'eslint.config.js', 'eslint.config.mjs',
            '.pylintrc', 'golangci.yml', '.golangci.yml',
            '.rubocop.yml', 'phpcs.xml',
        ].includes(b);
    });
    if (hasLint) { score += 5; } else { issues.push('No linter config found'); }

    // 5 pts \u2014 no hardcoded secrets
    const secretPattern = /(?:password|secret|api_key|apikey|token)\s*=\s*[""][^""]{6,}/i;
    const hasSecrets = srcFiles.some((f) => secretPattern.test(readSafe(f)));
    if (!hasSecrets) { score += 5; } else { issues.push('Possible hardcoded secrets detected'); }

    return { score: Math.min(100, Math.max(0, score)), docCoverage, testCoverage: Math.round(testCoverage), issues };
}

// \u2500\u2500 Endpoint detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function detectEndpoints(allFiles: string[]): ScannedEndpoint[] {
    const endpoints: ScannedEndpoint[] = [];
    const srcFiles = allFiles.filter((f) => SOURCE_EXTS.has(path.extname(f)));

    for (const filePath of srcFiles) {
        const content = readSafe(filePath);
        if (!content) continue;

        let m: RegExpExecArray | null;

        EXPRESS_RE.lastIndex = 0;
        while ((m = EXPRESS_RE.exec(content)) !== null) {
            endpoints.push({ method: m[1].toUpperCase(), path: m[2], deprecated: /@deprecated/.test(content), hasOpenApiSpec: false });
        }
        NESTJS_RE.lastIndex = 0;
        while ((m = NESTJS_RE.exec(content)) !== null) {
            endpoints.push({ method: m[1].toUpperCase(), path: m[2] || '/', deprecated: false, hasOpenApiSpec: false });
        }
        FLASK_RE.lastIndex = 0;
        while ((m = FLASK_RE.exec(content)) !== null) {
            endpoints.push({ method: 'GET', path: m[1], deprecated: false, hasOpenApiSpec: false });
        }
        FASTAPI_RE.lastIndex = 0;
        while ((m = FASTAPI_RE.exec(content)) !== null) {
            endpoints.push({ method: m[1].toUpperCase(), path: m[2], deprecated: false, hasOpenApiSpec: false });
        }
        GIN_RE.lastIndex = 0;
        while ((m = GIN_RE.exec(content)) !== null) {
            endpoints.push({ method: m[1].toUpperCase(), path: m[2], deprecated: false, hasOpenApiSpec: false });
        }
        SPRING_RE.lastIndex = 0;
        while ((m = SPRING_RE.exec(content)) !== null) {
            const verb = m[1].replace('Mapping', '').replace('Request', 'GET');
            endpoints.push({ method: verb.toUpperCase(), path: m[2], deprecated: false, hasOpenApiSpec: false });
        }
        ACTIX_RE.lastIndex = 0;
        while ((m = ACTIX_RE.exec(content)) !== null) {
            endpoints.push({ method: m[1].toUpperCase(), path: m[2], deprecated: false, hasOpenApiSpec: false });
        }

        // Hapi route blocks
        const routeBlocks = content.matchAll(/server\s*\.\s*route\s*\(\s*\{([^}]+)\}/gs);
        for (const block of routeBlocks) {
            const body = block[1];
            HAPI_METHOD_RE.lastIndex = 0;
            HAPI_PATH_RE.lastIndex = 0;
            const methodM = HAPI_METHOD_RE.exec(body);
            const pathM = HAPI_PATH_RE.exec(body);
            if (methodM && pathM) {
                endpoints.push({ method: methodM[1].toUpperCase(), path: pathM[1], deprecated: false, hasOpenApiSpec: false });
            }
        }
    }

    const seen = new Set<string>();
    return endpoints.filter((ep) => {
        const key = `${ep.method}:${ep.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// \u2500\u2500 Dependency detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function detectDependencies(
    _serviceDir: string,
    serviceId: string,
    allFiles: string[],
): ScannedDependency[] {
    const deps: ScannedDependency[] = [];
    const srcFiles = allFiles.filter((f) => SOURCE_EXTS.has(path.extname(f)));

    for (const filePath of srcFiles) {
        const content = readSafe(filePath);
        if (!content) continue;

        let m: RegExpExecArray | null;

        // HTTP calls JS/TS
        for (const re of [HTTP_CALL_RE, FETCH_RE]) {
            re.lastIndex = 0;
            while ((m = re.exec(content)) !== null) {
                const rawUrl = m[1];
                if (!rawUrl || rawUrl.startsWith('/')) continue;
                deps.push({ sourceId: serviceId, targetName: extractHostname(rawUrl), targetUrl: rawUrl, type: 'REST', endpoints: [rawUrl] });
            }
        }
        // HTTP calls Python
        for (const re of [REQUESTS_RE, HTTPX_RE]) {
            re.lastIndex = 0;
            while ((m = re.exec(content)) !== null) {
                const rawUrl = m[1];
                if (!rawUrl || rawUrl.startsWith('/')) continue;
                deps.push({ sourceId: serviceId, targetName: extractHostname(rawUrl), targetUrl: rawUrl, type: 'REST', endpoints: [rawUrl] });
            }
        }
        // HTTP calls Go
        GO_HTTP_RE.lastIndex = 0;
        while ((m = GO_HTTP_RE.exec(content)) !== null) {
            const rawUrl = m[1];
            if (!rawUrl || rawUrl.startsWith('/')) continue;
            deps.push({ sourceId: serviceId, targetName: extractHostname(rawUrl), targetUrl: rawUrl, type: 'REST', endpoints: [rawUrl] });
        }
        // Env-var HTTP
        ENV_VAR_HTTP_RE.lastIndex = 0;
        while ((m = ENV_VAR_HTTP_RE.exec(content)) !== null) {
            const envVarName = m[1];
            const pathPart = (m[2] ?? '').split(/\$\{/)[0].split('?')[0];
            deps.push({ sourceId: serviceId, targetName: `env:${envVarName}`, targetUrl: `env://${envVarName}${pathPart}`, type: 'REST', endpoints: [pathPart || '/'] });
        }

        // Build var map for queue resolution
        const varAssigns = new Map<string, string>();
        const VAR_RE = /(?:const|let|var)\s+(\w+)\s*=\s*["'`]([^"'`\n]{2,80})["'`]/g;
        VAR_RE.lastIndex = 0;
        while ((m = VAR_RE.exec(content)) !== null) varAssigns.set(m[1], m[2]);

        // RabbitMQ
        AMQP_LITERAL_RE.lastIndex = 0;
        while ((m = AMQP_LITERAL_RE.exec(content)) !== null) {
            if (m[1] && m[1].length > 1) deps.push({ sourceId: serviceId, targetName: `amqp:${m[1]}`, targetUrl: `amqp://${m[1]}`, type: 'Event', endpoints: [m[1]] });
        }
        AMQP_VAR_RE.lastIndex = 0;
        while ((m = AMQP_VAR_RE.exec(content)) !== null) {
            const q = varAssigns.get(m[1]);
            if (q && q.length > 1) deps.push({ sourceId: serviceId, targetName: `amqp:${q}`, targetUrl: `amqp://${q}`, type: 'Event', endpoints: [q] });
        }
        AMQP_WRAPPER_RE.lastIndex = 0;
        while ((m = AMQP_WRAPPER_RE.exec(content)) !== null) {
            if (m[1] && m[1].length > 1) deps.push({ sourceId: serviceId, targetName: `amqp:${m[1]}`, targetUrl: `amqp://${m[1]}`, type: 'Event', endpoints: [m[1]] });
        }
        // Kafka
        KAFKA_PRODUCER_RE.lastIndex = 0;
        while ((m = KAFKA_PRODUCER_RE.exec(content)) !== null) {
            deps.push({ sourceId: serviceId, targetName: `kafka:${m[1]}`, targetUrl: `kafka://${m[1]}`, type: 'Event', endpoints: [m[1]] });
        }
        KAFKA_CONSUMER_RE.lastIndex = 0;
        while ((m = KAFKA_CONSUMER_RE.exec(content)) !== null) {
            deps.push({ sourceId: serviceId, targetName: `kafka:${m[1]}`, targetUrl: `kafka://${m[1]}`, type: 'Event', endpoints: [m[1]] });
        }
        // NATS
        NATS_RE.lastIndex = 0;
        while ((m = NATS_RE.exec(content)) !== null) {
            deps.push({ sourceId: serviceId, targetName: `nats:${m[1]}`, targetUrl: `nats://${m[1]}`, type: 'Event', endpoints: [m[1]] });
        }
        // gRPC
        GRPC_RE.lastIndex = 0;
        if (GRPC_RE.test(content)) {
            deps.push({ sourceId: serviceId, targetName: 'grpc-target', targetUrl: 'grpc://unknown', type: 'gRPC', endpoints: [] });
        }
        // DB
        DB_URL_RE.lastIndex = 0;
        if (DB_URL_RE.test(content)) {
            deps.push({ sourceId: serviceId, targetName: 'database', targetUrl: 'db://internal', type: 'DB', endpoints: [] });
        }
    }

    const seen = new Set<string>();
    return deps.filter((d) => {
        const key = `${d.targetName}:${d.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// \u2500\u2500 Monorepo service discovery \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ServiceRoot { dir: string; name: string; markerFile: string; }

function findServiceRoots(repoPath: string): ServiceRoot[] {
    const roots: ServiceRoot[] = [];
    _findRec(repoPath, roots, 0, 5);
    return roots;
}

function _findRec(dir: string, results: ServiceRoot[], depth: number, maxDepth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const isMonorepoRoot =
        MONOREPO_ROOT_MARKERS.some((m) => fileNames.has(m)) ||
        (fileNames.has('package.json') && _isMonorepoPackageJson(path.join(dir, 'package.json')));
    const markerFile = SERVICE_MARKERS.find((m) => fileNames.has(m));

    if (markerFile && !isMonorepoRoot) {
        results.push({ dir, name: _extractServiceName(dir, markerFile), markerFile });
        return; // don't recurse further into a service
    }

    // Implicit service: directory under a workspace container that has source files
    // but no explicit marker (e.g. services/evaluator with only runner.py)
    const parentIsContainer = WORKSPACE_CONTAINER_NAMES.has(path.basename(path.dirname(dir)));
    if (!markerFile && parentIsContainer && depth >= 2) {
        const dirEntryFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
        const hasSourceFiles = dirEntryFiles.some((f) =>
            SOURCE_EXTS.has(path.extname(f)) ||
            f === 'Makefile' || f === 'Dockerfile'
        );
        if (hasSourceFiles) {
            results.push({ dir, name: path.basename(dir), markerFile: '' });
            return;
        }
    }

    const isWorkspaceContainer = WORKSPACE_CONTAINER_NAMES.has(path.basename(dir));

    for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        if (
            depth === 0 || isMonorepoRoot || isWorkspaceContainer ||
            WORKSPACE_CONTAINER_NAMES.has(entry.name)
        ) {
            _findRec(path.join(dir, entry.name), results, depth + 1, maxDepth);
        }
    }
}

function _isMonorepoPackageJson(pkgPath: string): boolean {
    try {
        const pkg = JSON.parse(readSafe(pkgPath));
        // Must have explicit workspaces field — `private: true` alone is NOT enough
        // (many child packages in a monorepo are also marked private)
        return !!(pkg.workspaces);
    } catch { return false; }
}

function _extractServiceName(dir: string, markerFile: string): string {
    const full = path.join(dir, markerFile);
    if (markerFile === 'package.json') {
        try {
            const pkg = JSON.parse(readSafe(full));
            if (pkg.name && pkg.name !== 'root' && !pkg.name.includes('workspace')) {
                return pkg.name.replace(/^@[^\/]+\//, '');
            }
        } catch { /* fall through */ }
    }
    if (markerFile === 'go.mod') {
        const firstLine = readSafe(full).split('\n')[0] ?? '';
        const mod = firstLine.replace(/^module\s+/, '').trim();
        if (mod) return path.basename(mod);
    }
    if (markerFile === 'Cargo.toml') {
        const m = readSafe(full).match(/^name\s*=\s*"([^"]+)"/m);
        if (m) return m[1];
    }
    if (markerFile === 'pom.xml') {
        const m = readSafe(full).match(/<artifactId>([^<]+)<\/artifactId>/);
        if (m) return m[1];
    }
    if (markerFile === 'pyproject.toml') {
        const m = readSafe(full).match(/^name\s*=\s*["'\']([^"'\']+)["'\']/m);
        if (m) return m[1];
    }
    return path.basename(dir);
}

// \u2500\u2500 Infrastructure detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface InfraResult { services: ScannedService[]; dependencies: ScannedDependency[]; }

function detectInfrastructure(repoPath: string, repoUrl: string | null, gitRoot: string | null): InfraResult {
    const services: ScannedService[] = [];
    const dependencies: ScannedDependency[] = [];
    const allFiles = walkDir(repoPath, 8);

    // Terraform
    const tfFiles = allFiles.filter((f) => path.extname(f) === '.tf');
    if (tfFiles.length > 0) {
        const providers = new Set<string>();
        const resources = new Set<string>();
        for (const tf of tfFiles) {
            const content = readSafe(tf);
            for (const m of content.matchAll(/^provider\s+"([^"]+)"/gm)) providers.add(m[1]);
            for (const m of content.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"/gm)) resources.add(m[1]);
        }
        const providerLabel = providers.size ? [...providers].join('+') : 'terraform';
        const infraId = serviceIdFromName(`infra:terraform:${repoPath}`);
        const subpath = gitRoot ? path.relative(gitRoot, repoPath) : null;
        services.push({
            id: infraId, name: `${providerLabel}-infra`,
            repoPath, repoUrl, repoSubpath: subpath,
            team: null, language: 'infra',
            healthScore: resources.size > 0 ? 85 : 40,
            docCoverage: 50, testCoverage: 0, lastCommit: null,
            endpoints: [],
            rawIssues: resources.size === 0 ? ['No Terraform resources found'] : [],
        });
    }

    // CI/CD workflows (GitHub Actions, GitLab CI, etc.)
    const ciFiles = allFiles.filter((f) => {
        const rel = path.relative(repoPath, f);
        return /^\.github[\\/]workflows[\\/].+\.ya?ml$/.test(rel) ||
            path.basename(f) === '.gitlab-ci.yml' ||
            path.basename(f) === 'Jenkinsfile' ||
            path.basename(f) === '.travis.yml' ||
            /^\.circleci[\\/]config\.ya?ml$/.test(rel) ||
            path.basename(f) === 'azure-pipelines.yml';
    });
    if (ciFiles.length > 0) {
        const ciId = serviceIdFromName(`infra:ci-cd:${repoPath}`);
        const subpath = gitRoot ? path.relative(gitRoot, repoPath) : null;
        services.push({
            id: ciId, name: 'ci-cd-pipelines',
            repoPath, repoUrl, repoSubpath: subpath,
            team: null, language: 'infra',
            healthScore: 80,
            docCoverage: 30, testCoverage: 0, lastCommit: null,
            endpoints: ciFiles.map((f) => ({
                method: 'WORKFLOW',
                path: path.relative(repoPath, f),
            })),
            rawIssues: [],
        });
    }

    // Docker Compose (repo-level)
    const composeFiles = allFiles.filter((f) => {
        const b = path.basename(f);
        return (b === 'docker-compose.yml' || b === 'docker-compose.yaml') &&
            path.dirname(f) === repoPath;
    });
    if (composeFiles.length > 0) {
        const content = readSafe(composeFiles[0]);
        const dockerServices: string[] = [];
        for (const m of content.matchAll(/^\s{2}([a-z][a-z0-9_-]+):\s*$/gm)) {
            dockerServices.push(m[1]);
        }
        if (dockerServices.length > 0) {
            // Add dependency links: each docker-compose service → potential matching service
            const composeId = serviceIdFromName('infra:docker-compose');
            for (const ds of dockerServices) {
                dependencies.push({
                    sourceId: composeId,
                    targetName: ds,
                    targetUrl: `docker-compose://${ds}`,
                    type: 'DOCKER',
                    endpoints: [],
                });
            }
        }
    }

    return { services, dependencies };
}

// \u2500\u2500 Source file walker for QA citations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function walkSourceFiles(dir: string, max = 200): string[] {
    if (!fs.existsSync(dir)) return [];
    return walkDir(dir, 8)
        .filter((f) => SOURCE_EXTS.has(path.extname(f)))
        .slice(0, max)
        .map((f) => path.relative(dir, f));
}

export function bestFileMatch(hallucinated: string, realFiles: string[]): string | null {
    if (realFiles.length === 0) return null;
    const norm = hallucinated.replace(/\\/g, '/').replace(/^\.\//, '');
    if (realFiles.includes(norm)) return norm;
    const base = path.basename(norm);
    const nameNoExt = base.replace(/\.[^.]+$/, '');
    const ext = path.extname(norm);
    const byBase = realFiles.find((f) => path.basename(f) === base);
    if (byBase) return byBase;
    const byName = realFiles.find((f) => path.basename(f).replace(/\.[^.]+$/, '') === nameNoExt);
    if (byName) return byName;
    const byContains = realFiles.find((f) => f.includes(nameNoExt) && nameNoExt.length > 3);
    if (byContains) return byContains;
    const segments = norm.split('/').filter((s) => s.length > 3);
    for (const seg of segments) {
        const bySeg = realFiles.find((f) => f.includes(seg) && path.extname(f) === ext);
        if (bySeg) return bySeg;
    }
    return null;
}

// \u2500\u2500 scanMonorepo \u2014 main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function scanMonorepo(repoPath: string, repoUrl?: string, team?: string): ScanResult {
    if (!fs.existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`);
    if (!fs.statSync(repoPath).isDirectory()) throw new Error(`Not a directory: ${repoPath}`);

    // Resolve symlinks (macOS /tmp → /private/tmp) so path.relative works with gitRoot
    repoPath = fs.realpathSync(repoPath);

    const gitInfo = detectGitInfo(repoPath);
    const resolvedUrl = repoUrl ?? gitInfo.repoUrl;
    const gitRoot = gitInfo.gitRoot;

    let serviceRoots = findServiceRoots(repoPath);
    if (serviceRoots.length === 0) {
        serviceRoots = [{ dir: repoPath, name: path.basename(repoPath), markerFile: '' }];
    }

    const services: ScannedService[] = [];
    const allDeps: ScannedDependency[] = [];
    const allIssues: string[] = [];

    for (const root of serviceRoots) {
        const allFiles = walkDir(root.dir, 10);
        const language = detectLanguage(allFiles);
        const { score, docCoverage, testCoverage, issues } = calculateHealthScore(root.dir, allFiles, repoPath);
        const endpoints = detectEndpoints(allFiles);
        const serviceId = serviceIdFromName(root.name);
        const deps = detectDependencies(root.dir, serviceId, allFiles);
        const lastCommit = detectLastCommit(root.dir);
        const subpath = gitRoot ? path.relative(gitRoot, root.dir) || null : null;

        services.push({
            id: serviceId, name: root.name,
            repoPath: root.dir, repoUrl: resolvedUrl, repoSubpath: subpath,
            team: team ?? null, language,
            healthScore: score, docCoverage, testCoverage, lastCommit,
            endpoints, rawIssues: issues,
        });
        allDeps.push(...deps);
        allIssues.push(...issues.map((i) => `[${root.name}] ${i}`));
    }

    const infra = detectInfrastructure(repoPath, resolvedUrl ?? null, gitRoot);
    services.push(...infra.services);
    allDeps.push(...infra.dependencies);

    const seen = new Set<string>();
    const uniqueDeps = allDeps.filter((d) => {
        const key = `${d.sourceId}:${d.targetName}:${d.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return { services, dependencies: uniqueDeps, issues: allIssues };
}

// \u2500\u2500 scanRepo \u2014 legacy alias for ingestWorker \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function scanRepo(repoPath: string, repoUrl?: string, team?: string): ScanResult {
    return scanMonorepo(repoPath, repoUrl, team);
}
