// Creates the MPR staging tables (same SQL as the staging section of apps/api/src/storage/postgres/schema.sql).
// Additive and idempotent: IF NOT EXISTS, touches nothing else. Run it BEFORE deploying the ingest image that uses them.
// Undo with: DROP TABLE recon.mpr_stage_kotak, recon.mpr_stage_hdfc_upi, recon.mpr_stage_hdfc_card;
import pg from 'pg';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const env = fs.readFileSync(new URL('.env', root), 'utf8');
const ddl = fs.readFileSync(new URL('../src/storage/postgres/schema.sql', import.meta.url), 'utf8');
// Only the staging section — schema.sql also holds older statements (e.g. a data backfill) that don't belong in this script.
const staging = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS recon.mpr_stage_kotak'));
const pool = new pg.Pool({ connectionString: env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^"|"$/g, ''), ssl: { rejectUnauthorized: false } });

await pool.query(staging);
const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'recon' AND table_name LIKE 'mpr_stage_%' ORDER BY 1`);
console.log('ready:', rows.map((r) => r.table_name).join(', '));
await pool.end();
