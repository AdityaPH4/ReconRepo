/**
 * Environment configuration.
 *
 * Every backing service is selected here and nowhere else. The defaults are
 * chosen so `npm run dev` works on a clean machine with no Postgres, no S3 and
 * no credentials — local disk for raw files, in-process store for sessions.
 * Setting the corresponding env vars switches each one independently.
 */

import path from 'node:path';

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
   * Auth. Real credential auth lands with Postgres; until then a fixed
   * development identity is injected so every route is already written
   * user-aware and outlet-scoped, with nothing to unpick later.
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
  },
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
