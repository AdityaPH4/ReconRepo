/**
 * Lambda entry point for the auth-only app (no VPC — see `authApp.ts`).
 * Same container image as the main API's `lambda.ts`; deployed as a second
 * Lambda function with its CMD overridden to this file's handler.
 */

import serverless from 'serverless-http';
import { authApp } from './authApp.js';

export const handler = serverless(authApp);
