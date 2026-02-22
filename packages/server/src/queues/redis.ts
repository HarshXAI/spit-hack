/**
 * Redis connection for BullMQ.
 * A single shared IORedis instance reused by all queues and workers.
 * Connection parameters are read from environment variables.
 *
 * Set DISABLE_REDIS=true to skip Redis entirely (jobs run in-process).
 */

import { Redis } from 'ioredis';

let _redis: Redis | null = null;

/** Returns true when Redis has been explicitly disabled via env var. */
export function isRedisDisabled(): boolean {
    return process.env.DISABLE_REDIS === 'true';
}

/**
 * Returns (and lazily creates) the shared Redis client.
 * Returns null when DISABLE_REDIS=true — callers must handle the null case.
 *
 * @returns Shared IORedis instance or null if Redis is disabled
 */
export function getRedis(): Redis | null {
    if (isRedisDisabled()) return null;
    if (!_redis) {
        _redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT) || 6379,
            password: process.env.REDIS_PASSWORD || undefined,
            maxRetriesPerRequest: null, // required by BullMQ
            enableReadyCheck: false,
            // Stop hammering the console — log once, then back off silently
            retryStrategy: (times: number) => {
                if (times === 1) console.warn('[Redis] Not available — ingest jobs will run in-process. Set DISABLE_REDIS=true to silence this.');
                return Math.min(times * 500, 10_000);
            },
        });

        _redis.on('error', () => { /* suppressed — retryStrategy already warned */ });
    }
    return _redis;
}

/**
 * Closes the shared Redis connection.
 * Call during graceful server shutdown.
 *
 * @returns Promise that resolves when connection is fully closed
 */
export async function closeRedis(): Promise<void> {
    if (_redis) {
        await _redis.quit();
        _redis = null;
    }
}
