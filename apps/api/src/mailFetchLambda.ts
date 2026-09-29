/**
 * Lambda entry point for Stage A of automated MPR ingestion (no VPC — see
 * `mailFetchService.ts`'s own doc comment for why). Same container image as
 * the main API's `lambda.ts`; deployed as a separate Lambda function with
 * its CMD overridden to this file's handler, triggered by its own
 * EventBridge Scheduled Rule rather than API Gateway — there is no HTTP
 * request/response here, so this is a plain async handler, not wrapped in
 * `serverless-http`.
 */

import { runMailFetch } from './services/mailFetchService.js';

export const handler = async () => {
  const result = await runMailFetch();
  return result;
};
