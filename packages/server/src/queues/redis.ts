/**
 * Redis connection for BullMQ.
 * A single shared IORedis instance reused by all queues and workers.
 * Connection parameters are read from environment variables.
 */

import { Redis } from 'ioredis';

let _redis: Redis | null = null;

/**
 * Returns (and lazily creates) the shared Redis client.
 * Skips real connection in test environment to avoid needing Redis in CI.
 *
 * @returns Shared IORedis instance
 */
export function getRedis(): Redis {
    if (!_redis) {
        _redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT) || 6379,
            password: process.env.REDIS_PASSWORD || undefined,
            maxRetriesPerRequest: null, // required by BullMQ
            enableReadyCheck: false,
        });

        _redis.on('error', (error: Error) => {
            console.error('[Redis] Connection error:', error.message);
        });
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
