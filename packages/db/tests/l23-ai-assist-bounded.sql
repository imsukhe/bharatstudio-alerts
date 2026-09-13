-- L23 (0121): AI assist, bounded. Uses base_world channel '...0011' (owner
-- 1/admin 3/operator 4/moderator 5/viewer 6, creator tier) and channel
-- '...0012' (owner 2, kept at 'free' tier for the entitlement-gate check).
-- Own fixture ids: ...1720 upward (see 00_base_world.sql's id registry —
-- this file was not free to edit that shared fixture under its ownership
-- boundary, so the range is documented here instead).
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values
  ('00000000-0000-4000-8000-000000000011', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', 1, 'free', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

-- =========================================================================
-- NEGATIVE TEST (financial write path): the two write functions this
-- migration adds must never reference payments/refunds/challenges in their
-- own body. This is the "fails by design" proof, not a review claim.
-- =========================================================================
do $$
declare def text;
begin
  def := pg_get_functiondef('app_private.create_assist_suggestion(uuid, text, jsonb, text)'::regprocedure);
  if def ilike '%public.payments%' or def ilike '%public.refunds%' or def ilike '%public.challenges%'
     or def ilike '%channel_payment_accounts%' then
    raise exception 'CHECK DOES NOT HOLD: create_assist_suggestion references a financial/state table';
  end if;

  def := pg_get_functiondef('app_private.decide_assist_suggestion(uuid, text, jsonb)'::regprocedure);
  if def ilike '%public.payments%' or def ilike '%public.refunds%' or def ilike '%public.challenges%'
     or def ilike '%channel_payment_accounts%' then
    raise exception 'CHECK DOES NOT HOLD: decide_assist_suggestion references a financial/state table';
  end if;
end
$$;

-- =========================================================================
-- CHECK: an unentitled (free) tier cannot generate a suggestion at all.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);
do $$
begin
  begin
    perform app_private.create_assist_suggestion(
      '00000000-0000-4000-8000-000000000012'::uuid, 'config', '{"queueMode": "manual"}'::jsonb, 'Free tier attempt'
    );
    raise exception 'CHECK DOES NOT HOLD: a free-tier channel generated an assist suggestion';
  exception when others then
    if sqlerrm <> 'assist is not enabled for this channel''s current tier' then
      raise exception 'unexpected error for free-tier create: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- Create a real suggestion on the entitled (creator-tier) channel, owner,
-- surface = 'config'. This is the surface gated to owner/admin only.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_assist_suggestion(
  '00000000-0000-4000-8000-000000000011'::uuid, 'config',
  '{"suggestedQueueMode": "auto_advance", "reason": "queue idle > 90s on average"}'::jsonb,
  'rule: average idle time over last 20 items exceeded 90 seconds'
);

-- =========================================================================
-- CHECK: a suggestion cannot become an action without an explicit accept —
-- it stays 'pending' with no confirmation row until decide is called.
-- =========================================================================
do $$
declare v_suggestion_id uuid; v_status text; v_confirmations integer;
begin
  select id, status into v_suggestion_id, v_status
    from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config'
   order by created_at desc limit 1;
  if v_status <> 'pending' then raise exception 'CHECK DOES NOT HOLD: a fresh suggestion was not pending (%)', v_status; end if;
  select count(*) into v_confirmations from public.assist_confirmations where suggestion_id = v_suggestion_id;
  if v_confirmations <> 0 then raise exception 'CHECK DOES NOT HOLD: an undecided suggestion already has a confirmation row'; end if;
end
$$;

-- =========================================================================
-- CHECK: a viewer cannot decide (accept or reject) a 'config' suggestion —
-- not authorized, no confirmation row, suggestion stays pending.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config' order by created_at desc limit 1;
  begin
    perform app_private.decide_assist_suggestion(v_suggestion_id, 'accepted', null);
    raise exception 'CHECK DOES NOT HOLD: a viewer accepted a config suggestion on the creator''s behalf';
  exception when others then
    if sqlerrm <> 'not authorized to decide this assist suggestion' then
      raise exception 'unexpected error for viewer decide: %', sqlerrm;
    end if;
  end;
end
$$;

-- =========================================================================
-- CHECK: a moderator cannot decide a 'config' suggestion either (config,
-- challenge_copy and alert_style are owner/admin-only surfaces).
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config' order by created_at desc limit 1;
  begin
    perform app_private.decide_assist_suggestion(v_suggestion_id, 'accepted', null);
    raise exception 'CHECK DOES NOT HOLD: a moderator accepted a config suggestion on the creator''s behalf';
  exception when others then
    if sqlerrm <> 'not authorized to decide this assist suggestion' then
      raise exception 'unexpected error for moderator decide: %', sqlerrm;
    end if;
  end;
end
$$;

-- Suggestion must still be pending after both rejected auth attempts.
do $$
declare v_status text;
begin
  select status into v_status from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config' order by created_at desc limit 1;
  if v_status <> 'pending' then raise exception 'CHECK DOES NOT HOLD: an unauthorized decide attempt changed status to %', v_status; end if;
end
$$;

-- =========================================================================
-- Owner rejects the config suggestion. Rejection is RECORDED, not just
-- discarded: a confirmation row exists with decision='rejected' and a null
-- applied_payload (nothing was ever applied).
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config' order by created_at desc limit 1;
  perform app_private.decide_assist_suggestion(v_suggestion_id, 'rejected', null);
end
$$;

do $$
declare v_suggestion_id uuid; v_status text; v_decision text; v_applied jsonb; v_role text;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config' order by created_at desc limit 1;
  select status into v_status from public.assist_suggestions where id = v_suggestion_id;
  select decision, applied_payload, decided_by_role into v_decision, v_applied, v_role
    from public.assist_confirmations where suggestion_id = v_suggestion_id;
  if v_status <> 'rejected' then raise exception 'CHECK DOES NOT HOLD: rejected suggestion status is %', v_status; end if;
  if v_decision <> 'rejected' then raise exception 'CHECK DOES NOT HOLD: no rejected confirmation recorded'; end if;
  if v_applied is not null then raise exception 'CHECK DOES NOT HOLD: a rejected suggestion recorded an applied_payload'; end if;
  if v_role <> 'owner' then raise exception 'CHECK DOES NOT HOLD: decided_by_role snapshot wrong (%)', v_role; end if;
end
$$;

-- A decided suggestion cannot be decided again.
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'config' order by created_at desc limit 1;
  begin
    perform app_private.decide_assist_suggestion(v_suggestion_id, 'accepted', null);
    raise exception 'CHECK DOES NOT HOLD: an already-decided suggestion was decided again';
  exception when others then
    if sqlerrm <> 'assist suggestion already decided' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

-- =========================================================================
-- Moderation surface: a moderator MAY decide (per master plan: "a human
-- moderator" confirms moderation suggestions), a viewer still may not.
-- Also exercises accept with a human-edited applied_payload different from
-- suggested_payload — "what was suggested vs. what was applied".
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_assist_suggestion(
  '00000000-0000-4000-8000-000000000011'::uuid, 'moderation',
  '{"suggestedAction": "hold", "targetAlertId": "00000000-0000-4000-8000-000000001721"}'::jsonb,
  'rule: message matched a flagged-term list entry'
);

select set_config('app.user_id', '00000000-0000-4000-8000-000000000006', false);
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'moderation' order by created_at desc limit 1;
  begin
    perform app_private.decide_assist_suggestion(v_suggestion_id, 'accepted', null);
    raise exception 'CHECK DOES NOT HOLD: a viewer accepted a moderation suggestion';
  exception when others then
    if sqlerrm <> 'not authorized to decide this assist suggestion' then raise exception 'unexpected error: %', sqlerrm; end if;
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000005', false);
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'moderation' order by created_at desc limit 1;
  perform app_private.decide_assist_suggestion(
    v_suggestion_id, 'accepted', '{"suggestedAction": "hold", "targetAlertId": "00000000-0000-4000-8000-000000001721", "editedBy": "moderator"}'::jsonb
  );
end
$$;

-- =========================================================================
-- CHECK (audit trail): the full lifecycle of the moderation suggestion is
-- reconstructable — what was suggested, on what basis, who decided, when,
-- and what was actually applied (edited by the moderator at accept time).
-- =========================================================================
do $$
declare
  v_suggestion_id uuid; v_surface text; v_status text; v_suggested jsonb; v_basis text;
  v_requested_by uuid; v_decision text; v_decided_by uuid; v_decided_role text; v_applied jsonb; v_decided_at timestamptz;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'moderation' order by created_at desc limit 1;
  select surface, status, suggested_payload, basis, requested_by_user_id, decision, decided_by_user_id, decided_by_role, applied_payload, decided_at
    into v_surface, v_status, v_suggested, v_basis, v_requested_by, v_decision, v_decided_by, v_decided_role, v_applied, v_decided_at
    from app_private.get_assist_suggestion_audit(v_suggestion_id);

  if v_surface <> 'moderation' then raise exception 'CHECK DOES NOT HOLD: audit surface mismatch'; end if;
  if v_status <> 'accepted' then raise exception 'CHECK DOES NOT HOLD: audit status mismatch (%)', v_status; end if;
  if v_basis <> 'rule: message matched a flagged-term list entry' then raise exception 'CHECK DOES NOT HOLD: audit basis mismatch'; end if;
  if v_requested_by <> '00000000-0000-4000-8000-000000000001' then raise exception 'CHECK DOES NOT HOLD: audit requester mismatch'; end if;
  if v_decision <> 'accepted' then raise exception 'CHECK DOES NOT HOLD: audit decision mismatch'; end if;
  if v_decided_by <> '00000000-0000-4000-8000-000000000005' then raise exception 'CHECK DOES NOT HOLD: audit decider mismatch'; end if;
  if v_decided_role <> 'moderator' then raise exception 'CHECK DOES NOT HOLD: audit decider-role mismatch (%)', v_decided_role; end if;
  if v_decided_at is null then raise exception 'CHECK DOES NOT HOLD: audit missing decided_at'; end if;
  if (v_suggested->>'suggestedAction') <> (v_applied->>'suggestedAction') then raise exception 'CHECK DOES NOT HOLD: applied lost the suggested action'; end if;
  if v_applied ? 'editedBy' is not true or v_suggested ? 'editedBy' is true then
    raise exception 'CHECK DOES NOT HOLD: suggested-vs-applied divergence not reconstructable';
  end if;
end
$$;

-- =========================================================================
-- CHECK: accepting a suggestion never wrote to public.challenges (the
-- product's financially-consequential table nearest to this feature's
-- surfaces) — proves the "no direct write path" claim end-to-end, not just
-- by function-body inspection.
-- =========================================================================
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.challenges where channel_id = '00000000-0000-4000-8000-000000000011';
  if v_count <> 0 then raise exception 'CHECK DOES NOT HOLD: an assist accept created/touched a challenges row'; end if;
end
$$;

-- =========================================================================
-- Translation surface: operator may decide (trusted content-adjacent role
-- elsewhere in the schema); viewer may not.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', false);
select app_private.create_assist_suggestion(
  '00000000-0000-4000-8000-000000000011'::uuid, 'translation',
  '{"targetLocale": "hi-IN", "translatedText": "shukriya!"}'::jsonb,
  'requested locale hi-IN for overlay copy'
);

select set_config('app.user_id', '00000000-0000-4000-8000-000000000004', false);
do $$
declare v_suggestion_id uuid;
begin
  select id into v_suggestion_id from public.assist_suggestions
   where channel_id = '00000000-0000-4000-8000-000000000011' and surface = 'translation' order by created_at desc limit 1;
  perform app_private.decide_assist_suggestion(v_suggestion_id, 'accepted', null);
end
$$;

select 'l23-ai-assist-bounded.sql: all checks passed' as result;
