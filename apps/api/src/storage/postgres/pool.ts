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
  // An idle connection RDS or the network drops (e.g. `read ETIMEDOUT`) is emitted as a pool 'error' — with no listener Node treats it as uncaught and kills the whole process. The pool discards that connection and opens a fresh one on the next query.
  pool.on('error', (err) => console.error('[pg] idle connection dropped:', err.message));
  return pool;
}
