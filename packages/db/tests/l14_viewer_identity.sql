-- L14 viewer identity: signup/login/session-revoke, cross-creator isolation
-- (the most important test in this lane), DPDP deletion erase-vs-retain, and
-- profile default-off. Synthetic rows only. Run against a disposable
-- per-container database — see run-l14-viewer-identity.sh.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixtures: two creators, two channels, synthetic viewer accounts.
-- ---------------------------------------------------------------------
insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('00000000-0000-4000-8000-00000000c001', 'l14-creator-one', 'Creator One', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-00000000c002', 'l14-creator-two', 'Creator Two', current_timestamp, current_timestamp);

insert into channels (id, owner_user_id, handle, display_name, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000ec101', '00000000-0000-4000-8000-00000000c001', 'l14-channel-one', 'Channel One', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-0000000ec102', '00000000-0000-4000-8000-00000000c002', 'l14-channel-two', 'Channel Two', current_timestamp, current_timestamp);

insert into channel_memberships (channel_id, user_id, role, created_at) values
  ('00000000-0000-4000-8000-0000000ec101', '00000000-0000-4000-8000-00000000c001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-0000000ec102', '00000000-0000-4000-8000-00000000c002', 'owner', current_timestamp);

-- ---------------------------------------------------------------------
-- Signup / duplicate-email rejection.
-- ---------------------------------------------------------------------
select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-0000000000a1', 'viewer-a@example.com', repeat('x', 32), 'Viewer A')
\gset viewer_a_

select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-0000000000b1', 'viewer-b@example.com', repeat('y', 32), 'Viewer B')
\gset viewer_b_

do $$
begin
  begin
    perform app_private.create_viewer_account(gen_random_uuid(), 'viewer-a@example.com', repeat('z', 32), 'Duplicate');
    raise exception 'duplicate viewer email must be rejected';
  exception when unique_violation or others then
    if sqlerrm = 'duplicate viewer email must be rejected' then raise; end if;
  end;
end
$$;

-- Profile default-off.
do $$
begin
  if (select profile_visibility from viewer_accounts where id = '00000000-0000-4000-8000-0000000000a1') <> 'private' then
    raise exception 'viewer profile visibility must default to private';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Login lookup + session create/lookup/revoke.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from app_private.find_viewer_account_by_email('viewer-a@example.com') where id = '00000000-0000-4000-8000-0000000000a1') then
    raise exception 'login lookup by email failed';
  end if;
end
$$;

select session_id, viewer_account_id
  from app_private.create_viewer_session(gen_random_uuid(), '00000000-0000-4000-8000-0000000000a1', 'test-token-hash-a', 'test-device', current_timestamp + interval '30 days')
\gset session_a_

-- psql does not substitute :'variables' inside dollar-quoted (do $$...$$)
-- blocks, so the session id crosses into plpgsql via a GUC instead.
select set_config('l14.session_a_id', :'session_a_session_id', false);

do $$
begin
  if (select viewer_account_id from app_private.lookup_viewer_session('test-token-hash-a')) <> '00000000-0000-4000-8000-0000000000a1' then
    raise exception 'session lookup by token hash failed';
  end if;
end
$$;

select set_config('app.viewer_id', '00000000-0000-4000-8000-0000000000b1', false);
do $$
begin
  begin
    perform app_private.revoke_viewer_session('00000000-0000-4000-8000-0000000000a1', current_setting('l14.session_a_id')::uuid);
    raise exception 'viewer B must not revoke viewer A''s session';
  exception when others then
    if sqlerrm = 'viewer B must not revoke viewer A''s session' then raise; end if;
  end;
end
$$;

select set_config('app.viewer_id', '00000000-0000-4000-8000-0000000000a1', false);
do $$
begin
  if not app_private.revoke_viewer_session('00000000-0000-4000-8000-0000000000a1', current_setting('l14.session_a_id')::uuid) then
    raise exception 'viewer A must be able to revoke her own session';
  end if;
end
$$;

-- Session listing is an authenticated account-management surface, not an
-- unbounded historical feed. 101 active synthetic sessions must return the
-- newest 100 only; the deliberately oldest session must be absent.
do $$
declare
  row_count integer;
begin
  for session_number in 1..101 loop
    perform app_private.create_viewer_session(
      gen_random_uuid(),
      '00000000-0000-4000-8000-0000000000a1',
      format('l14-session-cap-token-%s', session_number),
      format('l14-cap-%s', lpad(session_number::text, 3, '0')),
      current_timestamp + interval '30 days'
    );
  end loop;

  update viewer_sessions
     set last_seen_at = current_timestamp - interval '2 days'
   where viewer_account_id = '00000000-0000-4000-8000-0000000000a1'
     and device_label = 'l14-cap-001';

  select count(*) into row_count
    from app_private.list_viewer_sessions('00000000-0000-4000-8000-0000000000a1');
  if row_count <> 100 then
    raise exception 'viewer session list must cap at 100 rows, saw %', row_count;
  end if;
  if exists (
    select 1
      from app_private.list_viewer_sessions('00000000-0000-4000-8000-0000000000a1')
     where device_label = 'l14-cap-001'
  ) then
    raise exception 'oldest viewer session must be excluded by newest-100 bound';
  end if;
end
$$;

select set_config('app.viewer_id', '00000000-0000-4000-8000-0000000000b1', false);
do $$
begin
  if exists (select 1 from app_private.list_viewer_sessions('00000000-0000-4000-8000-0000000000a1')) then
    raise exception 'viewer B must not list viewer A sessions';
  end if;
end
$$;

select set_config('app.viewer_id', '00000000-0000-4000-8000-0000000000a1', false);

-- ---------------------------------------------------------------------
-- Supporter relations across two channels, two distinct identities.
-- ---------------------------------------------------------------------
insert into creator_supporter_relations (channel_id, viewer_identity_id, first_supported_at, last_supported_at, lifetime_amount_paise, tip_count, challenge_count, member_state)
values
  ('00000000-0000-4000-8000-0000000ec101', :'viewer_a_viewer_identity_id', current_timestamp - interval '10 days', current_timestamp, 150000, 4, 1, 'active'),
  ('00000000-0000-4000-8000-0000000ec102', :'viewer_b_viewer_identity_id', current_timestamp - interval '5 days', current_timestamp, 999999, 9, 0, 'none');

-- THE MOST IMPORTANT TEST: creator one must see only channel one's supporter
-- history, never channel two's, even when asked for channel two's data.
select set_config('app.user_id', '00000000-0000-4000-8000-00000000c001', false);

do $$
declare row_count int; leaked_amount bigint;
begin
  select count(*) into row_count from app_private.get_channel_supporter_history('00000000-0000-4000-8000-0000000ec101');
  if row_count <> 1 then raise exception 'creator one must see exactly their own channel''s one supporter row, saw %', row_count; end if;

  select count(*) into row_count from app_private.get_channel_supporter_history('00000000-0000-4000-8000-0000000ec102');
  if row_count <> 0 then raise exception 'creator one must see ZERO rows for a channel they do not own, saw %', row_count; end if;

  select lifetime_amount_paise into leaked_amount from app_private.get_channel_supporter_history('00000000-0000-4000-8000-0000000ec101') limit 1;
  if leaked_amount <> 150000 or leaked_amount = 999999 then
    raise exception 'cross-creator amount leaked into channel one''s supporter history';
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-00000000c002', false);
do $$
declare row_count int;
begin
  select count(*) into row_count from app_private.get_channel_supporter_history('00000000-0000-4000-8000-0000000ec101');
  if row_count <> 0 then raise exception 'creator two must see ZERO rows for a channel they do not own, saw %', row_count; end if;
end
$$;

-- ---------------------------------------------------------------------
-- Viewer's own cross-creator dashboard (allowed) vs another viewer's
-- dashboard (must never be reachable).
-- ---------------------------------------------------------------------
select set_config('app.viewer_id', '00000000-0000-4000-8000-0000000000a1', false);
do $$
declare row_count int;
begin
  select count(*) into row_count from app_private.get_viewer_dashboard('00000000-0000-4000-8000-0000000000a1');
  if row_count <> 1 then raise exception 'viewer A must see her own one supported channel, saw %', row_count; end if;
  select count(*) into row_count from app_private.get_viewer_dashboard('00000000-0000-4000-8000-0000000000b1');
  if row_count <> 0 then raise exception 'viewer A must not be able to read viewer B''s dashboard by passing her id';
  end if;
end
$$;

-- Private history is still bounded. Add 100 later relations to the existing
-- oldest relation: exactly the newest 100 must be returned, in a stable order.
select set_config('l14.viewer_a_identity_id', :'viewer_a_viewer_identity_id', false);
do $$
declare
  relation_number integer;
  row_count integer;
  first_handle text;
begin
  update creator_supporter_relations
   set last_supported_at = current_timestamp - interval '2 days'
   where channel_id = '00000000-0000-4000-8000-0000000ec101'
     and viewer_identity_id = current_setting('l14.viewer_a_identity_id')::uuid;

  for relation_number in 1..100 loop
    insert into channels (id, owner_user_id, handle, display_name, created_at, updated_at)
    values (
      format('00000000-0000-4000-8000-%s', lpad((1700 + relation_number)::text, 12, '0'))::uuid,
      '00000000-0000-4000-8000-00000000c001',
      format('l14-dashboard-cap-%s', lpad(relation_number::text, 3, '0')),
      format('L14 Dashboard %s', relation_number), current_timestamp, current_timestamp
    );
    insert into creator_supporter_relations (
      channel_id, viewer_identity_id, first_supported_at, last_supported_at,
      lifetime_amount_paise, tip_count, challenge_count, member_state
    ) values (
      format('00000000-0000-4000-8000-%s', lpad((1700 + relation_number)::text, 12, '0'))::uuid,
      current_setting('l14.viewer_a_identity_id')::uuid,
      current_timestamp - interval '10 days',
      current_timestamp - ((100 - relation_number) * interval '1 second'),
      relation_number, 1, 0, 'none'
    );
  end loop;

  select count(*) into row_count
    from app_private.get_viewer_dashboard('00000000-0000-4000-8000-0000000000a1');
  if row_count <> 100 then
    raise exception 'viewer dashboard must cap at 100 rows, saw %', row_count;
  end if;
  if exists (
    select 1 from app_private.get_viewer_dashboard('00000000-0000-4000-8000-0000000000a1')
     where channel_id = '00000000-0000-4000-8000-0000000ec101'
  ) then
    raise exception 'oldest viewer dashboard relation must be excluded by newest-100 bound';
  end if;
  select channel_handle into first_handle
    from app_private.get_viewer_dashboard('00000000-0000-4000-8000-0000000000a1')
   limit 1;
  if first_handle <> 'l14-dashboard-cap-100' then
    raise exception 'viewer dashboard order must be deterministic, first row was %', first_handle;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- DPDP deletion: erases profile/linkage, retains the financial record.
-- ---------------------------------------------------------------------
select app_private.request_viewer_account_deletion('00000000-0000-4000-8000-0000000000a1') as erasure \gset

do $$
declare acct record;
begin
  select email, password_hash, display_name, closed_at, profile_visibility into acct
    from viewer_accounts where id = '00000000-0000-4000-8000-0000000000a1';
  if acct.email is not null or acct.password_hash is not null or acct.display_name is not null then
    raise exception 'viewer deletion must erase email/password_hash/display_name';
  end if;
  if acct.closed_at is null then raise exception 'viewer deletion must close the account'; end if;
  if acct.profile_visibility <> 'private' then raise exception 'viewer deletion must reset profile visibility to private'; end if;
end
$$;

do $$
declare relation_count int;
begin
  -- Financial/audit record must survive account deletion untouched.
  select count(*) into relation_count from creator_supporter_relations
   where channel_id = '00000000-0000-4000-8000-0000000ec101' and lifetime_amount_paise = 150000;
  if relation_count <> 1 then raise exception 'deletion must retain the financial/audit supporter-relation row'; end if;
end
$$;

select 'L14_VIEWER_IDENTITY=PASS' as result;
