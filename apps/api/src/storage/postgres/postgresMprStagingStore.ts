/**
 * Postgres-backed MPR staging — one table per bank format (see `schema.sql`),
 * and `memoryMprStagingStore.ts` for the same behaviour in-process.
 */

import type { MprRow } from '@toit/mpr-core';
import type { Pool } from 'pg';
import type { MprStagingStore, StagedBank, StagedRow } from '../types.js';

const TABLE: Record<StagedBank, string> = { kotak: 'recon.mpr_stage_kotak', hdfc_upi: 'recon.mpr_stage_hdfc_upi', hdfc_card: 'recon.mpr_stage_hdfc_card' };
const BANKS = Object.keys(TABLE) as StagedBank[];
/** Rows per INSERT — a requeued month of files stays a sane statement size. */
const CHUNK = 2000;

interface DbRow {
  seq: string;
  identity: string;
  occurrence: number;
  rrn: string | null;
  txn_date: string | null;
  terminal: string;
  outlet: string | null;
  file_name: string;
  data: MprRow;
}

export function createPostgresMprStagingStore(pool: Pool): MprStagingStore {
  return {
    driver: 'postgres',

    async insertRows(input) {
      let added = 0;
      for (const bank of BANKS) {
        const rows = input.filter((r) => r.bank === bank);
        for (let i = 0; i < rows.length; i += CHUNK) {
          const c = rows.slice(i, i + CHUNK);
          const { rowCount } = await pool.query(
            `INSERT INTO ${TABLE[bank]} (identity, occurrence, rrn, txn_date, terminal, outlet, file_name, data)
             SELECT identity, occurrence, rrn, txn_date, terminal, outlet, file_name, data::jsonb
             FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
               AS x(identity, occurrence, rrn, txn_date, terminal, outlet, file_name, data)
             ON CONFLICT (identity, occurrence) DO NOTHING`,
            [
              c.map((r) => r.identity), c.map((r) => r.occurrence), c.map((r) => r.rrn), c.map((r) => r.txnDate),
              c.map((r) => r.terminal), c.map((r) => r.outlet), c.map((r) => r.fileName), c.map((r) => JSON.stringify(r.row)),
            ],
          );
          added += rowCount ?? 0;
        }
      }
      return added;
    },

    async listAll() {
      const out: StagedRow[] = [];
      for (const bank of BANKS) {
        const { rows } = await pool.query<DbRow>(
          `SELECT seq, identity, occurrence, rrn, txn_date, terminal, outlet, file_name, data FROM ${TABLE[bank]} ORDER BY seq`,
        );
        for (const r of rows) {
          out.push({
            bank, seq: Number(r.seq), identity: r.identity, occurrence: r.occurrence, rrn: r.rrn, txnDate: r.txn_date,
            terminal: r.terminal, outlet: r.outlet, fileName: r.file_name, row: r.data,
          });
        }
      }
      return out;
    },

    async deleteByIdentity(bank, identities) {
      let n = 0;
      for (let i = 0; i < identities.length; i += CHUNK) {
        const { rowCount } = await pool.query(`DELETE FROM ${TABLE[bank]} WHERE identity = ANY($1::text[])`, [identities.slice(i, i + CHUNK)]);
        n += rowCount ?? 0;
      }
      return n;
    },

    async reset() {
      await pool.query(`TRUNCATE ${BANKS.map((b) => TABLE[b]).join(', ')}`);
    },
  };
}
