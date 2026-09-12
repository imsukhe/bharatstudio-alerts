-- Correct 0080's allowedQueueModes ladder.
--
-- 0080 published allowedQueueModes straight from MASTER-PLAN §3.2, which
-- lists studio as getting "+approval". But approval is not a queue mode —
-- apps/api/src/domain/entitlement-policy.ts:1 defines
--   type QueueMode = 'fifo' | 'stacked' | 'pills' | 'aggregated' | 'priority'
-- and approvalRequired is a wholly separate boolean on EntitlementPolicy
-- (same file). 0080 conflated the flag with a mode, publishing 'approval'
-- into allowedQueueModes, and it silently omitted 'pills' — a real queue
-- mode — from every tier's list. Owner decision (2026-09-06): 'pills' is a
-- display variant, so it sits at Pro alongside stacked and aggregated, not
-- gated behind Creator/Studio. approvalRequired itself is untouched here —
-- it was already correct in 0080 (free/pro false, creator/studio true) and
-- studio's extra power over creator is approvalRequired plus the other
-- non-queue-mode dimensions, not a bigger mode list; studio and creator
-- correctly share the same allowedQueueModes.
--
-- Corrected ladder:
--   free    : ['fifo']
--   pro     : ['fifo', 'stacked', 'pills', 'aggregated']
--   creator : ['fifo', 'stacked', 'pills', 'aggregated', 'priority']
--   studio  : ['fifo', 'stacked', 'pills', 'aggregated', 'priority']
--
-- app_private.tier_entitlement_dimensions() is the single source of truth
-- 0080 established (see 0080's own header). This migration only
-- create-or-replaces its allowedQueueModes arrays; queueCount,
-- ttsEnabled, maxVisibleItems, maxCharLimit, maxDisplayMs, quietMode and
-- approvalRequired are copied through unchanged from 0080/0081 so this
-- stays a pure ladder fix. Postgres preserves the function's existing
-- grants across create-or-replace, so 0080's
-- `grant execute ... to bsa_app, bsa_payment` still applies — no grants
-- are repeated here.
--
-- EXISTING-CHANNEL SAFETY: every tier's corrected list is a superset of, or
-- equal to, its 0080 list except studio, which loses only 'approval'. No
-- application code path can ever have set a channel_configs queue mode to
-- 'approval' in the first place — QueueMode (entitlement-policy.ts:1) never
-- included it, and the app validates config.queue.mode against that type
-- before persisting — so removing it from the allowed list cannot strand a
-- real queue. This migration still verifies that defensively below: it
-- scans every channel's latest channel_configs row for a queue.mode value
-- that the corrected list (for that channel's current tier) does not
-- allow, and if it finds one it only RAISE NOTICEs the channel id, mode and
-- tier for manual follow-up — it never deletes, pauses, or rewrites a
-- creator's chosen queue mode. (Contrast with 0080's queueCount retier,
-- which has a real enforcement mechanism — enforce_queue_count_entitlement
-- — because queueCount is capacity, not a mode choice; there is no
-- equivalent "downgrade" action for a mode, so non-destructive flagging is
-- the correct handling here.)
--
-- The published `values` on every channel's latest entitlement version is
-- still refreshed in place, exactly as 0080 did, so the corrected list
-- reaches live channels immediately instead of at next billing event.
-- Older version rows are untouched — history is preserved.

create or replace function app_private.tier_entitlement_dimensions(target_tier text)
returns jsonb
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then
      return jsonb_build_object(
        'queueCount', 1,
        'ttsEnabled', false,
        'allowedQueueModes', jsonb_build_array('fifo'),
        'maxVisibleItems', 3,
        'maxCharLimit', 100,
        'maxDisplayMs', 6000,
        'quietMode', false,
        'approvalRequired', false
      );
    when 'pro' then
      return jsonb_build_object(
        'queueCount', 2,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'pills', 'aggregated'),
        'maxVisibleItems', 5,
        'maxCharLimit', 150,
        'maxDisplayMs', 8000,
        'quietMode', true,
        'approvalRequired', false
      );
    when 'creator' then
      return jsonb_build_object(
        'queueCount', 3,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'pills', 'aggregated', 'priority'),
        'maxVisibleItems', 8,
        'maxCharLimit', 300,
        'maxDisplayMs', 12000,
        'quietMode', true,
        'approvalRequired', true
      );
    when 'studio' then
      return jsonb_build_object(
        'queueCount', 5,
        'ttsEnabled', true,
        'allowedQueueModes', jsonb_build_array('fifo', 'stacked', 'pills', 'aggregated', 'priority'),
        'maxVisibleItems', 12,
        'maxCharLimit', 500,
        'maxDisplayMs', 20000,
        'quietMode', true,
        'approvalRequired', true
      );
    else raise exception 'unknown entitlement tier: %', target_tier using errcode = '22023';
  end case;
end
$$;

-- Defensive, non-destructive scan: flag (never touch) any channel whose
-- latest channel_configs queue.mode is not in the corrected allowed list
-- for its current tier. Expected to find nothing (see rationale above).
do $$
declare
  offending record;
begin
  for offending in
    select cc.channel_id, cc.values #>> '{queue,mode}' as queue_mode, ev.tier
      from public.channel_configs cc
      join lateral (
        select entitlement.tier
          from public.channel_entitlement_versions entitlement
         where entitlement.channel_id = cc.channel_id
         order by entitlement.version desc
         limit 1
      ) ev on true
     where cc.version = (
             select max(c2.version) from public.channel_configs c2
              where c2.channel_id = cc.channel_id
           )
       and cc.values #>> '{queue,mode}' is not null
       and not (app_private.tier_entitlement_dimensions(ev.tier) -> 'allowedQueueModes')
           ? (cc.values #>> '{queue,mode}')
  loop
    raise notice 'queue mode ladder correction: channel % has queue.mode=% which its tier % no longer allows — left untouched, needs manual review',
      offending.channel_id, offending.queue_mode, offending.tier;
  end loop;
end
$$;

-- Refresh every existing channel's latest published entitlement values in
-- place with the corrected allowedQueueModes, same mechanism 0080 used.
do $$
declare
  channel_row record;
begin
  for channel_row in
    select distinct on (entitlement.channel_id)
           entitlement.channel_id, entitlement.tier, entitlement.version
      from public.channel_entitlement_versions entitlement
     order by entitlement.channel_id, entitlement.version desc
  loop
    perform app_private.enforce_queue_count_entitlement(channel_row.channel_id, channel_row.tier);

    update public.channel_entitlement_versions
       set values = values || app_private.tier_entitlement_dimensions(channel_row.tier)
     where channel_id = channel_row.channel_id
       and version = channel_row.version;
  end loop;
end
$$;
