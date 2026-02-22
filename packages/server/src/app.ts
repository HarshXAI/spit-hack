/**
 * KA-CHOW Express application.
 * Sets up middleware, mounts route handlers, and defines error handling.
 * This file exports the `app` — it does NOT call app.listen().
 * Server startup lives in server.ts.
 */

import express, { type Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { ingestRouter } from './routes/ingest.js';
import { graphRouter } from './routes/graph.js';
import { githubRouter } from './routes/github.js';
import { impactRouter } from './routes/impact.js';
import { qaRouter } from './routes/qa.js';
import { streamRouter } from './routes/stream.js';
import { managerRouter } from './routes/manager.js';
import { architectureRouter } from './routes/architecture.js';
import { healingRouter } from './routes/healing.js';
import { webhooksRouter } from './routes/webhooks.js';
import { scannerRouter } from './routes/scanner.js';
import { agentRouter } from './routes/agents.js';
import { notificationRouter } from './routes/notifications.js';

// Load .env — try monorepo root first (packages/server → ../../), then local fallback
dotenv.config({ path: resolve(process.cwd(), '../../.env') });
dotenv.config(); // no-op if already loaded; handles local .env for non-monorepo setups

const app: Application = express();

// ── Middleware ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
    .concat(['http://localhost:5173', 'http://localhost:8080', 'http://127.0.0.1:8080']);

app.use(
    cors({
        origin: (origin, cb) => {
            // Allow requests with no origin (curl, Postman, server-to-server)
            if (!origin) return cb(null, true);
            if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
            cb(new Error(`CORS: origin ${origin} not allowed`));
        },
        credentials: true,
    }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Server health check used by load balancers and the frontend status strip.
 *
 * @returns Standard ApiResponse with server status and version
 */
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: { status: 'ok', version: '1.0.0' },
        error: null,
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    });
});

// ── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/ingest', ingestRouter);
app.use('/api/graph', graphRouter);
app.use('/api/github', githubRouter);
app.use('/api/impact', impactRouter);
app.use('/api/qa', qaRouter);
app.use('/api/stream', streamRouter);
app.use('/api/manager', managerRouter);
app.use('/api/onboarding', managerRouter);   // brief: GET /api/onboarding/path/:role
app.use('/api/architecture', architectureRouter);
app.use('/api/heal', healingRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/scanner', scannerRouter);
app.use('/api/agents', agentRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/ci', webhooksRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
    res.status(404).json({
        success: false,
        data: null,
        error: `Route ${req.method} ${req.path} not found`,
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    });
});

// ── Global error handler ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[KA-CHOW Error]', err.stack);
    res.status(500).json({
        success: false,
        data: null,
        error: err.message || 'Internal Server Error',
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    });
});

export { app };
