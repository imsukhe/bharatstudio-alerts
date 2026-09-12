-- L14: viewer password reset. Batch 2 shipped viewer signup/login/sessions/
-- dashboard/deletion (0084/0085) but no reset — a login surface without
-- password reset turns every forgotten password into an unresolvable
-- support ticket. This migration adds the mechanism only; it does not touch
-- 0084/0085's tables or functions beyond the additive email_outbox changes
-- below, and does not renumber or edit any existing migration file.
--
-- Token design: single-use, short-lived (30 minutes — set by the caller in
-- target_expires_at, enforced here), stored ONLY as a SHA-256 fingerprint
-- (same convention as apps/api/src/db/overlay-store.ts:8-9 — the plaintext
-- token itself never touches a column or a log line, here or in the API
-- layer). Completing a reset revokes every existing viewer session for that
-- account, exactly like 0085's DPDP deletion already does for a closed
-- account.
--
-- Enumeration defence: app_private.request_viewer_password_reset is a
-- silent no-op when the email does not match any open viewer account — it
-- never raises, never returns a different shape, so the calling route
-- always sends back the same generic response regardless of whether the
-- address is registered.

create table viewer_password_reset_tokens (
  id uuid primary key,
  viewer_account_id uuid not null references viewer_accounts(id),
  token_hash text not null,
  created_at timestamptz not null default current_timestamp,
  expires_at timestamptz not null,
  used_at timestamptz,
  unique (token_hash)
);

create index viewer_password_reset_tokens_account_idx on viewer_password_reset_tokens (viewer_account_id, used_at, expires_at);

alter table viewer_password_reset_tokens enable row level security;
revoke all on viewer_password_reset_tokens from public;
revoke all on viewer_password_reset_tokens from bsa_app;
-- No policies defined — every access path is a security-definer
-- app_private function below, matching every other viewer table in
-- 0084/0085.

-- ---------------------------------------------------------------------
-- email_outbox: additive support for a viewer recipient alongside the
-- existing app_users recipient (0075). viewer_accounts is a deliberately
-- separate auth surface (see 0084's header comment) so it cannot satisfy
-- email_outbox's existing recipient_user_id -> app_users FK; a second,
-- nullable recipient column is added instead of overloading the first.
-- ---------------------------------------------------------------------
alter table public.email_outbox alter column recipient_user_id drop not null;
alter table public.email_outbox add column recipient_viewer_account_id uuid references viewer_accounts(id);

alter table public.email_outbox
  add constraint email_outbox_recipient_check
  check (
    (recipient_user_id is not null and recipient_viewer_account_id is null)
    or (recipient_user_id is null and recipient_viewer_account_id is not null)
  );

alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox
  add constraint email_outbox_kind_check
  check (kind in ('invoice_subscription_event', 'dpdp_export_delivery', 'overlay_expiry_reminder', 'viewer_password_reset'));

-- Redefined (create or replace — signature unchanged, so existing grants
-- to bsa_app carry over without a new grant statement): now left-joins
-- viewer_accounts too, so a viewer_password_reset row claims correctly
-- alongside the three existing app_users-recipient kinds. viewer_accounts
-- has no email_verified column (unlike app_users — see 0075's header) — a
-- viewer's email is the address they themselves typed at signup or reset
-- request, and gating a password-reset send on a verification flag that
-- doesn't exist for this surface would just mean it never sends. A row
-- with a viewer recipient therefore reports recipient_email_verified as
-- true unconditionally.
create or replace function app_private.claim_pending_emails(
  target_limit integer
)
returns table (
  id uuid,
  kind text,
  recipient_user_id uuid,
  recipient_email text,
  recipient_email_verified boolean,
  channel_id uuid,
  payload jsonb,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  return query
    update public.email_outbox outbox
       set status = 'sending', updated_at = current_timestamp
      from (
        select claimable.id, claimable.recipient_user_id, claimable.recipient_viewer_account_id
          from public.email_outbox claimable
         where claimable.status = 'pending'
         order by claimable.created_at asc
         limit greatest(least(coalesce(target_limit, 25), 100), 1)
           for update of claimable skip locked
      ) claimed
      left join public.app_users recipient on recipient.id = claimed.recipient_user_id
      left join public.viewer_accounts viewer_recipient on viewer_recipient.id = claimed.recipient_viewer_account_id
     where outbox.id = claimed.id
    returning outbox.id, outbox.kind, outbox.recipient_user_id,
              coalesce(recipient.email, viewer_recipient.email),
              coalesce(recipient.email_verified, viewer_recipient.id is not null),
              outbox.channel_id, outbox.payload, outbox.attempt_count;
end
$$;

-- Purpose-built enqueue for the one viewer-recipient email kind, mirroring
-- enqueue_invoice_subscription_email/enqueue_dpdp_export_email's own
-- pattern: each owns its recipient resolution and payload shape, and none
-- of the three (including this one) are granted directly to bsa_app —
-- only called from other security-definer functions, so a route can never
-- enqueue an arbitrary email kind/payload. Called only from
-- request_viewer_password_reset below.
create or replace function app_private.enqueue_viewer_password_reset_email(
  target_id uuid,
  target_viewer_account_id uuid,
  target_payload jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  insert into public.email_outbox (id, kind, recipient_user_id, recipient_viewer_account_id, channel_id, payload, status, created_at, updated_at)
  values (target_id, 'viewer_password_reset', null, target_viewer_account_id, null, target_payload, 'pending', current_timestamp, current_timestamp);
end
$$;

-- Request a reset. target_token_hash is the SHA-256 fingerprint computed
-- app-side (viewer.ts never passes the plaintext token here); target_id is
-- the token row's own id, also generated app-side (same convention as
-- create_viewer_session's target_session_id). This function ALWAYS
-- succeeds from the caller's point of view — a non-matching email is a
-- silent no-op, not an error — so the route can send one unconditional
-- response.
create or replace function app_private.request_viewer_password_reset(
  target_id uuid,
  target_email text,
  target_token_hash text,
  target_expires_at timestamptz,
  target_reset_url text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  account_id uuid;
begin
  select va.id into account_id
    from viewer_accounts va
   where lower(va.email) = lower(target_email) and va.closed_at is null;

  if account_id is null then
    return;
  end if;

  insert into viewer_password_reset_tokens (id, viewer_account_id, token_hash, expires_at)
  values (target_id, account_id, target_token_hash, target_expires_at);

  perform app_private.enqueue_viewer_password_reset_email(
    gen_random_uuid(), account_id,
    jsonb_build_object('resetUrl', target_reset_url, 'expiresAt', target_expires_at)
  );
end
$$;

-- Complete a reset: single-use (a used or expired token row is treated
-- identically to "not found" — no row returned, no distinguishing error),
-- then revokes every existing session for the account, matching 0085's
-- deletion flow.
create or replace function app_private.consume_viewer_password_reset_token(
  target_token_hash text,
  target_new_password_hash text
)
returns table (viewer_account_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  token_row viewer_password_reset_tokens%rowtype;
begin
  if target_new_password_hash is null or char_length(target_new_password_hash) < 20 then
    raise exception 'invalid viewer password hash' using errcode = '22023';
  end if;

  select * into token_row
    from viewer_password_reset_tokens
   where token_hash = target_token_hash
   for update;

  if not found or token_row.used_at is not null or token_row.expires_at <= current_timestamp then
    return;
  end if;

  update viewer_password_reset_tokens vprt
     set used_at = current_timestamp
   where vprt.id = token_row.id;

  update viewer_accounts va
     set password_hash = target_new_password_hash, updated_at = current_timestamp
   where va.id = token_row.viewer_account_id and va.closed_at is null;

  update viewer_sessions vs
     set revoked_at = current_timestamp
   where vs.viewer_account_id = token_row.viewer_account_id and vs.revoked_at is null;

  return query select token_row.viewer_account_id;
end
$$;

revoke execute on function app_private.request_viewer_password_reset(uuid, text, text, timestamptz, text) from public;
revoke execute on function app_private.consume_viewer_password_reset_token(text, text) from public;
grant execute on function app_private.request_viewer_password_reset(uuid, text, text, timestamptz, text) to bsa_app;
grant execute on function app_private.consume_viewer_password_reset_token(text, text) to bsa_app;
-- enqueue_viewer_password_reset_email is deliberately NOT granted to
-- bsa_app — internal-only, called from request_viewer_password_reset.
