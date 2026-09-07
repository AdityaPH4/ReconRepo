/**
 * Local dev / container entry point — binds a port and listens.
 * For Lambda, see `lambda.ts`, which wraps the same `app` instead.
 */

import { app } from './app.js';
import { config, describeConfig } from './config.js';

app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
  console.log(`[api] ${describeConfig()}`);
  if (config.sessionStore.driver === 'memory') {
    console.log('[api] NOTE: sessions are in-memory and will be lost on restart.');
  }
  if (!config.auth.enabled) {
    console.log(
      `[api] NOTE: auth is stubbed — every request runs as ${config.auth.devUser.email}.`,
    );
  }
});
