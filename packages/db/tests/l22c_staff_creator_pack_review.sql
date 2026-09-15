-- L22c acceptance: the platform-staff review surface for Studio
-- creator-pack stickers (0122). Proves: a non-staff user is rejected from
-- every staff function; a channel owner (even the owner of the very
-- channel under review) cannot reach one either; approve makes a pending
-- sticker visible, reject keeps it invisible; a rejection without a
-- reason is refused; the audit trail names the reviewer; the review-read
-- shape carries no viewer/supporter PII. Runs inside begin/rollback.
-- Synthetic identifiers only.

\set ON_ERROR_STOP on

begin;

insert into app_users (id, external_subject, display_name, is_platform_admin, created_at, updated_at)
values
  ('0000000a-0000-4000-8000-000000000501', 'ext-staff-admin', 'Synthetic Platform Staff', true, current_timestamp, current_timestamp),
  ('0000000a-0000-4000-8000-000000000502', 'ext-staff-nonadmin', 'Synthetic Non-Staff', false, current_timestamp, current_timestamp),
  ('0000000a-0000-4000-8000-000000000503', 'ext-staff-studioowner', 'Synthetic Studio Owner', false, current_timestamp, current_timestamp);

select channel_id from app_private.create_channel('0000000c-0000-4000-8000-000000000501'::uuid, '0000000a-0000-4000-8000-000000000503'::uuid, 'staffreviewstudio', 'Staff Review Studio Channel');

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at) values
  ('0000000c-0000-4000-8000-000000000501'::uuid, 2, 'studio', 'individual_plan', jsonb_build_object('queueCount', 3), current_timestamp, current_timestamp);

-- Studio owner uploads a creator-pack sticker: lands pending_review per
-- 0119, invisible everywhere until reviewed.
do $$
declare v_id uuid; v_status text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000503', true);
  select entry_id, status into v_id, v_status from app_private.import_creator_pack_sticker(
    '0000000c-0000-4000-8000-000000000501'::uuid, 'Pending Pack', 'Reaction',
    '\x7b2276223a22312e30222c226c6179657273223a5b5d7d'::bytea, true
  );
  assert v_status = 'pending_review', 'a Studio upload must start pending_review, got: ' || v_status;
  perform set_config('app.pack_under_test', v_id::text, false);
end
$$;

-- =========================================================================
-- A non-staff user is rejected from every staff route.
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000502', true);
  begin
    perform app_private.staff_list_pending_creator_pack_stickers(50);
    assert false, 'a non-staff user must not be able to list pending creator packs';
  exception when others then
    assert sqlerrm like 'platform staff access is required%', 'unexpected error: ' || sqlerrm;
  end;

  begin
    perform app_private.staff_get_creator_pack_sticker_for_review(current_setting('app.pack_under_test')::uuid);
    assert false, 'a non-staff user must not be able to inspect a pending creator pack';
  exception when others then
    assert sqlerrm like 'platform staff access is required%', 'unexpected error: ' || sqlerrm;
  end;

  begin
    perform app_private.staff_review_creator_pack_sticker(current_setting('app.pack_under_test')::uuid, true, null);
    assert false, 'a non-staff user must not be able to review a pending creator pack';
  exception when others then
    assert sqlerrm like 'platform staff access is required%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- A channel owner cannot reach a staff route by any path — not even the
-- owner of the very channel whose upload is under review.
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000503', true);
  begin
    perform app_private.staff_list_pending_creator_pack_stickers(50);
    assert false, 'a channel owner must not be able to list pending creator packs';
  exception when others then
    assert sqlerrm like 'platform staff access is required%', 'unexpected error: ' || sqlerrm;
  end;

  begin
    perform app_private.staff_review_creator_pack_sticker(current_setting('app.pack_under_test')::uuid, true, null);
    assert false, 'a channel owner must not be able to review their own pending creator pack';
  exception when others then
    assert sqlerrm like 'platform staff access is required%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- Staff can list and inspect the pending sticker. The inspect shape
-- carries no viewer/supporter PII: assert the exact key set.
-- =========================================================================
do $$
declare v_found boolean;
declare v_keys text[];
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000501', true);

  select exists (
    select 1 from app_private.staff_list_pending_creator_pack_stickers(50) pending
     where pending.id = current_setting('app.pack_under_test')::uuid
  ) into v_found;
  assert v_found, 'staff must see the pending creator-pack sticker in the pending list';

  select array_agg(key order by key) into v_keys
    from app_private.staff_get_creator_pack_sticker_for_review(current_setting('app.pack_under_test')::uuid) review,
         jsonb_object_keys(to_jsonb(review)) key;
  assert v_keys = array['asset_bytes','byte_size','category','channel_id','created_at','creator_attested','display_name','id','mime_type','status'],
    'unexpected review response key set (viewer/supporter PII leak?): ' || v_keys::text;
end
$$;

-- =========================================================================
-- A rejection with no reason is refused before anything is written.
-- =========================================================================
do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000501', true);
  begin
    perform app_private.staff_review_creator_pack_sticker(current_setting('app.pack_under_test')::uuid, false, null);
    assert false, 'a rejection with no reason must be refused';
  exception when others then
    assert sqlerrm like 'a rejection reason is required%', 'unexpected error: ' || sqlerrm;
  end;
  begin
    perform app_private.staff_review_creator_pack_sticker(current_setting('app.pack_under_test')::uuid, false, '');
    assert false, 'a rejection with an empty-string reason must be refused';
  exception when others then
    assert sqlerrm like 'a rejection reason is required%', 'unexpected error: ' || sqlerrm;
  end;
end
$$;

-- =========================================================================
-- Reject (with a reason): stays invisible, audit records who/when/what/why.
-- =========================================================================
do $$
declare v_status text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000501', true);
  select status into v_status from app_private.staff_review_creator_pack_sticker(
    current_setting('app.pack_under_test')::uuid, false, 'fails brand-safety review: contains an external URL reference'
  );
  assert v_status = 'pending_review', 'a rejected sticker must remain non-visible (pending_review), got: ' || v_status;
end
$$;

do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000503', true);
  assert not exists (
    select 1 from app_private.list_public_creator_pack_for_channel('0000000c-0000-4000-8000-000000000501'::uuid) pub
     where pub.id = current_setting('app.pack_under_test')::uuid
  ), 'a rejected creator-pack sticker must not appear in the public listing';
end
$$;

do $$
declare v_reviewer uuid; v_decision text; v_reason text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000501', true);
  select reviewer_id, decision, reason into v_reviewer, v_decision, v_reason
    from public.staff_creator_pack_review_audit
   where pack_sticker_id = current_setting('app.pack_under_test')::uuid
   order by review_order desc limit 1;
  assert v_reviewer = '0000000a-0000-4000-8000-000000000501'::uuid, 'audit must name the actual reviewer, got: ' || v_reviewer::text;
  assert v_decision = 'rejected', 'audit must record the rejection, got: ' || v_decision;
  assert v_reason = 'fails brand-safety review: contains an external URL reference', 'audit must record the rejection reason, got: ' || coalesce(v_reason, '<null>');
end
$$;

-- =========================================================================
-- Approve: becomes visible, audit records the approval (reason optional).
-- =========================================================================
do $$
declare v_status text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000501', true);
  select status into v_status from app_private.staff_review_creator_pack_sticker(
    current_setting('app.pack_under_test')::uuid, true, null
  );
  assert v_status = 'active', 'an approved sticker must become active, got: ' || v_status;
end
$$;

do $$
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000503', true);
  assert exists (
    select 1 from app_private.list_public_creator_pack_for_channel('0000000c-0000-4000-8000-000000000501'::uuid) pub
     where pub.id = current_setting('app.pack_under_test')::uuid
  ), 'an approved creator-pack sticker must appear in the public listing';
end
$$;

do $$
declare v_count integer; v_latest_decision text;
begin
  perform set_config('app.user_id', '0000000a-0000-4000-8000-000000000501', true);
  select count(*) into v_count from app_private.staff_list_creator_pack_review_audit(current_setting('app.pack_under_test')::uuid);
  assert v_count = 2, 'the audit trail must retain both the rejection and the later approval, got: ' || v_count;

  select decision into v_latest_decision
    from public.staff_creator_pack_review_audit
   where pack_sticker_id = current_setting('app.pack_under_test')::uuid
   order by review_order desc limit 1;
  assert v_latest_decision = 'approved', 'the most recent audit entry must be the approval, got: ' || v_latest_decision;
end
$$;

rollback;
