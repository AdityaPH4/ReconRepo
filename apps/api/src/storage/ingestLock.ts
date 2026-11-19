/**
 * Keeps two `mpr-ingest` runs (the schedule plus a console "Test", say) from
 * overlapping. A Postgres session advisory lock held on its own connection for
 * the run: if the process dies the connection closes and the lock goes with it,
 * so it can't get stuck. Returns a release function, or null when another run
 * holds it. Without Postgres (local dev) there is nothing to guard against.
 */

import { config } from '../config.js';
import { getPool } from './postgres/pool.js';

export async function tryIngestLock(): Promise<(() => Promise<void>) | null> {
  if (config.sessionStore.driver !== 'postgres') return async () => {};
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('mpr-ingest')) AS ok`);
    if (!rows[0]?.ok) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('mpr-ingest'))`);
    } finally {
      client.release();
    }
  };
}
