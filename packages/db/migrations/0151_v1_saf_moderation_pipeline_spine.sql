-- SAF phase 1 -- the moderation pipeline spine: one corpus, one pipeline,
-- L0 normalisation, L1 Aho-Corasick, per-surface decisions, an evidence
-- snapshot that can never lose the original text.
--
-- AUTHORITY. bharatstudio-requirements/active/tasks/SAF-01-moderation-
-- pipeline-spine.md. FULL-PRODUCT-DEFINITION.md S31.13.2 rows SAF-01,
-- SAF-02, SAF-04, SAF-05, SAF-09 (register text: "One corpus, one
-- pipeline, every surface" / "L0 normalisation: NFKC, zero-width and
-- RTL-override stripping, combining-mark flood, homoglyph folding, leet
-- and separator folding, repeated-character collapse" / "Original text
-- never destroyed -- normalisation produces a parallel matching form" /
-- "L1 Aho-Corasick over the compiled corpus, global plus per-creator,
-- whole-word and substring rules kept separate" / "Per-surface decisions
-- -- payment, display, TTS, stored record, moderator review are
-- independent and separately audited"). S12.2 (content safety, one
-- pipeline every surface), S12.10 (evidence and retention for moderation
-- actions -- "snapshot the evidence at action time, do not retain the
-- firehose"), S12.6.2/S12.6.2.1 (raw unactioned text is the shortest
-- retention class, gated Open -- so it is never written at all, the same
-- reasoning 0141 already applied to reaction sends).
--
-- MIGRATION NUMBER: 0151, pre-assigned to this task. Nothing renumbered.
--
-- ============================================================
-- VERIFIED BEFORE STARTING: SAF is 45-of-46 absent. A repo-wide search
-- found zero matches for corpus, Aho-Corasick, phonetic, homoglyph, PII,
-- SSML or policy_version. The only moderation-shaped thing anywhere in
-- the product is `apps/api/src/domain/interaction-types.ts`'s
-- `ModerationRule` enum ('none'|'review'|'block_list'), which is stored
-- and never read -- decorative, not a pipeline. This migration builds a
-- foundation. It does not extend anything.
-- ============================================================
--
-- SCOPE -- FIVE ROWS ONLY: SAF-01, SAF-02, SAF-04, SAF-05, SAF-09.
--
-- WHAT THIS DELIBERATELY DOES NOT BUILD (later lanes, several need
-- decisions that do not exist yet -- see the task record):
--   - SAF-03 (Indic phonetic keys / script transliteration), SAF-06 (L2
--     edit distance), SAF-07 (L3 local classifier), SAF-08 (L4 AI),
--     SAF-10 (URL neutralisation), SAF-11 (SSML-injection guard),
--     SAF-12 (PII detection), SAF-13 (rate/flood control), SAF-14
--     (policy presets).
--   - Homoglyph folding, leet/separator folding and repeated-character
--     collapse -- the REGISTER's fuller SAF-02 text lists these, but the
--     TASK RECORD that dispatched this migration narrows SAF-02 to
--     "NFKC, zero-width and RTL-override stripping, combining-mark
--     handling" only, and that narrower text is what is built here. The
--     wider evasion techniques overlap SAF-03's phonetic-key territory
--     (a leet/homoglyph fold is only actually safe once script-aware
--     phonetic collapse exists behind it, or `assist` starts colliding
--     with folded slurs) and are recorded here, not silently dropped, as
--     deferred to whichever lane builds SAF-03/SAF-06.
--   - NOT wired into any live payment, TTS, chat or alert path. This is
--     the pipeline built and proven in isolation; switching a live
--     surface onto it is a separate task with its own record, so a
--     failure is attributable to one change, not two at once.
--   - NO corpus content. A slur list is content, not code, and nobody
--     has decided it. `safety_corpus_terms` ships schema-only: this
--     migration inserts ZERO rows into it. Empty means "matches
--     nothing" structurally (see the L1 matcher's own empty-input
--     behaviour, proven in packages/db/tests/saf_pipeline_spine.sql and
--     in apps/api/test/safety-pipeline.test.ts) -- never "match
--     everything", and never a guessed starter list.
--
-- ============================================================
-- SAF-01 -- ONE CORPUS, ONE PIPELINE, EVERY SURFACE. STRUCTURAL, NOT
-- CONVENTION-BASED, IN TWO INDEPENDENT WAYS.
-- ============================================================
-- (a) Database side: `bsa_app` has NO select/insert/update/delete grant
--     on `safety_corpus_terms` at all -- revoked from public AND from
--     bsa_app, the identical CTL-03 technique migration 0149 already
--     proved for "never per-capability queries". The ONLY way the
--     running API can ever read a corpus term is
--     `app_private.get_safety_corpus_terms(channel_id)`. A second
--     matching implementation reading the corpus directly -- from SQL,
--     from a second application table, from anywhere but this one
--     function -- cannot be written against this schema even by
--     accident, and packages/db/tests/saf_pipeline_spine.sql proves the
--     grant is absent behaviourally (a direct SELECT as bsa_app raises
--     insufficient_privilege).
-- (b) Application side: normalisation (SAF-02/SAF-04) and L1 matching
--     (SAF-05) each exist in exactly one TypeScript module --
--     apps/api/src/domain/safety-pipeline.ts (normalisation, decision
--     combination, the ONE exported `runSafetyPipeline` entry point) and
--     apps/api/src/domain/aho-corasick.ts (the automaton itself, generic
--     and reusable, first-party). apps/api/test/safety-pipeline.test.ts
--     scans the whole `apps/api/src` tree and fails if any file other
--     than those two defines a second `.normalize(` call against message
--     text or a second Aho-Corasick-shaped matcher (a class/function
--     named for trie/goto/fail-link construction) -- the "second
--     implementation" guard the task asks for, proven where the actual
--     risk of duplication lives (application code), paired with (a)'s
--     database-level guard against a second READ PATH into the corpus
--     that would make a second implementation possible in the first
--     place.
--
-- ============================================================
-- SAF-02/SAF-04 -- L0 NORMALISATION PRODUCES A PARALLEL FORM; THE
-- ORIGINAL IS STRUCTURALLY IMPOSSIBLE TO LOSE.
-- ============================================================
-- Normalisation (NFKC, zero-width U+200B-D/U+FEFF stripping, RTL/LTR
-- override U+202A-E/U+2066-9 stripping, combining-mark stripping for
-- Zalgo floods -- apps/api/src/domain/safety-pipeline.ts's
-- `normalizeForSafetyMatching`) happens entirely in application memory
-- and NEVER overwrites its input string (JS strings are immutable, so
-- there is no operation that could). What this migration adds is the
-- DURABLE half of that guarantee: `safety_moderation_actions` has
-- `original_text` and `normalised_text` as two SEPARATE, independently
-- NOT NULL columns. There is no single "text" column upstream of them,
-- so a write that has a normalised form but no original -- or vice
-- versa -- is rejected before it reaches storage, not merely
-- discouraged. Proven in packages/db/tests/saf_pipeline_spine.sql by
-- inserting a message whose normalised form visibly differs from its
-- original (zero-width characters removed) and asserting BOTH columns
-- read back byte-for-byte as given.
--
-- ============================================================
-- SAF-05 -- L1 AHO-CORASICK, GLOBAL PLUS PER-CREATOR, WHOLE-WORD AND
-- SUBSTRING KEPT SEPARATE.
-- ============================================================
-- `safety_corpus_terms.channel_id` is nullable: null means a global
-- term (matches for every channel), non-null scopes a term to one
-- creator's own corpus. `app_private.get_safety_corpus_terms` returns
-- the UNION of both for the calling channel in one read -- "global plus
-- per-creator" is a property of this one function's query, not two
-- separate corpus fetches a caller has to remember to make. Each term
-- carries its own `whole_word` boolean; whole-word and substring rules
-- are literally different rows, never a global setting, so the corpus
-- can hold "assist" as whole-word-only right beside a deliberately
-- substring-matched term without the two ever colliding. The automaton
-- itself is first-party (apps/api/src/domain/aho-corasick.ts) -- no
-- third-party dependency was added for it.
--
-- ============================================================
-- SAF-09 -- PER-SURFACE DECISIONS, NOT ONE VERDICT. THE MONEY BOUNDARY
-- AND THE "ALWAYS STORED IN FULL" RULE ARE DATABASE-ENFORCED, NOT JUST
-- APPLICATION CONVENTION.
-- ============================================================
-- Sec12.2.4's table names five surfaces: payment, public display, TTS,
-- stored record, moderator review. `safety_moderation_actions` carries
-- FIVE SEPARATE decision columns, one per surface, each independently
-- readable and independently auditable -- never one boolean callers
-- reinterpret five ways. Two of the five are CHECK-CONSTRAINED to a
-- single constant value, structurally, not by application discipline:
--   * `payment_decision` can only ever be 'allow' -- Sec12.2.4: "Never
--     affected by content. A message is never a reason to reject
--     money." Attempting any other value raises check_violation before
--     the row can exist, proven in the SQL test.
--   * `stored_record_decision` can only ever be 'allow' -- Sec12.2.4:
--     "Always stored in full -- it is a durable record." This column
--     exists on a row precisely because an evidence snapshot was taken
--     (Sec12.10); there is no state in which that snapshot exists but
--     is flagged as not-fully-stored.
-- `display_decision` and `tts_decision` (allow/mask/hold/block, the
-- Sec12.2.1 pipeline diagram's own vocabulary) and
-- `moderator_review_decision` (allow/hold -- "queued for a human or
-- not", Sec12.2.4) are free to differ from each other and from the two
-- constants on the SAME row for the SAME message -- proven in the SQL
-- test by inserting one evidence row whose display/tts decisions are
-- different values, and in apps/api/test/safety-pipeline.test.ts by
-- running the pipeline against text that matches a term configured to
-- mask on display and block on TTS.
--
-- ============================================================
-- RETENTION -- Sec12.10/Sec12.6.2/Sec12.6.2.1: SNAPSHOT AT ACTION TIME,
-- NEVER THE FIREHOSE.
-- ============================================================
-- `safety_moderation_actions` is written ONLY when the pipeline
-- produces at least one match (the application layer never calls
-- `record_safety_moderation_action` for a clean message -- there is
-- nothing for it to record, since every decision on a clean message is
-- 'allow'/'allow'/'allow'/'allow'/'allow' by construction). There is no
-- table anywhere in this migration that stores raw message text for a
-- message that was never actioned -- the same reasoning
-- Sec12.6.2.1 already applied to reaction sends (migration 0141): the
-- privacy/legal gate for the shortest retention class is still Open in
-- active/launch/05_SUPPORT_AND_EXTERNAL_EVIDENCE_REGISTER.md, so no
-- honest window exists to apply, and the lever the schedule itself names
-- for exactly this case -- "managed by what we choose to ingest and
-- index at all" -- is applied by never ingesting it. `original_text` and
-- `normalised_text` on an evidence row are the Sec12.10 evidence snapshot
-- ("attached to" the action record), never a general chat/tip log.
--
-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.record_safety_moderation_action(uuid, text, text, uuid[], numeric, text, text, text, uuid);
--   drop function if exists app_private.delete_safety_corpus_term(uuid, uuid);
--   drop function if exists app_private.create_safety_corpus_term(uuid, text, boolean, text, text, text);
--   drop function if exists app_private.get_safety_corpus_terms(uuid);
--   drop trigger if exists safety_corpus_bump_generation on public.safety_corpus_terms;
--   drop function if exists app_private.safety_corpus_bump_generation();
--   drop table if exists public.safety_moderation_actions;
--   drop table if exists public.safety_corpus_generation;
--   drop table if exists public.safety_corpus_terms;

-- =====================================================================
-- 1. SAF-05: the corpus itself. Empty by default -- this migration
--    inserts ZERO rows. channel_id null = global (applies to every
--    channel); non-null = this creator's own addition. whole_word is
--    per-term, not global, so whole-word and substring rules are always
--    "kept separate" by being different rows.
-- =====================================================================
create table public.safety_corpus_terms (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references public.channels(id),
  term text not null check (char_length(btrim(term)) between 1 and 200),
  whole_word boolean not null default true,
  -- SAF-09: each term configures what happens on the two surfaces that
  -- are actually allowed to vary (display, TTS) and on moderator queuing.
  -- payment and stored-record are NEVER configurable per term -- see the
  -- evidence table's own check constraints below, which is where those
  -- two invariants are actually enforced.
  display_decision text not null check (display_decision in ('allow', 'mask', 'hold', 'block')),
  tts_decision text not null check (tts_decision in ('allow', 'mask', 'hold', 'block')),
  moderator_review_decision text not null check (moderator_review_decision in ('allow', 'hold')),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

comment on table public.safety_corpus_terms is
  'SAF-01/SAF-05 (migration 0151). The single compiled corpus every surface matches against -- global (channel_id null) plus per-creator (channel_id set), whole-word and substring rules kept separate as distinct rows via the whole_word column. Empty by default: this migration ships zero rows, and an empty corpus is proven (packages/db/tests/saf_pipeline_spine.sql, apps/api/test/safety-pipeline.test.ts) to mean "matches nothing", never "match everything". No slur or otherwise-forbidden content is invented anywhere in this migration.';

-- One term text per scope: a global term is unique among global terms,
-- a channel's own term is unique among that channel's own terms. Two
-- different channels may each independently add the same literal term.
create unique index safety_corpus_terms_global_term_idx
  on public.safety_corpus_terms (lower(btrim(term)))
  where channel_id is null;

create unique index safety_corpus_terms_channel_term_idx
  on public.safety_corpus_terms (channel_id, lower(btrim(term)))
  where channel_id is not null;

create index safety_corpus_terms_channel_idx on public.safety_corpus_terms (channel_id);

alter table public.safety_corpus_terms enable row level security;
revoke all on public.safety_corpus_terms from public;
revoke all on public.safety_corpus_terms from bsa_app;

-- =====================================================================
-- 2. Global generation counter -- identical mechanism to migration
--    0149's capability_registry_generation, reused for the same reason:
--    a policy_version every evidence snapshot can cite (SAF-09's audit
--    contract, Sec12.2.7/Sec12.10) without recomputing a hash of the
--    whole corpus on every match.
-- =====================================================================
create table public.safety_corpus_generation (
  id boolean primary key default true check (id),
  generation bigint not null default 1,
  bumped_at timestamptz not null default current_timestamp
);

insert into public.safety_corpus_generation (id, generation) values (true, 1);

revoke all on public.safety_corpus_generation from public;
revoke all on public.safety_corpus_generation from bsa_app;

create or replace function app_private.safety_corpus_bump_generation()
returns trigger
language plpgsql
as $$
begin
  update public.safety_corpus_generation
     set generation = generation + 1, bumped_at = current_timestamp
   where id;
  return null;
end
$$;

create trigger safety_corpus_bump_generation
  after insert or update or delete on public.safety_corpus_terms
  for each statement execute function app_private.safety_corpus_bump_generation();

-- =====================================================================
-- 3. Sec12.10 evidence snapshot. Written ONLY at action time (the
--    application layer calls record_safety_moderation_action only when
--    the pipeline found at least one match -- see this migration's own
--    header). SAF-04: original_text and normalised_text are separate
--    NOT NULL columns -- structurally impossible for a row to carry one
--    without the other. SAF-09: five separate decision columns; two are
--    check-constrained to a single constant (payment_decision, stored_
--    record_decision), the database-enforced half of the money boundary
--    and the "always stored in full" rule.
-- =====================================================================
create table public.safety_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id),
  -- 500-character bound reused verbatim from the existing decided donor-
  -- message bound (packages/db/migrations/0006_v1_l04_payment_order_intents.sql:36,
  -- `check (char_length(donor_message) <= 500)`), not invented here.
  original_text text not null check (char_length(original_text) between 1 and 500),
  normalised_text text not null check (char_length(normalised_text) between 1 and 500),
  -- coalesce is load-bearing: array_length(ARRAY[]::uuid[], 1) is NULL,
  -- not 0, and a CHECK constraint that evaluates to NULL is treated as
  -- satisfied, not violated -- an uncoalesced check here would silently
  -- ACCEPT an empty array, exactly the "raw unactioned text" row this
  -- constraint exists to make impossible.
  matched_term_ids uuid[] not null check (coalesce(array_length(matched_term_ids, 1), 0) >= 1),
  -- Phase 1 has only L1. Left as a checked enum of one value rather than
  -- an unchecked free-text column, so a later layer (L2-L4) is a visible,
  -- reviewable widening of this constraint, not a silent free-text drift.
  layer text not null check (layer = 'l1'),
  -- L1 is exact/whole-word matching, not fuzzy -- confidence is
  -- deterministically 1.0 for every L1 match. This is a structural fact
  -- of the layer, not an invented business number.
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  policy_version bigint not null,
  -- Automated system decision: null. A human actor is recorded only if
  -- one was actually involved in this specific action -- Sec12.2.7's
  -- audit contract ("...and the actor if a human was involved").
  actor_user_id uuid references public.app_users(id),
  payment_decision text not null check (payment_decision = 'allow'),
  display_decision text not null check (display_decision in ('allow', 'mask', 'hold', 'block')),
  tts_decision text not null check (tts_decision in ('allow', 'mask', 'hold', 'block')),
  stored_record_decision text not null check (stored_record_decision = 'allow'),
  moderator_review_decision text not null check (moderator_review_decision in ('allow', 'hold')),
  created_at timestamptz not null default current_timestamp
);

comment on table public.safety_moderation_actions is
  'SAF-04/SAF-09/Sec12.10 (migration 0151). One row per moderation ACTION (never per message reviewed with no match -- see this migration''s own header for why raw unactioned text is never written here or anywhere). original_text and normalised_text are separate NOT NULL columns: structurally impossible for a write to carry one without the other. payment_decision and stored_record_decision are check-constrained to the single value ''allow'' -- the database-enforced half of "money is never affected by content" and "an actioned message is always stored in full".';

create index safety_moderation_actions_channel_idx
  on public.safety_moderation_actions (channel_id, created_at desc);

alter table public.safety_moderation_actions enable row level security;
revoke all on public.safety_moderation_actions from public;
revoke all on public.safety_moderation_actions from bsa_app;

-- =====================================================================
-- 4. SAF-01(a)/SAF-05: the ONE corpus read path. Global plus this
--    channel's own terms, in one query. Same member role set every
--    other channel read in this schema uses.
-- =====================================================================
create or replace function app_private.get_safety_corpus_terms(target_channel_id uuid)
returns table (
  id uuid,
  channel_id uuid,
  term text,
  whole_word boolean,
  display_decision text,
  tts_decision text,
  moderator_review_decision text,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin', 'operator', 'moderator', 'viewer']::text[]) then
    return;
  end if;

  return query
    select t.id, t.channel_id, t.term, t.whole_word, t.display_decision, t.tts_decision, t.moderator_review_decision, t.created_at
      from public.safety_corpus_terms t
     where t.channel_id is null or t.channel_id = target_channel_id
     order by t.created_at asc, t.id asc;
end
$$;

revoke execute on function app_private.get_safety_corpus_terms(uuid) from public;
grant execute on function app_private.get_safety_corpus_terms(uuid) to bsa_app;

-- =====================================================================
-- 5. Corpus write: create. A channel-scoped term (target_channel_id not
--    null) requires owner/admin on that channel -- ordinary creator
--    self-service. A global term (target_channel_id null) requires
--    platform staff -- the data-layer primitive a future admin surface
--    will call (CTL-04's own posture, migration 0149), not that surface
--    itself; no HTTP route in this phase ever passes a null channel id.
-- =====================================================================
create or replace function app_private.create_safety_corpus_term(
  target_channel_id uuid,
  target_term text,
  target_whole_word boolean,
  target_display_decision text,
  target_tts_decision text,
  target_moderator_review_decision text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  actor uuid;
  new_id uuid;
begin
  if target_channel_id is null then
    if not app_private.is_platform_admin() then
      raise exception 'platform staff access is required' using errcode = '42501';
    end if;
  else
    if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
      raise exception 'not authorized to manage this channel''s safety corpus' using errcode = '42501';
    end if;
  end if;

  actor := app_private.current_user_id();

  insert into public.safety_corpus_terms
    (channel_id, term, whole_word, display_decision, tts_decision, moderator_review_decision, created_by)
  values
    (target_channel_id, target_term, coalesce(target_whole_word, true),
     target_display_decision, target_tts_decision, target_moderator_review_decision, actor)
  returning id into new_id;

  return new_id;
end
$$;

revoke execute on function app_private.create_safety_corpus_term(uuid, text, boolean, text, text, text) from public;
grant execute on function app_private.create_safety_corpus_term(uuid, text, boolean, text, text, text) to bsa_app;

-- =====================================================================
-- 6. Corpus write: delete. Channel-owned terms only through this
--    function -- a global term is never deletable through a channel-
--    scoped call, so this is deliberately narrower than `create` above.
-- =====================================================================
create or replace function app_private.delete_safety_corpus_term(
  target_channel_id uuid,
  target_term_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  found_channel_id uuid;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s safety corpus' using errcode = '42501';
  end if;

  select channel_id into found_channel_id from public.safety_corpus_terms where id = target_term_id;

  if not found or found_channel_id is distinct from target_channel_id then
    raise exception 'safety corpus term not found' using errcode = 'P0002';
  end if;

  delete from public.safety_corpus_terms where id = target_term_id;
end
$$;

revoke execute on function app_private.delete_safety_corpus_term(uuid, uuid) from public;
grant execute on function app_private.delete_safety_corpus_term(uuid, uuid) to bsa_app;

-- =====================================================================
-- 7. Sec12.10 evidence snapshot write. Called by the application layer
--    only when app_private.runSafetyPipeline (TypeScript,
--    apps/api/src/domain/safety-pipeline.ts) produced at least one
--    match -- there is nothing to snapshot for a clean message. NOT
--    called from any live route in this phase (see this migration's own
--    header: nothing is wired live yet). policy_version is read from
--    the generation counter INSIDE this function, never accepted as a
--    caller-supplied argument -- a caller cannot forge which corpus
--    generation an action was evaluated against.
-- =====================================================================
create or replace function app_private.record_safety_moderation_action(
  target_channel_id uuid,
  target_original_text text,
  target_normalised_text text,
  target_matched_term_ids uuid[],
  target_confidence numeric,
  target_display_decision text,
  target_tts_decision text,
  target_moderator_review_decision text,
  target_actor_user_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  current_generation bigint;
  new_id uuid;
begin
  select generation into current_generation from public.safety_corpus_generation where id;

  insert into public.safety_moderation_actions (
    channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version,
    actor_user_id, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision
  ) values (
    target_channel_id, target_original_text, target_normalised_text, target_matched_term_ids, 'l1', target_confidence, current_generation,
    target_actor_user_id, 'allow', target_display_decision, target_tts_decision, 'allow', target_moderator_review_decision
  )
  returning id into new_id;

  return new_id;
end
$$;

revoke execute on function app_private.record_safety_moderation_action(uuid, text, text, uuid[], numeric, text, text, text, uuid) from public;
grant execute on function app_private.record_safety_moderation_action(uuid, text, text, uuid[], numeric, text, text, text, uuid) to bsa_app;
