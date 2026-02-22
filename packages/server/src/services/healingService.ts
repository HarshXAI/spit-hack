/**
 * Self-healing engine service — Phase 5.
 * Detects code quality issues in ingested services, generates patches
 * with OpenAI GPT-4o, and creates real GitHub PRs via Octokit.
 */

import OpenAI from 'openai';
import { Octokit } from '@octokit/rest';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HealingIssue {
    id: string;
    serviceId: string;
    serviceName: string;
    issueType: string;
    explanation: string;
    patch: string;
    githubPrUrl: string | null;
    githubPrNum: number | null;
    status: 'detected' | 'patch-ready' | 'pr-open' | 'merged' | 'closed';
    createdAt: string;
}

export interface PatchResult {
    patchedCode: string;
    explanation: string;
    testsNeedUpdate: boolean;
    testSuggestion: string;
}

// ── Issue patterns ────────────────────────────────────────────────────────────

const ISSUE_DESCRIPTIONS: Record<string, string> = {
    'missing-retry': 'HTTP/gRPC call without retry logic — transient failures become permanent errors',
    'no-error-handling': 'Async operation without try/catch — unhandled rejections crash the process',
    'no-timeout': 'External call without timeout — slow downstream service causes thread starvation',
    'deprecated-api': 'Calling a deprecated endpoint — will break when the upstream removes it',
    'hardcoded-secret': 'Credentials or secrets hardcoded in source — major security risk',
    'missing-input-validation': 'Route handler without input validation — open to injection attacks',
};

// ── Heal queue ────────────────────────────────────────────────────────────────

/**
 * Returns the current self-healing queue from the database.
 */
export function getHealingQueue(): HealingIssue[] {
    const db = getDb();
    return (db.prepare<[]>(`
        SELECT hp.id, hp.service_id, hp.issue_type, hp.patch, hp.explanation,
               hp.github_pr_url, hp.github_pr_num, hp.status, hp.created_at,
               s.name AS service_name
        FROM healing_prs hp
        JOIN services s ON s.id = hp.service_id
        ORDER BY hp.created_at DESC LIMIT 50
    `).all() as Array<{
        id: string; service_id: string; service_name: string;
        issue_type: string; explanation: string; patch: string;
        github_pr_url: string | null; github_pr_num: number | null;
        status: string; created_at: string;
    }>).map(h => ({
        id: h.id,
        serviceId: h.service_id,
        serviceName: h.service_name,
        issueType: h.issue_type,
        explanation: h.explanation,
        patch: h.patch,
        githubPrUrl: h.github_pr_url,
        githubPrNum: h.github_pr_num,
        status: h.status as HealingIssue['status'],
        createdAt: h.created_at,
    }));
}

// ── Find or create ────────────────────────────────────────────────────────────

/**
 * Finds an existing healing_prs entry matching the service + issue type,
 * or creates a new one. Returns the healing_prs ID.
 * Used by the combined apply-fix endpoint.
 */
export function findOrCreateHealingEntry(
    serviceId: string,
    issueType: string,
    explanation: string,
): string {
    const db = getDb();

    // Try to find existing entry
    const existing = db.prepare<[string, string]>(`
        SELECT id FROM healing_prs
        WHERE service_id = ? AND issue_type = ?
        ORDER BY created_at DESC LIMIT 1
    `).get(serviceId, issueType) as { id: string } | undefined;

    if (existing) return existing.id;

    // Create new entry
    const id = randomUUID();
    db.prepare(`
        INSERT INTO healing_prs (id, service_id, issue_type, patch, explanation, status)
        VALUES (?, ?, ?, '', ?, 'detected')
    `).run(id, serviceId, issueType, explanation);

    return id;
}

// ── Detect issues ─────────────────────────────────────────────────────────────

/**
 * Scans the service's metadata in the DB and adds detected issues to the healing queue.
 * For full source-level scanning, the scanner would call this.
 *
 * @param serviceId - ID of the service to scan
 */
export function detectAndEnqueueIssues(serviceId: string): HealingIssue[] {
    const db = getDb();

    const svc = db.prepare<[string]>('SELECT id, name, health_score, health_tier FROM services WHERE id = ?').get(serviceId) as
        | { id: string; name: string; health_score: number; health_tier: string }
        | undefined;

    if (!svc) throw new Error(`Service ${serviceId} not found`);

    const issues: HealingIssue[] = [];

    // Check health for issue types to create
    const issueTypes: string[] = [];
    if (svc.health_score < 50) issueTypes.push('no-error-handling');
    if (svc.health_tier === 'critical') issueTypes.push('missing-retry');
    if (svc.health_score < 75) issueTypes.push('no-timeout');

    for (const issueType of issueTypes) {
        const id = randomUUID();
        const explanation = ISSUE_DESCRIPTIONS[issueType] ?? `Issue detected: ${issueType}`;

        db.prepare(`
            INSERT INTO healing_prs (id, service_id, issue_type, patch, explanation, status)
            VALUES (?, ?, ?, '', ?, 'detected')
            ON CONFLICT DO NOTHING
        `).run(id, serviceId, issueType, explanation);

        issues.push({
            id,
            serviceId,
            serviceName: svc.name,
            issueType,
            explanation,
            patch: '',
            githubPrUrl: null,
            githubPrNum: null,
            status: 'detected',
            createdAt: new Date().toISOString(),
        });
    }

    return issues;
}

// ── Generate patch ────────────────────────────────────────────────────────────

/**
 * Uses OpenAI GPT-4o to generate a code patch for a detected issue.
 * Updates the healing_prs row with the generated patch.
 *
 * @param healingId - ID of the healing_prs row to patch
 */
export async function generatePatch(healingId: string): Promise<PatchResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const openai = new OpenAI({ apiKey });
    const db = getDb();

    const pr = db.prepare<[string]>(`
        SELECT hp.*, s.name AS service_name, s.language
        FROM healing_prs hp
        JOIN services s ON s.id = hp.service_id
        WHERE hp.id = ?
    `).get(healingId) as {
        id: string; service_id: string; service_name: string; language: string | null;
        issue_type: string; explanation: string;
    } | undefined;

    if (!pr) throw new Error(`Healing item ${healingId} not found`);

    const lang = pr.language ?? 'typescript';
    const langLabel = lang === 'python' ? 'Python' : 'TypeScript/Node.js';

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
            role: 'user',
            content: `You are a ${langLabel} expert. Generate a minimal, production-ready code fix.

Service: ${pr.service_name}
Issue type: ${pr.issue_type}
Issue description: ${pr.explanation}

Respond with ONLY valid JSON:
{
  "patchedCode": "the minimal fixed code snippet (the corrected function or handler)",
  "explanation": "one paragraph explaining what was changed and why",
  "testsNeedUpdate": true,
  "testSuggestion": "what specific test case to add/update"
}

Rules:
- Change ONLY what is necessary to fix the issue
- Preserve all existing functionality
- Do not add unnecessary dependencies
- The patch must be production-ready
- For missing-retry: add exponential backoff with max 3 retries
- For no-error-handling: add proper try/catch with structured error logging
- For no-timeout: add AbortController with 10s timeout`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 1000,
    });

    const raw = JSON.parse(completion.choices[0]?.message?.content ?? '{}') as {
        patchedCode?: string;
        explanation?: string;
        testsNeedUpdate?: boolean;
        testSuggestion?: string;
    };

    const result: PatchResult = {
        patchedCode: raw.patchedCode ?? `// Fix for ${pr.issue_type} in ${pr.service_name}\n// See explanation below`,
        explanation: raw.explanation ?? `Fixed ${pr.issue_type} issue in ${pr.service_name}`,
        testsNeedUpdate: raw.testsNeedUpdate ?? true,
        testSuggestion: raw.testSuggestion ?? `Add test for ${pr.issue_type} scenario`,
    };

    db.prepare(`
        UPDATE healing_prs SET patch = ?, explanation = ?, status = 'patch-ready' WHERE id = ?
    `).run(result.patchedCode, result.explanation, healingId);

    return result;
}

// ── Create GitHub PR ──────────────────────────────────────────────────────────

export interface PRCreationResult {
    prUrl: string;
    prNumber: number;
    branchName: string;
}

/**
 * Creates a real GitHub PR with the generated patch.
 * Requires GITHUB_TOKEN env var. Updates the healing_prs row with the PR URL.
 *
 * @param healingId - ID of the patch-ready healing_prs row
 * @param repoFullName - GitHub repo in "owner/repo" format
 */
export async function createHealingPR(healingId: string, repoFullName: string): Promise<PRCreationResult> {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) throw new Error('GITHUB_TOKEN not set');

    const db = getDb();
    const pr = db.prepare<[string]>(`
        SELECT hp.*, s.name AS service_name
        FROM healing_prs hp JOIN services s ON s.id = hp.service_id WHERE hp.id = ?
    `).get(healingId) as {
        id: string; service_name: string; issue_type: string; patch: string; explanation: string;
    } | undefined;

    if (!pr) throw new Error(`Healing item ${healingId} not found`);
    if (!pr.patch) throw new Error('Patch not generated yet — run /api/heal/patch first');

    const octokit = new Octokit({ auth: githubToken });
    const [owner, repo] = repoFullName.split('/');

    // Get default branch HEAD SHA
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;
    const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
    const baseSha = ref.object.sha;

    // Create branch — sanitize issue_type for valid git ref name
    const safeName = pr.issue_type.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40);
    const branchName = `kachow/heal-${safeName}-${Date.now()}`;
    await octokit.git.createRef({
        owner, repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
    });

    // Create/update file with patch — sanitize path too
    const safeIssueType = pr.issue_type.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
    const filePath = `kachow-patches/${pr.service_name}/${safeIssueType}.patch.ts`;
    await octokit.repos.createOrUpdateFileContents({
        owner, repo,
        path: filePath,
        message: `fix(${pr.service_name}): ${pr.issue_type} — auto-generated by KA-CHOW`,
        content: Buffer.from(`/**\n * KA-CHOW Auto-Patch\n * Issue: ${pr.issue_type}\n * Service: ${pr.service_name}\n *\n * ${pr.explanation}\n */\n\n${pr.patch}`).toString('base64'),
        branch: branchName,
    });

    // Create PR
    const { data: pullRequest } = await octokit.pulls.create({
        owner, repo,
        title: `[KA-CHOW] fix(${pr.service_name}): ${pr.issue_type}`,
        body: `## 🔧 KA-CHOW Self-Healing Patch\n\n**Service:** ${pr.service_name}\n**Issue type:** \`${pr.issue_type}\`\n\n### What changed\n${pr.explanation}\n\n### Patch\n\`\`\`typescript\n${pr.patch}\n\`\`\`\n\n---\n*Auto-generated by KA-CHOW — review before merging*`,
        head: branchName,
        base: defaultBranch,
        draft: false,
    });

    // Update DB
    db.prepare(`
        UPDATE healing_prs SET github_pr_url = ?, github_pr_num = ?, status = 'pr-open' WHERE id = ?
    `).run(pullRequest.html_url, pullRequest.number, healingId);

    return {
        prUrl: pullRequest.html_url,
        prNumber: pullRequest.number,
        branchName,
    };
}
