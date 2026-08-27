/**
 * View a stored session.
 *
 * Sessions are persisted server-side, so a reconciliation can be reopened by id
 * rather than only existing in the tab that ran it. Fetched on the server and
 * rendered through the same `SessionWorkspace` the live run uses, so the two
 * views cannot drift apart.
 */

import { notFound } from 'next/navigation';
import { Header } from '@/components/Header';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import { ApiError, getSession } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let session;
  try {
    session = await getSession(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <Header
        meta={session.meta}
        subtitle={`Business date: ${session.meta.businessDate ?? '—'}`}
      />
      <SessionWorkspace session={session} />
    </>
  );
}
