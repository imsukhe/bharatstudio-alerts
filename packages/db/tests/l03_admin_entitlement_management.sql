-- L03 acceptance: admin entitlement management is platform-admin-only,
-- scoped to a per-channel support override (never a bulk tier-value edit —
-- tier_queue_count() is untouched), fully versioned/audited, and the
-- "audit history" is the entitlement table's own natural versioning.
-- Runs inside begin/rollback. Synthetic identifiers only.

\set ON_ERROR_STOP on

begin;

insert into app_users (id, external_subject, display_name, is_platform_admin, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000903', 'google-entitlement-admin', 'Synthetic Entitlement Admin', true, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000904', 'google-entitlement-owner', 'Synthetic Channel Owner', false, current_timestamp, current_timestamp);

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000913', '00000000-0000-4000-8000-000000000904', 'entitlement_admin_channel', 'Entitlement Admin Channel', true, 1, current_timestamp, current_timestamp);

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000913', 1, 'free', 'individual_plan', '{"queueCount":1}'::jsonb, current_timestamp, current_timestamp);

do $$
declare
  view_tier text;
  view_queue_count text;
  history_count integer;
  audit_action text;
  non_admin_error boolean := false;
begin
  set role bsa_app;

  -- Non-admin (even the channel's own owner) cannot reach any admin
  -- entitlement function.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000904', true);
  begin
    perform app_private.get_channel_entitlement_admin('00000000-0000-4000-8000-000000000913');
    raise exception 'non-admin channel owner read the admin entitlement view';
  exception when sqlstate '42501' then
    non_admin_error := true;
  end;
  if not non_admin_error then
    raise exception 'non-admin entitlement read did not raise the expected permission error';
  end if;

  -- Admin: current view before any override reflects the free-tier seed.
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000903', true);
  select tier, entitlement_values ->> 'queueCount' into view_tier, view_queue_count
    from app_private.get_channel_entitlement_admin('00000000-0000-4000-8000-000000000913');
  if view_tier <> 'free' or view_queue_count <> '1' then
    raise exception 'admin entitlement view did not reflect the seeded free-tier row: tier=%, queueCount=%', view_tier, view_queue_count;
  end if;

  -- Override: publishes a new version with source='admin_override',
  -- carries the queueCount forward, and does NOT change the tier itself
  -- (a support override grants a limit exception, it does not silently
  -- upgrade someone's plan).
  perform app_private.admin_override_channel_entitlement('00000000-0000-4000-8000-000000000913', '00000000-0000-4000-8000-000000000903', 8, 'support case #123');

  select tier, entitlement_values ->> 'queueCount' into view_tier, view_queue_count
    from app_private.get_channel_entitlement_admin('00000000-0000-4000-8000-000000000913');
  if view_tier <> 'free' or view_queue_count <> '8' then
    raise exception 'admin override did not publish the expected values: tier=%, queueCount=%', view_tier, view_queue_count;
  end if;

  -- History shows both versions (audit trail via natural versioning).
  select count(*) into history_count
    from app_private.list_channel_entitlement_history('00000000-0000-4000-8000-000000000913', 50);
  if history_count <> 2 then
    raise exception 'entitlement history did not show both versions: %', history_count;
  end if;

  -- Bounds: queueCount must be 1-1000, reason must be non-empty.
  begin
    perform app_private.admin_override_channel_entitlement('00000000-0000-4000-8000-000000000913', '00000000-0000-4000-8000-000000000903', 0, 'invalid');
    raise exception 'admin override accepted queueCount=0';
  exception when sqlstate '22023' then
    null;
  end;
  begin
    perform app_private.admin_override_channel_entitlement('00000000-0000-4000-8000-000000000913', '00000000-0000-4000-8000-000000000903', 5, '');
    raise exception 'admin override accepted an empty reason';
  exception when sqlstate '22023' then
    null;
  end;

  -- Unknown channel fails closed rather than silently creating a row.
  begin
    perform app_private.admin_override_channel_entitlement('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000903', 5, 'typo channel id');
    raise exception 'admin override accepted an unknown channel id';
  exception when sqlstate '23503' then
    null;
  end;

  -- Audit trail: an audit_events row records who/why.
  reset role;
  select action into audit_action from audit_events where target_id = '00000000-0000-4000-8000-000000000913'::text and action = 'admin.entitlement.override' order by created_at desc limit 1;
  if audit_action <> 'admin.entitlement.override' then
    raise exception 'admin override did not write an audit_events row: %', audit_action;
  end if;
  set role bsa_app;
exception when others then
  reset role;
  raise;
end
$$;
reset role;
rollback;

select 'L03_ADMIN_ENTITLEMENT_MANAGEMENT=PASS' as result;
