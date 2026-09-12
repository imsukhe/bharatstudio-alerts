-- L07 desktop Companion device-authorization pairing (RFC 8628 shape,
-- adapted, no library pulled in).
--
-- PROBLEM: the desktop Companion app cannot mint a bearer token for the
-- existing termsAuth-gated POST /v1/channels/:channelId/companion/
-- control-session. Today's only workaround is the creator manually pasting
-- an access token into the desktop app — not shippable. This migration adds
-- the storage for a device-code pairing flow: the desktop app requests a
-- pairing_code, the creator approves it (choosing a channel) from an
-- authenticated browser session, and the desktop app polls for the outcome.
--
-- This table never issues a session itself. On approval, the API layer
-- (apps/api/src/db/companion-pairing-store.ts) calls the EXISTING
-- app_private.acquire_companion_control_session (0053) with the creator's
-- own user_id and the channel they picked — the same lease mechanism
-- POST .../companion/control-session already uses. This migration only
-- tracks the pairing handshake's own short lifecycle.
--
-- CODE SHAPES
--   user_code    — 8 chars, human-typeable, alphabet A-HJ-NP-Z2-9 (24
--                  letters with I/O removed, digits 2-9 with 0/1 removed:
--                  32 symbols, so 32^8 ~= 1.1e12 possibilities). Shown to
--                  the creator so they can confirm what's asking to pair.
--   device_code  — an opaque high-entropy secret (32 random bytes,
--                  generated in apps/api/src/db/companion-pairing-store.ts)
--                  the desktop app polls with. Only its SHA-256 fingerprint
--                  is ever stored, following the existing convention in
--                  apps/api/src/db/overlay-store.ts:8-9 (fingerprint()) and
--                  0067/0053's token-hash columns — the plaintext device
--                  code is never written to the database.
--
-- LIFECYCLE / SINGLE USE: pending -> approved -> consumed (terminal, once
-- the device has redeemed it for a session), or pending -> denied, or any
-- state -> expired once expires_at passes. app_private.
-- poll_companion_device_pairing() takes the row `for update` and only ever
-- transitions 'approved' -> 'consumed' inside that lock, so a second
-- redemption of the same device_code always observes the already-consumed
-- row and returns expired_token — there is no window for double-issue.
--
-- SHORT-LIVED: expires_at is capped at 10 minutes from creation
-- (app_private.start_companion_device_pairing enforces the cap). Ten
-- minutes is the standard RFC 8628 device-flow ballpark: long enough for a
-- creator to read an 8-character code off one screen and type/click it on
-- another, short enough that a code sitting unused is a small window for
-- anyone to have guessed or intercepted it.
--
-- BRUTE-FORCE / RATE-LIMIT MITIGATION (user_code is the guessable surface —
-- device_code at 256 bits of entropy is not):
--   1. Keyspace: 32^8 (~1.1e12) possible codes, and at most one row per
--      user_code is ever "live" (companion_device_pairings_active_user_code_idx
--      is a partial unique index over state in ('pending','approved')), so
--      the live target set an attacker could land on is always tiny relative
--      to the keyspace.
--   2. Short expiry + single use (above) bounds how long any one code is a
--      valid guess target and guarantees a guess can only ever be "spent"
--      once even if it lands.
--   3. The three endpoints that take a caller-supplied user_code (GET
--      /v1/companion/pairing/:userCode and its approve/deny) are additionally
--      throttled per-route in apps/api/src/routes/companion-pairing.ts (on
--      top of the app-wide 120/min limiter in app.ts) — at that request
--      rate, exhausting even a vanishingly small fraction of the keyspace
--      inside a single 10-minute code lifetime is computationally
--      infeasible.
--   4. The polling endpoint (device_code, not user_code) enforces its own
--      interval floor: a client polling faster than the advertised
--      `interval` gets slow_down instead of an extra guess.

create table public.companion_device_pairings (
  id uuid primary key,
  user_code text not null check (user_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  device_code_fingerprint text not null,
  client_type text not null check (client_type = 'desktop'),
  client_instance_id text not null check (client_instance_id ~ '^[A-Za-z0-9._:-]{16,128}$'),
  client_label text not null check (char_length(client_label) between 1 and 80),
  channel_id uuid references public.channels(id),
  approved_by_user_id uuid references public.app_users(id),
  state text not null default 'pending'
    check (state in ('pending', 'approved', 'denied', 'expired', 'consumed')),
  poll_count integer not null default 0 check (poll_count >= 0),
  last_polled_at timestamptz,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

-- Only one live (pending/approved) row may hold a given user_code at a
-- time. A collision on insert surfaces as 23505 and the app layer retries
-- with a fresh code (see companion-pairing-store.ts).
create unique index companion_device_pairings_active_user_code_idx
  on public.companion_device_pairings (user_code)
  where state in ('pending', 'approved');

create unique index companion_device_pairings_device_code_idx
  on public.companion_device_pairings (device_code_fingerprint);

create index companion_device_pairings_expiry_idx
  on public.companion_device_pairings (expires_at)
  where state in ('pending', 'approved');

alter table public.companion_device_pairings enable row level security;

-- No policies are granted directly to bsa_app: every read and write goes
-- through the SECURITY DEFINER functions below, same as
-- companion_control_sessions' mutation surface (0053). Unlike that table,
-- this one has no direct select policy either — the pairing record only
-- ever needs to be read back shaped and access-checked by
-- get_companion_pairing_request(), never queried ad hoc by route code.
revoke all on public.companion_device_pairings from public;
revoke all on public.companion_device_pairings from bsa_app;

-- Unauthenticated entry point: the desktop app has no session yet, that's
-- the whole problem this migration solves. Takes app-generated identifiers
-- (id, user_code, device_code_fingerprint) so Postgres never has to
-- generate or expose plaintext secrets.
create or replace function app_private.start_companion_device_pairing(
  target_id uuid,
  target_user_code text,
  target_device_code_fingerprint text,
  target_client_type text,
  target_client_instance_id text,
  target_client_label text,
  target_expires_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_id is null
     or target_user_code !~ '^[A-HJ-NP-Z2-9]{8}$'
     or target_device_code_fingerprint !~ '^[0-9a-f]{64}$'
     or target_client_type <> 'desktop'
     or target_client_instance_id !~ '^[A-Za-z0-9._:-]{16,128}$'
     or char_length(coalesce(target_client_label, '')) not between 1 and 80
     or target_expires_at <= current_timestamp
     or target_expires_at > current_timestamp + interval '10 minutes' then
    raise exception 'invalid Companion device pairing request' using errcode = '22023';
  end if;

  insert into public.companion_device_pairings (
    id, user_code, device_code_fingerprint, client_type, client_instance_id,
    client_label, state, poll_count, created_at, expires_at
  ) values (
    target_id, target_user_code, target_device_code_fingerprint, target_client_type,
    target_client_instance_id, target_client_label, 'pending', 0, current_timestamp,
    target_expires_at
  );
end
$$;

-- Unauthenticated polling entry point (device_code only — the desktop app
-- still has no session). Locks the row for update so approve-then-consume
-- and any concurrent poll serialize; that lock is what makes the "second
-- redemption fails" guarantee atomic rather than a best-effort check.
create or replace function app_private.poll_companion_device_pairing(
  target_device_code_fingerprint text,
  target_min_poll_interval_seconds integer
)
returns table (
  status text,
  channel_id uuid,
  approved_by_user_id uuid,
  client_type text,
  client_instance_id text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  pairing_row public.companion_device_pairings%rowtype;
begin
  select * into pairing_row
    from public.companion_device_pairings pairing
   where pairing.device_code_fingerprint = target_device_code_fingerprint
   for update;

  if not found then
    status := 'expired_token';
    return next;
    return;
  end if;

  if pairing_row.consumed_at is not null or pairing_row.state = 'consumed' then
    status := 'expired_token';
    return next;
    return;
  end if;

  if pairing_row.expires_at <= current_timestamp then
    if pairing_row.state not in ('expired', 'consumed') then
      update public.companion_device_pairings
         set state = 'expired'
       where id = pairing_row.id;
    end if;
    status := 'expired_token';
    return next;
    return;
  end if;

  if pairing_row.state = 'denied' then
    status := 'access_denied';
    return next;
    return;
  end if;

  if pairing_row.state = 'pending' then
    if pairing_row.last_polled_at is not null
       and pairing_row.last_polled_at + make_interval(secs => target_min_poll_interval_seconds) > current_timestamp then
      status := 'slow_down';
      return next;
      return;
    end if;
    update public.companion_device_pairings
       set last_polled_at = current_timestamp,
           poll_count = poll_count + 1
     where id = pairing_row.id;
    status := 'authorization_pending';
    return next;
    return;
  end if;

  if pairing_row.state = 'approved' then
    update public.companion_device_pairings
       set state = 'consumed',
           consumed_at = current_timestamp
     where id = pairing_row.id
       and state = 'approved';
    status := 'approved';
    channel_id := pairing_row.channel_id;
    approved_by_user_id := pairing_row.approved_by_user_id;
    client_type := pairing_row.client_type;
    client_instance_id := pairing_row.client_instance_id;
    return next;
    return;
  end if;

  status := 'expired_token';
  return next;
end
$$;

-- Authenticated (creator session): shows what is asking to pair before the
-- creator approves it. No channel-ownership check here — no channel is
-- bound yet at this point, that's the creator's choice in the approve call
-- below — so this only requires an authenticated caller.
create or replace function app_private.get_companion_pairing_request(
  target_user_code text
)
returns table (
  user_code text,
  client_type text,
  client_label text,
  state text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if app_private.current_user_id() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  return query
    select pairing.user_code, pairing.client_type, pairing.client_label,
           pairing.state, pairing.created_at, pairing.expires_at
      from public.companion_device_pairings pairing
     where pairing.user_code = target_user_code
       and pairing.state in ('pending', 'approved')
       and pairing.expires_at > current_timestamp
     limit 1;
end
$$;

-- Authenticated (creator session): approves a pending pairing request onto
-- one of the creator's own channels. Reuses has_channel_role, the same
-- owner/admin/operator gate acquire_companion_control_session (0053) uses,
-- so a pairing can only ever be bound to a channel the approving user
-- actually controls.
create or replace function app_private.approve_companion_pairing(
  target_user_code text,
  target_channel_id uuid,
  target_user_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  pairing_row public.companion_device_pairings%rowtype;
begin
  if target_user_id <> app_private.current_user_id() or target_channel_id is null then
    raise exception 'invalid Companion pairing approval' using errcode = '22023';
  end if;
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator']::text[]) then
    raise exception 'Companion pairing access denied' using errcode = '42501';
  end if;

  select * into pairing_row
    from public.companion_device_pairings pairing
   where pairing.user_code = target_user_code
     and pairing.state = 'pending'
     and pairing.expires_at > current_timestamp
   for update;
  if not found then
    return false;
  end if;

  update public.companion_device_pairings
     set state = 'approved',
         channel_id = target_channel_id,
         approved_by_user_id = target_user_id
   where id = pairing_row.id;
  return true;
end
$$;

-- Authenticated (creator session): denies a pending pairing request.
create or replace function app_private.deny_companion_pairing(
  target_user_code text,
  target_user_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if target_user_id <> app_private.current_user_id() then
    raise exception 'invalid Companion pairing denial' using errcode = '22023';
  end if;
  update public.companion_device_pairings
     set state = 'denied'
   where user_code = target_user_code
     and state = 'pending'
     and expires_at > current_timestamp;
  return found;
end
$$;

revoke execute on function app_private.start_companion_device_pairing(uuid, text, text, text, text, text, timestamptz) from public;
revoke execute on function app_private.poll_companion_device_pairing(text, integer) from public;
revoke execute on function app_private.get_companion_pairing_request(text) from public;
revoke execute on function app_private.approve_companion_pairing(text, uuid, uuid) from public;
revoke execute on function app_private.deny_companion_pairing(text, uuid) from public;

grant execute on function app_private.start_companion_device_pairing(uuid, text, text, text, text, text, timestamptz) to bsa_app;
grant execute on function app_private.poll_companion_device_pairing(text, integer) to bsa_app;
grant execute on function app_private.get_companion_pairing_request(text) to bsa_app;
grant execute on function app_private.approve_companion_pairing(text, uuid, uuid) to bsa_app;
grant execute on function app_private.deny_companion_pairing(text, uuid) to bsa_app;
