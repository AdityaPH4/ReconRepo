import { MprApp } from '@/components/mpr/MprApp';

/**
 * The MPR (Layer 2) reconciliation workspace — the second module.
 * A single route by design, same reasoning as the Payment Reconciliation
 * module's `/` route: one screen that swaps between upload and results.
 */
export default function Page() {
  return <MprApp />;
}
