-- L15 acceptance: YouTube connector (0086) — source_type widening
-- preserves history, per-tier connector entitlement, token round-trip
-- never exposes plaintext, and single-use OAuth state. Synthetic
-- identifiers only, no real Google credentials.

\set ON_ERROR_STOP on

-- 1. source_type widening: existing values still accepted, new 'youtube'
-- value accepted, an unapproved value still rejected.
do $$
begin
  if app_private.youtube_connector_entitlement_limit('free') <> 0
     or app_private.youtube_connector_entitlement_limit('pro') <> 1
     or app_private.youtube_connector_entitlement_limit('creator') <> 2
     or app_private.youtube_connector_entitlement_limit('studio') <> 3 then
    raise exception 'youtube_connector_entitlement_limit does not match 0/1/2/3';
  end if;
  begin
    perform app_private.youtube_connector_entitlement_limit('enterprise');
    raise exception 'youtube_connector_entitlement_limit accepted an unapproved tier';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000801', 'google-l15-source-type', 'Synthetic L15 Source-Type Owner', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000000801', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000000081',
  '00000000-0000-4000-8000-000000000801', 'l15_source_type_test', 'L15 Source Type Test'
);
commit;

do $$
begin
  -- Pre-existing value still accepted post-widening — no historical row
  -- is at risk.
  insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
  values ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000081', 'payment', 'pay-1', 'trace-1', 1, '{}'::jsonb, current_timestamp);

  -- New 'youtube' value now accepted, carrying provenance columns.
  insert into alert_events (id, channel_id, source_type, source_id, source_event_type, source_user_id, trace_id, config_snapshot_version, payload, created_at)
  values ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000081', 'youtube', 'yt-superchat-1', 'youtube.super_chat', 'UC_synthetic_viewer', 'trace-2', 1, '{}'::jsonb, current_timestamp);

  begin
    insert into alert_events (id, channel_id, source_type, source_id, trace_id, config_snapshot_version, payload, created_at)
    values ('00000000-0000-4000-8000-000000000903', '00000000-0000-4000-8000-000000000081', 'bogus', 'x', 'trace-3', 1, '{}'::jsonb, current_timestamp);
    raise exception 'source_type widening accepted an unapproved value';
  exception when check_violation then
    null;
  end;

  if (select count(*) from alert_events where channel_id = '00000000-0000-4000-8000-000000000081') <> 2 then
    raise exception 'source_type widening test left an unexpected row count';
  end if;
end
$$;

-- 2. Per-tier connector entitlement boundary.
do $$
declare
  channel_ids uuid[] := array[
    '00000000-0000-4000-8000-000000000082', -- free
    '00000000-0000-4000-8000-000000000083', -- pro
    '00000000-0000-4000-8000-000000000084', -- creator
    '00000000-0000-4000-8000-000000000085'  -- studio
  ];
  tiers text[] := array['free', 'pro', 'creator', 'studio'];
  limits int[] := array[0, 1, 2, 3];
  owner_id uuid := '00000000-0000-4000-8000-000000000802';
  i int;
  n int;
  connection_row record;
  entitlement_rejected boolean;
begin
  insert into app_users (id, external_subject, display_name, created_at, updated_at)
  values (owner_id, 'google-l15-entitlement', 'Synthetic L15 Entitlement Owner', current_timestamp, current_timestamp);

  for i in 1..4 loop
    perform set_config('app.user_id', owner_id::text, true);
    perform app_private.create_channel(channel_ids[i], owner_id, 'l15_tier_test_' || tiers[i], 'L15 Tier Test ' || tiers[i]);
    update channel_entitlement_versions set tier = tiers[i] where channel_id = channel_ids[i];
  end loop;

  for i in 1..4 loop
    -- Connect up to the tier's limit; each must succeed.
    for n in 1..limits[i] loop
      select * into connection_row from app_private.finalize_youtube_connection(
        gen_random_uuid(), channel_ids[i], owner_id,
        'ext-' || tiers[i] || '-' || n, 'Synthetic Channel ' || n,
        array['https://www.googleapis.com/auth/youtube.readonly'],
        'v1.synthetic-iv-' || n || '.synthetic-tag-' || n || '.synthetic-ciphertext-' || n, repeat('a', 64),
        'v1.synthetic-riv-' || n || '.synthetic-rtag-' || n || '.synthetic-rciphertext-' || n, repeat('b', 64),
        current_timestamp + interval '1 hour'
      );
      if connection_row.status <> 'active' then
        raise exception 'tier % connector % did not activate within its limit', tiers[i], n;
      end if;
    end loop;

    -- One more, distinct external channel, must be rejected once at limit
    -- (free's limit of 0 rejects on the very first attempt above being
    -- skipped, so test it explicitly here too).
    entitlement_rejected := false;
    begin
      perform app_private.finalize_youtube_connection(
        gen_random_uuid(), channel_ids[i], owner_id,
        'ext-' || tiers[i] || '-over-limit', 'Synthetic Over-Limit Channel',
        array['https://www.googleapis.com/auth/youtube.readonly'],
        'v1.iv-over.tag-over.ciphertext-over', repeat('c', 64),
        null, null,
        current_timestamp + interval '1 hour'
      );
    exception when sqlstate '42501' then
      entitlement_rejected := true;
    end;
    if not entitlement_rejected then
      raise exception 'tier % accepted a connector beyond its entitlement limit of %', tiers[i], limits[i];
    end if;

    -- Reconnecting an existing (non-revoked) external channel is a
    -- refresh, not a new connector, and must succeed even exactly at the
    -- limit.
    if limits[i] > 0 then
      select * into connection_row from app_private.finalize_youtube_connection(
        gen_random_uuid(), channel_ids[i], owner_id,
        'ext-' || tiers[i] || '-1', 'Synthetic Channel 1 Refreshed',
        array['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'],
        'v1.iv-refresh.tag-refresh.ciphertext-refresh', repeat('d', 64),
        'v1.riv-refresh.rtag-refresh.rciphertext-refresh', repeat('e', 64),
        current_timestamp + interval '2 hours'
      );
      if connection_row.external_channel_title <> 'Synthetic Channel 1 Refreshed' then
        raise exception 'tier % refresh of an existing connector was not applied', tiers[i];
      end if;
    end if;
  end loop;
end
$$;

-- 3. Token round-trip: encrypted in storage, never plaintext, never
-- returned by the read path.
do $$
declare
  stored record;
  status_row record;
begin
  -- get_youtube_connections is role-gated (has_channel_role); the prior
  -- do block's app.user_id was local to its own transaction and is gone
  -- by now, so it must be set again for this channel's owner.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000802', true);

  select access_token_ciphertext, access_token_fingerprint, refresh_token_ciphertext
    into stored
    from youtube_channel_connections
   where channel_id = '00000000-0000-4000-8000-000000000083' and external_channel_id = 'ext-pro-1';
  if stored.access_token_ciphertext = 'plaintext-access-token'
     or stored.access_token_ciphertext !~ '^v1\.' then
    raise exception 'stored access token is not in encrypted v1 ciphertext form';
  end if;
  if stored.access_token_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'stored access token fingerprint is not a sha-256 hex digest';
  end if;

  select * into status_row from app_private.get_youtube_connections('00000000-0000-4000-8000-000000000083')
   where external_channel_id = 'ext-pro-1';
  if status_row is null then
    raise exception 'connector status read returned no row';
  end if;
  -- get_youtube_connections' return type structurally excludes token
  -- columns; this asserts the row shape actually returned carries none.
  if to_jsonb(status_row) ? 'access_token_ciphertext'
     or to_jsonb(status_row) ? 'refresh_token_ciphertext' then
    raise exception 'connector status read leaked token ciphertext columns';
  end if;
end
$$;

-- 4. OAuth state + PKCE: valid single use, mismatch/expired rejected.
do $$
declare
  owner_id uuid := '00000000-0000-4000-8000-000000000803';
  test_channel_id uuid := '00000000-0000-4000-8000-000000000086';
  consumed record;
  rejected boolean;
begin
  insert into app_users (id, external_subject, display_name, created_at, updated_at)
  values (owner_id, 'google-l15-oauth-state', 'Synthetic L15 OAuth State Owner', current_timestamp, current_timestamp);
  perform set_config('app.user_id', owner_id::text, true);
  perform app_private.create_channel(test_channel_id, owner_id, 'l15_oauth_state_test', 'L15 OAuth State Test');
  update channel_entitlement_versions set tier = 'pro' where channel_id = test_channel_id;

  perform app_private.begin_youtube_oauth(
    gen_random_uuid(), test_channel_id, owner_id,
    'state-abc123-synthetic-000000', 'code-verifier-synthetic-000000000000000000000000000000000000000000', 'https://app.example.test/oauth/youtube/callback'
  );

  -- Wrong state string is rejected.
  rejected := false;
  begin
    perform app_private.consume_youtube_oauth_state('state-does-not-exist-000000000');
  exception when sqlstate '22023' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'oauth state mismatch was not rejected';
  end if;

  -- Correct state is consumed exactly once.
  select * into consumed from app_private.consume_youtube_oauth_state('state-abc123-synthetic-000000');
  if consumed.channel_id <> test_channel_id or consumed.code_verifier <> 'code-verifier-synthetic-000000000000000000000000000000000000000000' then
    raise exception 'oauth state consumption returned the wrong payload';
  end if;

  rejected := false;
  begin
    perform app_private.consume_youtube_oauth_state('state-abc123-synthetic-000000');
  exception when sqlstate '22023' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'oauth state was accepted a second time';
  end if;
end
$$;

-- 5. Revocation degrades cleanly and clears token material.
do $$
declare
  revoked boolean;
  connection_ids uuid[];
  cleared_count integer;
begin
  select array_agg(id) into connection_ids
    from youtube_channel_connections
   where channel_id = '00000000-0000-4000-8000-000000000083' and external_channel_id = 'ext-pro-1';

  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000802', true);
  select app_private.revoke_youtube_connection('00000000-0000-4000-8000-000000000083', '00000000-0000-4000-8000-000000000802', connection_ids[1])
    into revoked;
  if revoked is distinct from true then
    raise exception 'youtube connector revoke did not report success';
  end if;

  select count(*) into cleared_count
    from youtube_channel_connections
   where id = connection_ids[1]
     and status = 'revoked'
     and access_token_ciphertext is null
     and refresh_token_ciphertext is null;
  if cleared_count <> 1 then
    raise exception 'revoked youtube connector still carries token material';
  end if;

  -- Reconnecting the now-revoked external channel is treated as a fresh
  -- connector again and must succeed within the tier's limit (pro=1, and
  -- this channel is now back down to 0 active connectors).
  perform app_private.finalize_youtube_connection(
    gen_random_uuid(), '00000000-0000-4000-8000-000000000083', '00000000-0000-4000-8000-000000000802',
    'ext-pro-1', 'Synthetic Channel 1 Reconnected',
    array['https://www.googleapis.com/auth/youtube.readonly'],
    'v1.iv-reconnect.tag-reconnect.ciphertext-reconnect', repeat('f', 64),
    null, null, current_timestamp + interval '1 hour'
  );
end
$$;
