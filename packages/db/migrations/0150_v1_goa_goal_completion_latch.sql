-- GOA-01/GOA-02/GOA-03: goal completion semantics (FULL-PRODUCT-DEFINITION.md
-- S31, GOA register rows). See
-- bharatstudio-requirements/active/tasks/GOA-01-goal-completion-semantics.md
-- for the full task record.
--
-- THE DEFECT THIS CLOSES: 0102's support_goal_reached(goal_id) is entirely
-- derived (progress_paise >= target_amount_paise, recomputed on every read).
-- That is correct and unchanged for PROGRESS (see below) but wrong for
-- COMPLETION: a processed refund reduces progress the very next time it is
-- read, which silently flips support_goal_reached back to false. A goal that
-- was genuinely reached can un-reach itself with no record anything happened.
--
-- THE FIX, exactly as decided (not redesigned here):
--   * Progress stays completely untouched. app_private.support_goal_
--     progress_paise (0102) is not modified by one character in this file,
--     and no stored progress counter is added anywhere. 0102's own reasoning
--     for deriving progress live -- "a refund reduces progress the very next
--     time progress is read (no event to miss, nothing to reconcile, no
--     separate write path to keep in sync)" -- is sound and is reused, not
--     revisited.
--   * Completion becomes a LATCHED, AUDITED EVENT: a row in
--     support_goal_completions, written once, the first time progress is
--     observed to cross the target (GOA-01). It is a record that something
--     happened, not a cached copy of a calculation.
--   * A later refund reduces live progress but never un-writes the
--     completion row (GOA-02). The completion row freezes
--     completed_progress_paise at the moment of completion, so "why does
--     this say completed when it's at 94%?" has a complete, queryable
--     answer: completed at 100%+, currently at 94%, nothing rewritten.
--   * Reopening a completion is a distinct, manual, reason-required, audited
--     action (GOA-03) -- app_private.reopen_support_goal_completion -- never
--     a side effect of progress moving. Nothing in this file ever reopens a
--     completion automatically.
--
-- APPEND-ONLY POSTURE: support_goal_completions rows are never deleted, and
-- the 'completed' row's own identity/fields are never rewritten by a reopen
-- -- reopening moves that SAME row to status='reopened' (recording reopened_
-- at/reopened_by/reopen_reason on it, once), which is the same "resolve an
-- audited record in place, never delete it" shape 0059's
-- payment_reconciliation_manual_reviews already uses in this schema for an
-- open->resolved transition. This is a goal-status/workflow record, not
-- payment/refund ledger evidence itself (those stay in public.payments /
-- public.refunds, completely unmodified) -- governance/AGENTS.md's append-
-- only rule for "payment events and financial evidence" is honoured by
-- construction: nothing in this file writes to payments or refunds. A goal
-- that is re-completed after a reopen gets a SECOND, NEW 'completed' row
-- (the partial unique index below allows exactly one active 'completed' row
-- per goal at a time, not one ever) -- so the full history of every
-- completion and every reopen for a goal is always reconstructable from this
-- table, never overwritten.

create table public.support_goal_completions (
  id uuid primary key,
  goal_id uuid not null references public.support_goals(id),
  status text not null check (status in ('completed', 'reopened')),
  completed_at timestamptz not null default current_timestamp,
  completed_progress_paise bigint not null check (completed_progress_paise >= 0),
  target_amount_paise_at_completion bigint not null check (target_amount_paise_at_completion >= 1000),
  reopened_at timestamptz,
  reopened_by_user_id uuid references public.app_users(id),
  reopen_reason text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  -- GOA-03: reopen fields travel together. A 'completed' row carries none of
  -- them; a 'reopened' row carries all three, with the reason bound reused
  -- verbatim from 0059's manual-review reason (1-500 characters).
  check (
    (status = 'completed' and reopened_at is null and reopened_by_user_id is null and reopen_reason is null)
    or
    (status = 'reopened' and reopened_at is not null and reopened_by_user_id is not null
     and reopen_reason is not null and char_length(reopen_reason) between 1 and 500)
  )
);

-- GOA-01's idempotency lever: at most one ACTIVE ('completed') row per goal
-- at any time. This is what makes the latch idempotent under retry and
-- under concurrent callers -- a second insert for the same goal while one
-- 'completed' row already exists hits this index and is turned into a
-- no-op by ON CONFLICT ... DO NOTHING in the function below, never a second
-- row and never an error surfaced to the caller. A goal that is reopened
-- and later re-completed gets a new row (old 'reopened' row keeps its own
-- history), so the index constrains "at most one ACTIVE completion", not
-- "at most one completion ever" -- append-only history is preserved.
create unique index support_goal_completions_active_idx
  on public.support_goal_completions (goal_id)
  where status = 'completed';

create index support_goal_completions_goal_history_idx
  on public.support_goal_completions (goal_id, completed_at desc);

alter table public.support_goal_completions enable row level security;
revoke all on public.support_goal_completions from public;
revoke all on public.support_goal_completions from bsa_app;

-- GOA-01: the latch itself. Idempotent by construction (see the partial
-- unique index above) -- called once or a hundred times for the same goal
-- crossing the same target, it inserts exactly one row and always returns
-- that row's id. Takes only the goal id: this is a pure "has this goal's
-- live progress ever crossed its target" check with no channel-role
-- decision to make (that authorization lives in the callers below, exactly
-- as app_private.support_goal_progress_paise (0102) already has no role
-- check of its own and is called from authorized wrapper functions only).
-- Never reads, writes or joins public.payments or public.refunds directly
-- -- it goes through app_private.support_goal_progress_paise (0102) for
-- progress, the single source of truth that function's own header
-- established, unchanged here.
create or replace function app_private.latch_support_goal_completion(target_goal_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  progress bigint;
  active_id uuid;
  inserted_id uuid;
begin
  select * into goal from public.support_goals where id = target_goal_id;
  if not found then
    return null;
  end if;

  select id into active_id
    from public.support_goal_completions
   where goal_id = target_goal_id and status = 'completed';
  if active_id is not null then
    return active_id;
  end if;

  progress := app_private.support_goal_progress_paise(target_goal_id);
  if progress < goal.target_amount_paise then
    return null;
  end if;

  inserted_id := gen_random_uuid();
  insert into public.support_goal_completions (
    id, goal_id, status, completed_at, completed_progress_paise, target_amount_paise_at_completion, created_at, updated_at
  ) values (
    inserted_id, target_goal_id, 'completed', current_timestamp, progress, goal.target_amount_paise, current_timestamp, current_timestamp
  )
  on conflict (goal_id) where status = 'completed' do nothing
  returning id into inserted_id;

  if inserted_id is null then
    -- A concurrent caller won the race between our own existence check and
    -- our own insert. Return ITS row, not ours -- still exactly one active
    -- completion, still idempotent from the caller's point of view.
    select id into inserted_id
      from public.support_goal_completions
     where goal_id = target_goal_id and status = 'completed';
  end if;

  return inserted_id;
end
$$;

revoke execute on function app_private.latch_support_goal_completion(uuid) from public;
grant execute on function app_private.latch_support_goal_completion(uuid) to bsa_app;

-- Creator-dashboard read: same viewer-through-owner role shape as
-- app_private.get_channel_goal (0102), and the same "not found and not
-- authorized are the same P0002 answer" shape 0135's end_stream_mission
-- established. Opportunistically latches (GOA-01) before reading, so a
-- goal's completion state is always brought current on read without
-- requiring a separate poller or cron. GOA-02 is visible directly in the
-- shape of what is returned: completed_progress_paise (frozen at
-- completion) sits next to progress_paise (live, keeps moving with
-- payments/refunds) -- a refund shows up as progress_paise dropping while
-- completed stays true and completed_at/completed_progress_paise stay
-- exactly as first written.
create or replace function app_private.get_channel_goal_completion(
  target_channel_id uuid,
  target_goal_id uuid
)
returns table (
  goal_id uuid,
  completed boolean,
  completed_at timestamptz,
  completed_progress_paise bigint,
  target_amount_paise_at_completion bigint,
  progress_paise bigint,
  target_amount_paise bigint,
  last_reopened_at timestamptz,
  last_reopened_by_user_id uuid,
  last_reopen_reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
begin
  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found or not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[]) then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;

  perform app_private.latch_support_goal_completion(target_goal_id);

  return query
    select
      goal.id,
      completion.id is not null,
      completion.completed_at,
      completion.completed_progress_paise,
      completion.target_amount_paise_at_completion,
      app_private.support_goal_progress_paise(goal.id),
      goal.target_amount_paise,
      reopen.reopened_at,
      reopen.reopened_by_user_id,
      reopen.reopen_reason
      from (select 1) as dummy
      left join public.support_goal_completions completion
        on completion.goal_id = goal.id and completion.status = 'completed'
      left join lateral (
        select r.reopened_at, r.reopened_by_user_id, r.reopen_reason
          from public.support_goal_completions r
         where r.goal_id = goal.id and r.status = 'reopened'
         order by r.reopened_at desc
         limit 1
      ) reopen on true;
end
$$;

revoke execute on function app_private.get_channel_goal_completion(uuid, uuid) from public;
grant execute on function app_private.get_channel_goal_completion(uuid, uuid) to bsa_app;

-- GOA-03: manual reopen. Owner/admin only (same role bound as
-- create_support_goal / end_support_goal / update_support_goal, 0102).
-- Reason is required (1-500 chars, same bound as 0059's manual-review
-- reason) and is never optional -- there is no code path in this function
-- that can leave reopened_by_user_id or reopen_reason null on a 'reopened'
-- row (the table's own check constraint enforces that a second time).
-- Never triggered by progress moving, a refund, or any other automatic
-- process -- the only caller anywhere in this migration is this function
-- itself, invoked directly by an authenticated creator action.
create or replace function app_private.reopen_support_goal_completion(
  target_channel_id uuid,
  target_goal_id uuid,
  target_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  goal public.support_goals%rowtype;
  active_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s support goals' using errcode = '42501';
  end if;

  select * into goal from public.support_goals where id = target_goal_id and channel_id = target_channel_id;
  if not found then
    raise exception 'support goal not found' using errcode = 'P0002';
  end if;

  if target_reason is null or char_length(btrim(target_reason)) = 0 or char_length(target_reason) > 500 then
    raise exception 'a reopen reason is required (1-500 characters)' using errcode = '22023';
  end if;

  select id into active_id
    from public.support_goal_completions
   where goal_id = target_goal_id and status = 'completed';

  if active_id is null then
    raise exception 'support goal is not completed' using errcode = '22023';
  end if;

  update public.support_goal_completions
     set status = 'reopened',
         reopened_at = current_timestamp,
         reopened_by_user_id = app_private.current_user_id(),
         reopen_reason = left(target_reason, 500),
         updated_at = current_timestamp
   where id = active_id;
end
$$;

revoke execute on function app_private.reopen_support_goal_completion(uuid, uuid, text) from public;
grant execute on function app_private.reopen_support_goal_completion(uuid, uuid, text) to bsa_app;
