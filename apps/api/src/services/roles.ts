/**
 * Email → role/outlet resolution, from the `ADMIN_EMAILS`/`GM_OUTLETS`
 * allowlists (`config.ts`). The sole gate on who can sign in at all — an
 * email in neither list is not a user of this app.
 */

import type { CurrentUserDTO } from '@toit/contracts';
import { config } from '../config.js';

export function resolveUser(email: string): CurrentUserDTO | null {
  const lower = email.toLowerCase();
  if (config.auth.adminEmails.has(lower)) {
    return { email, role: 'admin', outlet: null };
  }
  const outlet = config.auth.gmOutlets.get(lower);
  if (outlet) {
    return { email, role: 'gm', outlet };
  }
  return null;
}
