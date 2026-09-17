-- SAF phase 1 continuation: URL neutralisation, the SSML-injection
-- guard, and PII detection -- extending the moderation pipeline spine
-- (migration 0151), not building a second one.
--
-- AUTHORITY. bharatstudio-requirements/active/tasks/SAF-10-url-ssml-pii-
-- guards.md. FULL-PRODUCT-DEFINITION.md S31.13.2 rows SAF-10, SAF-11,
-- SAF-12 (register text: "URL neutralisation with per-creator allow and
-- deny domains" / "SSML-injection guard -- a message can never become
-- synthesis instructions" / "PII detection: phone, UPI ID, email,
-- address, card-like strings, plus the no-accidental-doxxing rule").
-- S12.2.5, S12.10, S5.3's "no-accidental-doxxing detector".
--
-- MIGRATION NUMBER: 0154, pre-assigned to this lane by the coordinator.
-- 0153 is owned by a concurrently running sibling lane (migration
-- numbers and fixture ranges are pre-assigned, not independently
-- verified free -- packages/db/tests/fixtures/00_base_world.sql's own
-- header records why "verify free" is not enough between concurrent
-- lanes). Nothing renumbered.
--
-- ============================================================
-- READ FIRST -- WHAT THIS MIGRATION DOES NOT DO
-- ============================================================
-- SAF-11 has NO schema here. A message can never become synthesis
-- instructions because apps/api/src/tts/provider.ts's `sanitizeTtsText`
-- (pre-existing, lines 33-40) already strips every `<...>`-shaped
-- markup token unconditionally before any text reaches a TTS provider --
-- SSML syntax is entirely defined by `<tag>` delimiters, so removing
-- every well-formed `<...>` span removes every possible tag; no
-- database-side representation is needed for a guarantee that already
-- holds in application code, and adding one here would be exactly the
-- "second implementation to drift out of sync" SAF-01 forbids. See
-- apps/api/test/saf-ssml-injection-guard.test.ts for the proof this
-- migration's own governance review record cites.
--
-- SAF-12's "address" is narrowed to Indian PIN code presence only --
-- the same kind of documented, non-silent narrowing 0151 itself applied
-- to SAF-02 (see that migration's own header: leet/homoglyph/repeat-
-- collapse deferred to SAF-03/06, not silently dropped). Free-text
-- street-address extraction is an NLP/classifier problem and belongs to
-- SAF-07/08 (explicitly out of scope for this task, per the task's own
-- "hard constraints"), not an invented heuristic here.
--
-- NOT WIRED INTO ANY LIVE PAYMENT, TTS, CHAT OR ALERT PATH. Same posture
-- as 0151: built and proven in isolation. Switching a live surface onto
-- any of this is a separate task with its own record.
--
-- NO STARTER DOMAIN LIST. `safety_domain_rules` ships schema-only --
-- this migration inserts ZERO rows. Empty deny means "deny nothing",
-- never "deny everything" -- proven in packages/db/tests/saf_url_ssml_
-- pii.sql by neutralizeUrls's own empty-rules behaviour (apps/api/test/
-- url-neutralization.test.ts) and by this table shipping no seed rows,
-- identical to 0151's own corpus posture.
--
-- ============================================================
-- SAF-10 -- URL NEUTRALISATION, PER-CREATOR ALLOW AND DENY DOMAINS.
-- ============================================================
-- Baseline reused, not invented: apps/api/src/tts/provider.ts's
-- `sanitizeTtsText` already replaces every URL-shaped token with a
-- placeholder, UNCONDITIONALLY, before TTS dispatch (provider.ts:28
-- URL_TOKEN, provider.ts:36) -- an existing, decided behaviour. SAF-10
-- extends that same "neutralise by default" baseline to the DISPLAY
-- surface (which had zero URL handling before this migration -- 0151's
-- own "SAF is 45-of-46 absent" note) and makes it creator-configurable:
-- a domain on the ALLOW list is exempt (passed through untouched); a
-- domain on the DENY list is always neutralised, taking precedence over
-- an allow entry.
--
-- PRECEDENCE IS STRUCTURAL, NOT A RUNTIME TIE-BREAK. A domain can hold
-- at most ONE rule per channel -- `safety_domain_rules_channel_domain_
-- idx` below is a UNIQUE index on (channel_id, lower(domain)), so
-- attempting to insert both an allow and a deny row for the literal same
-- domain on the same channel raises a unique-violation before either can
-- contradict the other. There is no ambiguous state to resolve at match
-- time, the same "make the second thing impossible to write" technique
-- 0151 used for a second corpus-read path. The "precedence test" the
-- task's own vertical-slice instruction asks for is exactly this: (a)
-- the unique-violation proof at the database layer, and (b) a TS-level
-- test proving deny/allow/default resolve correctly when three
-- DIFFERENT domains each hold one of the three states.
create table public.safety_domain_rules (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id),
  -- RFC 1035 SS2.3.4 hostname-label shape (63 chars per label, dot-
  -- separated), lowercase-only so a stored rule and a normalised lookup
  -- host always compare byte-for-byte without a runtime lower() call
  -- masking a case mismatch. 253 is RFC 1035's own total-hostname bound
  -- -- both bounds are the standard's, not invented here.
  domain text not null check (
    char_length(domain) between 1 and 253
    and domain = lower(domain)
    and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  rule text not null check (rule in ('allow', 'deny')),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default current_timestamp
);

comment on table public.safety_domain_rules is
  'SAF-10 (migration 0154). Per-creator URL allow/deny domains extending the SAF phase 1 pipeline (0151). Empty by default: this migration ships zero rows -- an empty deny list means "deny nothing", never "deny everything" (proven in packages/db/tests/saf_url_ssml_pii.sql and apps/api/test/url-neutralization.test.ts). A domain can hold at most one rule per channel (safety_domain_rules_channel_domain_idx) -- allow/deny precedence is a structural impossibility of contradiction, not a runtime tie-break.';

create unique index safety_domain_rules_channel_domain_idx
  on public.safety_domain_rules (channel_id, domain);

create index safety_domain_rules_channel_idx on public.safety_domain_rules (channel_id);

alter table public.safety_domain_rules enable row level security;
revoke all on public.safety_domain_rules from public;
revoke all on public.safety_domain_rules from bsa_app;

-- One read path, mirroring app_private.get_safety_corpus_terms exactly:
-- SAF-01(a)'s structural guard (no grant on the table itself) applied to
-- this new table too.
create or replace function app_private.get_url_domain_rules(target_channel_id uuid)
returns table (
  id uuid,
  domain text,
  rule text,
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
    select r.id, r.domain, r.rule, r.created_at
      from public.safety_domain_rules r
     where r.channel_id = target_channel_id
     order by r.created_at asc, r.id asc;
end
$$;

revoke execute on function app_private.get_url_domain_rules(uuid) from public;
grant execute on function app_private.get_url_domain_rules(uuid) to bsa_app;

-- Owner/admin only, matching create_safety_corpus_term's own channel-
-- scoped authorization (there is no "global" domain rule -- SAF-10's own
-- register text says "per-creator", not "global plus per-creator" the
-- way SAF-05's corpus is).
create or replace function app_private.create_url_domain_rule(
  target_channel_id uuid,
  target_domain text,
  target_rule text
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
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s safety domain rules' using errcode = '42501';
  end if;

  actor := app_private.current_user_id();

  insert into public.safety_domain_rules (channel_id, domain, rule, created_by)
  values (target_channel_id, target_domain, target_rule, actor)
  returning id into new_id;

  return new_id;
end
$$;

revoke execute on function app_private.create_url_domain_rule(uuid, text, text) from public;
grant execute on function app_private.create_url_domain_rule(uuid, text, text) to bsa_app;

create or replace function app_private.delete_url_domain_rule(
  target_channel_id uuid,
  target_rule_id uuid
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
    raise exception 'not authorized to manage this channel''s safety domain rules' using errcode = '42501';
  end if;

  select channel_id into found_channel_id from public.safety_domain_rules where id = target_rule_id;

  if not found or found_channel_id is distinct from target_channel_id then
    raise exception 'safety domain rule not found' using errcode = 'P0002';
  end if;

  delete from public.safety_domain_rules where id = target_rule_id;
end
$$;

revoke execute on function app_private.delete_url_domain_rule(uuid, uuid) from public;
grant execute on function app_private.delete_url_domain_rule(uuid, uuid) to bsa_app;

-- ============================================================
-- SAF-12 -- PII DETECTION: THE TABLE IS SHAPED SO IT CANNOT HOLD A
-- DETECTED VALUE, EVER.
-- ============================================================
-- S12.10's rule, restated for detection rather than moderation action:
-- "detecting must never mean storing". `safety_pii_detections` has no
-- text/value/match column of ANY kind -- there is nothing here for a
-- phone number, UPI ID, email, address or card-like string to be
-- written INTO even if a caller tried. `pii_classes` can only ever hold
-- the five fixed class names below (CHECK-enforced, not a free-text
-- column) -- a caller attempting to smuggle a detected value through
-- this column is rejected by the CHECK before the row can exist, proven
-- behaviourally in packages/db/tests/saf_url_ssml_pii.sql.
--
-- Deliberately NOT a variant of safety_moderation_actions (0151): that
-- table's own CHECK (coalesce(array_length(matched_term_ids, 1), 0) >=
-- 1) requires a corpus-term match to exist before a row can be written,
-- and its original_text/normalised_text columns exist because SAF-04
-- requires the corpus-match evidence snapshot to never lose the
-- original -- reusing those columns for a PII-only detection (which may
-- have no corpus-term match at all) would mean writing the very message
-- text SAF-12 exists to keep out of storage. A separate, narrower table
-- keeps the two guarantees (SAF-04's "original is never destroyed" for
-- ACTIONED corpus matches, and SAF-12's "a detected value is never
-- written anywhere") from ever being able to contradict each other.
create table public.safety_pii_detections (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id),
  pii_classes text[] not null check (
    coalesce(array_length(pii_classes, 1), 0) >= 1
    and pii_classes <@ array['phone', 'upi_id', 'email', 'address_pin_code', 'card_like']::text[]
  ),
  created_at timestamptz not null default current_timestamp
);

comment on table public.safety_pii_detections is
  'SAF-12/S12.10 (migration 0154). Records THAT a PII class was found, never the value found -- there is no text/value column on this table of any kind, and pii_classes is CHECK-constrained to five fixed class names, so a detected phone number, UPI ID, email, address or card-like string cannot be written into this table even by a calling bug, not merely by discipline.';

create index safety_pii_detections_channel_idx
  on public.safety_pii_detections (channel_id, created_at desc);

alter table public.safety_pii_detections enable row level security;
revoke all on public.safety_pii_detections from public;
revoke all on public.safety_pii_detections from bsa_app;

-- Write-only in this phase, on purpose -- there is no creator-facing
-- config for PII detection (it is a fixed algorithm, apps/api/src/
-- domain/pii-detection.ts, not creator-editable data like the corpus or
-- domain rules), so there is nothing for an HTTP route to manage and
-- none is added, the same "data-layer primitive only, no HTTP surface"
-- posture 0151 already used for global corpus management. No channel-
-- role gate on insertion -- this function is called by trusted backend
-- pipeline code, not directly by a channel member, the identical
-- posture app_private.record_safety_moderation_action (0151) already
-- takes for the same reason. NO TypeScript store wraps this function in
-- this phase either -- 0151 built no TS adapter for its own
-- record_safety_moderation_action (grep confirms: no caller of it
-- exists anywhere in apps/api/src to this day), and this migration
-- follows that exact precedent rather than inventing a wrapper with no
-- consumer and no way to be exercised outside a direct SQL call. This
-- function is proven directly in packages/db/tests/saf_url_ssml_pii.sql.
create or replace function app_private.record_pii_detection(
  target_channel_id uuid,
  target_pii_classes text[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_id uuid;
begin
  insert into public.safety_pii_detections (channel_id, pii_classes)
  values (target_channel_id, target_pii_classes)
  returning id into new_id;

  return new_id;
end
$$;

revoke execute on function app_private.record_pii_detection(uuid, text[]) from public;
grant execute on function app_private.record_pii_detection(uuid, text[]) to bsa_app;

-- ROLLBACK: additive only, no production migration without separate
-- explicit approval.
--   drop function if exists app_private.record_pii_detection(uuid, text[]);
--   drop table if exists public.safety_pii_detections;
--   drop function if exists app_private.delete_url_domain_rule(uuid, uuid);
--   drop function if exists app_private.create_url_domain_rule(uuid, text, text);
--   drop function if exists app_private.get_url_domain_rules(uuid);
--   drop table if exists public.safety_domain_rules;
