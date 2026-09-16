/**
 * Local dev entry point for the auth-only app — there wasn't one until now;
 * `authApp.ts` only ever had a Lambda entry point (`authLambda.ts`), since in
 * production it's deployed as its own function specifically to dodge the
 * main API Lambda's VPC attachment (see `authApp.ts`'s doc comment). Locally
 * there's no VPC constraint at all, so this just binds a second port next to
 * the main API's — real Google sign-in was never actually reachable from
 * `npm run dev` before this file existed.
 */

import { authApp } from './authApp.js';
import { config } from './config.js';

authApp.listen(config.authPort, () => {
  console.log(`[auth] listening on http://localhost:${config.authPort}`);
  if (!config.auth.enabled) {
    console.log('[auth] NOTE: AUTH_SECRET is unset — token signing will fail. Set it to actually sign in.');
  }
  if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
    console.log('[auth] NOTE: Google OAuth is not fully configured (client id/secret/redirect URI).');
  }
});
