/**
 * Shared Postgres connection pool.
 *
 * One pool per process, lazily created — mirrors the memoized-singleton
 * pattern already used by `storage/index.ts` for each store.
 */

import { Pool } from 'pg';
import { config } from '../../config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: config.sessionStore.databaseUrl,
    // RDS rejects unencrypted connections outright (unlike `psql`, `pg`
    // defaults to no SSL). Not verifying the CA chain is the common
    // pragmatic default for app-to-RDS traffic; swap in the RDS CA bundle
    // here if full certificate verification is ever required.
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}
