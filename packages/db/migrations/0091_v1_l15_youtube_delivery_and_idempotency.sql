-- Closes three gaps the YouTube poller could not close from its own repo.
--
-- 1. IDEMPOTENCY AT THE DATABASE, NOT ONLY IN THE WRITER.
--    This project states the rule plainly: "Duplicate financial event =
--    unacceptable." alert_events has source_id (0003_v1_l03_application.sql:35)
--    but no uniqueness over (channel_id, source_type, source_id) — the only
--    unique in that area is queue_bindings(queue_id, source_type, source_id),
--    a different table. The poller therefore had to fall back to an advisory
--    lock plus a pre-check, which is the strongest guarantee available to a
--    writer but is not a guarantee at all against a second writer that does
--    not take the same lock, or against a bug computing the lock key.
--
--    A partial unique index is used, covering ONLY the external connector
--    source types. It deliberately does NOT cover 'payment'.
--
--    That distinction was not obvious and an earlier draft of this migration
--    got it wrong. For a connector, source_id is the upstream event id (a
--    YouTube chat message id) and is one-per-event. For 'payment' it is a
--    BINDING source identifier — the same value queue_bindings.source_id
--    carries — so two different alert_events legitimately share it. The
--    existing suite proves this on purpose:
--    packages/db/tests/l03_application_behavior.sql:1708-1709 inserts two
--    distinct events both with source_id 'rate-limited-source' to exercise
--    per-source rate limiting, and a unique index over 'payment' breaks it.
--    Payment de-duplication is enforced upstream at the webhook boundary on
--    the provider's own event id, not here.
--
--    Built CONCURRENTLY-style is NOT used here: this repo's migrations run in
--    a transaction, and CREATE INDEX CONCURRENTLY cannot. The table is small
--    at this stage of the product; if that stops being true, this index
--    should be rebuilt concurrently out-of-band before the table grows.
--
-- 2. DELIVERY ROUTING FOR EXTERNAL SOURCES.
--    0086 widened alert_events.source_type to include youtube/twitch/kick but
--    left queue_bindings.source_type (0001_v1_baseline.sql:107) at the
--    original three values. So a YouTube alert_event could be written and then
--    had nowhere to route: no binding could ever reference it. Widened here to
--    match, using the same NOT VALID + VALIDATE approach 0086 used and for the
--    same reason.
--
-- 3. A ROLE THAT CAN ACTUALLY RUN THE POLLER.
--    0086 revoked all privileges on youtube_channel_connections from public,
--    bsa_app and bsa_payment and granted them to nobody, so no role can read
--    the stored token ciphertext or refresh it. The poller is a separate
--    service and gets its own least-privilege role rather than borrowing
--    bsa_app: it needs exactly three things and must not have the rest of
--    bsa_app's surface.

-- ---------------------------------------------------------------------------
-- 1. Idempotency
-- ---------------------------------------------------------------------------
create unique index if not exists alert_events_external_source_unique
  on public.alert_events (channel_id, source_type, source_id)
  where source_type in ('youtube', 'twitch', 'kick');

-- ---------------------------------------------------------------------------
-- 2. Delivery routing
-- ---------------------------------------------------------------------------
alter table public.queue_bindings
  drop constraint queue_bindings_source_type_check;

alter table public.queue_bindings
  add constraint queue_bindings_source_type_check
  check (source_type in ('payment', 'manual', 'companion', 'youtube', 'twitch', 'kick'))
  not valid;

alter table public.queue_bindings
  validate constraint queue_bindings_source_type_check;

-- ---------------------------------------------------------------------------
-- 3. Least-privilege poller role
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bsa_connector_poller') then
    create role bsa_connector_poller nologin nobypassrls nosuperuser;
  end if;
end
$$;

grant usage on schema public to bsa_connector_poller;

-- Read connection rows (including token ciphertext) and write back refreshed
-- tokens. No DELETE: a connector must never be able to erase the record that
-- it was connected.
grant select, update on public.youtube_channel_connections to bsa_connector_poller;

-- Insert normalised events. No UPDATE and no DELETE: an external connector
-- appends evidence, it never rewrites or removes it.
grant insert, select on public.alert_events to bsa_connector_poller;

revoke all on public.channel_handle_history from bsa_connector_poller;
