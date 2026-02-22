#!/usr/bin/env node
/**
 * KA-CHOW CLI — fully implemented commands.
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import { readConfig } from './config.js';

dotenv.config();

const program = new Command();
program.name('kachow').description('⚡ KA-CHOW — Living knowledge graph').version('1.0.0');

// ── Helpers ───────────────────────────────────────────────────────────────────
function apiGet(port: number, apiPath: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}${apiPath}`, (r) => {
            let b = ''; r.on('data', (c: Buffer) => { b += c.toString(); });
            r.on('end', () => { try { resolve(JSON.parse(b) as Record<string,unknown>); } catch { reject(new Error('Invalid JSON')); } });
        }).on('error', reject);
    });
}

function apiPost(port: number, apiPath: string, data: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = http.request({ hostname: 'localhost', port, path: apiPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
            let buf = ''; r.on('data', (c: Buffer) => { buf += c.toString(); });
            r.on('end', () => { try { resolve(JSON.parse(buf) as Record<string,unknown>); } catch { reject(new Error('Invalid JSON')); } });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}

async function waitForServer(port: number, retries = 25): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try { await apiGet(port, '/health'); return true; } catch { process.stdout.write('.'); }
    }
    return false;
}

function openBrowser(url: string): void {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

function detectRepos(cwd: string): Array<{ name: string; path: string; language: string }> {
    const repos: Array<{ name: string; path: string; language: string }> = [];
    const langMarkers = [
        { file: 'package.json', lang: 'typescript' },
        { file: 'setup.py', lang: 'python' },
        { file: 'pyproject.toml', lang: 'python' },
        { file: 'pom.xml', lang: 'java' },
        { file: 'go.mod', lang: 'go' },
        { file: 'Cargo.toml', lang: 'rust' },
    ];
    // Check CWD itself
    const cwdLang = langMarkers.find(m => fs.existsSync(path.join(cwd, m.file)))?.lang;
    if (cwdLang) repos.push({ name: path.basename(cwd), path: cwd, language: cwdLang });
    // Scan common monorepo subdirs
    for (const subdir of ['services', 'packages', 'apps']) {
        const subdirPath = path.join(cwd, subdir);
        if (!fs.existsSync(subdirPath)) continue;
        for (const entry of fs.readdirSync(subdirPath, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const ep = path.join(subdirPath, entry.name);
            const lang = langMarkers.find(m => fs.existsSync(path.join(ep, m.file)))?.lang;
            if (lang) repos.push({ name: entry.name, path: ep, language: lang });
        }
    }
    return repos;
}

function generateConfig(cwd: string, repos: Array<{ name: string; path: string; language: string }>): string {
    return yaml.dump({
        version: 1,
        project: { name: path.basename(cwd), description: `Auto-detected from ${cwd}` },
        repos: repos.map(r => ({ name: r.name, path: path.relative(cwd, r.path) || '.', language: r.language })),
        standards: { require_readme: true, require_error_handling: true, min_test_coverage: 70 },
        llm: { openai_key: '${OPENAI_API_KEY}', qa_model: 'gpt-4o', healing_model: 'gpt-4o' },
    }, { lineWidth: 80 });
}

// ── init ──────────────────────────────────────────────────────────────────────
program.command('init')
    .description('Auto-detect repos in CWD, scan them, start server, open browser')
    .option('-c, --config <path>', 'Path to kachow.config.yaml', './kachow.config.yaml')
    .option('-p, --port <number>', 'Server port', '3000')
    .option('--no-browser', 'Skip opening browser')
    .action(async (opts: { config: string; port: string; browser: boolean }) => {
        const port = parseInt(opts.port, 10);
        const cwd = process.cwd();
        console.log(`\n⚡ KA-CHOW init — ${cwd}\n`);

        // 1. Find/create config & repos
        const configPath = path.resolve(cwd, opts.config);
        let repos: Array<{ name: string; path: string; language: string }> = [];

        if (fs.existsSync(configPath)) {
            console.log(`  ✓ Found ${opts.config}`);
            try {
                const cfg = readConfig(cwd);
                repos = (cfg.repos ?? []).map(r => ({
                    name: r.name, path: path.resolve(cwd, r.path ?? '.'), language: r.language ?? 'unknown',
                }));
            } catch { /* fallback to auto-detect */ }
        }

        if (repos.length === 0) {
            console.log('  🔍 Auto-detecting repos...');
            repos = detectRepos(cwd);
            if (repos.length === 0) {
                repos = [{ name: path.basename(cwd), path: cwd, language: 'unknown' }];
            }
            console.log(`  Found: ${repos.map(r => r.name).join(', ')}`);
            fs.writeFileSync(configPath, generateConfig(cwd, repos));
            console.log(`  ✓ Created ${opts.config}`);
        }

        // 2. Check/start server
        let running = false;
        try { await apiGet(port, '/health'); running = true; console.log(`  ✓ Server already on :${port}`); } catch { /**/ }

        if (!running) {
            console.log(`  🚀 Starting server on :${port}...`);
            const serverPkg = path.resolve(__dirname, '../../server');
            const serverEntry = fs.existsSync(path.join(serverPkg, 'dist/server.js'))
                ? path.join(serverPkg, 'dist/server.js')
                : path.join(serverPkg, 'src/server.ts');
            const isTs = serverEntry.endsWith('.ts');
            spawn(isTs ? 'npx' : 'node', isTs ? ['tsx', serverEntry] : [serverEntry], {
                env: { ...process.env, PORT: String(port) }, stdio: 'ignore', detached: true,
            }).unref();
            process.stdout.write('  Waiting');
            const ok = await waitForServer(port);
            console.log('');
            if (!ok) { console.error('  ✗ Server failed to start. Run: npx tsx packages/server/src/server.ts'); process.exit(1); }
            console.log(`  ✓ Server ready`);
        }

        // 3. Ingest repos
        console.log(`\n  📦 Ingesting ${repos.length} repo(s)...`);
        for (const repo of repos) {
            if (!fs.existsSync(repo.path)) { console.log(`  ⚠  ${repo.name}: path not found`); continue; }
            try {
                const r = await apiPost(port, '/api/ingest/repo', { repoPath: repo.path, repoName: repo.name, team: 'auto-detected' });
                const jobId = ((r.data ?? {}) as { jobId?: string }).jobId;
                console.log(`  ✓ ${repo.name} → job ${jobId?.slice(0, 8) ?? 'started'}`);
            } catch (e) { console.log(`  ✗ ${repo.name}: ${e instanceof Error ? e.message : String(e)}`); }
        }

        const url = `http://localhost:${port}`;
        if (opts.browser !== false) { setTimeout(() => openBrowser(url), 2500); }
        console.log(`\n⚡ KA-CHOW live at ${url}\n`);
    });

// ── serve ─────────────────────────────────────────────────────────────────────
program.command('serve')
    .description('Start the KA-CHOW server without re-scanning')
    .option('-p, --port <number>', 'Port', '3000')
    .action((opts: { port: string }) => {
        process.env.PORT = opts.port;
        console.log(`🚀 KA-CHOW server on :${opts.port}`);
        const serverPkg = path.resolve(__dirname, '../../server');
        const entry = path.join(serverPkg, 'dist/server.js');
        if (!fs.existsSync(entry)) {
            console.error('Build the server first: cd packages/server && pnpm build');
            process.exit(1);
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require(entry);
    });

// ── scan ──────────────────────────────────────────────────────────────────────
program.command('scan')
    .description('Scan a repo and add it to the knowledge graph')
    .requiredOption('-p, --path <path>', 'Repository path')
    .option('--port <number>', 'Server port', '3000')
    .option('--name <name>', 'Service name')
    .option('--team <team>', 'Team name')
    .action(async (opts: { path: string; port: string; name?: string; team?: string }) => {
        const port = parseInt(opts.port, 10);
        const repoPath = path.resolve(opts.path);
        const repoName = opts.name ?? path.basename(repoPath);
        if (!fs.existsSync(repoPath)) { console.error(`✗ Path not found: ${repoPath}`); process.exit(1); }
        console.log(`🔍 Scanning ${repoName}...`);
        try {
            const r = await apiPost(port, '/api/ingest/repo', { repoPath, repoName, team: opts.team ?? null });
            const jobId = ((r.data ?? {}) as { jobId?: string }).jobId;
            console.log(`✓ Job ${jobId} started — watch: GET http://localhost:${port}/api/ingest/status/${jobId}`);
        } catch { console.error(`✗ Server not running on :${port}. Start with: kachow serve`); process.exit(1); }
    });

// ── health ────────────────────────────────────────────────────────────────────
program.command('health')
    .description('Print system health')
    .option('--port <number>', 'Server port', '3000')
    .option('--json', 'Output JSON')
    .action(async (opts: { port: string; json: boolean }) => {
        try {
            const r = await apiGet(parseInt(opts.port, 10), '/api/graph/health');
            const h = r.data as { overallScore: number; totalServices: number; critical: number; warning: number; healthy: number; totalEdges: number };
            if (opts.json) { console.log(JSON.stringify(h, null, 2)); return; }
            const icon = h.overallScore >= 75 ? '💚' : h.overallScore >= 50 ? '🟡' : '🔴';
            console.log(`\n${icon} KA-CHOW Health — ${h.overallScore}/100`);
            console.log(`   Services: ${h.totalServices} | Healthy: ${h.healthy} | Warning: ${h.warning} | Critical: ${h.critical}`);
            console.log(`   Edges: ${h.totalEdges}\n`);
        } catch { console.error(`✗ Server not running on :${opts.port}`); process.exit(1); }
    });

// ── onboard ───────────────────────────────────────────────────────────────────
program.command('onboard')
    .description('Print onboarding path for a new engineer')
    .requiredOption('-r, --role <role>', 'backend-engineer | sre | engineering-manager')
    .option('--port <number>', 'Server port', '3000')
    .action(async (opts: { role: string; port: string }) => {
        try {
            const r = await apiGet(parseInt(opts.port, 10), `/api/manager/onboarding/path/${opts.role}`);
            const d = r.data as { steps: Array<{ step: number; title: string; description: string; estimatedMinutes: number }> };
            console.log(`\n🎓 Onboarding: ${opts.role}\n`);
            for (const s of d.steps) { console.log(`  ${s.step}. ${s.title} (~${s.estimatedMinutes}min)\n     ${s.description}\n`); }
        } catch { console.error(`✗ Server not running on :${opts.port}`); process.exit(1); }
    });

// ── blueprint ─────────────────────────────────────────────────────────────────
program.command('blueprint')
    .description('Print service architecture blueprint')
    .requiredOption('-s, --service <id>', 'Service ID')
    .option('--port <number>', 'Server port', '3000')
    .action(async (opts: { service: string; port: string }) => {
        try {
            const r = await apiGet(parseInt(opts.port, 10), `/api/architecture/blueprint/${opts.service}`);
            const bp = r.data as { service: { name: string; healthScore: number; healthTier: string }; endpoints: unknown[]; standardsCompliance: Array<{ standard: string; passing: boolean; violation?: string }> };
            console.log(`\n📐 ${bp.service.name} — ${bp.service.healthScore}/100 (${bp.service.healthTier})`);
            for (const s of bp.standardsCompliance) console.log(`  ${s.passing ? '✓' : '✗'} ${s.standard}${s.violation ? ` — ${s.violation}` : ''}`);
            console.log('');
        } catch { console.error(`✗ Server not running on :${opts.port}`); process.exit(1); }
    });

// ── reset ─────────────────────────────────────────────────────────────────────
program.command('reset')
    .description('Wipe the KA-CHOW database')
    .option('--force', 'Skip confirmation')
    .action((opts: { force?: boolean }) => {
        if (!opts.force) { console.log('⚠️  Re-run with --force to confirm.'); return; }
        const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), 'kachow.db');
        if (fs.existsSync(dbPath)) { fs.unlinkSync(dbPath); console.log(`🗑️  Deleted ${dbPath}`); }
        else console.log('No database found — already clean.');
    });

// ── analyze (CI mode) ─────────────────────────────────────────────────────────
program.command('analyze')
    .description('Run PR impact analysis in CI mode')
    .requiredOption('--pr <number>', 'PR number')
    .requiredOption('--repo <owner/repo>', 'GitHub repo')
    .option('--port <number>', 'Server port', '3000')
    .action(async (opts: { pr: string; repo: string; port: string }) => {
        try {
            const r = await apiPost(parseInt(opts.port, 10), '/api/ci/analyze-pr', { prNumber: parseInt(opts.pr, 10), repoFullName: opts.repo });
            console.log(JSON.stringify(r, null, 2));
        } catch { console.error(`✗ Server not running on :${opts.port}`); process.exit(1); }
    });

program.parse(process.argv);
