// Single source of truth for the retention-sweep maintenance jobs added in
// migration 0095. Each job deletes only rows that are already dead (expired,
// consumed, or revoked) for a table that otherwise grows unbounded — see the
// migration's header comment for the full rationale and what these sweeps are
// forbidden from touching (append-only evidence tables).
export const retentionJobs = [
  'retention-companion-pairings',
  'retention-youtube-oauth-states',
  'retention-viewer-reset-tokens',
] as const;

export type RetentionJob = typeof retentionJobs[number];

export type RetentionWindow = {
  windowDays: number;
  reason: string;
};

// Kept here (not just in the SQL comments) so the window/justification is
// visible from application code and testable without a database.
export const retentionWindows: Record<RetentionJob, RetentionWindow> = {
  'retention-companion-pairings': {
    windowDays: 7,
    reason:
      'A consumed/denied/expired pairing code can never be replayed, but support is asked "did my device pair?" against a code the user already used or gave up on — a short grace window has real value and no bearer-equivalent risk.',
  },
  'retention-youtube-oauth-states': {
    windowDays: 0,
    reason:
      'Pure CSRF/PKCE handshake material (state + code_verifier) for one in-flight OAuth redirect. Once consumed or expired it has no support or audit value, only exposure surface.',
  },
  'retention-viewer-reset-tokens': {
    windowDays: 0,
    reason:
      'Bearer-equivalent to a password reset. A used or expired token has no legitimate reason to persist at all.',
  },
};
