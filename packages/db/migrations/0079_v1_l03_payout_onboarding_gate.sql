-- L03: payout onboarding gate — owner-directed change, 2026-08-16.
--
-- The onboarding wizard's "connect payout" step was deliberately built
-- non-gating: a channel existing was the only fact that unlocked the
-- dashboard, and nothing distinguished "hasn't reached the payout step
-- yet" from "explicitly skipped it" because both looked identical (no
-- payment_accounts row). The owner reported reaching the dashboard from a
-- second tab while still sitting on the payout step, without having
-- clicked "Connect" or "Skip for now" — confirmed as the intended design
-- at the time, then explicitly asked for it to become a real gate.
--
-- A real gate needs the missing third state ("explicitly skipped") to be
-- persisted, or a returning creator who skipped would be sent back to this
-- screen forever, indistinguishable from one who never got there. This
-- column is that state. It does not gate anything by itself — the
-- frontend's onboarding-routing logic treats "payout onboarding done" as
-- (this column is set) OR (a payment_accounts row exists for the
-- channel), so connecting an account for real also satisfies the gate
-- without a separate flag to keep in sync.
alter table public.channels
  add column if not exists payout_onboarding_skipped_at timestamptz;

create or replace function app_private.skip_payout_onboarding(
  target_channel_id uuid,
  target_user_id uuid
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  result timestamptz;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'invalid payout-onboarding skip' using errcode = '42501';
  end if;

  perform 1 from public.channels channel
   where channel.id = target_channel_id and channel.closed_at is null;
  if not found then
    raise exception 'channel not found' using errcode = '42501';
  end if;

  update public.channels
     set payout_onboarding_skipped_at = coalesce(payout_onboarding_skipped_at, current_timestamp)
   where id = target_channel_id
  returning payout_onboarding_skipped_at into result;

  return result;
end
$$;

revoke execute on function app_private.skip_payout_onboarding(uuid, uuid) from public;
grant execute on function app_private.skip_payout_onboarding(uuid, uuid) to bsa_app;
