/**
 * View a stored MPR (Layer 2) session — mirrors `/sessions/[id]`.
 */

import { notFound } from 'next/navigation';
import { MprHeader } from '@/components/mpr/MprHeader';
import { MprWorkspace } from '@/components/mpr/MprWorkspace';
import { ApiError, getMprSession } from '@/lib/mprApi';

export const dynamic = 'force-dynamic';

export default async function MprSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let session;
  try {
    session = await getMprSession(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <MprHeader subtitle={`Run ${new Date(session.meta.createdAt).toLocaleString('en-IN')}`} />
      <main className="app-main">
        <MprWorkspace session={session} />
      </main>
    </>
  );
}
