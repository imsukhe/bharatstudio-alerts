-- L15 TipIntent wiring (0101): the youtube_tip_intent_dedup ledger that
-- gives "the same chat message id reprocessed creates no more than one
-- TipIntent" a real database guarantee, not just a poller-side check.
-- Exercised directly at the SQL layer, entirely through the same
-- SECURITY DEFINER surface bsa_connector_poller is actually granted (no
-- raw table reads used for verification -- see the final block, which
-- proves that surface is all bsa_connector_poller has): a
-- reserve-again-and-expect-refused probe is black-box proof of the
-- table's real internal state, exactly as reserve_youtube_tip_intent's
-- own caller (the poller) would observe it. The Go side is covered by
-- services/youtube-poller-go/internal/tipintent and .../internal/store.
-- Synthetic identifiers only; own fixture ids
-- 00000000-...-00000000b001 upward.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000b001', 'google-l15tw-owner', 'Synthetic L15 TipWiring Owner', current_timestamp, current_timestamp)
on conflict (id) do nothing;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000b001', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-00000000b011',
  '00000000-0000-4000-8000-00000000b001', 'l15tw_channel', 'L15 TipWiring Test Channel'
);
commit;

-- SET ROLE (not LOCAL) is required here: every top-level statement in this
-- file is its own implicit transaction under psql autocommit, and a LOCAL
-- setting is discarded the instant its own statement's transaction
-- commits (see l07_companion_feature_reads.sql's own note on set_config
-- for the same autocommit property). Plain SET ROLE persists for the rest
-- of this session until reset role, below.
set role bsa_connector_poller;

-- A valid !tip reserves exactly once: first call wins, second call for the
-- SAME chat message id is a no-op (reserved = false, no new row created --
-- proven by the uniqueness constraint itself: if a second row had been
-- inserted, the conflict target would not have fired and reserved would
-- have come back true).
do $$
declare
  first_reserved boolean;
  second_reserved boolean;
begin
  select reserved into first_reserved from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b021'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-001'
  );
  if not first_reserved then raise exception 'first reservation for a new chat message id was unexpectedly refused'; end if;

  -- Same message id, different attempted dedup row id (simulating a
  -- retried/overlapping poll cycle that generated a new candidate id) --
  -- must still be refused, because the uniqueness is on
  -- (channel_id, source_platform, source_chat_message_id), not on the
  -- caller-supplied id.
  select reserved into second_reserved from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b022'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-001'
  );
  if second_reserved then raise exception 'a duplicate chat message id was reserved a second time'; end if;
end
$$;

-- A different chat message id on the same channel is independent (not
-- blocked by the first reservation).
do $$
declare
  reserved boolean;
begin
  select r.reserved into reserved from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b023'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-002'
  ) r;
  if not reserved then raise exception 'a distinct chat message id was incorrectly refused'; end if;
end
$$;

-- Successful creation is terminal: mark_youtube_tip_intent_created, then
-- reserving the SAME message id again is still refused -- proving the row
-- moved to a terminal, non-'pending' status rather than staying open.
do $$
declare
  reserved_again boolean;
begin
  perform app_private.mark_youtube_tip_intent_created('00000000-0000-4000-8000-00000000b021'::uuid);

  select r.reserved into reserved_again from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b024'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-001'
  ) r;
  if reserved_again then raise exception 'a chat message id already marked created was reserved again'; end if;
end
$$;

-- Permanent failure (e.g. secret misconfigured, request rejected):
-- terminal, same as above -- never retried for this exact message id --
-- but does NOT block a different message id on the same channel (the
-- failure taxonomy from 0094: permanent means "this one is done", not
-- "this channel is done").
do $$
declare
  reserved boolean;
  reserved_after_fail boolean;
begin
  select r.reserved into reserved from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b025'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-003'
  ) r;
  if not reserved then raise exception 'reservation for chatmsg-tw-003 unexpectedly failed'; end if;

  perform app_private.mark_youtube_tip_intent_failed('00000000-0000-4000-8000-00000000b025'::uuid, 'internal endpoint returned 401');

  select r.reserved into reserved_after_fail from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b026'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-003'
  ) r;
  if reserved_after_fail then raise exception 'a permanently-failed chat message id was reserved again'; end if;

  -- A different message id on the same channel is unaffected.
  select r.reserved into reserved_after_fail from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b027'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-004'
  ) r;
  if not reserved_after_fail then raise exception 'a permanent failure on one message id incorrectly blocked a different message id'; end if;
end
$$;

-- Transient failure: the reservation is released, so the SAME message id
-- can be re-attempted next cycle -- this is what keeps the poller's page
-- cursor from wedging: the caller retries the message, not the whole page
-- forever, and the retry is allowed to actually succeed.
do $$
declare
  reserved boolean;
  reserved_again boolean;
begin
  select r.reserved into reserved from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b028'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-005'
  ) r;
  if not reserved then raise exception 'reservation for chatmsg-tw-005 unexpectedly failed'; end if;

  perform app_private.release_youtube_tip_intent_reservation('00000000-0000-4000-8000-00000000b028'::uuid);

  select r.reserved into reserved_again from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b029'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-005'
  ) r;
  if not reserved_again then raise exception 'a released (transiently-failed) chat message id could not be re-reserved'; end if;
end
$$;

-- release_youtube_tip_intent_reservation must never undo a terminal
-- outcome -- only a still-'pending' row is deleted. Proven the same
-- black-box way: releasing an already-'created' or already-'failed' row
-- must be a no-op, so a subsequent reservation attempt for that same
-- message id must STILL be refused.
do $$
declare
  reserved_after_release boolean;
begin
  perform app_private.release_youtube_tip_intent_reservation('00000000-0000-4000-8000-00000000b021'::uuid); -- status='created'
  select r.reserved into reserved_after_release from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b02a'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-001'
  ) r;
  if reserved_after_release then raise exception 'releasing an already-created (terminal) reservation incorrectly reopened it'; end if;

  perform app_private.release_youtube_tip_intent_reservation('00000000-0000-4000-8000-00000000b025'::uuid); -- status='failed'
  select r.reserved into reserved_after_release from app_private.reserve_youtube_tip_intent(
    '00000000-0000-4000-8000-00000000b02b'::uuid, '00000000-0000-4000-8000-00000000b011'::uuid, 'chatmsg-tw-003'
  ) r;
  if reserved_after_release then raise exception 'releasing an already-failed (terminal) reservation incorrectly reopened it'; end if;
end
$$;

-- No raw table access: bsa_connector_poller can reach youtube_tip_intent_dedup
-- only through the SECURITY DEFINER functions above, exactly like
-- tip_intents (0097) and youtube_event_ingest_failures (0094).
do $$
begin
  begin
    perform 1 from youtube_tip_intent_dedup limit 1;
    raise exception 'bsa_connector_poller unexpectedly has raw select on youtube_tip_intent_dedup';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

reset role;
select 'L15_TIPWIRING_IDEMPOTENCY=PASS' as result;
