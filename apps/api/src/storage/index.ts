/**
 * Storage wiring — the one place that decides which driver is in play.
 */

import { config } from '../config.js';
import { createLocalObjectStore } from './localObjectStore.js';
import { createMemorySessionStore } from './memorySessionStore.js';
import type { ObjectStore, SessionStore } from './types.js';

let objectStore: ObjectStore | null = null;
let sessionStore: SessionStore | null = null;

export function getObjectStore(): ObjectStore {
  if (objectStore) return objectStore;

  if (config.objectStore.driver === 's3') {
    // Wired in Step 2 alongside the Prisma layer. Failing loudly is better than
    // silently writing production uploads to a developer's disk.
    throw new Error(
      'S3 object store is not implemented yet. Unset S3_BUCKET to use local disk.',
    );
  }

  objectStore = createLocalObjectStore(config.objectStore.localRoot);
  return objectStore;
}

export function getSessionStore(): SessionStore {
  if (sessionStore) return sessionStore;

  if (config.sessionStore.driver === 'postgres') {
    throw new Error(
      'Postgres session store is not implemented yet. Unset DATABASE_URL to use the in-memory store.',
    );
  }

  sessionStore = createMemorySessionStore();
  return sessionStore;
}

export type { ObjectStore, SessionStore } from './types.js';
export { buildStorageKey } from './types.js';
