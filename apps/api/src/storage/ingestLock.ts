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
  // The pool only listens for errors on idle connections; on one that is checked out, a dropped connection would
  // otherwise be an uncaught exception that kills the Lambda mid-run.
  const onError = (err: Error) => console.error('[mpr-ingest] lock connection dropped:', err.message);
  client.on('error', onError);
  const done = () => {
    client.off('error', onError);
    client.release();
  };
  try {
    const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('mpr-ingest')) AS ok`);
    if (!rows[0]?.ok) {
      done();
      return null;
    }
  } catch (err) {
    done();
    throw err;
  }
  return async () => {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('mpr-ingest'))`);
    } catch (err) {
      console.error('[mpr-ingest] could not release the lock cleanly:', (err as Error).message); // a dead connection has already dropped it
    } finally {
      done();
    }
  };
}
