-- L03/§3.14 acceptance: moderator seat enforcement
-- (0104_v1_l03_moderator_seat_enforcement.sql). Asserts: per-tier limits
-- 0/0/2/5; adding a moderator beyond the limit is rejected with a
-- distinguishable error (23514) distinct from the unknown-tier error
-- (22023); a channel that already has more moderators than its tier allows
-- is never mutated by anything in this migration and still cannot add MORE;
-- a tier downgrade never removes anyone; owner/admin/operator never count
-- against the moderator limit. Synthetic identifiers only; id block
-- ...1701-...1799 per fixtures/00_base_world.sql's registry.

\set ON_ERROR_STOP on

-- 1. Function-level: exact approved values, and the unknown-tier exception.
do $$
begin
  if app_private.tier_moderator_seat_limit('free') <> 0
     or app_private.tier_moderator_seat_limit('pro') <> 0
     or app_private.tier_moderator_seat_limit('creator') <> 2
     or app_private.tier_moderator_seat_limit('studio') <> 5 then
    raise exception 'tier_moderator_seat_limit does not match MASTER-PLAN §3.14 (0/0/2/5)';
  end if;
  begin
    perform app_private.tier_moderator_seat_limit('enterprise');
    raise exception 'tier_moderator_seat_limit accepted an unapproved tier';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001701', 'google-l03-seat-owner', 'Synthetic Seat Owner', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001702', 'google-l03-seat-mod-a', 'Synthetic Seat Mod A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001703', 'google-l03-seat-mod-b', 'Synthetic Seat Mod B', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001704', 'google-l03-seat-mod-c', 'Synthetic Seat Mod C', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001705', 'google-l03-seat-admin', 'Synthetic Seat Admin', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001706', 'google-l03-seat-operator', 'Synthetic Seat Operator', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001701', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001711',
  '00000000-0000-4000-8000-000000001701', 'seat_limit_test', 'Seat Limit Test'
);
commit;

-- 2. Free tier (limit 0): even the very first moderator grant is rejected,
-- distinguishably (23514, not 22023/42501/23503).
do $$
begin
  begin
    set local role bsa_app;
    perform set_config('app.user_id', '00000000-0000-4000-8000-000000001701', true);
    perform app_private.set_channel_membership_role(
      '00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001702', 'moderator'
    );
    raise exception 'free-tier channel accepted a moderator grant beyond its 0 seat limit';
  exception when sqlstate '23514' then
    null;
  end;
end
$$;

-- 3. Retier to 'creator' (limit 2). Two moderator grants succeed.
select app_private.publish_active_individual_entitlement(
  '00000000-0000-4000-8000-000000001711', 'creator', 'sub_l03_seat_limit_test', 'monthly', 39900,
  current_timestamp
);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001701', true);
select * from app_private.set_channel_membership_role('00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001702', 'moderator');
select * from app_private.set_channel_membership_role('00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001703', 'moderator');
commit;

do $$
declare
  moderator_count integer;
begin
  select count(*) into moderator_count
    from channel_memberships
   where channel_id = '00000000-0000-4000-8000-000000001711'
     and role = 'moderator'
     and revoked_at is null;
  if moderator_count <> 2 then
    raise exception 'expected 2 active moderators on creator tier, got %', moderator_count;
  end if;
end
$$;

-- 4. A third moderator on a creator-tier (limit 2) channel is rejected,
-- distinguishably, and does not add a row.
do $$
begin
  begin
    set local role bsa_app;
    perform set_config('app.user_id', '00000000-0000-4000-8000-000000001701', true);
    perform app_private.set_channel_membership_role(
      '00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001704', 'moderator'
    );
    raise exception 'creator-tier channel accepted a 3rd moderator beyond its 2 seat limit';
  exception when sqlstate '23514' then
    null;
  end;
end
$$;

-- 5. Owner/admin/operator grants on the SAME already-at-limit channel never
-- count against the moderator limit and always succeed.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001701', true);
select * from app_private.set_channel_membership_role('00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001705', 'admin');
select * from app_private.set_channel_membership_role('00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001706', 'operator');
commit;

do $$
declare
  admin_role text;
  operator_role text;
  moderator_count integer;
begin
  select role into admin_role from channel_memberships where channel_id = '00000000-0000-4000-8000-000000001711' and user_id = '00000000-0000-4000-8000-000000001705';
  select role into operator_role from channel_memberships where channel_id = '00000000-0000-4000-8000-000000001711' and user_id = '00000000-0000-4000-8000-000000001706';
  if admin_role <> 'admin' or operator_role <> 'operator' then
    raise exception 'admin/operator grants were blocked by the moderator seat limit: admin=%, operator=%', admin_role, operator_role;
  end if;
  select count(*) into moderator_count
    from channel_memberships
   where channel_id = '00000000-0000-4000-8000-000000001711' and role = 'moderator' and revoked_at is null;
  if moderator_count <> 2 then
    raise exception 'admin/operator grants unexpectedly changed the moderator count: %', moderator_count;
  end if;
end
$$;

-- 6. Downgrade to free (limit 0) does NOT remove either existing moderator
-- — nothing in 0104 hooks the entitlement publish path.
select app_private.publish_free_entitlement('00000000-0000-4000-8000-000000001711', current_timestamp);

do $$
declare
  moderator_count integer;
begin
  select count(*) into moderator_count
    from channel_memberships
   where channel_id = '00000000-0000-4000-8000-000000001711'
     and role = 'moderator'
     and revoked_at is null;
  if moderator_count <> 2 then
    raise exception 'tier downgrade removed a moderator: expected 2 active moderators, got %', moderator_count;
  end if;
end
$$;

-- 7. A channel that predates enforcement and is already over its (now free,
-- limit 0) tier's limit: simulate that pre-existing over-limit state with a
-- direct insert (bypassing the enforcement function entirely, exactly as a
-- row written before this migration existed would look), confirm nothing
-- in 0104 mutates it, and confirm it still cannot add MORE.
insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001707', 'google-l03-seat-preexisting-owner', 'Synthetic Preexisting Owner', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001708', 'google-l03-seat-preexisting-mod-a', 'Synthetic Preexisting Mod A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001709', 'google-l03-seat-preexisting-mod-b', 'Synthetic Preexisting Mod B', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001710', 'google-l03-seat-preexisting-mod-c', 'Synthetic Preexisting Mod C', current_timestamp, current_timestamp);

begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001707', true);
select * from app_private.create_channel(
  '00000000-0000-4000-8000-000000001712',
  '00000000-0000-4000-8000-000000001707', 'seat_overlimit_test', 'Seat Over-Limit Test'
);
commit;

-- Direct insert: three moderators on a channel whose (free) tier only ever
-- allowed 0 — the exact shape of a channel that shipped moderators before
-- any enforcement existed.
insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000001712', '00000000-0000-4000-8000-000000001708', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000001712', '00000000-0000-4000-8000-000000001709', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000001712', '00000000-0000-4000-8000-000000001710', 'moderator', current_timestamp);

do $$
declare
  moderator_count integer;
begin
  select count(*) into moderator_count
    from channel_memberships
   where channel_id = '00000000-0000-4000-8000-000000001712' and role = 'moderator' and revoked_at is null;
  if moderator_count <> 3 then
    raise exception 'pre-existing over-limit fixture setup failed: expected 3 moderators, got %', moderator_count;
  end if;
end
$$;

-- Re-affirming an already-active moderator's role is never blocked by the
-- seat check, even though the channel is already 3-over its 0 seat limit —
-- no existing membership row can be broken by this migration.
begin;
set local role bsa_app;
select set_config('app.user_id', '00000000-0000-4000-8000-000000001707', true);
select * from app_private.set_channel_membership_role('00000000-0000-4000-8000-000000001712', '00000000-0000-4000-8000-000000001708', 'moderator');
commit;

do $$
declare
  moderator_count integer;
begin
  select count(*) into moderator_count
    from channel_memberships
   where channel_id = '00000000-0000-4000-8000-000000001712' and role = 'moderator' and revoked_at is null;
  if moderator_count <> 3 then
    raise exception 'a no-op re-affirm of an existing moderator mutated the over-limit channel: got %', moderator_count;
  end if;
end
$$;

-- But this over-limit channel still cannot add a 4th, distinguishably.
do $$
begin
  begin
    set local role bsa_app;
    perform set_config('app.user_id', '00000000-0000-4000-8000-000000001707', true);
    perform app_private.set_channel_membership_role(
      '00000000-0000-4000-8000-000000001712', '00000000-0000-4000-8000-000000001701', 'moderator'
    );
    raise exception 'over-limit channel accepted a 4th moderator instead of being blocked from adding MORE';
  exception when sqlstate '23514' then
    null;
  end;
end
$$;

do $$
declare
  moderator_count integer;
begin
  select count(*) into moderator_count
    from channel_memberships
   where channel_id = '00000000-0000-4000-8000-000000001712' and role = 'moderator' and revoked_at is null;
  if moderator_count <> 3 then
    raise exception 'a rejected grant attempt still mutated the over-limit channel: got %', moderator_count;
  end if;
end
$$;

-- 8. A non-owner/admin caller cannot grant a moderator seat at all
-- (42501 — distinguishable from the seat-limit 23514).
do $$
begin
  begin
    set local role bsa_app;
    perform set_config('app.user_id', '00000000-0000-4000-8000-000000001702', true); -- an active moderator, not owner/admin
    perform app_private.set_channel_membership_role(
      '00000000-0000-4000-8000-000000001711', '00000000-0000-4000-8000-000000001704', 'viewer'
    );
    raise exception 'a moderator was allowed to change channel memberships';
  exception when sqlstate '42501' then
    null;
  end;
end
$$;
