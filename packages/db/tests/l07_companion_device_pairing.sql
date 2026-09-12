-- L07 desktop Companion device-authorization pairing (0082).
-- Executed in the isolated PostgreSQL harness after migrations 0001-0082.
-- Proves: start -> get -> approve -> poll happy path; single-use (second
-- redemption fails); expiry; wrong code; deny path; a non-owner cannot
-- approve onto someone else's channel; slow_down on a fast re-poll; and
-- that an unapproved device_code never yields a session-worthy 'approved'
-- status.

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000901', 'google-l07-pairing-creator', 'Synthetic Pairing Creator', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000902', 'google-l07-pairing-other', 'Synthetic Other User', current_timestamp, current_timestamp);

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000901', 'l07_pairing_channel', 'L07 Pairing Channel', true, 1, current_timestamp, current_timestamp);

insert into channel_memberships (channel_id, user_id, role, created_at)
values ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000901', 'owner', current_timestamp);

do $$
declare
  creator_id uuid := '00000000-0000-4000-8000-000000000901';
  other_user_id uuid := '00000000-0000-4000-8000-000000000902';
  channel_id uuid := '00000000-0000-4000-8000-000000000911';
  fp_happy text := encode(sha256('device-code-happy-path'::bytea), 'hex');
  fp_expiry text := encode(sha256('device-code-expiry'::bytea), 'hex');
  fp_deny text := encode(sha256('device-code-deny'::bytea), 'hex');
  fp_slow text := encode(sha256('device-code-slow-down'::bytea), 'hex');
  fp_unapproved text := encode(sha256('device-code-unapproved'::bytea), 'hex');
  poll_row record;
  view_row record;
  approved boolean;
  denied boolean;
  access_denied_seen boolean := false;
begin
  perform set_config('app.user_id', creator_id::text, true);

  -- === Happy path: start -> get -> approve -> poll returns approved ===
  perform app_private.start_companion_device_pairing(
    '00000000-0000-4000-8000-000000000a01', 'PARCDEF2', fp_happy, 'desktop', 'desktop-instance-happy01', 'Happy Desktop',
    current_timestamp + interval '10 minutes'
  );

  select * into view_row from app_private.get_companion_pairing_request('PARCDEF2');
  if view_row.state is distinct from 'pending' or view_row.client_label is distinct from 'Happy Desktop' then
    raise exception 'happy path: pairing request view is wrong: %', to_jsonb(view_row);
  end if;

  select app_private.approve_companion_pairing('PARCDEF2', channel_id, creator_id) into approved;
  if approved is distinct from true then
    raise exception 'happy path: approval did not report success';
  end if;

  select * into poll_row from app_private.poll_companion_device_pairing(fp_happy, 5);
  if poll_row.status is distinct from 'approved'
     or poll_row.channel_id is distinct from channel_id
     or poll_row.approved_by_user_id is distinct from creator_id
     or poll_row.client_instance_id is distinct from 'desktop-instance-happy01' then
    raise exception 'happy path: poll after approval did not return the approved session binding: %', to_jsonb(poll_row);
  end if;

  -- The consumed pairing request is no longer visible as pending/approved.
  select * into view_row from app_private.get_companion_pairing_request('PARCDEF2');
  if view_row.user_code is not null then
    raise exception 'happy path: consumed pairing request is still visible as pending/approved';
  end if;

  -- === Single-use: a second redemption of the same device_code fails ===
  select * into poll_row from app_private.poll_companion_device_pairing(fp_happy, 5);
  if poll_row.status is distinct from 'expired_token' or poll_row.channel_id is not null then
    raise exception 'single-use: second redemption did not fail closed: %', to_jsonb(poll_row);
  end if;

  -- === Expiry: a code past its expiry never reaches approved ===
  -- current_timestamp is frozen for the whole statement/transaction in
  -- Postgres, so a real pg_sleep() would never actually age this row from
  -- inside one DO block. Backdate expires_at directly instead (test-only;
  -- production rows are never written to this way) — the function under
  -- test still does its own real expiry comparison against current_timestamp.
  perform app_private.start_companion_device_pairing(
    '00000000-0000-4000-8000-000000000a02', 'PARCDEF3', fp_expiry, 'desktop', 'desktop-instance-expiry1', 'Expiring Desktop',
    current_timestamp + interval '10 minutes'
  );
  update public.companion_device_pairings
     set expires_at = current_timestamp - interval '1 second'
   where user_code = 'PARCDEF3';
  select * into poll_row from app_private.poll_companion_device_pairing(fp_expiry, 5);
  if poll_row.status is distinct from 'expired_token' then
    raise exception 'expiry: expired pairing did not report expired_token: %', to_jsonb(poll_row);
  end if;
  select app_private.approve_companion_pairing('PARCDEF3', channel_id, creator_id) into approved;
  if approved is distinct from false then
    raise exception 'expiry: an expired pairing request was approved';
  end if;

  -- === Wrong code: unknown user_code and unknown device_code fail closed ===
  select * into view_row from app_private.get_companion_pairing_request('ZZZZZZZZ');
  if view_row.user_code is not null then
    raise exception 'wrong code: an unknown user_code unexpectedly returned a pairing request';
  end if;
  select * into poll_row from app_private.poll_companion_device_pairing(encode(sha256('never-issued'::bytea), 'hex'), 5);
  if poll_row.status is distinct from 'expired_token' then
    raise exception 'wrong code: an unknown device_code did not fail closed as expired_token: %', to_jsonb(poll_row);
  end if;

  -- A non-owning user cannot approve onto someone else's channel.
  perform app_private.start_companion_device_pairing(
    '00000000-0000-4000-8000-000000000a03', 'PARCDEF4', fp_deny, 'desktop', 'desktop-instance-deny001', 'Deny Desktop',
    current_timestamp + interval '10 minutes'
  );
  perform set_config('app.user_id', other_user_id::text, true);
  begin
    perform app_private.approve_companion_pairing('PARCDEF4', channel_id, other_user_id);
  exception
    when sqlstate '42501' then
      access_denied_seen := true;
  end;
  if not access_denied_seen then
    raise exception 'access control: a non-owning user was allowed to approve onto someone else''s channel';
  end if;
  perform set_config('app.user_id', creator_id::text, true);

  -- === Deny path ===
  select app_private.deny_companion_pairing('PARCDEF4', creator_id) into denied;
  if denied is distinct from true then
    raise exception 'deny path: denial did not report success';
  end if;
  select * into poll_row from app_private.poll_companion_device_pairing(fp_deny, 5);
  if poll_row.status is distinct from 'access_denied' or poll_row.channel_id is not null then
    raise exception 'deny path: denied pairing did not poll as access_denied: %', to_jsonb(poll_row);
  end if;

  -- === slow_down: a second poll inside the interval window is throttled ===
  perform app_private.start_companion_device_pairing(
    '00000000-0000-4000-8000-000000000a04', 'PARCDEF5', fp_slow, 'desktop', 'desktop-instance-slowd01', 'Slow Poller',
    current_timestamp + interval '10 minutes'
  );
  select * into poll_row from app_private.poll_companion_device_pairing(fp_slow, 30);
  if poll_row.status is distinct from 'authorization_pending' then
    raise exception 'slow_down: first poll did not report authorization_pending: %', to_jsonb(poll_row);
  end if;
  select * into poll_row from app_private.poll_companion_device_pairing(fp_slow, 30);
  if poll_row.status is distinct from 'slow_down' then
    raise exception 'slow_down: immediate re-poll under the interval was not throttled: %', to_jsonb(poll_row);
  end if;

  -- === Unapproved device_code never yields 'approved' ===
  perform app_private.start_companion_device_pairing(
    '00000000-0000-4000-8000-000000000a05', 'PARCDEF6', fp_unapproved, 'desktop', 'desktop-instance-unappr1', 'Untouched Desktop',
    current_timestamp + interval '10 minutes'
  );
  select * into poll_row from app_private.poll_companion_device_pairing(fp_unapproved, 0);
  if poll_row.status is distinct from 'authorization_pending' or poll_row.channel_id is not null then
    raise exception 'unapproved: an un-actioned pairing request unexpectedly carried session-binding data: %', to_jsonb(poll_row);
  end if;

  raise notice 'l07_companion_device_pairing: all assertions passed';
end
$$;
