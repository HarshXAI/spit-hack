/**
 * Notification routes — Slack & Jira integrations.
 *
 *   POST /api/notifications/slack   — Send Slack alert for a critical issue
 *   POST /api/notifications/jira    — Comment or create Jira ticket
 */

import { Router, type Router as ExpressRouter, Request, Response } from 'express';
import { z } from 'zod';
import {
    sendSlackNotification,
    commentOrCreateJira,
} from '../services/notificationService.js';
import { ok, err } from '../types/index.js';

const router: ExpressRouter = Router();

// ── POST /api/notifications/slack ─────────────────────────────────────────────

const SlackSchema = z.object({
    issueId: z.string().min(1, 'issueId required'),
    channel: z.string().optional(),
    customMessage: z.string().optional(),
    // For agent-sourced issues, the full issue context is passed from frontend
    issueContext: z.object({
        serviceName: z.string(),
        serviceId: z.string(),
        severity: z.string(),
        title: z.string(),
        description: z.string(),
        category: z.string(),
        file: z.string().nullable().optional(),
        line: z.number().nullable().optional(),
        suggestedFix: z.string().nullable().optional(),
        source: z.string(),
    }).optional(),
});

router.post('/slack', async (req: Request, res: Response): Promise<void> => {
    const parse = SlackSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const result = await sendSlackNotification(
            { issueId: parse.data.issueId, channel: parse.data.channel, customMessage: parse.data.customMessage },
            parse.data.issueContext ?? undefined,
        );
        res.json(ok(result));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Slack notification failed'));
    }
});

// ── POST /api/notifications/jira ──────────────────────────────────────────────

const JiraSchema = z.object({
    issueId: z.string().min(1, 'issueId required'),
    jiraIssueKey: z.string().optional(),
    createNewTicket: z.boolean().optional(),
    issueContext: z.object({
        serviceName: z.string(),
        serviceId: z.string(),
        severity: z.string(),
        title: z.string(),
        description: z.string(),
        category: z.string(),
        file: z.string().nullable().optional(),
        line: z.number().nullable().optional(),
        suggestedFix: z.string().nullable().optional(),
        source: z.string(),
    }).optional(),
});

router.post('/jira', async (req: Request, res: Response): Promise<void> => {
    const parse = JiraSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json(err(parse.error.errors.map(e => e.message).join('; ')));
        return;
    }

    try {
        const result = await commentOrCreateJira(
            {
                issueId: parse.data.issueId,
                jiraIssueKey: parse.data.jiraIssueKey,
                createNewTicket: parse.data.createNewTicket,
            },
            parse.data.issueContext ?? undefined,
        );
        res.json(ok(result));
    } catch (e) {
        res.status(500).json(err(e instanceof Error ? e.message : 'Jira integration failed'));
    }
});

export { router as notificationRouter };
