-- PRF-02 / migration 0131: the server-owned Master Canvas module cap
-- (§30.3 "Master Canvas modules active -- Free 2 / Pro 5 / Creator 12 /
-- Studio all") and the durable, never-deleted module configuration it
-- gates. Proves:
--
--   1. cap enforcement at each of the four stated tiers, by creation order;
--   2. a downgrade never deletes a module row -- only recomputes `active`;
--   3. disabling a module frees its cap slot for the next-oldest enabled
--      module, live, on the very next read (no stored rank);
--   4. re-toggling an existing module is an update, never a second insert;
--   5. only owner/admin may upsert a module; every member role can read the
--      creator-facing list; a non-member sees zero rows;
--   6. the overlay-facing (token-fingerprinted) read returns exactly the
--      active module keys and nothing else -- no config, no disabled/
--      over-cap module, no reason -- and is gated the same way every other
--      overlay widget read already is (revoked/expired/wrong-fingerprint
--      session -> zero rows, never an error).
--
-- Own synthetic id range: 00000000-0000-4000-8000-00000000c0xx, distinct
-- from every other test file's range.

\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000c001', 'google-prf02-owner', 'Synthetic PRF-02 Owner', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000c002', 'google-prf02-viewer', 'Synthetic PRF-02 Viewer', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000c003', 'google-prf02-outsider', 'Synthetic PRF-02 Outsider', current_timestamp, current_timestamp)
on conflict (id) do nothing;

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
-- Channel A: Free tier (cap 2). Channel B: Pro (cap 5). Channel C: Creator
-- (cap 12). Channel D: Studio (cap "all" / null).
select * from app_private.create_channel('00000000-0000-4000-8000-00000000c011', '00000000-0000-4000-8000-00000000c001', 'prf02_channel_a', 'PRF-02 Channel A (Free)');
select * from app_private.create_channel('00000000-0000-4000-8000-00000000c012', '00000000-0000-4000-8000-00000000c001', 'prf02_channel_b', 'PRF-02 Channel B (Pro)');
select * from app_private.create_channel('00000000-0000-4000-8000-00000000c013', '00000000-0000-4000-8000-00000000c001', 'prf02_channel_c', 'PRF-02 Channel C (Creator)');
select * from app_private.create_channel('00000000-0000-4000-8000-00000000c014', '00000000-0000-4000-8000-00000000c001', 'prf02_channel_d', 'PRF-02 Channel D (Studio)');
commit;

-- Add a viewer member to Channel A, to prove a non-admin role can still
-- read the creator-facing list (but never upsert). Plain fixture insert as
-- the migration superuser, outside the bsa_app role — matches every other
-- test file's direct-table-fixture convention (e.g. rt02's alert_queues/
-- overlay_sessions inserts): bsa_app itself has no direct table grants,
-- only execute on the SECURITY DEFINER functions.
insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-00000000c011', '00000000-0000-4000-8000-00000000c002', 'viewer', current_timestamp);

update channel_entitlement_versions set tier = 'pro' where channel_id = '00000000-0000-4000-8000-00000000c012';
update channel_entitlement_versions set tier = 'creator' where channel_id = '00000000-0000-4000-8000-00000000c013';
update channel_entitlement_versions set tier = 'studio' where channel_id = '00000000-0000-4000-8000-00000000c014';

insert into overlay_sessions (id, channel_id, token_fingerprint, expires_at, revoked_at, created_at)
values
  ('00000000-0000-4000-8000-00000000c021', '00000000-0000-4000-8000-00000000c011', 'fingerprint-prf02-a-valid', current_timestamp + interval '1 hour', null, current_timestamp),
  ('00000000-0000-4000-8000-00000000c022', '00000000-0000-4000-8000-00000000c011', 'fingerprint-prf02-a-revoked', current_timestamp + interval '1 hour', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000c023', '00000000-0000-4000-8000-00000000c011', 'fingerprint-prf02-a-expired', current_timestamp - interval '1 hour', null, current_timestamp);

-- Channel A (Free, cap 2): configure three modules, oldest first --
-- ticker, then goal ladder, then chat. Both in-scope renderers land inside
-- the cap; chat (not built by this slice, but still cap-counted per the
-- migration's file header) is the one pushed over.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
select app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c011', 'supporter_ticker', true);
select pg_sleep(0.01);
select app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c011', 'community_goal_ladder', true);
select pg_sleep(0.01);
select app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c011', 'chat', true);
commit;

do $$
declare
  row_record record;
  active_count integer := 0;
  ticker_active boolean;
  goal_active boolean;
  chat_active boolean;
  chat_reason text;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  for row_record in select * from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c011') loop
    if row_record.active then active_count := active_count + 1; end if;
    if row_record.module_key = 'supporter_ticker' then ticker_active := row_record.active; end if;
    if row_record.module_key = 'community_goal_ladder' then goal_active := row_record.active; end if;
    if row_record.module_key = 'chat' then chat_active := row_record.active; chat_reason := row_record.inactive_reason; end if;
  end loop;

  if active_count <> 2 then
    raise exception 'PRF-02.8: expected exactly 2 active modules on Free tier, got %', active_count;
  end if;
  if not ticker_active or not goal_active then
    raise exception 'PRF-02.8: the two oldest-configured modules must be active on Free tier';
  end if;
  if chat_active then
    raise exception 'PRF-02.9: the third module must be inactive over the Free cap of 2';
  end if;
  if chat_reason <> 'tier_module_cap' then
    raise exception 'PRF-02.9: expected inactive_reason = tier_module_cap, got %', coalesce(chat_reason, '<null>');
  end if;
end
$$;

-- PRF-02.9: over-cap is never deleted -- still 3 rows, still readable.
do $$
declare
  row_count integer;
begin
  select count(*) into row_count from master_canvas_modules where channel_id = '00000000-0000-4000-8000-00000000c011';
  if row_count <> 3 then
    raise exception 'PRF-02.9: expected 3 durable module rows (never deleted), got %', row_count;
  end if;
end
$$;

-- PRF-02.9 continued: disabling the ticker (the creator's own choice, a
-- 'disabled' reason -- distinct from the tier cap) must free its cap slot
-- for chat, live, on the very next read -- no stored rank to go stale.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
select app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c011', 'supporter_ticker', false);
commit;

do $$
declare
  row_record record;
  ticker_active boolean;
  ticker_reason text;
  chat_active boolean;
  row_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  for row_record in select * from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c011') loop
    if row_record.module_key = 'supporter_ticker' then ticker_active := row_record.active; ticker_reason := row_record.inactive_reason; end if;
    if row_record.module_key = 'chat' then chat_active := row_record.active; end if;
  end loop;
  if ticker_active or ticker_reason <> 'disabled' then
    raise exception 'expected supporter_ticker inactive with reason=disabled, got active=% reason=%', ticker_active, coalesce(ticker_reason, '<null>');
  end if;
  if not chat_active then
    raise exception 'expected chat to become active once the ticker''s cap slot was freed';
  end if;

  -- Back to the session default (superuser) role before the raw table
  -- read below — master_canvas_modules itself has no grant for bsa_app
  -- (every access goes through a SECURITY DEFINER function; see the
  -- migration header), so a direct SELECT under bsa_app would itself be
  -- permission-denied, not merely untested.
  reset role;
  select count(*) into row_count from master_canvas_modules where channel_id = '00000000-0000-4000-8000-00000000c011';
  if row_count <> 3 then
    raise exception 'toggling enabled must never insert a second row: expected 3, got %', row_count;
  end if;
end
$$;

-- Re-enable the ticker for the remaining tests (back to the 3-module
-- state the rest of this file assumes), and prove the upsert really is
-- update-in-place: created_at (and therefore cap rank) must survive a
-- disable/re-enable round trip unchanged.
do $$
declare
  before_created_at timestamptz;
  after_created_at timestamptz;
begin
  select created_at into before_created_at from master_canvas_modules where channel_id = '00000000-0000-4000-8000-00000000c011' and module_key = 'supporter_ticker';
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  perform app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c011', 'supporter_ticker', true);
  reset role; -- see the previous block's comment: raw table reads need the session default role, not bsa_app
  select created_at into after_created_at from master_canvas_modules where channel_id = '00000000-0000-4000-8000-00000000c011' and module_key = 'supporter_ticker';
  if before_created_at <> after_created_at then
    raise exception 'a re-enable must not change created_at / cap rank';
  end if;
end
$$;

-- Access control: only owner/admin may upsert. The viewer member must be
-- refused (42501), and the row set must be unaffected by the attempt.
do $$
declare
  row_count_before integer;
  row_count_after integer;
  raised boolean := false;
begin
  select count(*) into row_count_before from master_canvas_modules where channel_id = '00000000-0000-4000-8000-00000000c011';
  begin
    set local role bsa_app;
    perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c002', true);
    perform app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c011', 'now_playing', true);
  exception when others then
    raised := true;
  end;
  -- PL/pgSQL's exception handler rolls back to an implicit savepoint,
  -- which undoes the nested block's SET LOCAL ROLE -- but reset
  -- explicitly rather than depend on that for a raw table read.
  reset role;
  if not raised then
    raise exception 'a viewer must not be able to upsert a master canvas module';
  end if;
  select count(*) into row_count_after from master_canvas_modules where channel_id = '00000000-0000-4000-8000-00000000c011';
  if row_count_before <> row_count_after then
    raise exception 'a refused upsert must not change the row set';
  end if;
end
$$;

-- Access control: an outsider (no membership at all) sees zero rows from
-- the creator-facing list -- filtered, not an exception, matching
-- list_channel_goals' own convention.
do $$
declare
  row_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c003', true);
  select count(*) into row_count from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c011');
  if row_count <> 0 then
    raise exception 'a non-member must see zero master canvas module rows, got %', row_count;
  end if;
end
$$;

-- Access control: the viewer member (read-only role) CAN read the list.
do $$
declare
  row_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c002', true);
  select count(*) into row_count from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c011');
  if row_count <> 3 then
    raise exception 'a viewer member must still be able to read the module list, got % rows', row_count;
  end if;
end
$$;

-- Pro tier (cap 5): configure 6 modules, oldest-first; the 6th must be
-- the only one inactive.
do $$
declare
  modules text[] := array['support_theater', 'community_goal_ladder', 'supporter_ticker', 'tug_of_war_vote', 'challenge_board', 'chat'];
  module_key text;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  foreach module_key in array modules loop
    perform app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c012', module_key, true);
    perform pg_sleep(0.01);
  end loop;
end
$$;

do $$
declare
  row_record record;
  active_count integer := 0;
  chat_active boolean;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  for row_record in select * from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c012') loop
    if row_record.active then active_count := active_count + 1; end if;
    if row_record.module_key = 'chat' then chat_active := row_record.active; end if;
  end loop;
  if active_count <> 5 then
    raise exception 'expected exactly 5 active modules on Pro tier (cap 5), got %', active_count;
  end if;
  if chat_active then
    raise exception 'expected the 6th-configured module (chat) inactive over the Pro cap';
  end if;
end
$$;

-- Creator tier (cap 12): configure all 20 catalogue keys; exactly 12 must
-- be active, the 8 newest inactive over the cap.
do $$
declare
  modules text[] := array[
    'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
    'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
    'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
    'milestone_celebration', 'vertical_stream_layout', 'stream_health_widget',
    'lobby_status', 'giveaway_tournament_card', 'now_playing', 'chat', 'media_meme_queue'
  ];
  module_key text;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  foreach module_key in array modules loop
    perform app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c013', module_key, true);
    perform pg_sleep(0.01);
  end loop;
end
$$;

do $$
declare
  active_count integer;
  total_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  select count(*) filter (where active), count(*) into active_count, total_count
    from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c013');
  if total_count <> 20 then
    raise exception 'expected all 20 catalogue rows configured, got %', total_count;
  end if;
  if active_count <> 12 then
    raise exception 'expected exactly 12 active modules on Creator tier (cap 12), got %', active_count;
  end if;
end
$$;

-- Studio tier (cap "all" / null): configure 15 modules, every one active.
do $$
declare
  modules text[] := array[
    'support_theater', 'community_goal_ladder', 'tug_of_war_vote', 'boss_fight',
    'reaction_cloud', 'safe_soundboard_alert', 'supporter_ticker', 'challenge_board',
    'stream_mission_card', 'qr_smart_card', 'sponsor_card', 'moderator_status_card',
    'milestone_celebration', 'vertical_stream_layout', 'stream_health_widget'
  ];
  module_key text;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  foreach module_key in array modules loop
    perform app_private.upsert_master_canvas_module('00000000-0000-4000-8000-00000000c014', module_key, true);
  end loop;
end
$$;

do $$
declare
  active_count integer;
  total_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  select count(*) filter (where active), count(*) into active_count, total_count
    from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c014');
  if total_count <> 15 or active_count <> 15 then
    raise exception 'Studio tier ("all") must leave every configured module active: total=% active=%', total_count, active_count;
  end if;
end
$$;

-- Downgrade proof (§12.6): retier Channel C (Creator, 20 configured, 12
-- active) down to Free must not delete a single row -- only recompute
-- `active` to the new, lower cap.
update channel_entitlement_versions set tier = 'free' where channel_id = '00000000-0000-4000-8000-00000000c013';

do $$
declare
  active_count integer;
  total_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  select count(*) filter (where active), count(*) into active_count, total_count
    from app_private.list_channel_master_canvas_modules('00000000-0000-4000-8000-00000000c013');
  if total_count <> 20 then
    raise exception 'a downgrade must never delete a module row: expected 20, got %', total_count;
  end if;
  if active_count <> 2 then
    raise exception 'a downgrade to Free must recompute active down to cap 2, got %', active_count;
  end if;
end
$$;

-- Overlay-facing (browser-source) read: Channel A currently has ticker
-- (active) and goal ladder (active) and chat (inactive, over cap). A
-- valid overlay session must see exactly the two active module keys, in
-- alphabetical order, and nothing about chat's existence or reason.
do $$
declare
  keys text[];
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);
  select array_agg(module_key order by module_key) into keys
    from app_private.list_overlay_master_canvas_modules('00000000-0000-4000-8000-00000000c021', 'fingerprint-prf02-a-valid');
  if keys is distinct from array['community_goal_ladder', 'supporter_ticker'] then
    raise exception 'expected exactly [community_goal_ladder, supporter_ticker], got %', keys;
  end if;
end
$$;

-- Overlay-facing gating: revoked session, expired session, and a
-- mismatched fingerprint each yield zero rows -- never an error, never a
-- partial/stale list.
do $$
declare
  row_count integer;
begin
  set local role bsa_app;
  perform set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', true);

  select count(*) into row_count from app_private.list_overlay_master_canvas_modules('00000000-0000-4000-8000-00000000c022', 'fingerprint-prf02-a-revoked');
  if row_count <> 0 then raise exception 'a revoked overlay session must see zero master canvas modules'; end if;

  select count(*) into row_count from app_private.list_overlay_master_canvas_modules('00000000-0000-4000-8000-00000000c023', 'fingerprint-prf02-a-expired');
  if row_count <> 0 then raise exception 'an expired overlay session must see zero master canvas modules'; end if;

  select count(*) into row_count from app_private.list_overlay_master_canvas_modules('00000000-0000-4000-8000-00000000c021', 'wrong-fingerprint-entirely');
  if row_count <> 0 then raise exception 'a mismatched token fingerprint must see zero master canvas modules'; end if;
end
$$;

-- Unrecognised tier fails closed (raises), matching tier_goal_count_limit's
-- posture -- never silently read as "unlimited".
do $$
declare
  raised boolean := false;
begin
  begin
    perform app_private.tier_master_canvas_module_cap('enterprise');
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'an unrecognised tier must raise, not silently resolve a cap';
  end if;
end
$$;
