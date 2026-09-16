-- RT-03 correction, 2026-09-16. 0128 closed the live billing defect (a failed
-- synthesis permanently consumed premium characters) but left two properties
-- unenforced, and said so in its own comments rather than fixing them:
--
--   1. release_tts_usage_reservation(uuid, integer) was NOT idempotent. The
--      greatest(...,0) floor only prevents a negative counter. A second
--      release against a month that holds OTHER usage subtracts a second
--      time and hands the creator quota nobody reserved. The only thing
--      preventing it was a caller-side invariant written in a comment --
--      "any future caller must hold the same invariant". That is a
--      correctness property with no enforcement, which is the same shape as
--      every §2 finding in this register.
--
--   2. Release targeted date_trunc('month', current_timestamp), NOT the
--      month the reservation was actually charged to. Reserve and release
--      sit either side of one provider call, so a UTC month boundary
--      crossing between them is rare but real. 0128 called this "a safe
--      no-op", which is only true when the NEW month has no usage row yet.
--      When it does -- another synthesis already metered in the new month --
--      the release lands on the wrong month: the old month keeps the charge
--      AND the new month is credited characters it never reserved. That is
--      the same manufacture-quota outcome as (1), and it contradicts the
--      TtsQuotaMeter interface's own written contract ("must never
--      manufacture quota that was not reserved").
--
-- The existing acceptance test packages/db/tests/rt03_tts_quota_reservation_
-- release.sql asserted idempotency and passed -- but only in the one
-- arrangement where the counter had already reached 0 and the floor hid the
-- missing property. A green check blind to the case it was never told about.
--
-- The fix is structural, not another comment: reservations become durable
-- rows. meter_tts_usage records what it charged and to which billing month;
-- release consumes a reservation by id, exactly once, against the month
-- stored on the reservation. Idempotency and month-correctness become
-- properties of the schema rather than of the caller's discipline.
--
-- Deliberate narrowing: release is now all-or-nothing per reservation.
-- 0128 accepted an arbitrary character count, which made "release less than
-- was reserved" expressible; no caller ever used it (apps/api/src/routes/
-- tts.ts always released the full metered amount on three mutually
-- exclusive paths) and it is not a §10.2 ledger entry type. Removing it
-- removes a whole class of arithmetic error rather than testing around it.
--
-- No new personal-data class: the reservation row carries channel_id, a
-- character count, a billing month and timestamps. No viewer, no payment,
-- no message text, no identifier that reaches a log or a metric label.
--
-- Depends on 0001-0133. Modifies no existing migration file.

create table if not exists public.alert_tts_usage_reservations (
  id uuid primary key,
  event_id uuid not null references public.alert_events(id),
  channel_id uuid not null,
  billing_month date not null,
  characters integer not null check (characters > 0),
  reserved_at timestamptz not null default current_timestamp,
  released_at timestamptz,
  -- The composite reference is the whole point of the table: a reservation
  -- can only ever name a monthly usage row that exists, so release can
  -- never miss the month it must credit back. meter_tts_usage inserts the
  -- monthly row before it charges, so this is always satisfiable.
  foreign key (channel_id, billing_month)
    references public.alert_tts_usage_monthly (channel_id, billing_month)
);

create index if not exists alert_tts_usage_reservations_event_idx
  on public.alert_tts_usage_reservations (event_id);

-- Same posture as alert_tts_usage_monthly (0081): reachable only through the
-- security-definer functions below, never directly by the application role.
alter table public.alert_tts_usage_reservations enable row level security;
revoke all on public.alert_tts_usage_reservations from public;
revoke all on public.alert_tts_usage_reservations from bsa_app;

-- Return shape changes (a fourth column), so this is a drop-and-recreate
-- rather than a create-or-replace -- same approach 0127 took with
-- app_private.get_overlay_events. The metering arithmetic and the hard-stop
-- behaviour are unchanged from 0081; the only addition is recording what was
-- charged.
drop function if exists app_private.meter_tts_usage(uuid, integer);

create function app_private.meter_tts_usage(
  target_event_id uuid,
  target_char_count integer
)
returns table (allowed boolean, remaining integer, reason text, reservation_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  target_channel_id uuid;
  current_tier text;
  quota integer;
  current_month date := date_trunc('month', current_timestamp)::date;
  used integer;
  new_reservation_id uuid;
begin
  -- No upper bound here beyond non-negative: the per-synthesis-call bound
  -- (message length, capped at 500 by app_private.get_alert_tts_input in
  -- 0067) is enforced upstream of this function, and this function's own
  -- job is only the arithmetic hard stop against the monthly quota.
  if target_char_count is null or target_char_count < 0 then
    raise exception 'invalid TTS character count' using errcode = '22023';
  end if;

  select event.channel_id into target_channel_id
    from public.alert_events event
   where event.id = target_event_id;
  if not found then
    raise exception 'alert event not found for TTS metering' using errcode = '23503';
  end if;

  perform 1 from public.channels where id = target_channel_id for update;

  select entitlement.tier into current_tier
    from public.channel_entitlement_versions entitlement
   where entitlement.channel_id = target_channel_id
   order by entitlement.version desc
   limit 1;
  current_tier := coalesce(current_tier, 'free');

  quota := app_private.tier_tts_monthly_quota(current_tier);

  if quota = 0 then
    return query select false, 0, 'tier_not_entitled', null::uuid;
    return;
  end if;

  insert into public.alert_tts_usage_monthly (channel_id, billing_month, characters_used, updated_at)
  values (target_channel_id, current_month, 0, current_timestamp)
  on conflict (channel_id, billing_month) do nothing;

  select usage_row.characters_used into used
    from public.alert_tts_usage_monthly usage_row
   where usage_row.channel_id = target_channel_id
     and usage_row.billing_month = current_month
     for update;

  if used + target_char_count > quota then
    return query select false, greatest(quota - used, 0), 'quota_exhausted', null::uuid;
    return;
  end if;

  update public.alert_tts_usage_monthly
     set characters_used = used + target_char_count,
         updated_at = current_timestamp
   where channel_id = target_channel_id
     and billing_month = current_month;

  -- A zero-character meter charges nothing, so there is nothing to release
  -- and no reservation row is written. The caller gets a null reservation id
  -- and must not call release -- rather than a zero-character reservation
  -- that would violate the table's own characters > 0 check.
  if target_char_count > 0 then
    new_reservation_id := gen_random_uuid();
    insert into public.alert_tts_usage_reservations
      (id, event_id, channel_id, billing_month, characters, reserved_at)
    values
      (new_reservation_id, target_event_id, target_channel_id, current_month, target_char_count, current_timestamp);
  end if;

  return query select true, quota - (used + target_char_count), null::text, new_reservation_id;
end
$$;

-- The (uuid, integer) signature is dropped, not left alongside the new one.
-- Leaving the non-idempotent function callable would keep exactly the defect
-- this migration exists to close: a future caller could still reach it and
-- manufacture quota. Removing the unsafe path is the enforcement.
drop function if exists app_private.release_tts_usage_reservation(uuid, integer);

create function app_private.release_tts_usage_reservation(
  target_reservation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  reservation_channel_id uuid;
  reservation record;
begin
  -- A null reservation id means the meter never charged (zero characters, or
  -- an unmetered deployment). Nothing to give back.
  if target_reservation_id is null then
    return;
  end if;

  select res.channel_id into reservation_channel_id
    from public.alert_tts_usage_reservations res
   where res.id = target_reservation_id;
  if not found then
    raise exception 'TTS reservation not found' using errcode = '23503';
  end if;

  -- Lock the channel row FIRST, then the reservation row -- the same order
  -- meter_tts_usage takes (channel, then the usage/reservation rows), so a
  -- concurrent reserve and release on one channel can never form a cycle.
  perform 1 from public.channels where id = reservation_channel_id for update;

  select res.* into reservation
    from public.alert_tts_usage_reservations res
   where res.id = target_reservation_id
     for update;

  -- Idempotency, enforced by durable state rather than by the caller: a
  -- reservation already released gives back nothing a second time. A
  -- concurrent duplicate release blocks on the row lock above and lands
  -- here, so it is safe under concurrency and not merely in sequence.
  if reservation.released_at is not null then
    return;
  end if;

  update public.alert_tts_usage_reservations
     set released_at = current_timestamp
   where id = target_reservation_id;

  -- Credited back to the month the reservation was CHARGED to, never to
  -- whatever month it happens to be now. The composite foreign key above
  -- guarantees this row exists.
  --
  -- greatest(...,0) remains only as a non-negativity backstop. With
  -- per-reservation state it should now be unreachable: every release gives
  -- back exactly one charge that the same month recorded. It is kept
  -- because a counter that can go negative is a worse failure than one that
  -- floors, not because it is doing the correctness work.
  update public.alert_tts_usage_monthly
     set characters_used = greatest(characters_used - reservation.characters, 0),
         updated_at = current_timestamp
   where channel_id = reservation.channel_id
     and billing_month = reservation.billing_month;
end
$$;

revoke execute on function app_private.meter_tts_usage(uuid, integer) from public;
grant execute on function app_private.meter_tts_usage(uuid, integer) to bsa_app;
revoke execute on function app_private.release_tts_usage_reservation(uuid) from public;
grant execute on function app_private.release_tts_usage_reservation(uuid) to bsa_app;
