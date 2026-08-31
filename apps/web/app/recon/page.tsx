import { ReconciliationApp } from '@/components/ReconciliationApp';

/**
 * The reconciliation workspace.
 *
 * A single route by design — the legacy tool was one screen that swapped
 * between an upload state and a results state, and splitting that across routes
 * would change the operator's workflow. The state machine lives in
 * `ReconciliationApp`.
 */
export default function Page() {
  return <ReconciliationApp />;
}
