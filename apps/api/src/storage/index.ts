/**
 * Storage wiring — the one place that decides which driver is in play.
 */

import { config } from '../config.js';
import { createLocalObjectStore } from './localObjectStore.js';
import { createMemoryAdvanceStore } from './memoryAdvanceStore.js';
import { createMemoryBohStore } from './memoryBohStore.js';
import { createMemoryMprSessionStore } from './memoryMprSessionStore.js';
import { createMemorySessionStore } from './memorySessionStore.js';
import type { AdvanceStore, BohStore, MprSessionStore, ObjectStore, SessionStore } from './types.js';

let objectStore: ObjectStore | null = null;
let sessionStore: SessionStore | null = null;
let advanceStore: AdvanceStore | null = null;
let bohStore: BohStore | null = null;
let mprSessionStore: MprSessionStore | null = null;

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

export function getAdvanceStore(): AdvanceStore {
  if (advanceStore) return advanceStore;

  if (config.sessionStore.driver === 'postgres') {
    throw new Error(
      'Postgres advance store is not implemented yet. Unset DATABASE_URL to use the in-memory store.',
    );
  }

  advanceStore = createMemoryAdvanceStore();
  return advanceStore;
}

export function getBohStore(): BohStore {
  if (bohStore) return bohStore;

  if (config.sessionStore.driver === 'postgres') {
    throw new Error('Postgres BOH store is not implemented yet. Unset DATABASE_URL to use the in-memory store.');
  }

  bohStore = createMemoryBohStore();
  return bohStore;
}

export function getMprSessionStore(): MprSessionStore {
  if (mprSessionStore) return mprSessionStore;

  if (config.sessionStore.driver === 'postgres') {
    throw new Error(
      'Postgres MPR session store is not implemented yet. Unset DATABASE_URL to use the in-memory store.',
    );
  }

  mprSessionStore = createMemoryMprSessionStore();
  return mprSessionStore;
}

export type { AdvanceStore, BohStore, MprSessionStore, ObjectStore, SessionStore } from './types.js';
export { buildStorageKey } from './types.js';
