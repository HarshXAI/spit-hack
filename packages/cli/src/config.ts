/**
 * kachow.config.yaml reader and validator.
 * Uses Zod to parse and type-check the user's config file.
 * Environment variable substitution (${VAR}) is handled here.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const RepoSchema = z.object({
    name: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
    team: z.string().optional(),
    language: z.string().optional(),
});

const StandardsSchema = z
    .object({
        require_openapi_spec: z.boolean().default(false),
        require_readme: z.boolean().default(true),
        require_error_handling: z.boolean().default(true),
        min_test_coverage: z.number().min(0).max(100).default(70),
        require_retry_on_external_calls: z.boolean().default(false),
    })
    .default({});

const IntegrationsSchema = z
    .object({
        github: z
            .object({
                token: z.string().optional(),
                webhook_secret: z.string().optional(),
                block_high_risk_prs: z.boolean().default(true),
                risk_score_threshold: z.number().default(7),
            })
            .optional(),
        slack: z
            .object({
                bot_token: z.string().optional(),
                channels: z.record(z.string()).optional(),
            })
            .optional(),
        jira: z
            .object({
                base_url: z.string().optional(),
                email: z.string().optional(),
                token: z.string().optional(),
                project_key: z.string().optional(),
            })
            .optional(),
        confluence: z
            .object({
                base_url: z.string().optional(),
                token: z.string().optional(),
                adr_space: z.string().optional(),
            })
            .optional(),
    })
    .default({});

const LlmSchema = z
    .object({
        anthropic_key: z.string().optional(),
        openai_key: z.string().optional(),
        qa_model: z.string().default('claude-sonnet-4-6'),
        healing_model: z.string().default('gpt-4o'),
    })
    .default({});

// ── Root schema ───────────────────────────────────────────────────────────────

const KachowConfigSchema = z.object({
    version: z.number().default(1),
    project: z.object({
        name: z.string(),
        description: z.string().optional(),
    }),
    repos: z.array(RepoSchema).default([]),
    standards: StandardsSchema,
    integrations: IntegrationsSchema,
    llm: LlmSchema,
});

export type KachowConfig = z.infer<typeof KachowConfigSchema>;
export type RepoConfig = z.infer<typeof RepoSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively replace ${ENV_VAR} placeholders in a string with process.env values.
 *
 * @param value - String that may contain ${VAR} placeholders
 * @returns String with all recognised placeholders substituted
 */
function interpolateEnv(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
        return process.env[key] ?? '';
    });
}

/**
 * Walk any object and interpolate env vars in string leaves.
 *
 * @param obj - Arbitrary object (string, array, or record)
 * @returns Object with all string values interpolated
 */
function interpolateObject(obj: unknown): unknown {
    if (typeof obj === 'string') return interpolateEnv(obj);
    if (Array.isArray(obj)) return obj.map(interpolateObject);
    if (obj !== null && typeof obj === 'object') {
        return Object.fromEntries(
            Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateObject(v)]),
        );
    }
    return obj;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reads, interpolates env vars, and validates kachow.config.yaml.
 *
 * @param configDir - Directory containing kachow.config.yaml (defaults to cwd)
 * @returns Parsed and validated KachowConfig
 * @throws If the config file is missing, unreadable, or fails Zod validation
 */
export function readConfig(configDir: string = process.cwd()): KachowConfig {
    const configPath = path.join(configDir, 'kachow.config.yaml');

    if (!fs.existsSync(configPath)) {
        throw new Error(
            `kachow.config.yaml not found at ${configPath}.\n` +
            `Run 'kachow init' to create one, or copy .env.example to .env and add a kachow.config.yaml.`,
        );
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const interpolated = interpolateObject(parsed) as Record<string, unknown>;

    return KachowConfigSchema.parse(interpolated);
}
