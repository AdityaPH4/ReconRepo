/**
 * Lambda entry point for Stage B of automated MPR ingestion. Same
 * container image as the main API's `lambda.ts`, deployed as a separate
 * Lambda function with its CMD overridden to this file's handler,
 * VPC-attached (same VPC/subnets/security group as the main API Lambda,
 * for RDS access) and triggered by its own EventBridge Scheduled Rule
 * rather than API Gateway or an S3 event — see `mprIngestService.ts`'s own
 * doc comment for why a schedule, not a per-file S3 trigger, is correct
 * here. Plain async handler, not wrapped in `serverless-http` — there is
 * no HTTP request/response involved.
 */

import { runMprIngest } from './services/mprIngestService.js';

export const handler = async () => {
  const result = await runMprIngest();
  return result;
};
