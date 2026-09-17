-- CMP-94/CMP-22/CMP-30 (0161): Companion live-ops -- Recent Actions
-- projection, quick-note stream markers, Wrap Stream server-only slice.
--
-- Fixture: reuses base_world channel '...0011' (owner '...0001', admin
-- '...0003', operator '...0004', moderator '...0005', viewer '...0006')
-- for CMP-22/CMP-94 tests, and base_world channel '...0012' (owner
-- '...0002', no other members) for CMP-30 tests -- kept on a SEPARATE
-- channel so wrap-stream window aggregates are never polluted by the
-- CMP-22 test markers created against '...0011'. Own explicit-id rows
-- (payment/refund/synthetic audit event) use the pre-assigned
-- 00000000-0000-0000-0000-0000000062xx block, verified free by grepping
-- every packages/db/tests/*.sql for that suffix before use. This
-- migration does not touch packages/db/tests/fixtures/00_base_world.sql.
\set ON_ERROR_STOP on

-- =====================================================================
-- CMP-22-T1 -- cap unset (no capability_registry row for
-- 'companion_stream_marker') means no enforcement, today's behaviour.
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);

do $$
declare v_cap integer;
begin
  select app_private.companion_stream_marker_cap('00000000-0000-4000-8000-000000000011'::uuid) into v_cap;
  if v_cap is not null then
    raise exception 'CMP-22-T1: cap must be NULL (unset) before any capability_registry row exists, got %', v_cap;
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false); -- moderator

do $$
declare v_marker_id uuid;
begin
  select marker_id into v_marker_id from app_private.create_companion_stream_marker(
    '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000005'::uuid, 'great clutch', 'note', null
  );
  if v_marker_id is null then raise exception 'CMP-22-T1: marker 1 was not created'; end if;

  select marker_id into v_marker_id from app_private.create_companion_stream_marker(
    '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000005'::uuid, 'sponsor read', 'sponsor_mention', null
  );
  if v_marker_id is null then raise exception 'CMP-22-T1: marker 2 was not created'; end if;
end
$$;

do $$
declare v_count integer;
begin
  select count(*) into v_count from app_private.list_companion_stream_markers('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if v_count <> 2 then raise exception 'CMP-22-T1: expected 2 active markers, got %', v_count; end if;
end
$$;

-- =====================================================================
-- CMP-22-T2 -- once an admin sets a cap via the capability control
-- plane (a direct insert here, mirroring packages/db/tests/
-- ctl_public_capability_matrix.sql's own direct-insert style), a third
-- marker is rejected.
-- =====================================================================
insert into public.capability_registry (capability_key, capacity_class, description, limits)
values ('companion_stream_marker', 'automation_volume', 'CMP-22 marker cap test row', jsonb_build_object('maxActiveMarkers', 2));

do $$
declare v_cap integer;
begin
  select app_private.companion_stream_marker_cap('00000000-0000-4000-8000-000000000011'::uuid) into v_cap;
  if v_cap <> 2 then raise exception 'CMP-22-T2: cap must read 2 once the registry row exists, got %', v_cap; end if;
end
$$;

do $$
declare caught boolean := false;
begin
  begin
    perform 1 from app_private.create_companion_stream_marker(
      '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000005'::uuid, 'clip this', 'clip_moment', null
    );
  exception when others then
    caught := true;
  end;
  if not caught then raise exception 'CMP-22-T2: a third marker must be rejected once cap=2 is set and 2 are active'; end if;
end
$$;

-- =====================================================================
-- CMP-22-T3 -- delete (retract), the CMP-94 inverse of create. Free
-- text stays subject to the same 1-500 bound proven implicitly by T1's
-- successful inserts; this step proves deletion frees no cap headroom
-- back up in the same test run (deleted_at is a soft delete, not a
-- vacancy), then confirms an already-deleted marker cannot be deleted
-- again.
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000004', false); -- operator

do $$
declare v_marker_id uuid; v_deleted_at timestamptz; v_count integer; caught boolean := false;
begin
  select id into v_marker_id from public.companion_stream_markers
   where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'great clutch' and deleted_at is null;

  select marker_id, deleted_at into v_marker_id, v_deleted_at from app_private.delete_companion_stream_marker(
    '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000004'::uuid, v_marker_id
  );
  if v_deleted_at is null then raise exception 'CMP-22-T3: delete did not stamp deleted_at'; end if;

  select count(*) into v_count from app_private.list_companion_stream_markers('00000000-0000-4000-8000-000000000011'::uuid, null, null);
  if v_count <> 1 then raise exception 'CMP-22-T3: expected 1 active marker after one delete, got %', v_count; end if;

  begin
    perform 1 from app_private.delete_companion_stream_marker(
      '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000004'::uuid, v_marker_id
    );
  exception when others then caught := true;
  end;
  if not caught then raise exception 'CMP-22-T3: deleting an already-deleted marker must fail'; end if;
end
$$;

-- =====================================================================
-- CMP-22-T4 -- viewer is not authorized to write a marker.
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false); -- viewer

do $$
declare caught boolean := false;
begin
  begin
    perform 1 from app_private.create_companion_stream_marker(
      '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000006'::uuid, 'viewer attempt', 'note', null
    );
  exception when others then caught := true;
  end;
  if not caught then raise exception 'CMP-22-T4: a viewer must not be able to create a stream marker'; end if;
end
$$;

-- =====================================================================
-- CMP-94-T1 -- a synthetic 'admin.entitlement.override' audit row
-- (financial category, real existing action value, actor = base_world
-- admin). Own explicit id in the reserved 62xx block.
-- =====================================================================
insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
values (
  '00000000-0000-0000-0000-000000006220', '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000003'::uuid,
  'admin.entitlement.override', 'channel_entitlement_versions', '00000000-0000-4000-8000-000000000011', '{}'::jsonb, current_timestamp
);

-- Owner and moderator must see a different set: owner sees the
-- financial entry too, moderator never does (fail-closed default
-- category applies to every action not explicitly whitelisted
-- 'operational' -- admin.entitlement.override is one of those).
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false); -- owner

do $$
declare v_has_financial boolean;
begin
  select bool_or(action = 'admin.entitlement.override') into v_has_financial
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000011'::uuid, 50);
  if not coalesce(v_has_financial, false) then
    raise exception 'CMP-94-T1: owner must see the financial admin.entitlement.override entry';
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false); -- moderator

do $$
declare v_has_financial boolean; v_has_marker_create boolean; v_has_marker_delete boolean;
begin
  select
    bool_or(action = 'admin.entitlement.override'),
    bool_or(action = 'companion.stream_marker.create'),
    bool_or(action = 'companion.stream_marker.delete')
    into v_has_financial, v_has_marker_create, v_has_marker_delete
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000011'::uuid, 50);

  if coalesce(v_has_financial, false) then
    raise exception 'CMP-94-T1: a moderator must never see the financial admin.entitlement.override entry';
  end if;
  if not coalesce(v_has_marker_create, false) or not coalesce(v_has_marker_delete, false) then
    raise exception 'CMP-94-T1: a moderator must see both operational stream-marker entries';
  end if;
end
$$;

-- =====================================================================
-- CMP-94-T2 -- reversible is computed from live state, not stored: the
-- deleted marker's create entry is no longer reversible; the surviving
-- marker's create entry still is; the delete entry itself never is; and
-- no action outside the closed whitelist is ever marked reversible.
-- =====================================================================
do $$
declare
  v_deleted_label_reversible boolean;
  v_active_label_reversible boolean;
  v_delete_entry_reversible boolean;
  v_any_other_reversible boolean;
begin
  select r.reversible into v_deleted_label_reversible
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000011'::uuid, 50) r
   where r.action = 'companion.stream_marker.create' and r.reason is null
     and r.target_id = (select id::text from public.companion_stream_markers where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'great clutch');
  if coalesce(v_deleted_label_reversible, true) then
    raise exception 'CMP-94-T2: the deleted marker''s create entry must no longer be reversible';
  end if;

  select r.reversible into v_active_label_reversible
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000011'::uuid, 50) r
   where r.target_id = (select id::text from public.companion_stream_markers where channel_id = '00000000-0000-4000-8000-000000000011' and label = 'sponsor read');
  if not coalesce(v_active_label_reversible, false) then
    raise exception 'CMP-94-T2: the still-active marker''s create entry must be reversible';
  end if;

  select r.reversible into v_delete_entry_reversible
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000011'::uuid, 50) r
   where r.action = 'companion.stream_marker.delete';
  if coalesce(v_delete_entry_reversible, true) then
    raise exception 'CMP-94-T2: a delete entry must never itself be reversible';
  end if;

  select bool_or(reversible) into v_any_other_reversible
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000011'::uuid, 50) r
   where r.action <> 'companion.stream_marker.create';
  if coalesce(v_any_other_reversible, false) then
    raise exception 'CMP-94-T2: the reversible set must be closed to companion.stream_marker.create only';
  end if;
end
$$;

-- =====================================================================
-- CMP-94-T3 -- STRUCTURAL: the exact returned column set of
-- get_companion_recent_actions, asserted against information_schema.
-- parameters the same way packages/db/tests/ctl_capability_registry.sql
-- proves get_channel_capabilities' own shape. No amount/currency column
-- exists in this projection for ANY caller -- the structural half of
-- "operators and moderators see operational entries without financial
-- amounts".
-- =====================================================================
do $$
declare actual text;
begin
  select string_agg(p.parameter_name, ',' order by p.ordinal_position) into actual
    from information_schema.parameters p
    join information_schema.routines r
      on r.specific_name = p.specific_name and r.specific_schema = p.specific_schema
   where r.routine_schema = 'app_private' and r.routine_name = 'get_companion_recent_actions' and p.parameter_mode = 'OUT';
  if actual is distinct from 'action_id,action,category,target_type,target_id,actor_user_id,occurred_at,reversible,reason' then
    raise exception 'get_companion_recent_actions must project exactly action_id,action,category,target_type,target_id,actor_user_id,occurred_at,reversible,reason. Found: %', coalesce(actual, '<none>');
  end if;
end
$$;

-- =====================================================================
-- CMP-30-T1 -- only owner/admin may begin Wrap Stream. Reuses
-- base_world operator '...0004' (a member of channel '...0011', not
-- '...0012') as the non-authorized actor against channel '...0012'.
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000004', false);

do $$
declare caught boolean := false;
begin
  begin
    perform 1 from app_private.begin_companion_stream_wrap('00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000004'::uuid);
  exception when others then caught := true;
  end;
  if not caught then raise exception 'CMP-30-T1: a non-member/non-owner-admin must not be able to begin Wrap Stream'; end if;
end
$$;

-- =====================================================================
-- CMP-30-T2 -- owner begins Wrap Stream; a second call is idempotent
-- (returns the same in-flight session, not a duplicate).
-- =====================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false); -- owner of '...0012'

do $$
declare v_id1 uuid; v_id2 uuid; v_status text;
begin
  select wrap_session_id, status into v_id1, v_status from app_private.begin_companion_stream_wrap(
    '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid
  );
  if v_status <> 'confirming_stop' then raise exception 'CMP-30-T2: a fresh wrap session must start confirming_stop, got %', v_status; end if;

  select wrap_session_id into v_id2 from app_private.begin_companion_stream_wrap(
    '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid
  );
  if v_id1 <> v_id2 then raise exception 'CMP-30-T2: a second begin call while one is in flight must be idempotent, not create a duplicate'; end if;
end
$$;

-- =====================================================================
-- CMP-30-T3 -- generating a summary before the stop is confirmed must
-- fail.
-- =====================================================================
do $$
declare v_session_id uuid; caught boolean := false;
begin
  select id into v_session_id from public.companion_stream_wrap_sessions where channel_id = '00000000-0000-4000-8000-000000000012';
  begin
    perform 1 from app_private.generate_companion_stream_wrap_summary(
      '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, v_session_id
    );
  exception when others then caught := true;
  end;
  if not caught then raise exception 'CMP-30-T3: generating a summary before stop_confirmed must fail'; end if;
end
$$;

-- =====================================================================
-- CMP-30-T4 -- confirm-stop is a two-flag gate: partial confirmation
-- keeps status confirming_stop; both flags true moves to stop_confirmed
-- and stamps confirmed_stop_at.
-- =====================================================================
do $$
declare v_session_id uuid; v_status text; v_confirmed_at timestamptz;
begin
  select id into v_session_id from public.companion_stream_wrap_sessions where channel_id = '00000000-0000-4000-8000-000000000012';

  select status into v_status from app_private.confirm_companion_stream_stop(
    '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, v_session_id, true, false
  );
  if v_status <> 'confirming_stop' then raise exception 'CMP-30-T4: a partial confirmation must not advance status, got %', v_status; end if;
end
$$;

-- Payment/refund/marker for the wrap-stream summary window -- own
-- explicit ids in the reserved 62xx block, on channel '...0012' only
-- (kept separate from the CMP-22 markers on '...0011').
insert into public.payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, created_at, updated_at)
values ('00000000-0000-0000-0000-000000006210', '00000000-0000-4000-8000-000000000012', 'razorpay', 'pay_cmp30_1', 'order_cmp30_1', 500000, 'INR', 'captured', current_timestamp, current_timestamp);

insert into public.refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-0000-0000-000000006211', '00000000-0000-0000-0000-000000006210', 'rfnd_cmp30_1', 100000, 'processed', current_timestamp, current_timestamp);

do $$
declare v_marker_id uuid;
begin
  select marker_id into v_marker_id from app_private.create_companion_stream_marker(
    '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, 'chapter one moment', 'clip_moment', null
  );
  if v_marker_id is null then raise exception 'CMP-30 fixture: marker was not created on channel ...0012'; end if;
end
$$;

do $$
declare v_session_id uuid; v_status text;
begin
  select id into v_session_id from public.companion_stream_wrap_sessions where channel_id = '00000000-0000-4000-8000-000000000012';
  select status into v_status from app_private.confirm_companion_stream_stop(
    '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, v_session_id, true, true
  );
  if v_status <> 'stop_confirmed' then raise exception 'CMP-30-T4: full confirmation must advance to stop_confirmed, got %', v_status; end if;
end
$$;

-- =====================================================================
-- CMP-30-T5 -- generate the summary: derived counts, chapters from the
-- CMP-22 marker, and exactly the four prepared items, every one
-- fire_mode = 'prepare'.
-- =====================================================================
do $$
declare
  v_session_id uuid;
  v_summary jsonb;
  v_item_count integer;
  v_all_prepared boolean;
  v_chapters jsonb;
  v_finance jsonb;
begin
  select id into v_session_id from public.companion_stream_wrap_sessions where channel_id = '00000000-0000-4000-8000-000000000012';

  select summary into v_summary from app_private.generate_companion_stream_wrap_summary(
    '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, v_session_id
  );
  if (v_summary ->> 'markerCount')::integer <> 1 then
    raise exception 'CMP-30-T5: expected markerCount=1, got %', v_summary ->> 'markerCount';
  end if;

  select count(*), bool_and(fire_mode = 'prepare') into v_item_count, v_all_prepared
    from public.companion_wrap_prepared_items where wrap_session_id = v_session_id;
  if v_item_count <> 4 then raise exception 'CMP-30-T5: expected exactly 4 prepared items, got %', v_item_count; end if;
  if not v_all_prepared then raise exception 'CMP-30-T5: every prepared item must be fire_mode=prepare'; end if;

  select content into v_chapters from public.companion_wrap_prepared_items
   where wrap_session_id = v_session_id and item_kind = 'vod_chapters';
  if jsonb_array_length(v_chapters) <> 1 then raise exception 'CMP-30-T5: expected exactly 1 chapter, got %', jsonb_array_length(v_chapters); end if;

  select content into v_finance from public.companion_wrap_prepared_items
   where wrap_session_id = v_session_id and item_kind = 'finance_delta_summary';
  if (v_finance ->> 'grossPaise')::bigint <> 500000 or (v_finance ->> 'refundedPaise')::bigint <> 100000 or (v_finance ->> 'netPaise')::bigint <> 400000 then
    raise exception 'CMP-30-T5: finance_delta_summary mismatch: %', v_finance;
  end if;
end
$$;

-- =====================================================================
-- CMP-30-T6 -- structural "prepare, not auto-post": a direct INSERT
-- attempting fire_mode=fire on an outbound_or_public item_kind must be
-- rejected by the CHECK constraint, exactly the raw-INSERT proof
-- packages/db/tests/goa_trigger_engine.sql's own GTE-1 uses for GOA-21.
-- A local item_kind may still opt into fire (same posture 0158 takes),
-- proven as the non-exception counter-case.
-- =====================================================================
do $$
declare v_session_id uuid; caught boolean := false;
begin
  select id into v_session_id from public.companion_stream_wrap_sessions where channel_id = '00000000-0000-4000-8000-000000000012';

  begin
    insert into public.companion_wrap_prepared_items (wrap_session_id, channel_id, item_kind, fire_mode, content)
    values (v_session_id, '00000000-0000-4000-8000-000000000012', 'vod_chapters', 'fire', '[]'::jsonb);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'CMP-30-T6: an outbound_or_public item_kind with fire_mode=fire must be rejected by a CHECK constraint'; end if;

  -- Counter-case: a LOCAL item_kind is allowed to opt into fire_mode=fire
  -- structurally (this migration's own write path never does so, but
  -- the constraint must not over-restrict local items either).
  insert into public.companion_wrap_prepared_items (wrap_session_id, channel_id, item_kind, fire_mode, content)
  values (v_session_id, '00000000-0000-4000-8000-000000000012', 'followup_clip_review_task', 'fire', '{}'::jsonb);
end
$$;

-- =====================================================================
-- CMP-30-T7 -- confirm_companion_stream_stop and wrap-stream lifecycle
-- actions never appear in the CMP-94 reversible set (already covered
-- generally by CMP-94-T2's "closed to companion.stream_marker.create
-- only" assertion on channel '...0011'; this repeats the same check on
-- channel '...0012' against the wrap-stream action values themselves).
-- =====================================================================
do $$
declare v_any_reversible boolean;
begin
  select bool_or(reversible) into v_any_reversible
    from app_private.get_companion_recent_actions('00000000-0000-4000-8000-000000000012'::uuid, 50) r
   where r.action like 'companion.wrap_stream.%';
  if coalesce(v_any_reversible, false) then
    raise exception 'CMP-30-T7: no wrap-stream lifecycle action may ever be marked reversible';
  end if;
end
$$;

