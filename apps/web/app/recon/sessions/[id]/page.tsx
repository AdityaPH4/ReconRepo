/**
 * View a stored session.
 *
 * Sessions are persisted server-side, so a reconciliation can be reopened by id
 * rather than only existing in the tab that ran it. Data is fetched
 * client-side by `StoredSessionView` — see its own doc comment for why.
 */

import { StoredSessionView } from '@/components/StoredSessionView';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StoredSessionView id={id} />;
}
