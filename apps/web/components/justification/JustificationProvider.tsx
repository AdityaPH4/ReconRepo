'use client';

/**
 * The justification layer's shared context: the current session, whether
 * it's locked (submitted), a setter every mutation calls with the API's
 * response, and a way to open one of the six modals from anywhere in the
 * tree (a Pinelabs row, an HDFC-UPI row, or the Cash/UPI/Bank tabs all reach
 * the same modal components).
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { SessionDTO } from '@toit/contracts';
import { AdvanceAppliedModal } from './modals/AdvanceAppliedModal';
import { AdvanceReceivedModal } from './modals/AdvanceReceivedModal';
import { BohAddModal } from './modals/BohAddModal';
import { BohClearModal } from './modals/BohClearModal';
import { EprModal } from './modals/EprModal';
import { OtherModal } from './modals/OtherModal';
import { ShortCollectionModal } from './modals/ShortCollectionModal';
import type { ModalRequest } from './types';

interface JustificationCtxValue {
  session: SessionDTO;
  locked: boolean;
  updateSession: (session: SessionDTO) => void;
  openModal: (request: ModalRequest) => void;
}

const JustificationCtx = createContext<JustificationCtxValue | null>(null);

export function useJustification(): JustificationCtxValue {
  const ctx = useContext(JustificationCtx);
  if (!ctx) throw new Error('useJustification() must be used inside a JustificationProvider');
  return ctx;
}

export function JustificationProvider({
  session,
  onSessionUpdate,
  children,
}: {
  session: SessionDTO;
  onSessionUpdate: (session: SessionDTO) => void;
  children: ReactNode;
}) {
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const locked = session.meta.status === 'submitted';

  const value: JustificationCtxValue = {
    session,
    locked,
    updateSession: onSessionUpdate,
    openModal: (request) => {
      if (!locked) setModal(request);
    },
  };

  function close() {
    setModal(null);
  }

  function saved(updated: SessionDTO) {
    onSessionUpdate(updated);
    close();
  }

  return (
    <JustificationCtx.Provider value={value}>
      {children}
      {modal?.kind === 'advance-received' && (
        <AdvanceReceivedModal session={session} request={modal} onClose={close} onSaved={saved} />
      )}
      {modal?.kind === 'advance-applied' && (
        <AdvanceAppliedModal session={session} request={modal} onClose={close} onSaved={saved} />
      )}
      {modal?.kind === 'boh-clear' && (
        <BohClearModal session={session} request={modal} onClose={close} onSaved={saved} />
      )}
      {modal?.kind === 'boh-add' && (
        <BohAddModal session={session} request={modal} onClose={close} onSaved={saved} />
      )}
      {modal?.kind === 'epr' && <EprModal session={session} request={modal} onClose={close} onSaved={saved} />}
      {modal?.kind === 'other' && <OtherModal session={session} request={modal} onClose={close} onSaved={saved} />}
      {modal?.kind === 'short-collection' && (
        <ShortCollectionModal session={session} request={modal} onClose={close} onSaved={saved} />
      )}
    </JustificationCtx.Provider>
  );
}
