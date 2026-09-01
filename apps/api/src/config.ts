/**
 * Environment configuration.
 *
 * Every backing service is selected here and nowhere else. The defaults are
 * chosen so `npm run dev` works on a clean machine with no Postgres, no S3 and
 * no credentials — local disk for raw files, in-process store for sessions.
 * Setting the corresponding env vars switches each one independently.
 */

import path from 'node:path';
import { OUTLET_CODES, type OutletCode } from '@toit/recon-core';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** `ADMIN_EMAILS=alice@toit.in,bob@toit.in` → a lowercased lookup set. */
function parseAdminEmails(name: string): Set<string> {
  const v = process.env[name];
  if (!v) return new Set();
  return new Set(
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** `GM_OUTLETS=carol@toit.in:BLRT,dave@toit.in:PUNT` → a lowercased email → outlet map. Entries naming an unknown outlet code are dropped, not silently miskeyed. */
function parseGmOutlets(name: string): Map<string, OutletCode> {
  const v = process.env[name];
  const map = new Map<string, OutletCode>();
  if (!v) return map;
  for (const pair of v.split(',')) {
    const [rawEmail, rawOutlet] = pair.split(':').map((s) => s.trim());
    if (!rawEmail || !rawOutlet) continue;
    const outlet = rawOutlet.toUpperCase() as OutletCode;
    if (!(OUTLET_CODES as string[]).includes(outlet)) continue;
    map.set(rawEmail.toLowerCase(), outlet);
  }
  return map;
}

const repoRoot = path.resolve(process.cwd(), '../..');

export const config = {
  port: int('API_PORT', 4000),

  corsOrigins: str('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Largest single upload accepted. The transactions ZIP is the big one. */
  maxUploadBytes: int('MAX_UPLOAD_MB', 50) * 1024 * 1024,

  /**
   * Object storage for raw uploads.
   * `local` writes under `.data/raw/`; `s3` requires S3_BUCKET and credentials.
   */
  objectStore: {
    driver: (process.env.S3_BUCKET ? 's3' : 'local') as 'local' | 's3',
    localRoot: str('LOCAL_STORAGE_ROOT', path.join(repoRoot, '.data', 'raw')),
    region: str('S3_REGION', 'ap-south-1'),
    bucket: str('S3_BUCKET', ''),
    endpoint: str('S3_ENDPOINT', ''),
    accessKeyId: str('S3_ACCESS_KEY_ID', ''),
    secretAccessKey: str('S3_SECRET_ACCESS_KEY', ''),
  },

  /**
   * Session persistence.
   * `memory` keeps sessions in-process — fine for local development, lost on
   * restart. `postgres` requires DATABASE_URL.
   */
  sessionStore: {
    driver: (process.env.DATABASE_URL ? 'postgres' : 'memory') as 'memory' | 'postgres',
    databaseUrl: str('DATABASE_URL', ''),
  },

  /**
   * Auth. Real Google sign-in is active once `AUTH_SECRET` is set — the same
   * secret HMAC-signs the app's own bearer token (see `middleware/auth.ts`)
   * and is never sent to Google. Until then a fixed development identity is
   * injected so every route stays user-aware and outlet-scoped either way.
   */
  auth: {
    enabled: Boolean(process.env.AUTH_SECRET),
    secret: str('AUTH_SECRET', ''),
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    devUser: {
      email: str('DEV_USER_EMAIL', 'dev@toit.local'),
      role: 'admin' as const,
      outlet: null,
    },
    /** Case-insensitive; role is resolved once at Google sign-in and baked into that session's bearer token. */
    adminEmails: parseAdminEmails('ADMIN_EMAILS'),
    gmOutlets: parseGmOutlets('GM_OUTLETS'),
  },

  /** Google OAuth — Client ID/Secret from Google Cloud Console; redirect URI must match exactly what's registered there. */
  google: {
    clientId: str('GOOGLE_CLIENT_ID', ''),
    clientSecret: str('GOOGLE_CLIENT_SECRET', ''),
    redirectUri: str('GOOGLE_REDIRECT_URI', ''),
  },

  /** Where the browser lands after a successful Google sign-in. */
  webAppUrl: str('WEB_APP_URL', 'http://localhost:3000'),
} as const;

/** One-line summary of what this process is actually wired to, logged at boot. */
export function describeConfig(): string {
  const parts = [
    `port=${config.port}`,
    `objects=${config.objectStore.driver}`,
    `sessions=${config.sessionStore.driver}`,
    `auth=${config.auth.enabled ? 'credentials' : 'DEV STUB'}`,
  ];
  return parts.join('  ');
}
