// Creates the two tables behind the per-day MPR counters (same SQL as apps/api/src/storage/postgres/schema.sql).
// Additive and idempotent: IF NOT EXISTS, touches nothing else.
// Undo with: DROP TABLE recon.mpr_day_totals, recon.mpr_day_cleared;
import pg from 'pg';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const env = fs.readFileSync(new URL('.env', root), 'utf8');
const pool = new pg.Pool({ connectionString: env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^"|"$/g, ''), ssl: { rejectUnauthorized: false } });

await pool.query(`
  CREATE TABLE IF NOT EXISTS recon.mpr_day_totals (
    business_date TEXT NOT NULL, outlet TEXT NOT NULL, bank TEXT NOT NULL,
    total INTEGER NOT NULL, session_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (business_date, outlet, bank)
  );
  CREATE TABLE IF NOT EXISTS recon.mpr_day_cleared (
    business_date TEXT NOT NULL, outlet TEXT NOT NULL, bank TEXT NOT NULL,
    row_key TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT NOT NULL,
    PRIMARY KEY (business_date, outlet, bank, row_key)
  );
`);
const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'recon' AND table_name LIKE 'mpr_day_%' ORDER BY 1`);
console.log('ready:', rows.map((r) => r.table_name).join(', '));
await pool.end();
