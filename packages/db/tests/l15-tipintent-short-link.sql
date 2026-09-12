-- L15 acceptance: TipIntent + opaque short link (migration 0097).
-- Verifies: create/resolve/consume round-trip; single-use enforcement at
-- the database level (not merely in application code); ready/used/expired
-- render as distinct states; amount/name/message are never returned for a
-- used or expired token; bounds/format CHECK constraints reject malformed
-- rows; no role holds a raw grant on tip_intents (SECURITY DEFINER
-- functions only). Synthetic identifiers only.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000901', 'google-l15-tipintent-owner', 'Synthetic TipIntent Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000901', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000000091',
  '00000000-0000-4000-8000-000000000901', 'l15_tipintent_test', 'L15 TipIntent Test Channel'
);
commit;

-- 1. Create, resolve (ready), consume, then resolve again (used) — and a
-- second consume attempt on the same token fails, proving single-use is a
-- database guarantee, not only an application-layer check.
do $$
declare
  ready_hash text := repeat('a', 64);
  ready_id uuid;
  ready_expiry timestamptz;
  resolved record;
  consumed record;
  second_consume_count integer;
begin
  select id, expires_at into ready_id, ready_expiry from app_private.create_tip_intent(
    '00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000091', ready_hash,
    10000, 'Rahul', 'play GTA bhai', 'youtube', 'UC_synthetic_viewer', 30
  );
  if ready_id <> '00000000-0000-4000-8000-000000000911' or ready_expiry <= current_timestamp then
    raise exception 'create_tip_intent did not return the expected id/expiry';
  end if;

  select * into resolved from app_private.get_tip_intent_by_token_hash(ready_hash);
  if resolved.state <> 'ready' or resolved.amount_paise <> 10000
     or resolved.donor_display_name <> 'Rahul' or resolved.message <> 'play GTA bhai'
     or resolved.channel_handle <> 'l15_tipintent_test' then
    raise exception 'get_tip_intent_by_token_hash did not resolve the expected ready row: %', resolved;
  end if;

  select * into consumed from app_private.consume_tip_intent(ready_hash, '00000000-0000-4000-8000-000000000921');
  if consumed.amount_paise <> 10000 or consumed.channel_id <> '00000000-0000-4000-8000-000000000091' then
    raise exception 'consume_tip_intent did not return the expected row';
  end if;

  select * into resolved from app_private.get_tip_intent_by_token_hash(ready_hash);
  if resolved.state <> 'used' then
    raise exception 'expected state=used after consume, got %', resolved.state;
  end if;
  -- amount/name/message must never come back for a used token.
  if resolved.amount_paise is not null or resolved.donor_display_name is not null or resolved.message is not null then
    raise exception 'used TipIntent leaked amount/name/message: %', resolved;
  end if;

  select count(*) into second_consume_count from app_private.consume_tip_intent(ready_hash, '00000000-0000-4000-8000-000000000922');
  if second_consume_count <> 0 then
    raise exception 'a second consume on an already-used token must return no rows (single-use is a DB guarantee)';
  end if;
end
$$;

-- 2. Unknown token: no rows, distinct from both ready/used/expired.
do $$
declare
  row_count integer;
begin
  select count(*) into row_count from app_private.get_tip_intent_by_token_hash(repeat('f', 64));
  if row_count <> 0 then
    raise exception 'an unissued token hash must resolve to no rows';
  end if;
end
$$;

-- 3. Expired token: resolves distinctly from used, and cannot be consumed.
-- The expiry is forced directly (as the table owner, outside the
-- app_private API) purely to simulate time passing within this test.
do $$
begin
  perform app_private.create_tip_intent(
    '00000000-0000-4000-8000-000000000912', '00000000-0000-4000-8000-000000000091', repeat('b', 64),
    5000, null, null, 'youtube', null, 30
  );
end
$$;

update public.tip_intents set expires_at = current_timestamp - interval '1 minute'
 where id = '00000000-0000-4000-8000-000000000912';

do $$
declare
  expired_hash text := repeat('b', 64);
  resolved record;
  consume_count integer;
begin
  select * into resolved from app_private.get_tip_intent_by_token_hash(expired_hash);
  if resolved.state <> 'expired' then
    raise exception 'expected state=expired, got %', resolved.state;
  end if;
  if resolved.amount_paise is not null then
    raise exception 'expired TipIntent leaked amount: %', resolved;
  end if;

  select count(*) into consume_count from app_private.consume_tip_intent(expired_hash, '00000000-0000-4000-8000-000000000923');
  if consume_count <> 0 then
    raise exception 'an expired token must not be consumable';
  end if;
end
$$;

-- 4. Bounds/format CHECK constraints reject malformed rows outright
-- (never coerced/clamped).
do $$
begin
  begin
    perform app_private.create_tip_intent(
      gen_random_uuid(), '00000000-0000-4000-8000-000000000091', repeat('c', 64),
      50, null, null, 'youtube', null, 30 -- below the 100-paise minimum
    );
    raise exception 'amount_paise below minimum was accepted';
  exception when check_violation then
    null;
  end;

  begin
    perform app_private.create_tip_intent(
      gen_random_uuid(), '00000000-0000-4000-8000-000000000091', 'not-a-valid-hash',
      5000, null, null, 'youtube', null, 30
    );
    raise exception 'a non-hex-64 token_hash was accepted';
  exception when check_violation then
    null;
  end;

  begin
    perform app_private.create_tip_intent(
      gen_random_uuid(), '00000000-0000-4000-8000-000000000091', repeat('d', 64),
      5000, null, null, 'twitch', null, 30 -- source_platform not yet supported
    );
    raise exception 'an unsupported source_platform was accepted';
  exception when check_violation then
    null;
  end;
end
$$;

-- 5. No role holds a raw grant on tip_intents — every access goes through
-- the SECURITY DEFINER functions above, same convention as
-- youtube_oauth_states/youtube_channel_connections (0094). Switch to
-- bsa_app for real (SET ROLE, not SECURITY DEFINER's caller-independent
-- execution) so this actually exercises the grant, not superuser bypass.
set role bsa_app;

do $$
begin
  begin
    perform 1 from public.tip_intents limit 1;
    raise exception 'bsa_app must not have a raw SELECT grant on tip_intents';
  exception when insufficient_privilege then
    null;
  end;
end
$$;

reset role;
