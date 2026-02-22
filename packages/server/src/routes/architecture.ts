/**
 * Architecture diagram routes — Phase 9.
 *
 * GET  /api/architecture/flow              — Services in layers (INGRESS/CORE/DOMAIN/INFRA)
 * GET  /api/architecture/blueprint/:id     — Full service blueprint
 * POST /api/architecture/propose           — AI-proposed new service (brownie points)
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import OpenAI from 'openai';
import { getArchitectureFlow, getServiceBlueprint } from '../services/architectureService.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

// ── GET /api/architecture/flow ────────────────────────────────────────────────

router.get('/flow', (_req: Request, res: Response): void => {
    try {
        res.json(ok(getArchitectureFlow()));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get architecture flow'));
    }
});

// ── GET /api/architecture/blueprint/:serviceId ────────────────────────────────

router.get('/blueprint/:serviceId', (req: Request, res: Response): void => {
    try {
        const blueprint = getServiceBlueprint(req.params.serviceId);
        if (!blueprint) {
            res.status(404).json(err(`Service ${req.params.serviceId} not found`));
            return;
        }
        res.json(ok(blueprint));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Failed to get blueprint'));
    }
});

// ── POST /api/architecture/propose (brownie points) ───────────────────────────

const ProposeSchema = z.object({
    requirement: z.string().min(10, 'Requirement must be at least 10 characters').max(500),
});

router.post('/propose', async (req: Request, res: Response): Promise<void> => {
    const parse = ProposeSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        res.status(503).json(err('OPENAI_API_KEY not set'));
        return;
    }

    try {
        const openai = new OpenAI({ apiKey });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'user',
                content: `You are a senior software architect. Design a new microservice to fulfil this requirement: "${parse.data.requirement}"

Respond with ONLY valid JSON:
{
  "name": "kebab-case-service-name",
  "description": "what this service does",
  "dependencies": ["existing-service-name"],
  "techStack": ["Node.js", "TypeScript", "PostgreSQL"],
  "folderStructure": ["src/index.ts", "src/routes.ts", "src/service.ts"],
  "adraft": "one paragraph ADR context for this decision"
}`,
            }],
            response_format: { type: 'json_object' },
            temperature: 0.4,
            max_tokens: 600,
        });

        const proposed = JSON.parse(completion.choices[0]?.message?.content ?? '{}');
        res.json(ok({ proposedService: proposed, requirement: parse.data.requirement }));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Proposal generation failed'));
    }
});

export { router as architectureRouter };
