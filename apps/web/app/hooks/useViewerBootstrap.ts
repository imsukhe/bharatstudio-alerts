'use client';

/*
 * Parallel to useChannelBootstrap.ts, NOT a reuse of it. useChannelBootstrap
 * is hard-wired to the creator surface: it always calls getCurrentUser()
 * (the CREATOR session, creator sessionStorage token) and always yields a
 * CurrentUser. A viewer account is a separate auth surface (see
 * packages/db/migrations/0084's header comment) with its own token and no
 * equivalent single "current user" endpoint — the closest thing is
 * whichever viewer-scoped fetch a given page actually needs (dashboard,
 * sessions, ...). Bending useChannelBootstrap to cover that would mean
 * either hardcoding one viewer endpoint into a creator-named hook, or
 * threading a fetcher through it and losing the one thing that made it
 * useful (a single, obviously-creator-scoped call). A small generic
 * version, kept in this file, is clearer than either.
 */
import { useEffect } from 'react';

export function useViewerBootstrap<T>(
  fetcher: () => Promise<T>,
  onData: (data: T) => void | Promise<void>,
  onError: (message: string) => void,
  fallbackErrorMessage = 'Your data is unavailable',
) {
  useEffect(() => {
    fetcher()
      .then((data) => onData(data))
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : fallbackErrorMessage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
