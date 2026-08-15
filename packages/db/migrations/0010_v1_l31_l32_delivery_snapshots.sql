-- BharatStudio Alerts v1 L31/L32 per-queue routing snapshots.
-- Accepted deliveries retain the source priority and per-source overrides
-- selected at ingestion; later binding edits cannot change their rendering.

alter table public.event_outbox_deliveries
  add column if not exists source_priority integer not null default 0
    check (source_priority between 0 and 100000);

alter table public.event_outbox_deliveries
  add column if not exists override_values jsonb;
