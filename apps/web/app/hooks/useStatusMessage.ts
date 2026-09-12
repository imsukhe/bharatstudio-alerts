'use client';

/*
 * The `message`/`messageKind` success-vs-error notification pattern was
 * redeclared independently in the Alerts page, Mod console, DashboardClient
 * and Companion page — same two state variables, same `notify(text, kind)`
 * shape (or the same setMessage+setMessageKind pair inlined). Extracted
 * once so every call site sets both together and no call site can regress
 * to a single shared `message` string with no success/error distinction.
 */
import { useState } from 'react';

export type MessageKind = 'success' | 'error';

export function useStatusMessage(initialMessage: string | null = null) {
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [messageKind, setMessageKind] = useState<MessageKind>('success');

  function notify(text: string, kind: MessageKind = 'success') {
    setMessage(text);
    setMessageKind(kind);
  }

  function clear() {
    setMessage(null);
  }

  return { message, messageKind, notify, clear, setMessage, setMessageKind };
}
