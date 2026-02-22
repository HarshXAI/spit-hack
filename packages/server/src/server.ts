/**
 * KA-CHOW server entry point.
 * Imports the Express app, initialises the DB, starts the BullMQ worker,
 * and begins listening for HTTP traffic.
 * This file is intentionally separate from app.ts so tests can import
 * the app without triggering a server start or worker spawn.
 */

import { app } from './app.js';
import { getDb } from './db/index.js';
import { startIngestWorker, stopIngestWorker } from './workers/ingestWorker.js';
import { closeIngestQueue } from './queues/ingestQueue.js';
import { closeRedis } from './queues/redis.js';

const PORT = Number(process.env.PORT) || 3000;

// Initialise DB (creates file + runs migrations) before accepting traffic
getDb();

// Start background BullMQ worker
startIngestWorker();

const server = app.listen(PORT, () => {
    console.log(`⚡ KA-CHOW server running at http://localhost:${PORT}`);
    console.log(`   Ingest:    POST http://localhost:${PORT}/api/ingest/repo`);
    console.log(`   SSE:       GET  http://localhost:${PORT}/api/ingest/status/:jobId`);
    console.log(`   Frontend:  http://localhost:5173`);
});

// Graceful shutdown — drain BullMQ worker before exiting
async function shutdown(signal: string): Promise<void> {
    console.log(`\n[KA-CHOW] Received ${signal}, shutting down gracefully...`);
    server.close(async () => {
        await stopIngestWorker();
        await closeIngestQueue();
        await closeRedis();
        console.log('[KA-CHOW] Shutdown complete.');
        process.exit(0);
    });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
