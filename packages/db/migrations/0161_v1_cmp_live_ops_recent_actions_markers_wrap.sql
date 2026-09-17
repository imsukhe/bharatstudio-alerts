-- CMP-94/CMP-22/CMP-30 -- Companion live-ops server capabilities: Recent
-- Actions on the Live Deck, quick-note stream markers, and the
-- server-only, no-external-dependency half of Wrap Stream.
--
-- AUTHORITY. FULL-PRODUCT-DEFINITION.md S5.2 "Live Deck", S5.5 "Wrap
-- Stream" (lines 579-654), S7.5 "Activity Log" (lines 1141-1168), S7.2
-- detail-view contract (lines 1096-1113), S31.8 register (CMP-94/CMP-22/
-- CMP-30, line 5675).
--
-- MIGRATION NUMBER: 0161, pre-assigned (0160's own header already names
-- 0161 as a concurrent sibling migration in a separate worktree). Fixture
-- range 00000000-0000-0000-0000-0000000062xx ("...6200-...62ff"),
-- pre-assigned to this lane, own self-contained fixture in
-- packages/db/tests/cmp_live_ops_recent_actions_markers_wrap.sql -- this
-- migration does not touch packages/db/tests/fixtures/00_base_world.sql.
--
-- ============================================================
-- CMP-94 -- RECENT ACTIONS IS A PROJECTION, NEVER A SECOND LOG.
-- ============================================================
-- public.audit_events already exists (0001_v1_baseline.sql:172: id,
-- channel_id, actor_user_id, action, target_type, target_id, metadata,
-- created_at) and is already written by exactly three action types today
-- (grepped across every migration): 'admin.dlq.replay' and
-- 'admin.dlq.discard' (0073_v1_l03_admin_dlq_tooling.sql) and
-- 'admin.entitlement.override' (0074_v1_l03_admin_entitlement_management.
-- sql). No channel-moderation action (ban, timeout, mute, hide) writes to
-- audit_events anywhere in this repository -- grepped for 'unban',
-- 'timeout', 'ban_request' and every spelling of a moderation-action
-- writer; none exists. app_private.record_safety_moderation_action
-- (0151) writes to its OWN table, safety_moderation_actions, not
-- audit_events, and that table is a content-safety decision record (SAF-
-- 09), not an actor-took-an-action record -- it is deliberately left out
-- of this projection.
--
-- This migration adds NO new log table and NO counter. CMP-94 is built
-- as app_private.get_companion_recent_actions(channel_id, limit): a read
-- function over audit_events alone, plus the two write paths this same
-- migration adds for CMP-22 (create_companion_stream_marker/
-- delete_companion_stream_marker), which are exactly the FIRST channel-
-- moderation-shaped actions this schema has ever had a real inverse for.
--
-- "SESSION-SCOPED" -- HONESTLY, WHAT THAT MEANS HERE. S7.5 calls Recent
-- Actions "a short, session-scoped list ... the last few actions anyone
-- took on this channel right now". This schema has NO live-broadcast-
-- session concept anywhere -- no is_live column, no stream_sessions
-- table (0158's own header already recorded this same absence: "no
-- is_live/broadcast-status column anywhere in this schema"; still true
-- today, grepped again for this migration). Inventing one is out of this
-- task's scope (CMP-94/22/30 only, not a stream-session primitive every
-- other Companion surface would then depend on). "Session-scoped" is
-- therefore honestly implemented as "most recent N", bounded by
-- get_companion_recent_actions' own LIMIT (capped at 50, mirroring the
-- Activity Log's own "virtualised past 50 rows" bound at S7.5) --
-- recency-ordered, not literally fenced to a broadcast session, because
-- this schema has no broadcast session to fence it to.
--
-- ROLE-SCOPED, STRUCTURALLY -- "operators and moderators see operational
-- entries without financial amounts" (S7.5). Read literally: the entries
-- they see ARE operational (non-money) entries; a financial entry is not
-- shown to them at all, redacted or otherwise. This is built two ways,
-- both structural, neither a UI concern:
--
--   1. app_private.companion_action_category(action text) is an
--      IMMUTABLE, action-string-only lookup classifying every known
--      action as 'operational' or 'financial', DEFAULTING UNCLASSIFIED
--      ACTIONS TO 'financial' -- fail closed. A future action type
--      nobody has yet taught this function about is hidden from
--      operator/moderator until someone deliberately reclassifies it,
--      never the other way round. Of today's five real action values:
--      'admin.dlq.replay'/'admin.dlq.discard' (delivery-queue retry
--      operations, no amounts) and 'companion.stream_marker.create'/
--      'companion.stream_marker.delete' (this migration's own CMP-22
--      writes) are 'operational'. 'admin.entitlement.override' touches
--      tier/queueCount, revenue-adjacent platform-staff config -- kept
--      'financial' deliberately, on the conservative side, proven in the
--      SQL test by a moderator-role call NOT returning it while an
--      owner-role call does.
--   2. get_companion_recent_actions' own `returns table` shape carries
--      NO amount/currency column at all -- not `amount_paise`, not raw
--      `metadata` (which could carry one from an action nobody has
--      written yet), nothing. `reason` is the only free-text field
--      exposed, extracted as text from metadata->>'reason', never the
--      jsonb blob itself. This is what "privacy is a property of the
--      query, not of the caller" means in a single, checkable place:
--      packages/db/tests/cmp_live_ops_recent_actions_markers_wrap.sql
--      asserts against information_schema.parameters for this function
--      that no output column name matches 'amount', 'paise', 'inr' or
--      'currency' -- structurally, not by trusting every caller to
--      redact correctly.
--
-- ============================================================
-- CMP-94 -- THE REVERSIBLE SET IS CLOSED AND SMALL, ON PURPOSE.
-- ============================================================
-- "Reversibility is a closed whitelist ... An action is reversible ONLY
-- if a real inverse operation already exists in this repo." Audited
-- against every action this migration can see:
--   - 'admin.dlq.replay'   -- no undo function anywhere; the only other
--     terminal state a delivery can reach is admin_discard_delivery,
--     which is a DIFFERENT action (discard), not an inverse of replay.
--     NOT reversible.
--   - 'admin.dlq.discard'  -- 0073's own comment calls this "Terminal
--     discard ... never a delete"; no un-discard function exists.
--     NOT reversible.
--   - 'admin.entitlement.override' -- no restore-previous-version
--     function exists; reverting requires a human to call the same
--     override function again with the old values by hand. NOT a
--     one-tap inverse. NOT reversible.
--   - 'companion.stream_marker.create' -- REVERSIBLE. Real inverse:
--     app_private.delete_companion_stream_marker, built in this same
--     migration (below), which soft-deletes the marker row. Computed
--     live, not stored: reversible = true only while the marker still
--     exists and is not already deleted -- an already-undone create is
--     no longer offered a second undo.
--   - 'companion.stream_marker.delete' -- NOT reversible. There is no
--     un-delete/restore function; offering a second undo on top of the
--     first would require inventing one, which this migration does not
--     do.
-- The doc's own worked example -- "did my mod just ban someone, and why"
-- -- names a ban. This schema has no ban/timeout function of any kind
-- (see the grep note above), so a ban action is neither in audit_events
-- today nor in this reversible set: there is nothing to point an inverse
-- at, so none is invented. Reported honestly in this task's RETURN
-- CONTRACT rather than stubbed here.
--
-- ============================================================
-- CMP-22 -- MARKERS: NO INVENTED CAP, NO INVENTED RETENTION.
-- ============================================================
-- "Do not invent a maximum count or a retention period -- if a cap is
-- needed, build the mechanism and read the value from the capability
-- control plane, leaving it unset". The control plane (0149/0153/0157)
-- exposes exactly one numeric config surface today: capability_registry.
-- limits (jsonb, added by 0153, default '{}'::jsonb, populated only
-- through the staff propose/approve/apply workflow -- no code path in
-- this repository writes a row for a 'companion_stream_marker' capability
-- key, so today the row is simply ABSENT, which is what "unset" means
-- here). app_private.companion_stream_marker_cap(channel_id) reads
-- capability_registry.limits->>'maxActiveMarkers' for capability_key
-- 'companion_stream_marker'; no row, or no key inside limits, both
-- resolve to NULL, and create_companion_stream_marker enforces no cap at
-- all when the function returns NULL -- exactly today's behaviour, never
-- a guessed number, never 'unlimited' baked in as a magic sentinel. The
-- day an admin uses the EXISTING 0152/0157 staff workflow to set
-- limits->>'maxActiveMarkers' on that capability_key, enforcement starts,
-- with no code change here. No retention/expiry column exists on
-- companion_stream_markers (grepped for 'retention'/'retain'/'ttl'/
-- 'expir' the same way 0149's own CTL-15 test does) -- markers live until
-- explicitly deleted or the platform-wide retention sweep (0095, already
-- excludes audit_events/payments/refunds/alert_events; this migration
-- does not touch 0095 and companion_stream_markers is new, so 0095 says
-- nothing about it either way -- a genuinely separate, later decision).
--
-- CARRY A TIMESTAMP USABLE FOR VOD CHAPTERS (S5.5). marker_at is the
-- moment being marked, defaulting to current_timestamp but overridable
-- by the caller (a Companion client may know the real in-stream moment
-- slightly before its own network round-trip completes). Wrap Stream's
-- chapter derivation below reads marker_at directly.
--
-- ============================================================
-- CMP-30 -- SCOPE CUT, EXACTLY AS ASSIGNED.
-- ============================================================
-- Built here (pure code, no external dependency):
--   - confirm-stop state machine: begin -> confirming_stop ->
--     stop_confirmed -> summary_ready, one row per wrap attempt
--     (companion_stream_wrap_sessions). The server never itself checks
--     OBS or a live broadcast's real status -- "confirm OBS has stopped
--     and the broadcast is really complete" (S5.1's own irreversible-
--     action posture: creator-confirmed, not server-verified) is
--     recorded as two caller-supplied booleans
--     (obs_stopped_confirmed/broadcast_complete_confirmed); the server's
--     job is to hold that confirmation as durable state and gate
--     everything downstream on it, not to reach into OBS or a video
--     platform itself.
--   - preserve overlay/event/payment audit records: already true,
--     platform-wide, before this migration -- alert_events, payments,
--     refunds and audit_events are all append-only and excluded from the
--     retention sweep (0095's own header: "Nothing here touches
--     alert_events, payments, refunds, audit_events"). This migration
--     adds no deletion path for any of them and generate_companion_
--     stream_wrap_summary below only ever reads them.
--   - a private stream summary: a jsonb aggregate persisted on the wrap
--     session row (window boundaries, marker count, moderation-action
--     count, alert delivery counts). Private to the channel's own
--     owner/admin (the only roles this migration's write/read functions
--     accept) -- never a public surface.
--   - chapters derived from CMP-22 markers: pure computation over
--     companion_stream_markers in the window, offsetSeconds relative to
--     the window start. Stored as a 'vod_chapters' prepared item,
--     fire_mode 'prepare' -- see the enforcement section below. This
--     migration computes the chapter list; it does not write it to any
--     video platform.
--   - missed alerts / queued items / failures / reconciliation tasks:
--     derived from event_outbox_deliveries (via alert_events.channel_id)
--     -- failed_retriable+quarantined counted as missed/failed,
--     pending+ready+held counted as queued, quarantined delivery ids
--     (bounded, most recent 50) listed as the reconciliation task set.
--     reconciliation_work_items (0001) carries no channel_id column at
--     all (checked directly against its own baseline definition) -- no
--     join to it is invented here; the reconciliation figures in this
--     report come from event_outbox_deliveries.status alone, which IS
--     channel-scoped via alert_events.
--
-- Explicitly NOT built here, and why -- three different reasons, kept
-- distinct rather than flattened into one "out of scope" line:
--   - YouTube VOD metadata writes, Google Sheets export, supporter
--     thank-you POSTING: EXTERNAL DEPENDENCY (a video platform API, a
--     spreadsheet API, a social/chat posting call) this lane does not
--     have and must not stub as though it existed. vod_title and
--     vod_description prepared-item kinds are likewise not built: S5.5's
--     "Suggest VOD title cleanup, description blocks" is a CONTENT-
--     GENERATION step (drafting new text), a different dependency this
--     task does not assign and this migration does not fabricate a
--     placeholder for.
--   - sponsor exposure log: S5.5 asks for "sponsor exposure log with
--     timestamps and caveats"; public.sponsor_cards (0145) carries no
--     display/impression/exposure timestamp column of any kind (checked
--     directly against its own definition) -- there is no source data in
--     this schema to derive an exposure log FROM. Not an external
--     dependency; a genuinely missing upstream fact this migration does
--     not invent.
--   - supporter thank-you TEXT: "prepared" here means a factual count
--     shell only (distinct-supporter count in the window, no names, no
--     amounts, matching S5.4's "never public spend amount by default"
--     even though this record is private) -- drafting the actual thank-
--     you wording is the same content-generation dependency as vod_title
--     above, left to the creator.
--
-- Enforcement precedent reused, not re-invented: migration 0158
-- (goal_trigger_actions) makes "prepare, not fire" for an outbound/public
-- action STRUCTURAL via a CHECK constraint that calls an IMMUTABLE,
-- action-type-only classification function -- "a CHECK CONSTRAINT ... is
-- what make[s] GOA-20 and GOA-21 structural ... There is no column, flag
-- or API field anywhere in this schema through which an outbound_or_
-- public action could be stored with fire_mode = 'fire'". This migration
-- reuses the exact same shape for companion_wrap_prepared_items:
-- app_private.wrap_stream_item_class(item_kind), IMMUTABLE, and a CHECK
-- constraint on the table referencing it. No write path in this
-- migration ever passes fire_mode = 'fire' for anything -- every insert
-- is hardcoded to 'prepare' -- and the CHECK constraint means no future
-- or direct-SQL write can flip an outbound item to 'fire' either.
--
-- ============================================================
-- NEVER TOUCHES.
-- ============================================================
-- apps/api/src/routes/companion.ts, goals.ts, goal-triggers.ts (owned by
-- other lanes). contracts/openapi/v1.yaml's CompanionState/
-- CompanionActionSlot/CompanionActionRequest schemas (lane A). No
-- existing table is altered. No existing function is replaced. Migration
-- numbers 0159/0160 and this migration's own sibling lanes' fixture
-- ranges are untouched.

-- =====================================================================
-- 1. CMP-22 -- companion_stream_markers.
-- =====================================================================
create table public.companion_stream_markers (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id),
  actor_user_id uuid not null references public.app_users(id),

  -- S5.2's own examples: "great clutch" (free-form note), "sponsor
  -- mention", "clip this", "technical issue". A closed set covering all
  -- four, plus a general 'note' catch-all for free text like "great
  -- clutch" that names no specific category -- not an open enum, so a
  -- new marker type is a reviewable migration, not silent drift.
  marker_type text not null default 'note'
    check (marker_type in ('note', 'clip_moment', 'sponsor_mention', 'technical_issue')),

  -- The creator-authored short text itself. Bound reused from the
  -- existing donor-message/original_text precedent (0006:36, 0151:9),
  -- not invented here.
  label text not null check (char_length(label) between 1 and 500),

  -- S5.5: "must carry a timestamp usable for that [chapter derivation]".
  -- Defaults to insert time but is caller-overridable for the real
  -- in-stream moment.
  marker_at timestamptz not null default current_timestamp,

  -- Soft delete only -- CMP-94's reversible set needs a live existence
  -- check, and this table follows the same "status marker, never a
  -- delete" posture 0073's admin_discard_delivery comment states for
  -- event_outbox_deliveries.
  deleted_at timestamptz,
  deleted_by_user_id uuid references public.app_users(id),

  created_at timestamptz not null default current_timestamp
);

comment on table public.companion_stream_markers is
  'CMP-22 (migration 0161). Creator-authored quick notes/stream markers from the Live Deck (S5.2). marker_at is the usable-for-chapters moment (S5.5). deleted_at is a soft delete, never a physical delete, so CMP-94 Recent Actions can compute "is this create still reversible" from live state. No cap/retention column exists here by design -- see this migration header for the capability-control-plane cap mechanism and why no default is invented.';

create index companion_stream_markers_channel_active_idx
  on public.companion_stream_markers (channel_id, marker_at)
  where deleted_at is null;

alter table public.companion_stream_markers enable row level security;
revoke all on public.companion_stream_markers from public;
revoke all on public.companion_stream_markers from bsa_app;

-- =====================================================================
-- 2. CMP-22 -- the capability-control-plane cap read. Unset (no
--    registry row, or no `maxActiveMarkers` key inside `limits`) means
--    no cap -- today's behaviour, never a guessed number.
-- =====================================================================
create or replace function app_private.companion_stream_marker_cap(target_channel_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select nullif(reg.limits ->> 'maxActiveMarkers', '')::integer
    from public.capability_registry reg
   where reg.capability_key = 'companion_stream_marker'
$$;

revoke execute on function app_private.companion_stream_marker_cap(uuid) from public;
grant execute on function app_private.companion_stream_marker_cap(uuid) to bsa_app;

-- =====================================================================
-- 3. CMP-22 -- create. Role set matches every other Companion write in
--    this schema (owner/admin/operator/moderator -- never viewer).
-- =====================================================================
create or replace function app_private.create_companion_stream_marker(
  target_channel_id uuid,
  target_actor_user_id uuid,
  target_label text,
  target_marker_type text default 'note',
  target_marker_at timestamptz default null
)
returns table (
  marker_id uuid,
  marker_type text,
  label text,
  marker_at timestamptz,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
  effective_marker_at timestamptz;
  active_count integer;
  cap integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'not authorized to add a stream marker on this channel' using errcode = '42501';
  end if;

  if target_label is null or char_length(target_label) < 1 or char_length(target_label) > 500 then
    raise exception 'label must be between 1 and 500 characters' using errcode = '22023';
  end if;
  if target_marker_type not in ('note', 'clip_moment', 'sponsor_mention', 'technical_issue') then
    raise exception 'invalid marker_type' using errcode = '22023';
  end if;

  cap := app_private.companion_stream_marker_cap(target_channel_id);
  if cap is not null then
    select count(*) into active_count
      from public.companion_stream_markers m
     where m.channel_id = target_channel_id and m.deleted_at is null;
    if active_count >= cap then
      raise exception 'stream marker cap reached for this channel' using errcode = '22023';
    end if;
  end if;

  effective_marker_at := coalesce(target_marker_at, current_timestamp);

  insert into public.companion_stream_markers (id, channel_id, actor_user_id, marker_type, label, marker_at, created_at)
  values (gen_random_uuid(), target_channel_id, target_actor_user_id, target_marker_type, target_label, effective_marker_at, current_timestamp)
  returning id into new_id;

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  values (
    gen_random_uuid(), target_channel_id, target_actor_user_id, 'companion.stream_marker.create', 'companion_stream_marker', new_id::text,
    jsonb_build_object('markerType', target_marker_type, 'label', left(target_label, 200)), current_timestamp
  );

  return query
    select m.id, m.marker_type, m.label, m.marker_at, m.created_at
      from public.companion_stream_markers m
     where m.id = new_id;
end
$$;

revoke execute on function app_private.create_companion_stream_marker(uuid, uuid, text, text, timestamptz) from public;
grant execute on function app_private.create_companion_stream_marker(uuid, uuid, text, text, timestamptz) to bsa_app;

-- =====================================================================
-- 4. CMP-22 -- delete/retract. This IS the CMP-94 inverse operation for
--    'companion.stream_marker.create'.
-- =====================================================================
create or replace function app_private.delete_companion_stream_marker(
  target_channel_id uuid,
  target_actor_user_id uuid,
  target_marker_id uuid
)
returns table (
  marker_id uuid,
  deleted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.companion_stream_markers%rowtype;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    raise exception 'not authorized to remove a stream marker on this channel' using errcode = '42501';
  end if;

  select * into current_row
    from public.companion_stream_markers m
   where m.id = target_marker_id and m.channel_id = target_channel_id
   for update;

  if not found then
    raise exception 'stream marker not found' using errcode = 'P0002';
  end if;
  if current_row.deleted_at is not null then
    raise exception 'stream marker already removed' using errcode = '22023';
  end if;

  update public.companion_stream_markers
     set deleted_at = current_timestamp, deleted_by_user_id = target_actor_user_id
   where id = target_marker_id
  returning id, companion_stream_markers.deleted_at into marker_id, deleted_at;

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  values (
    gen_random_uuid(), target_channel_id, target_actor_user_id, 'companion.stream_marker.delete', 'companion_stream_marker', target_marker_id::text,
    '{}'::jsonb, current_timestamp
  );

  return query select marker_id, deleted_at;
end
$$;

revoke execute on function app_private.delete_companion_stream_marker(uuid, uuid, uuid) from public;
grant execute on function app_private.delete_companion_stream_marker(uuid, uuid, uuid) to bsa_app;

-- =====================================================================
-- 5. CMP-22 -- list (Live Deck read + Wrap Stream chapter source).
-- =====================================================================
create or replace function app_private.list_companion_stream_markers(
  target_channel_id uuid,
  target_since timestamptz default null,
  target_until timestamptz default null
)
returns table (
  marker_id uuid,
  marker_type text,
  label text,
  marker_at timestamptz,
  actor_user_id uuid,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    return;
  end if;

  return query
    select m.id, m.marker_type, m.label, m.marker_at, m.actor_user_id, m.created_at
      from public.companion_stream_markers m
     where m.channel_id = target_channel_id
       and m.deleted_at is null
       and (target_since is null or m.marker_at >= target_since)
       and (target_until is null or m.marker_at <= target_until)
     order by m.marker_at asc;
end
$$;

revoke execute on function app_private.list_companion_stream_markers(uuid, timestamptz, timestamptz) from public;
grant execute on function app_private.list_companion_stream_markers(uuid, timestamptz, timestamptz) to bsa_app;

-- =====================================================================
-- 6. CMP-94 -- action category, IMMUTABLE, fail-closed default.
-- =====================================================================
create or replace function app_private.companion_action_category(target_action text)
returns text
language sql
immutable
as $$
  select case target_action
    when 'companion.stream_marker.create' then 'operational'
    when 'companion.stream_marker.delete' then 'operational'
    when 'admin.dlq.replay' then 'operational'
    when 'admin.dlq.discard' then 'operational'
    when 'admin.entitlement.override' then 'financial'
    else 'financial'
  end
$$;

revoke execute on function app_private.companion_action_category(text) from public;
grant execute on function app_private.companion_action_category(text) to public;
grant execute on function app_private.companion_action_category(text) to bsa_app;

-- =====================================================================
-- 7. CMP-94 -- Recent Actions projection. Returns-table shape carries no
--    amount/currency column, by construction -- see this migration's
--    header for why that is the structural half of role-scoping.
-- =====================================================================
create or replace function app_private.get_companion_recent_actions(
  target_channel_id uuid,
  target_limit integer default 20
)
returns table (
  action_id uuid,
  action text,
  category text,
  target_type text,
  target_id text,
  actor_user_id uuid,
  occurred_at timestamptz,
  reversible boolean,
  reason text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  is_privileged boolean;
  effective_limit integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator']::text[]) then
    return;
  end if;
  is_privileged := app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]);

  -- S7.5's own Activity Log bound ("virtualised past 50 rows") reused
  -- verbatim as this projection's ceiling -- not a new number chosen
  -- here.
  effective_limit := least(greatest(coalesce(target_limit, 20), 1), 50);

  return query
    select
      e.id,
      e.action,
      app_private.companion_action_category(e.action),
      e.target_type,
      e.target_id,
      e.actor_user_id,
      e.created_at,
      (
        e.action = 'companion.stream_marker.create'
        and exists (
          select 1 from public.companion_stream_markers m
           where m.id::text = e.target_id and m.deleted_at is null
        )
      ) as reversible,
      nullif(e.metadata ->> 'reason', '')
    from public.audit_events e
   where e.channel_id = target_channel_id
     and (is_privileged or app_private.companion_action_category(e.action) = 'operational')
   order by e.created_at desc
   limit effective_limit;
end
$$;

revoke execute on function app_private.get_companion_recent_actions(uuid, integer) from public;
grant execute on function app_private.get_companion_recent_actions(uuid, integer) to bsa_app;

-- =====================================================================
-- 8. CMP-30 -- wrap-stream session: the confirm-stop state machine and
--    the persisted private summary.
-- =====================================================================
create table public.companion_stream_wrap_sessions (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id),
  initiated_by_user_id uuid not null references public.app_users(id),

  status text not null default 'confirming_stop'
    check (status in ('confirming_stop', 'stop_confirmed', 'summary_ready')),

  -- Caller-confirmed, never server-verified -- see this migration's
  -- header for why the server does not itself reach into OBS or a video
  -- platform.
  obs_stopped_confirmed boolean not null default false,
  broadcast_complete_confirmed boolean not null default false,
  confirmed_stop_at timestamptz,

  window_since timestamptz,
  window_until timestamptz,
  summary jsonb,

  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

comment on table public.companion_stream_wrap_sessions is
  'CMP-30 (migration 0161). One row per Wrap Stream attempt (S5.5). status is a forward-only state machine: confirming_stop -> stop_confirmed -> summary_ready. summary is a derived jsonb snapshot (window boundaries, marker/moderation/alert counts) -- a report artifact, not a competing source of truth; every figure inside it is re-derivable from alert_events/event_outbox_deliveries/companion_stream_markers at any time.';

create index companion_stream_wrap_sessions_channel_idx
  on public.companion_stream_wrap_sessions (channel_id, created_at desc);

alter table public.companion_stream_wrap_sessions enable row level security;
revoke all on public.companion_stream_wrap_sessions from public;
revoke all on public.companion_stream_wrap_sessions from bsa_app;

-- =====================================================================
-- 9. CMP-30 -- prepared items. "Prepare, not auto-post" made structural
--    the same way 0158 makes GOA-21 structural: an IMMUTABLE
--    classification function plus a CHECK constraint on the table that
--    calls it. No write path in this migration ever inserts fire_mode =
--    'fire'; the CHECK constraint additionally makes it impossible for
--    any future or direct-SQL write to do so for an outbound/public
--    item either.
-- =====================================================================
create or replace function app_private.wrap_stream_item_class(target_item_kind text)
returns text
language sql
immutable
as $$
  select case target_item_kind
    when 'vod_chapters' then 'outbound_or_public'
    when 'supporter_thankyou_comment' then 'outbound_or_public'
    when 'finance_delta_summary' then 'local'
    when 'followup_clip_review_task' then 'local'
    else null
  end
$$;

revoke execute on function app_private.wrap_stream_item_class(text) from public;
grant execute on function app_private.wrap_stream_item_class(text) to public;
grant execute on function app_private.wrap_stream_item_class(text) to bsa_app;

create table public.companion_wrap_prepared_items (
  id uuid primary key default gen_random_uuid(),
  wrap_session_id uuid not null references public.companion_stream_wrap_sessions(id),
  channel_id uuid not null references public.channels(id),

  -- Closed set: exactly the S5.5 deliverables this lane builds. vod_title/
  -- vod_description (content generation) and sponsor_exposure_log (no
  -- source data -- see this migration's header) are deliberately absent,
  -- not silently representable via a free-text kind.
  item_kind text not null check (item_kind in (
    'vod_chapters', 'supporter_thankyou_comment', 'finance_delta_summary', 'followup_clip_review_task'
  )),

  fire_mode text not null default 'prepare' check (fire_mode in ('prepare', 'fire')),
  content jsonb not null,

  created_at timestamptz not null default current_timestamp,

  -- CMP-30 structural guarantee: an outbound/public item can never be
  -- stored with fire_mode = 'fire'. See section 9's header comment.
  check (app_private.wrap_stream_item_class(item_kind) <> 'outbound_or_public' or fire_mode = 'prepare')
);

comment on column public.companion_wrap_prepared_items.fire_mode is
  'CMP-30, GOA-21-style structural guarantee (0158 precedent). Every write in this migration hardcodes prepare; the CHECK constraint on this table makes an outbound_or_public item + fire_mode=fire impossible regardless of caller.';

create index companion_wrap_prepared_items_session_idx
  on public.companion_wrap_prepared_items (wrap_session_id);

alter table public.companion_wrap_prepared_items enable row level security;
revoke all on public.companion_wrap_prepared_items from public;
revoke all on public.companion_wrap_prepared_items from bsa_app;

-- =====================================================================
-- 10. CMP-30 -- begin. Owner/admin only: matches S5.1's posture that
--     ending a broadcast is an irreversible, explicitly-confirmed action,
--     not an operator/moderator-level control.
-- =====================================================================
create or replace function app_private.begin_companion_stream_wrap(
  target_channel_id uuid,
  target_actor_user_id uuid
)
returns table (
  wrap_session_id uuid,
  status text,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  existing_id uuid;
  existing_status text;
  existing_created_at timestamptz;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to begin Wrap Stream on this channel' using errcode = '42501';
  end if;

  -- Idempotent: a second tap while one is already in flight returns the
  -- existing attempt rather than creating a duplicate wrap session.
  select w.id, w.status, w.created_at into existing_id, existing_status, existing_created_at
    from public.companion_stream_wrap_sessions w
   where w.channel_id = target_channel_id and w.status <> 'summary_ready'
   order by w.created_at desc
   limit 1;

  if found then
    return query select existing_id, existing_status, existing_created_at;
    return;
  end if;

  new_id := gen_random_uuid();
  insert into public.companion_stream_wrap_sessions (id, channel_id, initiated_by_user_id, status, created_at, updated_at)
  values (new_id, target_channel_id, target_actor_user_id, 'confirming_stop', current_timestamp, current_timestamp);

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  values (gen_random_uuid(), target_channel_id, target_actor_user_id, 'companion.wrap_stream.begin', 'companion_stream_wrap_session', new_id::text, '{}'::jsonb, current_timestamp);

  return query select w.id, w.status, w.created_at from public.companion_stream_wrap_sessions w where w.id = new_id;
end
$$;

revoke execute on function app_private.begin_companion_stream_wrap(uuid, uuid) from public;
grant execute on function app_private.begin_companion_stream_wrap(uuid, uuid) to bsa_app;

-- =====================================================================
-- 11. CMP-30 -- confirm-stop. NOT in the CMP-94 reversible set -- ending
--     a broadcast is an irreversible, explicitly-confirmed action (S5.1),
--     and this migration adds no un-confirm function.
-- =====================================================================
create or replace function app_private.confirm_companion_stream_stop(
  target_channel_id uuid,
  target_actor_user_id uuid,
  target_wrap_session_id uuid,
  target_obs_stopped_confirmed boolean,
  target_broadcast_complete_confirmed boolean
)
returns table (
  wrap_session_id uuid,
  status text,
  confirmed_stop_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.companion_stream_wrap_sessions%rowtype;
  next_status text;
  next_confirmed_stop_at timestamptz;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to confirm stream stop on this channel' using errcode = '42501';
  end if;

  select * into current_row
    from public.companion_stream_wrap_sessions w
   where w.id = target_wrap_session_id and w.channel_id = target_channel_id
   for update;

  if not found then
    raise exception 'wrap session not found' using errcode = 'P0002';
  end if;
  if current_row.status = 'summary_ready' then
    raise exception 'wrap session already completed' using errcode = '22023';
  end if;

  if target_obs_stopped_confirmed and target_broadcast_complete_confirmed then
    next_status := 'stop_confirmed';
    next_confirmed_stop_at := coalesce(current_row.confirmed_stop_at, current_timestamp);
  else
    next_status := 'confirming_stop';
    next_confirmed_stop_at := current_row.confirmed_stop_at;
  end if;

  update public.companion_stream_wrap_sessions
     set obs_stopped_confirmed = target_obs_stopped_confirmed,
         broadcast_complete_confirmed = target_broadcast_complete_confirmed,
         status = next_status,
         confirmed_stop_at = next_confirmed_stop_at,
         updated_at = current_timestamp
   where id = target_wrap_session_id;

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  values (
    gen_random_uuid(), target_channel_id, target_actor_user_id, 'companion.wrap_stream.confirm_stop', 'companion_stream_wrap_session', target_wrap_session_id::text,
    jsonb_build_object('obsStoppedConfirmed', target_obs_stopped_confirmed, 'broadcastCompleteConfirmed', target_broadcast_complete_confirmed), current_timestamp
  );

  return query select target_wrap_session_id, next_status, next_confirmed_stop_at;
end
$$;

revoke execute on function app_private.confirm_companion_stream_stop(uuid, uuid, uuid, boolean, boolean) from public;
grant execute on function app_private.confirm_companion_stream_stop(uuid, uuid, uuid, boolean, boolean) to bsa_app;

-- =====================================================================
-- 12. CMP-30 -- generate summary. Gated on stop_confirmed. Pure
--     derivation: window_since is the previous wrap session's
--     confirmed_stop_at for this channel (a real, derivable boundary --
--     "since we last wrapped a stream"), falling back to the channel's
--     own created_at for a channel's first-ever wrap. No arbitrary
--     window length (e.g. "last 12 hours") is invented.
-- =====================================================================
create or replace function app_private.generate_companion_stream_wrap_summary(
  target_channel_id uuid,
  target_actor_user_id uuid,
  target_wrap_session_id uuid
)
returns table (
  wrap_session_id uuid,
  status text,
  window_since timestamptz,
  window_until timestamptz,
  summary jsonb
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_row public.companion_stream_wrap_sessions%rowtype;
  since_ts timestamptz;
  until_ts timestamptz;
  marker_count integer;
  moderation_action_count integer;
  delivered_count integer;
  missed_or_failed_count integer;
  queued_count integer;
  quarantined_ids uuid[];
  supporter_count integer;
  payments_total_paise bigint;
  refunds_total_paise bigint;
  computed_summary jsonb;
  chapters jsonb;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to generate a Wrap Stream summary on this channel' using errcode = '42501';
  end if;

  select * into current_row
    from public.companion_stream_wrap_sessions w
   where w.id = target_wrap_session_id and w.channel_id = target_channel_id
   for update;

  if not found then
    raise exception 'wrap session not found' using errcode = 'P0002';
  end if;
  if current_row.status <> 'stop_confirmed' then
    raise exception 'wrap session must have a confirmed stop before generating a summary' using errcode = '22023';
  end if;

  until_ts := coalesce(current_row.confirmed_stop_at, current_timestamp);

  select w.confirmed_stop_at into since_ts
    from public.companion_stream_wrap_sessions w
   where w.channel_id = target_channel_id
     and w.id <> target_wrap_session_id
     and w.confirmed_stop_at is not null
   order by w.confirmed_stop_at desc
   limit 1;

  if since_ts is null then
    select c.created_at into since_ts from public.channels c where c.id = target_channel_id;
  end if;

  select count(*) into marker_count
    from public.companion_stream_markers m
   where m.channel_id = target_channel_id and m.deleted_at is null
     and m.marker_at >= since_ts and m.marker_at <= until_ts;

  select count(*) into moderation_action_count
    from public.audit_events e
   where e.channel_id = target_channel_id
     and app_private.companion_action_category(e.action) = 'operational'
     and e.created_at >= since_ts and e.created_at <= until_ts;

  select
    count(*) filter (where d.status = 'displayed' or d.status = 'acknowledged'),
    count(*) filter (where d.status in ('failed_retriable', 'quarantined')),
    count(*) filter (where d.status in ('pending', 'ready', 'held')),
    array_agg(d.id) filter (where d.status = 'quarantined')
    into delivered_count, missed_or_failed_count, queued_count, quarantined_ids
    from public.event_outbox_deliveries d
    join public.alert_events ev on ev.id = d.event_id
   where ev.channel_id = target_channel_id
     and d.created_at >= since_ts and d.created_at <= until_ts;

  select count(distinct p.id) into supporter_count
    from public.payments p
   where p.channel_id = target_channel_id and p.status = 'captured'
     and p.created_at >= since_ts and p.created_at <= until_ts;

  select coalesce(sum(p.gross_amount_paise), 0) into payments_total_paise
    from public.payments p
   where p.channel_id = target_channel_id and p.status in ('captured', 'partially_refunded', 'refunded')
     and p.created_at >= since_ts and p.created_at <= until_ts;

  select coalesce(sum(r.amount_paise), 0) into refunds_total_paise
    from public.refunds r
    join public.payments p on p.id = r.payment_id
   where p.channel_id = target_channel_id
     and r.created_at >= since_ts and r.created_at <= until_ts;

  computed_summary := jsonb_build_object(
    'windowSince', since_ts, 'windowUntil', until_ts,
    'markerCount', marker_count, 'moderationActionCount', moderation_action_count,
    'alerts', jsonb_build_object('delivered', delivered_count, 'missedOrFailed', missed_or_failed_count, 'queued', queued_count),
    'reconciliation', jsonb_build_object('quarantinedDeliveryIds', coalesce(to_jsonb(quarantined_ids), '[]'::jsonb))
  );

  update public.companion_stream_wrap_sessions
     set status = 'summary_ready', window_since = since_ts, window_until = until_ts, summary = computed_summary, updated_at = current_timestamp
   where id = target_wrap_session_id;

  -- Prepared items -- every insert hardcodes fire_mode = 'prepare'. See
  -- section 9's header for the structural guarantee behind this.
  select coalesce(jsonb_agg(jsonb_build_object(
           'markerId', m.id, 'label', m.label, 'markerType', m.marker_type,
           'offsetSeconds', floor(extract(epoch from (m.marker_at - since_ts)))
         ) order by m.marker_at asc), '[]'::jsonb)
    into chapters
    from public.companion_stream_markers m
   where m.channel_id = target_channel_id and m.deleted_at is null
     and m.marker_at >= since_ts and m.marker_at <= until_ts;

  insert into public.companion_wrap_prepared_items (id, wrap_session_id, channel_id, item_kind, fire_mode, content, created_at)
  values
    (gen_random_uuid(), target_wrap_session_id, target_channel_id, 'vod_chapters', 'prepare', chapters, current_timestamp),
    (gen_random_uuid(), target_wrap_session_id, target_channel_id, 'supporter_thankyou_comment', 'prepare', jsonb_build_object('supporterCount', supporter_count), current_timestamp),
    (gen_random_uuid(), target_wrap_session_id, target_channel_id, 'finance_delta_summary', 'prepare',
      jsonb_build_object('grossPaise', payments_total_paise, 'refundedPaise', refunds_total_paise, 'netPaise', payments_total_paise - refunds_total_paise), current_timestamp),
    (gen_random_uuid(), target_wrap_session_id, target_channel_id, 'followup_clip_review_task', 'prepare',
      jsonb_build_object('status', 'pending_review', 'windowSince', since_ts, 'windowUntil', until_ts), current_timestamp);

  insert into public.audit_events (id, channel_id, actor_user_id, action, target_type, target_id, metadata, created_at)
  values (gen_random_uuid(), target_channel_id, target_actor_user_id, 'companion.wrap_stream.summary_ready', 'companion_stream_wrap_session', target_wrap_session_id::text, '{}'::jsonb, current_timestamp);

  return query select target_wrap_session_id, 'summary_ready'::text, since_ts, until_ts, computed_summary;
end
$$;

revoke execute on function app_private.generate_companion_stream_wrap_summary(uuid, uuid, uuid) from public;
grant execute on function app_private.generate_companion_stream_wrap_summary(uuid, uuid, uuid) to bsa_app;

-- =====================================================================
-- 13. CMP-30 -- read (wrap session + its prepared items, for the
--     Companion client to render/approve before any human-driven
--     external posting -- which stays entirely outside this migration).
-- =====================================================================
create or replace function app_private.get_companion_stream_wrap_session(
  target_channel_id uuid,
  target_wrap_session_id uuid
)
returns table (
  wrap_session_id uuid,
  status text,
  obs_stopped_confirmed boolean,
  broadcast_complete_confirmed boolean,
  confirmed_stop_at timestamptz,
  window_since timestamptz,
  window_until timestamptz,
  summary jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    return;
  end if;

  return query
    select w.id, w.status, w.obs_stopped_confirmed, w.broadcast_complete_confirmed, w.confirmed_stop_at,
           w.window_since, w.window_until, w.summary, w.created_at, w.updated_at
      from public.companion_stream_wrap_sessions w
     where w.id = target_wrap_session_id and w.channel_id = target_channel_id;
end
$$;

revoke execute on function app_private.get_companion_stream_wrap_session(uuid, uuid) from public;
grant execute on function app_private.get_companion_stream_wrap_session(uuid, uuid) to bsa_app;

create or replace function app_private.list_companion_wrap_prepared_items(
  target_channel_id uuid,
  target_wrap_session_id uuid
)
returns table (
  item_id uuid,
  item_kind text,
  fire_mode text,
  content jsonb,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    return;
  end if;

  return query
    select i.id, i.item_kind, i.fire_mode, i.content, i.created_at
      from public.companion_wrap_prepared_items i
     where i.wrap_session_id = target_wrap_session_id and i.channel_id = target_channel_id
     order by i.created_at asc;
end
$$;

revoke execute on function app_private.list_companion_wrap_prepared_items(uuid, uuid) from public;
grant execute on function app_private.list_companion_wrap_prepared_items(uuid, uuid) to bsa_app;
