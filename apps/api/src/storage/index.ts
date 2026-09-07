/**
 * Storage wiring — the one place that decides which driver is in play.
 */

import { config } from '../config.js';
import { createLocalObjectStore } from './localObjectStore.js';
import { createMemoryAdvanceStore } from './memoryAdvanceStore.js';
import { createMemoryApprovalStore } from './memoryApprovalStore.js';
import { createMemoryBohStore } from './memoryBohStore.js';
import { createMemoryMprSessionStore } from './memoryMprSessionStore.js';
import { createMemorySessionStore } from './memorySessionStore.js';
import { getPool } from './postgres/pool.js';
import { createPostgresAdvanceStore } from './postgres/postgresAdvanceStore.js';
import { createPostgresApprovalStore } from './postgres/postgresApprovalStore.js';
import { createPostgresBohStore } from './postgres/postgresBohStore.js';
import { createPostgresMprSessionStore } from './postgres/postgresMprSessionStore.js';
import { createPostgresSessionStore } from './postgres/postgresSessionStore.js';
import { createS3ObjectStore } from './s3ObjectStore.js';
import type {
  AdvanceStore,
  ApprovalStore,
  BohStore,
  MprSessionStore,
  ObjectStore,
  SessionStore,
} from './types.js';

let objectStore: ObjectStore | null = null;
let sessionStore: SessionStore | null = null;
let advanceStore: AdvanceStore | null = null;
let bohStore: BohStore | null = null;
let mprSessionStore: MprSessionStore | null = null;
let approvalStore: ApprovalStore | null = null;

export function getObjectStore(): ObjectStore {
  if (objectStore) return objectStore;

  if (config.objectStore.driver === 's3') {
    objectStore = createS3ObjectStore({
      region: config.objectStore.region,
      bucket: config.objectStore.bucket,
      endpoint: config.objectStore.endpoint || undefined,
      accessKeyId: config.objectStore.accessKeyId || undefined,
      secretAccessKey: config.objectStore.secretAccessKey || undefined,
    });
    return objectStore;
  }

  objectStore = createLocalObjectStore(config.objectStore.localRoot);
  return objectStore;
}

export function getSessionStore(): SessionStore {
  if (sessionStore) return sessionStore;

  if (config.sessionStore.driver === 'postgres') {
    sessionStore = createPostgresSessionStore(getPool());
    return sessionStore;
  }

  sessionStore = createMemorySessionStore();
  return sessionStore;
}

export function getAdvanceStore(): AdvanceStore {
  if (advanceStore) return advanceStore;

  if (config.sessionStore.driver === 'postgres') {
    advanceStore = createPostgresAdvanceStore(getPool());
    return advanceStore;
  }

  advanceStore = createMemoryAdvanceStore();
  return advanceStore;
}

export function getBohStore(): BohStore {
  if (bohStore) return bohStore;

  if (config.sessionStore.driver === 'postgres') {
    bohStore = createPostgresBohStore(getPool());
    return bohStore;
  }

  bohStore = createMemoryBohStore();
  return bohStore;
}

export function getMprSessionStore(): MprSessionStore {
  if (mprSessionStore) return mprSessionStore;

  if (config.sessionStore.driver === 'postgres') {
    mprSessionStore = createPostgresMprSessionStore(getPool());
    return mprSessionStore;
  }

  mprSessionStore = createMemoryMprSessionStore();
  return mprSessionStore;
}

export function getApprovalStore(): ApprovalStore {
  if (approvalStore) return approvalStore;

  if (config.sessionStore.driver === 'postgres') {
    approvalStore = createPostgresApprovalStore(getPool());
    return approvalStore;
  }

  approvalStore = createMemoryApprovalStore();
  return approvalStore;
}

export type { AdvanceStore, ApprovalStore, BohStore, MprSessionStore, ObjectStore, SessionStore } from './types.js';
export { buildStorageKey } from './types.js';
