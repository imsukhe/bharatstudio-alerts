// Admin read/disposition surface for youtube_event_ingest_failures
// (packages/db/migrations/0094_v1_l15_youtube_delivery_and_failure_recording.sql).
//
// That table is insert-only via app_private.record_youtube_ingest_failure,
// called by the poller only after it classifies a failure as PERMANENT
// (SQLSTATE class 22/23 -- i.e. the row failed a validation or database
// constraint, not a transient error). The table has row level security
// enabled with `revoke all on ... from public` and carries NO select
// policy and NO SECURITY DEFINER read function -- so today literally
// nothing, not even bsa_app, can read a row except direct
// database/superuser access. That is the exact gap this file's route
// layer exists to close.
//
// THIS PASS MAY NOT WRITE A MIGRATION. Reading (or updating) this table at
// all requires new SQL objects that do not exist yet -- see this change's
// "Schema needed" report for the precise objects. IngestFailureAdminStore
// below is the application-layer contract those objects must satisfy; the
// route layer (routes/admin.ts) is wired against it exactly like the
// existing /v1/admin/dlq surface is wired against AdminStore, so a real
// implementation (apps/api/src/db/ingest-failure-store.ts, also new in
// this pass) drops in once the migration lands. Until then, an unconfigured
// `ingestFailureStore` makes every route below fail closed with 503
// `admin_unavailable`, the same way the DLQ routes already do without
// `store` -- never a silent bypass.
//
// Content boundary, matching list_admin_dlq's own rule (0073's header
// comment, "does not project donor/message content -- an admin needs to
// know WHAT is stuck and WHERE, not read content"): this surface never
// projects the raw `payload` column. A YouTube ingest payload can carry
// viewer-identifying fields (chat/superchat display names) and this admin
// tool has no verified, exhaustive redaction allowlist for that shape --
// omitting it entirely is the only leak-proof choice available without
// auditing the connector's full payload schema, which is out of this
// pass's scope. `errorDetail` + `sqlstateCode` already say what broke and
// why; that is enough to triage. OAuth token material is never stored in
// this table at all (it records the ingest failure, not connector
// credentials), so there is nothing to redact there.
export type IngestFailureEntry = {
  id: string;
  channelId: string;
  channelHandle: string;
  sourceId: string;
  sourceEventType: string | null;
  sqlstateCode: string | null;
  errorDetail: string;
  createdAt: string;
};

export type IngestFailurePage = {
  entries: IngestFailureEntry[];
  // Opaque cursor (created_at + id) for the next page, or null when this
  // page was the last one. Never a raw offset -- an admin queue this is
  // actively triaging must not skip/duplicate rows as new failures land.
  nextCursor: string | null;
};

export type IngestFailureActionResult = {
  id: string;
  acknowledgedAt: string;
};

export interface IngestFailureAdminStore {
  listIngestFailures(userId: string, limit: number, cursor: string | null): Promise<IngestFailurePage>;
  // Returns null when the id does not exist (or is not visible to this
  // reader) -- the route maps that to 404, never a 5xx.
  getIngestFailure(userId: string, id: string): Promise<IngestFailureEntry | null>;
  // The ONLY disposition action this store exposes.
  //
  // Replay is deliberately NOT offered: a row here is a PERMANENT failure
  // by definition (SQLSTATE class 22/23 -- validation or constraint
  // violation). Re-submitting the identical payload through
  // app_private.record_youtube_alert_event cannot succeed where the same
  // check already failed; blindly replaying would either repeat the exact
  // same rejection or, worse, mask a real data problem as "handled" without
  // anyone having fixed anything. A genuine recovery needs a human or the
  // poller to correct the input first and reprocess it as a NEW event --
  // that path already exists (the poller's own ingestion), it does not
  // need an admin "replay" button that could re-fire a bad payload as-is.
  //
  // Discard is equally inapplicable: unlike a DLQ delivery,
  // record_youtube_ingest_failure never creates an alert_events or
  // event_outbox row, so there is no delivery to mark discarded --
  // nothing downstream is stuck waiting on this row.
  //
  // Acknowledge-only: an operator confirms they reviewed this failure
  // (fixed the upstream mapping/poller bug, filed a follow-up, or judged
  // it non-actionable noise) and clears it from the open queue. This is
  // the correct terminal action for a permanent, already-rejected event.
  // Returns null when the id does not exist or is already acknowledged --
  // the route maps that to 404, never a 5xx.
  acknowledgeIngestFailure(userId: string, id: string, note: string): Promise<IngestFailureActionResult | null>;
}
