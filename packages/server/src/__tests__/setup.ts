/**
 * Vitest global setup for the @kachow/server test suite.
 * Ensures the test database is closed cleanly after all tests complete,
 * preventing file handle leaks that could fail subsequent test runs.
 */

import { afterAll } from 'vitest';
import { closeTestDb } from '../db/test-helpers';

afterAll(() => {
    closeTestDb();
});
