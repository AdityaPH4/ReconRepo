/**
 * Google sign-in.
 *
 * The whole OAuth dance happens here, server-side — the browser only ever
 * sees two redirects and comes back with the app's own bearer token
 * (`services/authToken.ts`). Deliberately not cookie-based: this API and the
 * web app run on different origins (and, per this app's own LAN-access setup,
 * sometimes different hosts entirely), where cross-site cookies are its own
 * source of pain. A bearer token in an `Authorization` header sidesteps that
 * entirely.
 *
 * Mounted at `/auth`, outside `/api/*` — `attachUser` only requires a token
 * for `/api/*`.
 */

import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { signOAuthState, signToken, verifyOAuthState } from '../services/authToken.js';
import { resolveUser } from '../services/roles.js';

export const authRouter = Router();

function client(): OAuth2Client {
  return new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

function requireGoogleConfigured(res: import('express').Response): boolean {
  if (config.google.clientId && config.google.clientSecret && config.google.redirectUri) return true;
  res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  return false;
}

authRouter.get('/google/login', (req, res) => {
  if (!requireGoogleConfigured(res)) return;
  const redirect = typeof req.query.redirect === 'string' ? req.query.redirect : '/';
  const state = signOAuthState(redirect, config.auth.secret);
  const url = client().generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
  res.redirect(url);
});

authRouter.get('/google/callback', async (req, res) => {
  if (!requireGoogleConfigured(res)) return;
  const { code, state } = req.query;
  const verifiedState = typeof state === 'string' ? verifyOAuthState(state, config.auth.secret) : null;
  const redirect = verifiedState?.redirect ?? '/';

  if (typeof code !== 'string' || !verifiedState) {
    res.redirect(`${config.webAppUrl}/auth/callback?error=invalid_state`);
    return;
  }

  try {
    const oauth = client();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.id_token) {
      res.redirect(`${config.webAppUrl}/auth/callback?error=no_id_token`);
      return;
    }
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    const payload = ticket.getPayload();
    const email = payload?.email;
    if (!email || !payload.email_verified) {
      res.redirect(`${config.webAppUrl}/auth/callback?error=unverified_email`);
      return;
    }

    const user = resolveUser(email);
    if (!user) {
      res.redirect(`${config.webAppUrl}/auth/callback?error=not_provisioned`);
      return;
    }

    const appToken = signToken(user, config.auth.secret, config.auth.sessionTtlHours);
    const returnPath = redirect.startsWith('/') ? redirect : '/';
    res.redirect(
      `${config.webAppUrl}/auth/callback?token=${encodeURIComponent(appToken)}&redirect=${encodeURIComponent(returnPath)}`,
    );
  } catch (err) {
    console.error('[api] Google sign-in failed:', err);
    res.redirect(`${config.webAppUrl}/auth/callback?error=sign_in_failed`);
  }
});
