-- L04: creator-direct Razorpay account onboarding boundary.
-- Creator API requests may register a provider account as pending. Only the
-- private payment service may activate it after provider verification. Existing
-- payment intents retain their immutable account snapshot when an account is
-- switched or revoked.

create table if not exists public.payment_account_audit (
  id uuid primary key,
  payment_account_id uuid references public.payment_accounts(id),
  channel_id uuid not null references public.channels(id),
  actor_user_id uuid references public.app_users(id),
  actor_service text,
  action text not null check (action in ('registered', 'switched', 'activated', 'revoked')),
  previous_account_ref text,
  next_account_ref text,
  previous_status text,
  next_status text not null,
  evidence_ref text,
  created_at timestamptz not null default current_timestamp,
  check (actor_user_id is not null or actor_service is not null)
);

create index if not exists payment_account_audit_channel_idx
  on public.payment_account_audit (channel_id, created_at desc);

alter table public.payment_account_audit enable row level security;
revoke all on public.payment_account_audit from public;
revoke all on public.payment_account_audit from bsa_app;
revoke all on public.payment_account_audit from bsa_payment;

create or replace function app_private.get_creator_payment_accounts(
  target_channel_id uuid
)
returns table (
  account_id uuid,
  channel_id uuid,
  provider text,
  environment text,
  connected_account_ref text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select account.id, account.channel_id, account.provider, account.environment,
         account.connected_account_ref, account.status, account.created_at,
         account.updated_at, account.revoked_at
    from public.payment_accounts account
   where account.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
   order by account.environment asc
$$;

create or replace function app_private.register_creator_payment_account(
  target_account_id uuid,
  target_channel_id uuid,
  target_user_id uuid,
  target_environment text,
  target_connected_account_ref text
)
returns table (
  account_id uuid,
  channel_id uuid,
  provider text,
  environment text,
  connected_account_ref text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.payment_accounts%rowtype;
  next_status text;
  audit_action text;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
     or target_environment not in ('test', 'live')
     or target_connected_account_ref is null
     or target_connected_account_ref !~ '^[A-Za-z0-9._:-]{1,128}$'
     or target_account_id is null then
    raise exception 'invalid creator payment-account registration' using errcode = '42501';
  end if;

  perform 1 from public.channels channel
   where channel.id = target_channel_id and channel.closed_at is null;
  if not found then
    raise exception 'channel not found' using errcode = '42501';
  end if;

  select account.* into existing
    from public.payment_accounts account
   where account.channel_id = target_channel_id
     and account.provider = 'razorpay'
     and account.environment = target_environment
   for update;

  if found then
    next_status := case when existing.connected_account_ref = target_connected_account_ref
                        and existing.status = 'active' then 'active' else 'pending' end;
    audit_action := case when existing.connected_account_ref = target_connected_account_ref
                         then 'registered' else 'switched' end;
    update public.payment_accounts account
       set connected_account_ref = target_connected_account_ref,
           status = next_status,
           revoked_at = null,
           updated_at = current_timestamp
     where account.id = existing.id
    ;
    insert into public.payment_account_audit (
      id, payment_account_id, channel_id, actor_user_id, action,
      previous_account_ref, next_account_ref, previous_status, next_status
    ) values (
      gen_random_uuid(), existing.id, target_channel_id, target_user_id, audit_action,
      existing.connected_account_ref, target_connected_account_ref, existing.status, next_status
    );
    return query
      select account.id, account.channel_id, account.provider, account.environment,
             account.connected_account_ref, account.status, account.created_at,
             account.updated_at, account.revoked_at
        from public.payment_accounts account
       where account.id = existing.id;
    return;
  end if;

  insert into public.payment_accounts (
    id, channel_id, provider, environment, connected_account_ref, status,
    created_at, updated_at, revoked_at
  ) values (
    target_account_id, target_channel_id, 'razorpay', target_environment,
    target_connected_account_ref, 'pending', current_timestamp, current_timestamp, null
  );

  insert into public.payment_account_audit (
    id, payment_account_id, channel_id, actor_user_id, action,
    previous_account_ref, next_account_ref, previous_status, next_status
  ) values (
    gen_random_uuid(), target_account_id, target_channel_id, target_user_id, 'registered',
    null, target_connected_account_ref, null, 'pending'
  );
  return query
    select account.id, account.channel_id, account.provider, account.environment,
           account.connected_account_ref, account.status, account.created_at,
           account.updated_at, account.revoked_at
      from public.payment_accounts account
     where account.id = target_account_id;
end
$$;

create or replace function app_private.revoke_creator_payment_account(
  target_channel_id uuid,
  target_user_id uuid,
  target_environment text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.payment_accounts%rowtype;
begin
  if target_user_id is null
     or target_user_id <> app_private.current_user_id()
     or not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[])
     or target_environment not in ('test', 'live') then
    raise exception 'invalid creator payment-account revocation' using errcode = '42501';
  end if;
  select account.* into existing
    from public.payment_accounts account
   where account.channel_id = target_channel_id
     and account.provider = 'razorpay'
     and account.environment = target_environment
     and account.status <> 'revoked'
   for update;
  if not found then return false; end if;
  update public.payment_accounts account
     set status = 'revoked', revoked_at = current_timestamp, updated_at = current_timestamp
   where account.id = existing.id;
  insert into public.payment_account_audit (
    id, payment_account_id, channel_id, actor_user_id, action,
    previous_account_ref, next_account_ref, previous_status, next_status
  ) values (
    gen_random_uuid(), existing.id, target_channel_id, target_user_id, 'revoked',
    existing.connected_account_ref, existing.connected_account_ref, existing.status, 'revoked'
  );
  return true;
end
$$;

create or replace function app_private.activate_creator_payment_account(
  target_channel_id uuid,
  target_environment text,
  target_connected_account_ref text,
  target_service text,
  target_evidence_ref text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing public.payment_accounts%rowtype;
begin
  if target_service is null or char_length(target_service) = 0
     or target_environment not in ('test', 'live')
     or target_connected_account_ref is null
     or target_connected_account_ref !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid creator payment-account activation' using errcode = '22023';
  end if;
  select account.* into existing
    from public.payment_accounts account
   where account.channel_id = target_channel_id
     and account.provider = 'razorpay'
     and account.environment = target_environment
     and account.connected_account_ref = target_connected_account_ref
   for update;
  if not found then return false; end if;
  update public.payment_accounts account
     set status = 'active', revoked_at = null, updated_at = current_timestamp
   where account.id = existing.id;
  insert into public.payment_account_audit (
    id, payment_account_id, channel_id, actor_service, action,
    previous_account_ref, next_account_ref, previous_status, next_status, evidence_ref
  ) values (
    gen_random_uuid(), existing.id, target_channel_id, left(target_service, 160), 'activated',
    existing.connected_account_ref, existing.connected_account_ref, existing.status, 'active', left(target_evidence_ref, 500)
  );
  return true;
end
$$;

revoke execute on function app_private.get_creator_payment_accounts(uuid) from public;
revoke execute on function app_private.register_creator_payment_account(uuid, uuid, uuid, text, text) from public;
revoke execute on function app_private.revoke_creator_payment_account(uuid, uuid, text) from public;
revoke execute on function app_private.activate_creator_payment_account(uuid, text, text, text, text) from public;
grant execute on function app_private.get_creator_payment_accounts(uuid) to bsa_app;
grant execute on function app_private.register_creator_payment_account(uuid, uuid, uuid, text, text) to bsa_app;
grant execute on function app_private.revoke_creator_payment_account(uuid, uuid, text) to bsa_app;
grant execute on function app_private.activate_creator_payment_account(uuid, text, text, text, text) to bsa_payment;
