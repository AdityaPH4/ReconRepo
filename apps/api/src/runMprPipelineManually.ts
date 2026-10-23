/**
 * Manual trigger for the two automated MPR Lambdas, run locally.
 * Usage (from apps/api): npx tsx src/runMprPipelineManually.ts
 */
import { runMailFetch } from './services/mailFetchService.js';
import { runMprIngest } from './services/mprIngestService.js';

async function main() {
  console.log('--- Stage A: mail fetch ---');
  console.log(await runMailFetch());

  console.log('--- Stage B: MPR ingest ---');
  console.log(await runMprIngest());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
