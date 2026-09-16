-- PRF-02 slice 5, module #12: Moderator Status Card -- HELD HALF ONLY.
-- FULL-PRODUCT-DEFINITION.md §6: "Held count and moderation state --
-- never private content", with the owner decisions of 2026-09-16 written
-- into §6's own module table. This migration adds exactly one function
-- and one partial index: NO new table, NO new column, NO new event type,
-- NO trigger, NO row. The data this reads is already durable and already
-- channel-scoped -- verified against the baseline before a line of this
-- was written:
--   * event_outbox_deliveries.status already includes 'held'
--     (0001 line 134, the status check constraint).
--   * event_outbox_deliveries.queue_id already references
--     alert_queues(id), and alert_queues already carries channel_id
--     (0001 lines 53-55).
-- There was nothing to add, so nothing was added.
--
-- WHAT THIS DELIBERATELY DOES NOT DO -- "SAFE MODE" IS NOT BUILT HERE.
-- §6's original module text paired "messages held" with "safe mode on".
-- The owner decided on 2026-09-16 that safe mode is NOT
-- alert_queues.is_paused: it is a separate moderation control that does
-- not exist in this schema at all, and it needs its own record and its
-- own decision before it can appear on this card. So this function does
-- not read that column, does not return it, does not approximate it, and
-- does not surface any queue-lifecycle state under any label. The token
-- naming that column does not appear anywhere in this function's text,
-- and packages/db/tests/prf02_slice5_moderator_status.sql asserts that
-- against pg_get_functiondef rather than trusting this comment.
--
-- WHAT "HELD" MEANS HERE, STATED BECAUSE IT IS EASY TO MISREAD. It is
-- held ALERT DELIVERIES -- a paid alert awaiting a moderator's decision
-- through ALQ-10's alert_moderation_actions / app_private.
-- apply_moderation_action path (0003, 0062). It is NOT a live-chat
-- held-messages queue, which is a different system's different count.
-- §6's "messages held" wording predates this schema and has been
-- corrected in §6 itself; the renderer labels the figure "held for
-- review" for the same reason.
--
-- "NEVER PRIVATE CONTENT" IS A PROPERTY OF THIS QUERY, NOT OF THE
-- RENDERER (§6, §12.7). The function returns ONE column, held_count
-- bigint. No supporter name, no message text, no amount, no delivery id,
-- no event id, no queue id, no payment reference, no viewer identifier
-- is selected, joined out, or returned on this path -- and none can be
-- added without changing the declared `returns table` signature, which
-- the SQL test asserts directly (from pg_get_function_result AND from a
-- table materialised out of a live call). §12.7's bounded-data rule is
-- satisfied by construction: the projection is a single integer, and it
-- is not possible for it to grow silently.
--
-- AN INVALID SESSION RETURNS ZERO ROWS, NOT A ROW CONTAINING ZERO, AND
-- THAT SHAPE IS DELIBERATE. overlay_sessions is the OUTER from-clause and
-- the count is a scalar subquery in the select list. Written the other
-- way round -- count first, join the session on afterwards -- a bad token
-- would have produced one row reading 0, indistinguishable by the client
-- from a channel with genuinely nothing held. The Canvas module needs
-- that distinction: a real zero hides the card, an unauthorised read is
-- a null snapshot. Same token-fingerprint / revoked_at / expires_at gate
-- as every other list_overlay_* function (0105 L926 is the canonical
-- shape); no second auth path is introduced.
--
-- QUEUE LIFECYCLE DOES NOT FILTER THE COUNT. Held deliveries are counted
-- across every queue belonging to the channel, including paused and
-- closed ones. Pausing and closing are QUEUE lifecycle states; held is a
-- DELIVERY state. A delivery awaiting a moderator is awaiting a
-- moderator whatever its queue's lifecycle says, and filtering on queue
-- state would be inventing a moderation rule no authority states.
--
-- THE INDEX. event_outbox_deliveries_held_by_queue_idx matches this
-- query's exact predicate (queue_id, restricted to the held rows) and
-- stays small because the held set is small by nature -- a moderation
-- backlog, not a history table. It is additive. No index is added to
-- alert_queues, even though alert_queues(channel_id) has none today and
-- the captured plan therefore shows a sequential scan on it at seed
-- size: adding one would change plan shapes for queries this slice does
-- not own. That is disclosed in
-- packages/db/explain-plans/moderator-status.explain.md and referred as
-- an open question rather than patched speculatively.
--
-- TIER. All tiers, like every other built canvas module. §30.3's module
-- cap (0131) already governs how many modules a tier may activate; there
-- is no second tier gate in this migration, and moderator_status_card was
-- already one of 0131's twenty catalogue keys, so the catalogue check
-- constraint is untouched.
--
-- ROLLBACK: additive only.
--   drop function app_private.list_overlay_moderator_status(uuid, text);
--   drop index public.event_outbox_deliveries_held_by_queue_idx;
-- Nothing else is created, altered or deleted, so dropping both leaves
-- the dispatcher, the moderation path and get_companion_state
-- byte-for-byte unaffected. No production migration without separate
-- explicit approval.

create index if not exists event_outbox_deliveries_held_by_queue_idx
  on public.event_outbox_deliveries (queue_id)
  where status = 'held';

create or replace function app_private.list_overlay_moderator_status(
  target_overlay_id uuid,
  target_token_fingerprint text
)
returns table (held_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select (
           select count(*)
             from public.event_outbox_deliveries delivery
             join public.alert_queues queue on queue.id = delivery.queue_id
            where queue.channel_id = session.channel_id
              and delivery.status = 'held'
         )::bigint as held_count
    from public.overlay_sessions session
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
$$;

revoke execute on function app_private.list_overlay_moderator_status(uuid, text) from public;
grant execute on function app_private.list_overlay_moderator_status(uuid, text) to bsa_app;
