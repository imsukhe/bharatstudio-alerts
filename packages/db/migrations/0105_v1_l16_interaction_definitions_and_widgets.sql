-- L16 (reconciled 2026-09-07): the interaction-menu catalogue, generic
-- widget configuration, support votes, hype mode, and a privacy-safe
-- leaderboard. Migration 0102 shipped only support_goals and the goal
-- widget; this migration ships the rest of L16's Part 6/7 scope. Depends
-- on 0001-0104 (in particular 0102's support_goals and 0084's
-- creator_supporter_relations/payments.viewer_identity_id). Modifies no
-- existing table — see the Rollback note at the bottom of this header.
--
-- SCOPE BOUNDARY, STATED PLAINLY: the only existing path that creates a
-- real Razorpay order (apps/api/src/routes/public.ts's
-- POST /v1/public/channels/:handle/tips/orders) is owned by another lane
-- and out of bounds for this task. It has no field to tag an order with an
-- interaction_definition_id or a vote option_key. That closes off the one
-- design that would let a *specific* payment be attributed to a specific
-- vote option without touching a forbidden file. Two features are shaped
-- around that constraint rather than around the DESIGN RULES' "financial
-- must derive from real payments" ideal followed everywhere it is actually
-- reachable:
--   * support votes are a plain per-voter tally (one vote per
--     voter_fingerprint per poll) — not money-gated. Upgrading to a
--     paid-vote model needs routes/public.ts (and payment-order-client.ts)
--     to accept an interaction tag on the order body; that is out of this
--     migration's ownership boundary and is recorded under "Remaining
--     open" in the delivery report, not silently designed around.
--   * hype mode NEEDS no such per-option tagging — a hype meter is just
--     "how much has this channel been tipped, recently", which needs
--     nothing but channel_id + created_at on public.payments, already
--     readable. So hype mode IS fully money-derived, following 0102's
--     exact live-sum-minus-refunds shape. See app_private.hype_mode_state
--     below.
--
-- LEADERBOARD PRIVACY: L14 (0084) built cross-creator isolation and
-- lifetime aggregates (creator_supporter_relations) but explicitly did NOT
-- build the opt-in public-profile column its own task file promises ("Public
-- profiles are opt-in, default-off... NOT built"). Touching 0084 to add
-- that column is out of bounds here (0084 is a final/owned migration). With
-- no opt-in switch to check, the only safe behaviour is to never expose an
-- exact amount from any leaderboard function in this migration, under any
-- configuration — there is no "public" mode to fall into by mistake. Every
-- leaderboard row carries a rank and a coarse tier bucket only, computed
-- from public.payments/public.refunds (read-only join, same rule as 0102),
-- always scoped to exactly one channel_id.
--
-- ENTITLEMENT: two new hidden per-tier limits
-- (tier_interaction_definition_limit, tier_widget_count_limit) follow
-- tier_goal_count_limit's exact shape from 0102 — computed live at
-- creation time, never merged into channel_entitlement_versions.values.
-- This is not a ninth public entitlement dimension.
--
-- ROLLBACK: every table here is additive. None alters payments, refunds,
-- alert_events, support_goals, or any queue table — only read-only joins
-- against payments/refunds (interaction_definitions/hype/leaderboard) and
-- against support_goals (the community_goal config reference, validated,
-- never written). Feature-flagging this off does not touch tip/TTS-tip
-- flows, which predate L16. No production migration without separate
-- explicit approval, per the task's Definition gate.

-- =========================================================================
-- interaction_definitions: the per-channel catalogue.
-- =========================================================================
create table public.interaction_definitions (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  interaction_type text not null check (interaction_type in (
    'tip', 'tts_tip', 'sticker', 'mega_alert', 'priority_question',
    'support_vote', 'community_goal', 'hype_mode'
  )),
  label text not null check (char_length(label) between 1 and 120),
  -- Fixed/minimum amount for the money-tied types (tip, tts_tip, sticker,
  -- mega_alert, priority_question). Null for support_vote/hype_mode (their
  -- money shape, if any, lives elsewhere per the header) and for
  -- community_goal (the amount lives on the referenced support_goals row).
  amount_paise bigint check (amount_paise is null or amount_paise >= 1000),
  queue_id uuid not null references public.alert_queues(id),
  tts_enabled boolean not null default false,
  moderation_rule text not null default 'review' check (moderation_rule in ('none', 'review', 'block_list')),
  visual jsonb not null default '{}'::jsonb,
  -- Type-specific shape, validated in app_private.create_interaction_definition:
  --   community_goal -> {"goalId": "<uuid of a support_goals row on this channel>"}
  --   hype_mode      -> {"thresholdPaise": <int >= 1000>, "decaySeconds": <int 30-3600>}
  --   everything else -> {} (support_vote's options live in interaction_vote_options)
  config jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  -- Generic "closed" marker, meaningful for support_vote (resolution) and
  -- hype_mode (explicit early end) — see close_interaction_definition.
  closed_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index interaction_definitions_channel_idx on public.interaction_definitions (channel_id) where closed_at is null;

alter table public.interaction_definitions enable row level security;
revoke all on public.interaction_definitions from public;
revoke all on public.interaction_definitions from bsa_app;

-- =========================================================================
-- Support-vote options and per-voter tally records. Free (not money-gated)
-- — see header. One row per (definition, voter_fingerprint): a second cast
-- from the same voter is silently a no-op (on conflict do nothing), never
-- an error a client has to special-case.
-- =========================================================================
create table public.interaction_vote_options (
  id uuid primary key,
  interaction_definition_id uuid not null references public.interaction_definitions(id),
  option_key text not null check (option_key ~ '^[a-z0-9_-]{1,40}$'),
  label text not null check (char_length(label) between 1 and 120),
  created_at timestamptz not null default current_timestamp,
  unique (interaction_definition_id, option_key)
);

alter table public.interaction_vote_options enable row level security;
revoke all on public.interaction_vote_options from public;
revoke all on public.interaction_vote_options from bsa_app;

create table public.interaction_vote_records (
  id uuid primary key,
  interaction_definition_id uuid not null references public.interaction_definitions(id),
  option_key text not null,
  -- Opaque client-supplied dedupe key (a stored anonymous id, or a signed-in
  -- viewer's identity id as text) — this migration does not mint or verify
  -- identity, only prevents one voter from being counted twice per poll.
  voter_fingerprint text not null check (char_length(voter_fingerprint) between 8 and 128),
  created_at timestamptz not null default current_timestamp,
  unique (interaction_definition_id, voter_fingerprint),
  foreign key (interaction_definition_id, option_key) references public.interaction_vote_options (interaction_definition_id, option_key)
);

create index interaction_vote_records_tally_idx on public.interaction_vote_records (interaction_definition_id, option_key);

alter table public.interaction_vote_records enable row level security;
revoke all on public.interaction_vote_records from public;
revoke all on public.interaction_vote_records from bsa_app;

-- =========================================================================
-- Hype mode: a time-boxed activation window. The meter itself is never
-- stored — app_private.hype_mode_state computes it live, exactly like
-- 0102's support_goal_progress_paise, as a decayed sum over real captured
-- payments (minus processed refunds) inside [started_at, least(now, ends_at)].
-- =========================================================================
create table public.hype_mode_activations (
  id uuid primary key,
  interaction_definition_id uuid not null references public.interaction_definitions(id),
  channel_id uuid not null references public.channels(id),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default current_timestamp
);

create index hype_mode_activations_active_idx on public.hype_mode_activations (interaction_definition_id, started_at desc);

alter table public.hype_mode_activations enable row level security;
revoke all on public.hype_mode_activations from public;
revoke all on public.hype_mode_activations from bsa_app;

-- =========================================================================
-- widget_configs: per-channel widget placement/style/data-source, so a
-- creator can run more than the single hardcoded goal widget. This table
-- stores CONFIGURATION only — it does not add a delivery mechanism.
-- Existing widget types (main_alert, support_goal) keep their existing
-- rendering path untouched; a row here for those types is registration
-- (placement/style) only, never a second way to deliver their data.
-- =========================================================================
create table public.widget_configs (
  id uuid primary key,
  channel_id uuid not null references public.channels(id),
  widget_type text not null check (widget_type in (
    'main_alert', 'support_goal', 'recent_tips', 'top_supporters',
    'supporter_ticker', 'public_leaderboard', 'mega_tip_banner'
  )),
  placement jsonb not null default '{}'::jsonb,
  style jsonb not null default '{}'::jsonb,
  -- e.g. {"interactionDefinitionId": "..."} or {"goalId": "..."} or
  -- {"window": "weekly"} for a leaderboard/ticker widget. Validated only
  -- for shape (object), not cross-referenced at write time — a dangling
  -- reference degrades the widget to its empty state at read time (see
  -- the overlay widgets' own "never throw" rule), it never errors here.
  data_source jsonb not null default '{}'::jsonb,
  -- Controls whether an overlay browser source may read this config at
  -- all (see list_overlay_widget_config). Default 'private': dashboard-only
  -- preview, not yet live on stream. This is unrelated to, and does not
  -- override, the leaderboard's separate "never exact amounts" rule above.
  privacy_scope text not null default 'private' check (privacy_scope in ('private', 'public')),
  is_enabled boolean not null default true,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create index widget_configs_channel_idx on public.widget_configs (channel_id) where is_enabled;

alter table public.widget_configs enable row level security;
revoke all on public.widget_configs from public;
revoke all on public.widget_configs from bsa_app;

-- =========================================================================
-- Entitlement: live-computed limits only. Mirrors tier_goal_count_limit
-- (0102) exactly — see that migration's header for why this shape keeps
-- these out of the public entitlement dimension set.
-- =========================================================================
create or replace function app_private.tier_interaction_definition_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 3;
    when 'pro' then return 6;
    when 'creator' then return 8;
    when 'studio' then return 8;
    else raise exception 'unrecognised tier for interaction definition entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_interaction_definition_limit(text) from public;
grant execute on function app_private.tier_interaction_definition_limit(text) to bsa_app;

create or replace function app_private.tier_widget_count_limit(target_tier text)
returns integer
language plpgsql
immutable
as $$
begin
  case target_tier
    when 'free' then return 1;
    when 'pro' then return 3;
    when 'creator' then return 7;
    when 'studio' then return 7;
    else raise exception 'unrecognised tier for widget entitlement: %', target_tier using errcode = '22023';
  end case;
end
$$;

revoke execute on function app_private.tier_widget_count_limit(text) from public;
grant execute on function app_private.tier_widget_count_limit(text) to bsa_app;

-- =========================================================================
-- interaction_definitions CRUD
-- =========================================================================
create or replace function app_private.create_interaction_definition(
  target_channel_id uuid,
  target_interaction_type text,
  target_label text,
  target_amount_paise bigint,
  target_queue_id uuid,
  target_tts_enabled boolean,
  target_moderation_rule text,
  target_visual jsonb,
  target_config jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  active_count integer;
  new_id uuid;
  referenced_goal_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;

  if target_label is null or char_length(target_label) not between 1 and 120
     or target_interaction_type not in ('tip', 'tts_tip', 'sticker', 'mega_alert', 'priority_question', 'support_vote', 'community_goal', 'hype_mode')
     or target_moderation_rule not in ('none', 'review', 'block_list')
     or (target_amount_paise is not null and target_amount_paise < 1000) then
    raise exception 'invalid interaction definition' using errcode = '22023';
  end if;

  perform 1 from public.alert_queues queue
   where queue.id = target_queue_id and queue.channel_id = target_channel_id and queue.closed_at is null;
  if not found then
    raise exception 'invalid interaction definition' using errcode = '22023';
  end if;

  if target_interaction_type = 'community_goal' then
    referenced_goal_id := nullif(target_config->>'goalId', '')::uuid;
    if referenced_goal_id is null then
      raise exception 'invalid interaction definition' using errcode = '22023';
    end if;
    perform 1 from public.support_goals goal where goal.id = referenced_goal_id and goal.channel_id = target_channel_id;
    if not found then
      raise exception 'invalid interaction definition' using errcode = '22023';
    end if;
  end if;

  if target_interaction_type = 'hype_mode' then
    if target_config->>'thresholdPaise' is null
       or (target_config->>'thresholdPaise')::bigint < 1000
       or target_config->>'decaySeconds' is null
       or (target_config->>'decaySeconds')::integer not between 30 and 3600 then
      raise exception 'invalid interaction definition' using errcode = '22023';
    end if;
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;
  if current_tier is null then
    raise exception 'invalid interaction definition' using errcode = '22023';
  end if;

  select count(*) into active_count
    from public.interaction_definitions
   where channel_id = target_channel_id and closed_at is null and is_enabled;
  if active_count >= app_private.tier_interaction_definition_limit(current_tier) then
    raise exception 'interaction definition limit reached for the channel''s current tier' using errcode = '42501';
  end if;

  new_id := gen_random_uuid();
  insert into public.interaction_definitions (
    id, channel_id, interaction_type, label, amount_paise, queue_id, tts_enabled, moderation_rule, visual, config, created_at, updated_at
  ) values (
    new_id, target_channel_id, target_interaction_type, target_label, target_amount_paise, target_queue_id,
    coalesce(target_tts_enabled, false), target_moderation_rule, coalesce(target_visual, '{}'::jsonb), coalesce(target_config, '{}'::jsonb),
    current_timestamp, current_timestamp
  );

  return new_id;
end
$$;

revoke execute on function app_private.create_interaction_definition(uuid, text, text, bigint, uuid, boolean, text, jsonb, jsonb) from public;
grant execute on function app_private.create_interaction_definition(uuid, text, text, bigint, uuid, boolean, text, jsonb, jsonb) to bsa_app;

create or replace function app_private.list_channel_interaction_definitions(target_channel_id uuid)
returns table (
  definition_id uuid, interaction_type text, label text, amount_paise bigint, queue_id uuid,
  tts_enabled boolean, moderation_rule text, visual jsonb, config jsonb, is_enabled boolean,
  closed boolean, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select def.id, def.interaction_type, def.label, def.amount_paise, def.queue_id,
         def.tts_enabled, def.moderation_rule, def.visual, def.config, def.is_enabled,
         def.closed_at is not null, def.created_at, def.updated_at
    from public.interaction_definitions def
   where def.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by def.created_at desc
$$;

revoke execute on function app_private.list_channel_interaction_definitions(uuid) from public;
grant execute on function app_private.list_channel_interaction_definitions(uuid) to bsa_app;

create or replace function app_private.update_interaction_definition(
  target_channel_id uuid,
  target_definition_id uuid,
  target_label text,
  target_amount_paise bigint,
  target_tts_enabled boolean,
  target_moderation_rule text,
  target_visual jsonb,
  target_is_enabled boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;

  select * into def from public.interaction_definitions where id = target_definition_id and channel_id = target_channel_id;
  if not found then
    raise exception 'interaction definition not found' using errcode = 'P0002';
  end if;

  if target_label is not null and char_length(target_label) not between 1 and 120 then
    raise exception 'invalid interaction definition' using errcode = '22023';
  end if;
  if target_amount_paise is not null and target_amount_paise < 1000 then
    raise exception 'invalid interaction definition' using errcode = '22023';
  end if;
  if target_moderation_rule is not null and target_moderation_rule not in ('none', 'review', 'block_list') then
    raise exception 'invalid interaction definition' using errcode = '22023';
  end if;

  update public.interaction_definitions
     set label = coalesce(target_label, label),
         amount_paise = coalesce(target_amount_paise, amount_paise),
         tts_enabled = coalesce(target_tts_enabled, tts_enabled),
         moderation_rule = coalesce(target_moderation_rule, moderation_rule),
         visual = coalesce(target_visual, visual),
         is_enabled = coalesce(target_is_enabled, is_enabled),
         updated_at = current_timestamp
   where id = target_definition_id;
end
$$;

revoke execute on function app_private.update_interaction_definition(uuid, uuid, text, bigint, boolean, text, jsonb, boolean) from public;
grant execute on function app_private.update_interaction_definition(uuid, uuid, text, bigint, boolean, text, jsonb, boolean) to bsa_app;

-- Generic close — resolution marker for support_vote, early end for
-- hype_mode. Idempotent (a second call on an already-closed row is a
-- no-op), same shape as 0102's end_support_goal.
create or replace function app_private.close_interaction_definition(target_channel_id uuid, target_definition_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;

  select * into def from public.interaction_definitions where id = target_definition_id and channel_id = target_channel_id;
  if not found then
    raise exception 'interaction definition not found' using errcode = 'P0002';
  end if;

  if def.closed_at is null then
    update public.interaction_definitions set closed_at = current_timestamp, updated_at = current_timestamp where id = target_definition_id;
  end if;

  if def.interaction_type = 'hype_mode' then
    update public.hype_mode_activations
       set ended_at = current_timestamp
     where interaction_definition_id = target_definition_id and ended_at is null;
  end if;
end
$$;

revoke execute on function app_private.close_interaction_definition(uuid, uuid) from public;
grant execute on function app_private.close_interaction_definition(uuid, uuid) to bsa_app;

-- =========================================================================
-- Support-vote options + tally
-- =========================================================================
create or replace function app_private.create_vote_option(target_channel_id uuid, target_definition_id uuid, target_option_key text, target_label text)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;

  select * into def from public.interaction_definitions
   where id = target_definition_id and channel_id = target_channel_id and interaction_type = 'support_vote';
  if not found then
    raise exception 'interaction definition not found' using errcode = 'P0002';
  end if;
  if def.closed_at is not null then
    raise exception 'a closed support vote cannot be edited' using errcode = '22023';
  end if;
  if target_option_key !~ '^[a-z0-9_-]{1,40}$' or target_label is null or char_length(target_label) not between 1 and 120 then
    raise exception 'invalid vote option' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.interaction_vote_options (id, interaction_definition_id, option_key, label)
  values (new_id, target_definition_id, target_option_key, target_label);
  return new_id;
end
$$;

revoke execute on function app_private.create_vote_option(uuid, uuid, text, text) from public;
grant execute on function app_private.create_vote_option(uuid, uuid, text, text) to bsa_app;

-- Public/viewer-callable: casting a vote needs no channel-role check, only
-- that the poll is live. on conflict do nothing makes a repeat cast from
-- the same voter_fingerprint an idempotent no-op, never an error.
create or replace function app_private.cast_support_vote(target_definition_id uuid, target_option_key text, target_voter_fingerprint text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
  affected_rows integer;
begin
  if target_voter_fingerprint is null or char_length(target_voter_fingerprint) not between 8 and 128 then
    raise exception 'invalid vote' using errcode = '22023';
  end if;

  select * into def from public.interaction_definitions
   where id = target_definition_id and interaction_type = 'support_vote';
  if not found or not def.is_enabled or def.closed_at is not null then
    raise exception 'this support vote is not accepting votes' using errcode = '22023';
  end if;

  perform 1 from public.interaction_vote_options where interaction_definition_id = target_definition_id and option_key = target_option_key;
  if not found then
    raise exception 'invalid vote option' using errcode = '22023';
  end if;

  insert into public.interaction_vote_records (id, interaction_definition_id, option_key, voter_fingerprint)
  values (gen_random_uuid(), target_definition_id, target_option_key, target_voter_fingerprint)
  on conflict (interaction_definition_id, voter_fingerprint) do nothing;

  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
end
$$;

revoke execute on function app_private.cast_support_vote(uuid, text, text) from public;
grant execute on function app_private.cast_support_vote(uuid, text, text) to bsa_app;

-- Channel-scoped tally read (dashboard). Zero votes returns zero rows per
-- option (left join), never an error, and never leaks another channel's
-- vote via a bare definition id (channel_id is joined and role-checked).
create or replace function app_private.support_vote_tally(target_channel_id uuid, target_definition_id uuid)
returns table (option_key text, label text, vote_count bigint, resolved boolean, resolved_option_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with tallies as (
    select opt.option_key, opt.label, count(rec.id) as vote_count
      from public.interaction_vote_options opt
      join public.interaction_definitions def on def.id = opt.interaction_definition_id
      left join public.interaction_vote_records rec on rec.interaction_definition_id = opt.interaction_definition_id and rec.option_key = opt.option_key
     where def.id = target_definition_id
       and def.channel_id = target_channel_id
       and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
     group by opt.option_key, opt.label
  ),
  winner as (
    select option_key from tallies order by vote_count desc, option_key asc limit 1
  ),
  is_closed as (
    select closed_at is not null as closed from public.interaction_definitions where id = target_definition_id
  )
  select t.option_key, t.label, t.vote_count,
         (select closed from is_closed) as resolved,
         case when (select closed from is_closed) and exists (select 1 from tallies where vote_count > 0)
              then (select option_key from winner) else null end as resolved_option_key
    from tallies t
   order by t.vote_count desc, t.option_key asc
$$;

revoke execute on function app_private.support_vote_tally(uuid, uuid) from public;
grant execute on function app_private.support_vote_tally(uuid, uuid) to bsa_app;

-- Overlay read — same overlay_sessions/token-fingerprint scoping as 0102's
-- list_overlay_goal. Never returns another channel's poll.
create or replace function app_private.list_overlay_vote_tally(target_overlay_id uuid, target_token_fingerprint text, target_definition_id uuid)
returns table (option_key text, label text, vote_count bigint, resolved boolean, resolved_option_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with scoped_channel as (
    select session.channel_id
      from public.overlay_sessions session
     where session.id = target_overlay_id
       and session.token_fingerprint = target_token_fingerprint
       and session.revoked_at is null
       and session.expires_at > current_timestamp
  ),
  tallies as (
    select opt.option_key, opt.label, count(rec.id) as vote_count
      from public.interaction_vote_options opt
      join public.interaction_definitions def on def.id = opt.interaction_definition_id
      join scoped_channel sc on sc.channel_id = def.channel_id
      left join public.interaction_vote_records rec on rec.interaction_definition_id = opt.interaction_definition_id and rec.option_key = opt.option_key
     where def.id = target_definition_id
     group by opt.option_key, opt.label
  ),
  winner as (
    select option_key from tallies order by vote_count desc, option_key asc limit 1
  ),
  is_closed as (
    select def.closed_at is not null as closed
      from public.interaction_definitions def
      join scoped_channel sc on sc.channel_id = def.channel_id
     where def.id = target_definition_id
  )
  select t.option_key, t.label, t.vote_count,
         coalesce((select closed from is_closed), false) as resolved,
         case when coalesce((select closed from is_closed), false) and exists (select 1 from tallies where vote_count > 0)
              then (select option_key from winner) else null end as resolved_option_key
    from tallies t
   order by t.vote_count desc, t.option_key asc
$$;

revoke execute on function app_private.list_overlay_vote_tally(uuid, text, uuid) from public;
grant execute on function app_private.list_overlay_vote_tally(uuid, text, uuid) to bsa_app;

-- =========================================================================
-- Hype mode: activation lifecycle + live decayed meter.
-- =========================================================================
create or replace function app_private.start_hype_mode(target_channel_id uuid, target_definition_id uuid, target_duration_seconds integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;
  if target_duration_seconds is null or target_duration_seconds not between 30 and 3600 then
    raise exception 'invalid hype mode activation' using errcode = '22023';
  end if;

  select * into def from public.interaction_definitions
   where id = target_definition_id and channel_id = target_channel_id and interaction_type = 'hype_mode';
  if not found then
    raise exception 'interaction definition not found' using errcode = 'P0002';
  end if;
  if def.closed_at is not null or not def.is_enabled then
    raise exception 'this hype mode definition is not active' using errcode = '22023';
  end if;

  -- End any still-open prior activation before starting a new one — at
  -- most one live activation per definition at a time.
  update public.hype_mode_activations set ended_at = current_timestamp where interaction_definition_id = target_definition_id and ended_at is null;

  new_id := gen_random_uuid();
  insert into public.hype_mode_activations (id, interaction_definition_id, channel_id, started_at, ends_at)
  values (new_id, target_definition_id, target_channel_id, current_timestamp, current_timestamp + make_interval(secs => target_duration_seconds));
  return new_id;
end
$$;

revoke execute on function app_private.start_hype_mode(uuid, uuid, integer) from public;
grant execute on function app_private.start_hype_mode(uuid, uuid, integer) to bsa_app;

create or replace function app_private.end_hype_mode(target_channel_id uuid, target_definition_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;
  update public.hype_mode_activations
     set ended_at = current_timestamp
   where interaction_definition_id = target_definition_id
     and channel_id = target_channel_id
     and ended_at is null;
end
$$;

revoke execute on function app_private.end_hype_mode(uuid, uuid) from public;
grant execute on function app_private.end_hype_mode(uuid, uuid) to bsa_app;

-- The single source of truth for a hype meter. Deterministic pure function
-- of stored rows + current_timestamp — no decay job. Each contributing
-- payment's amount decays linearly to zero over decaySeconds from the
-- payment's own created_at; the meter is the sum of currently-undecayed
-- contributions. Refunds (processed) remove a payment from the sum
-- entirely, same "financial truth" rule as 0102. Returns zero rows if
-- there is no activation at all — callers render the "no active hype
-- mode" empty state, never an error.
create or replace function app_private.hype_mode_state(target_definition_id uuid)
returns table (meter_paise bigint, threshold_paise bigint, reached boolean, started_at timestamptz, ends_at timestamptz, ended boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  def public.interaction_definitions%rowtype;
  activation public.hype_mode_activations%rowtype;
  window_end timestamptz;
  decay_seconds numeric;
  threshold bigint;
  net_paise numeric;
begin
  select * into def from public.interaction_definitions where id = target_definition_id and interaction_type = 'hype_mode';
  if not found then
    return;
  end if;

  select * into activation from public.hype_mode_activations
   where interaction_definition_id = target_definition_id
   order by started_at desc
   limit 1;
  if not found then
    return;
  end if;

  decay_seconds := greatest((def.config->>'decaySeconds')::numeric, 1);
  threshold := (def.config->>'thresholdPaise')::bigint;
  window_end := least(current_timestamp, activation.ends_at);
  if activation.ended_at is not null then
    window_end := least(window_end, activation.ended_at);
  end if;

  select coalesce(sum(
           greatest(0, (payment.gross_amount_paise - coalesce(refunded.amount_paise, 0))
             * greatest(0, 1 - extract(epoch from (window_end - payment.created_at)) / decay_seconds))
         ), 0)
    into net_paise
    from public.payments payment
    left join (
      select refund.payment_id, sum(refund.amount_paise) as amount_paise
        from public.refunds refund
       where refund.status = 'processed'
       group by refund.payment_id
    ) refunded on refunded.payment_id = payment.id
   where payment.channel_id = activation.channel_id
     and payment.status in ('captured', 'refunded', 'partially_refunded')
     and payment.created_at >= activation.started_at
     and payment.created_at <= window_end;

  return query select
    greatest(round(net_paise)::bigint, 0),
    threshold,
    round(net_paise)::bigint >= threshold,
    activation.started_at,
    activation.ends_at,
    (activation.ended_at is not null or current_timestamp >= activation.ends_at);
end
$$;

revoke execute on function app_private.hype_mode_state(uuid) from public;
grant execute on function app_private.hype_mode_state(uuid) to bsa_app;

-- Role-gated dashboard wrapper.
create or replace function app_private.get_channel_hype_mode(target_channel_id uuid, target_definition_id uuid)
returns table (meter_paise bigint, threshold_paise bigint, reached boolean, started_at timestamptz, ends_at timestamptz, ended boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select state.*
    from app_private.hype_mode_state(target_definition_id) state
   where app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
     and exists (select 1 from public.interaction_definitions def where def.id = target_definition_id and def.channel_id = target_channel_id)
$$;

revoke execute on function app_private.get_channel_hype_mode(uuid, uuid) from public;
grant execute on function app_private.get_channel_hype_mode(uuid, uuid) to bsa_app;

-- Overlay wrapper — same session/token-fingerprint scoping as every other
-- overlay read in this migration.
create or replace function app_private.list_overlay_hype_mode(target_overlay_id uuid, target_token_fingerprint text, target_definition_id uuid)
returns table (meter_paise bigint, threshold_paise bigint, reached boolean, started_at timestamptz, ends_at timestamptz, ended boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select state.*
    from app_private.hype_mode_state(target_definition_id) state
   where exists (
     select 1
       from public.overlay_sessions session
       join public.interaction_definitions def on def.channel_id = session.channel_id
      where session.id = target_overlay_id
        and session.token_fingerprint = target_token_fingerprint
        and session.revoked_at is null
        and session.expires_at > current_timestamp
        and def.id = target_definition_id
   )
$$;

revoke execute on function app_private.list_overlay_hype_mode(uuid, text, uuid) from public;
grant execute on function app_private.list_overlay_hype_mode(uuid, text, uuid) to bsa_app;

-- =========================================================================
-- widget_configs CRUD
-- =========================================================================
create or replace function app_private.create_widget_config(
  target_channel_id uuid, target_widget_type text, target_placement jsonb, target_style jsonb, target_data_source jsonb, target_privacy_scope text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_tier text;
  active_count integer;
  new_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s widgets' using errcode = '42501';
  end if;

  if target_widget_type not in ('main_alert', 'support_goal', 'recent_tips', 'top_supporters', 'supporter_ticker', 'public_leaderboard', 'mega_tip_banner')
     or coalesce(target_privacy_scope, 'private') not in ('private', 'public') then
    raise exception 'invalid widget config' using errcode = '22023';
  end if;

  select tier into current_tier
    from public.channel_entitlement_versions
   where channel_id = target_channel_id
   order by version desc
   limit 1;
  if current_tier is null then
    raise exception 'invalid widget config' using errcode = '22023';
  end if;

  select count(*) into active_count from public.widget_configs where channel_id = target_channel_id and is_enabled;
  if active_count >= app_private.tier_widget_count_limit(current_tier) then
    raise exception 'widget limit reached for the channel''s current tier' using errcode = '42501';
  end if;

  new_id := gen_random_uuid();
  insert into public.widget_configs (id, channel_id, widget_type, placement, style, data_source, privacy_scope, created_at, updated_at)
  values (new_id, target_channel_id, target_widget_type, coalesce(target_placement, '{}'::jsonb), coalesce(target_style, '{}'::jsonb),
          coalesce(target_data_source, '{}'::jsonb), coalesce(target_privacy_scope, 'private'), current_timestamp, current_timestamp);
  return new_id;
end
$$;

revoke execute on function app_private.create_widget_config(uuid, text, jsonb, jsonb, jsonb, text) from public;
grant execute on function app_private.create_widget_config(uuid, text, jsonb, jsonb, jsonb, text) to bsa_app;

create or replace function app_private.list_channel_widget_configs(target_channel_id uuid)
returns table (
  widget_config_id uuid, widget_type text, placement jsonb, style jsonb, data_source jsonb,
  privacy_scope text, is_enabled boolean, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select w.id, w.widget_type, w.placement, w.style, w.data_source, w.privacy_scope, w.is_enabled, w.created_at, w.updated_at
    from public.widget_configs w
   where w.channel_id = target_channel_id
     and app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
   order by w.created_at desc
$$;

revoke execute on function app_private.list_channel_widget_configs(uuid) from public;
grant execute on function app_private.list_channel_widget_configs(uuid) to bsa_app;

create or replace function app_private.update_widget_config(
  target_channel_id uuid, target_widget_config_id uuid, target_placement jsonb, target_style jsonb,
  target_data_source jsonb, target_privacy_scope text, target_is_enabled boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s widgets' using errcode = '42501';
  end if;
  perform 1 from public.widget_configs where id = target_widget_config_id and channel_id = target_channel_id;
  if not found then
    raise exception 'widget config not found' using errcode = 'P0002';
  end if;
  if target_privacy_scope is not null and target_privacy_scope not in ('private', 'public') then
    raise exception 'invalid widget config' using errcode = '22023';
  end if;

  update public.widget_configs
     set placement = coalesce(target_placement, placement),
         style = coalesce(target_style, style),
         data_source = coalesce(target_data_source, data_source),
         privacy_scope = coalesce(target_privacy_scope, privacy_scope),
         is_enabled = coalesce(target_is_enabled, is_enabled),
         updated_at = current_timestamp
   where id = target_widget_config_id;
end
$$;

revoke execute on function app_private.update_widget_config(uuid, uuid, jsonb, jsonb, jsonb, text, boolean) from public;
grant execute on function app_private.update_widget_config(uuid, uuid, jsonb, jsonb, jsonb, text, boolean) to bsa_app;

create or replace function app_private.delete_widget_config(target_channel_id uuid, target_widget_config_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s widgets' using errcode = '42501';
  end if;
  delete from public.widget_configs where id = target_widget_config_id and channel_id = target_channel_id;
  if not found then
    raise exception 'widget config not found' using errcode = 'P0002';
  end if;
end
$$;

revoke execute on function app_private.delete_widget_config(uuid, uuid) from public;
grant execute on function app_private.delete_widget_config(uuid, uuid) to bsa_app;

-- Overlay read of a widget's own config (placement/style/data_source) —
-- only rows explicitly marked privacy_scope = 'public' and enabled are
-- readable this way; a 'private' (dashboard-preview-only) widget never
-- reaches an overlay browser source. Scoped by channel via overlay_sessions,
-- exactly like every other overlay function in this migration.
create or replace function app_private.list_overlay_widget_config(target_overlay_id uuid, target_token_fingerprint text, target_widget_type text)
returns table (widget_config_id uuid, widget_type text, placement jsonb, style jsonb, data_source jsonb)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select w.id, w.widget_type, w.placement, w.style, w.data_source
    from public.overlay_sessions session
    join public.widget_configs w on w.channel_id = session.channel_id
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
     and w.widget_type = target_widget_type
     and w.is_enabled
     and w.privacy_scope = 'public'
   order by w.created_at desc
   limit 1
$$;

revoke execute on function app_private.list_overlay_widget_config(uuid, text, text) from public;
grant execute on function app_private.list_overlay_widget_config(uuid, text, text) to bsa_app;

-- =========================================================================
-- Leaderboard: rank + coarse tier bucket only, NEVER an exact amount, and
-- always scoped to exactly one channel_id. See header for why there is no
-- "public, exact amount" mode at all in this migration.
-- =========================================================================
create or replace function app_private.channel_leaderboard(target_channel_id uuid, target_window text)
returns table (rank integer, viewer_ref text, tier_label text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  with window_bounds as (
    select case target_window
      when 'weekly' then current_timestamp - interval '7 days'
      when 'monthly' then current_timestamp - interval '30 days'
      else '-infinity'::timestamptz
    end as window_start
  ),
  net as (
    select payment.viewer_identity_id,
           sum(payment.gross_amount_paise) - coalesce(sum(refunded.amount_paise), 0) as net_paise
      from public.payments payment
      left join (
        select refund.payment_id, sum(refund.amount_paise) as amount_paise
          from public.refunds refund
         where refund.status = 'processed'
         group by refund.payment_id
      ) refunded on refunded.payment_id = payment.id
     where payment.channel_id = target_channel_id
       and payment.status in ('captured', 'refunded', 'partially_refunded')
       and payment.viewer_identity_id is not null
       and payment.created_at >= (select window_start from window_bounds)
     group by payment.viewer_identity_id
    having sum(payment.gross_amount_paise) - coalesce(sum(refunded.amount_paise), 0) > 0
  )
  select
    row_number() over (order by net_paise desc)::integer as rank,
    'viewer_' || substr(net.viewer_identity_id::text, 1, 8) as viewer_ref,
    case
      when net_paise >= 5000000 then 'platinum'
      when net_paise >= 1000000 then 'gold'
      when net_paise >= 200000 then 'silver'
      else 'bronze'
    end as tier_label
    from net
   where target_window in ('weekly', 'monthly', 'all')
   order by net_paise desc
   limit 100
$$;

-- Channel-role-gated dashboard wrapper (creator sees only their own
-- channel's supporters — Part 11.5's cross-creator invisibility).
create or replace function app_private.get_channel_leaderboard(target_channel_id uuid, target_window text)
returns table (rank integer, viewer_ref text, tier_label text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select board.* from app_private.channel_leaderboard(target_channel_id, target_window) board
   where app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[])
$$;

revoke execute on function app_private.channel_leaderboard(uuid, text) from public;
revoke execute on function app_private.get_channel_leaderboard(uuid, text) from public;
grant execute on function app_private.get_channel_leaderboard(uuid, text) to bsa_app;

-- Overlay wrapper — channel resolved solely from the overlay session, so a
-- widget can never be pointed at another channel's leaderboard by passing
-- a different channel id (there is no such parameter here at all).
create or replace function app_private.list_overlay_leaderboard(target_overlay_id uuid, target_token_fingerprint text, target_window text)
returns table (rank integer, viewer_ref text, tier_label text)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select board.*
    from public.overlay_sessions session,
         lateral app_private.channel_leaderboard(session.channel_id, target_window) board
   where session.id = target_overlay_id
     and session.token_fingerprint = target_token_fingerprint
     and session.revoked_at is null
     and session.expires_at > current_timestamp
$$;

revoke execute on function app_private.list_overlay_leaderboard(uuid, text, text) from public;
grant execute on function app_private.list_overlay_leaderboard(uuid, text, text) to bsa_app;
