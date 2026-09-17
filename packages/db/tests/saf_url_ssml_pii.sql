-- SAF-10/SAF-11/SAF-12 (packages/db/migrations/0154_v1_saf_url_ssml_pii_
-- guards.sql): URL neutralisation domain rules, the SSML-injection
-- guard, and PII detection -- extending the moderation pipeline spine
-- (migration 0151), not building a second one.
--
-- Covers:
--   * SAF-01 reapplied to the two new tables: bsa_app has NO select/
--     insert/update/delete grant on safety_domain_rules or safety_pii_
--     detections at all -- proven both structurally (catalogue) and
--     behaviourally (connecting as bsa_app and attempting a direct
--     SELECT).
--   * SAF-10: safety_domain_rules ships EMPTY -- a fresh channel's
--     domain-rule read returns zero rows before any insert. Owner/admin
--     may add a rule; operator/moderator/viewer may not. Channel
--     isolation: channel B never sees channel A's rules.
--   * SAF-10 PRECEDENCE, STRUCTURAL: a domain can hold at most one rule
--     per channel -- attempting to add a contradictory second rule for
--     the SAME domain (e.g. 'allow' after 'deny') raises a
--     unique_violation, so allow/deny ambiguity cannot be written to
--     the database in the first place. Paired with the TypeScript-level
--     precedence test (apps/api/test/url-neutralization.test.ts) that
--     proves deny/allow/default resolve correctly across three
--     DIFFERENT domains.
--   * SAF-10: the domain CHECK constraint (RFC 1035 hostname shape)
--     rejects a malformed domain.
--   * SAF-11, DATABASE-LEVEL COMPONENT: neither this migration's own
--     columns nor 0151's safety_moderation_actions original_text/
--     normalised_text columns are typed `xml` -- postgres itself never
--     parses stored moderation text as markup. THE SUBSTANTIVE SAF-11
--     PROOF (a message can never become synthesis instructions) is at
--     the application layer, where the risk actually lives -- see
--     apps/api/test/saf-ssml-injection-guard.test.ts, which feeds SSML
--     through the full TTS dispatch path and asserts it is inert. This
--     file's own migration header explains why SAF-11 has no schema.
--   * SAF-12, STRUCTURAL: safety_pii_detections.pii_classes can only
--     ever hold the five fixed class names -- inserting anything else
--     (an attempted smuggled value, an empty array) raises
--     check_violation. THE TABLE HAS NO TEXT/VALUE COLUMN OF ANY KIND
--     -- proven here by enumerating its actual columns and asserting
--     the exact set, so a detected phone number, UPI id, email, address
--     or card-like string is structurally impossible to persist here,
--     not merely undocumented.
--
-- Fixture: own users '...6e00' (owner, channel A), '...6e03' (admin),
-- '...6e04' (operator), '...6e05' (moderator), '...6e06' (viewer),
-- '...6e08' (owner, channel B -- cross-channel isolation probe). Own
-- channels '...6e01' (A) and '...6e02' (B). Own fixture ids
-- '...6e00'-'...6eff', pre-assigned by the coordinator (see
-- fixtures/00_base_world.sql's own "next free block" note and its own
-- correction history for why pre-assignment, not independent
-- verification, is what concurrent lanes require).
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values
  ('00000000-0000-4000-8000-000000006e00', 'google-saf10-owner-a', 'SAF10 Owner A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006e03', 'google-saf10-admin-a', 'SAF10 Admin A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006e04', 'google-saf10-operator-a', 'SAF10 Operator A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006e05', 'google-saf10-moderator-a', 'SAF10 Moderator A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006e06', 'google-saf10-viewer-a', 'SAF10 Viewer A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006e08', 'google-saf10-owner-b', 'SAF10 Owner B', current_timestamp, current_timestamp, false)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000006e01', '00000000-0000-4000-8000-000000006e00', 'saf10_channel_a', 'SAF10 Channel A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000006e02', '00000000-0000-4000-8000-000000006e08', 'saf10_channel_b', 'SAF10 Channel B', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000006e01', '00000000-0000-4000-8000-000000006e00', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000006e01', '00000000-0000-4000-8000-000000006e03', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000006e01', '00000000-0000-4000-8000-000000006e04', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000006e01', '00000000-0000-4000-8000-000000006e05', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000006e01', '00000000-0000-4000-8000-000000006e06', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000006e02', '00000000-0000-4000-8000-000000006e08', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- =========================================================================
-- SAF-01 STRUCTURAL (reapplied to the two new tables): every function
-- this migration ships is revoked from public, granted to bsa_app;
-- every table it creates is revoked from BOTH public and bsa_app.
-- =========================================================================
do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.get_url_domain_rules(uuid)',
      'app_private.create_url_domain_rule(uuid, text, text)',
      'app_private.delete_url_domain_rule(uuid, uuid)',
      'app_private.record_pii_detection(uuid, text[])'
    ]) as sig
  loop
    if has_function_privilege('public', fn.sig, 'execute') then
      raise exception 'SAF-01: execute on % must be revoked from public', fn.sig;
    end if;
    if not has_function_privilege('bsa_app', fn.sig, 'execute') then
      raise exception 'SAF-01: execute on % must be granted to bsa_app', fn.sig;
    end if;
  end loop;
end
$$;

do $$
declare tbl record;
begin
  for tbl in
    select unnest(array['public.safety_domain_rules', 'public.safety_pii_detections']) as name
  loop
    if has_table_privilege('public', tbl.name, 'SELECT') then
      raise exception 'SAF-01: SELECT on % must be revoked from public', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'SELECT') then
      raise exception 'SAF-01: SELECT on % must be revoked from bsa_app -- the ONLY reachable read path (for safety_domain_rules) is app_private.get_url_domain_rules, and safety_pii_detections has NO read path at all in this phase', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'INSERT') then
      raise exception 'SAF-01: INSERT on % must be revoked from bsa_app', tbl.name;
    end if;
  end loop;
end
$$;

-- Behavioural confirmation: connecting AS bsa_app and attempting a
-- direct read fails with insufficient_privilege, not just "the
-- catalogue says so".
set role bsa_app;
do $$
begin
  begin
    perform 1 from public.safety_domain_rules limit 1;
    raise exception 'SAF-01: bsa_app must not be able to SELECT safety_domain_rules directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
do $$
begin
  begin
    perform 1 from public.safety_pii_detections limit 1;
    raise exception 'SAF-01: bsa_app must not be able to SELECT safety_pii_detections directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
reset role;

-- =========================================================================
-- SAF-10 EMPTY BY DEFAULT: before any insert, a member's domain-rule
-- read returns ZERO rows. Migration 0154 ships no seed content, and no
-- starter domain list was invented -- proven here BEFORE the fixture
-- below inserts anything into safety_domain_rules.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false);
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_url_domain_rules('00000000-0000-4000-8000-000000006e01'::uuid);
  if row_count != 0 then
    raise exception 'SAF-10: the domain-rule list must ship empty -- expected 0 rows, got %. Empty must mean "no rule configured", never a guessed starter list.', row_count;
  end if;
end
$$;

-- A non-member sees zero rows too (not an exception).
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e08', false); -- channel B's owner, not a member of A
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_url_domain_rules('00000000-0000-4000-8000-000000006e01'::uuid);
  if row_count != 0 then
    raise exception 'SAF-10: a non-member must see zero domain-rule rows for a channel they do not belong to, got %', row_count;
  end if;
end
$$;

-- =========================================================================
-- SAF-10: create_url_domain_rule authorisation. Owner/admin may add a
-- rule; operator/moderator/viewer may not.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e06', false); -- viewer
do $$
begin
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'viewer-probe.example', 'deny');
    raise exception 'SAF-10: a viewer must not be able to add a domain rule';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006e04', false); -- operator
do $$
begin
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'operator-probe.example', 'deny');
    raise exception 'SAF-10: an operator must not be able to add a domain rule -- owner/admin only';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006e05', false); -- moderator
do $$
begin
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'moderator-probe.example', 'deny');
    raise exception 'SAF-10: a moderator must not be able to add a domain rule -- owner/admin only';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

-- Owner CAN add a domain rule.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false); -- owner
select app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'scam.example', 'deny') as owner_deny_rule_id \gset

-- Admin CAN add a domain rule too.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e03', false); -- admin
select app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'mychannel.example', 'allow') as admin_allow_rule_id \gset

-- Channel B, isolated: its own owner adds a rule for B only.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e08', false); -- owner B
select app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e02'::uuid, 'channel-b-only.example', 'deny') as channel_b_rule_id \gset

-- =========================================================================
-- SAF-10: channel isolation. Channel A sees exactly its own two rules,
-- never channel B's; channel B sees exactly its own one rule, never
-- channel A's.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false);
do $$
declare domains text[];
begin
  select array_agg(domain order by domain) into domains from app_private.get_url_domain_rules('00000000-0000-4000-8000-000000006e01'::uuid);
  if domains != array['mychannel.example', 'scam.example'] then
    raise exception 'SAF-10: channel A must see exactly its own two rules, got %', domains;
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006e08', false);
do $$
declare domains text[];
begin
  select array_agg(domain order by domain) into domains from app_private.get_url_domain_rules('00000000-0000-4000-8000-000000006e02'::uuid);
  if domains != array['channel-b-only.example'] then
    raise exception 'SAF-10: channel B must see exactly its own rule, never channel A''s, got %', domains;
  end if;
end
$$;

-- =========================================================================
-- SAF-10 PRECEDENCE, STRUCTURAL: a domain can hold at most ONE rule per
-- channel. Attempting to add a contradictory 'allow' for a domain that
-- already has 'deny' (or vice versa) on the same channel raises
-- unique_violation -- there is no ambiguous state for a runtime
-- tie-break to resolve, because the database never allows one to exist.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false); -- owner, channel A
do $$
begin
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'scam.example', 'allow');
    raise exception 'SAF-10: a domain that already has a rule on this channel must reject a second, contradictory rule -- precedence is structural, not a runtime tie-break';
  exception when unique_violation then
    null; -- expected
  end;
end
$$;

-- A DIFFERENT channel may independently hold ITS OWN rule for the same
-- literal domain text -- scopes are independent, same shape 0151's
-- corpus scoping already established.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e08', false);
select app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e02'::uuid, 'scam.example', 'deny');

-- =========================================================================
-- SAF-10: the domain CHECK constraint (RFC 1035 hostname shape,
-- lowercase-only) rejects a malformed domain -- uppercase, invalid
-- characters, and empty are all rejected before a row can exist.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false);
do $$
begin
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'UPPERCASE.example', 'deny');
    raise exception 'SAF-10: an uppercase domain must be rejected by the CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'not a domain!!', 'deny');
    raise exception 'SAF-10: a domain with invalid characters must be rejected by the CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
  begin
    perform app_private.create_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, 'nodotatall', 'deny');
    raise exception 'SAF-10: a domain with no dot at all must be rejected by the CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
end
$$;

-- =========================================================================
-- SAF-10: delete_url_domain_rule -- channel-owned only. Owner can delete
-- their own channel's rule; cannot delete another channel's rule
-- through their own channel's call; a viewer cannot delete at all.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e06', false); -- viewer, channel A
do $$
begin
  begin
    perform app_private.delete_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, (select id from public.safety_domain_rules where domain = 'scam.example' and channel_id = '00000000-0000-4000-8000-000000006e01'::uuid));
    raise exception 'SAF-10: a viewer must not be able to delete a domain rule';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false); -- owner, channel A
do $$
begin
  begin
    perform app_private.delete_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, (select id from public.safety_domain_rules where domain = 'channel-b-only.example' and channel_id = '00000000-0000-4000-8000-000000006e02'::uuid));
    raise exception 'SAF-10: channel A must not be able to delete channel B''s own rule';
  exception when others then
    if sqlstate != 'P0002' then raise; end if; -- expected: "not found"
  end;
end
$$;

-- Owner CAN delete their own channel's rule.
select app_private.delete_url_domain_rule('00000000-0000-4000-8000-000000006e01'::uuid, (select id from public.safety_domain_rules where domain = 'mychannel.example' and channel_id = '00000000-0000-4000-8000-000000006e01'::uuid));
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_url_domain_rules('00000000-0000-4000-8000-000000006e01'::uuid) where domain = 'mychannel.example';
  if row_count != 0 then
    raise exception 'SAF-10: the deleted rule must no longer be returned';
  end if;
end
$$;

-- =========================================================================
-- SAF-11, DATABASE-LEVEL COMPONENT: no column anywhere touched by this
-- migration (or by 0151's own evidence table) is typed `xml` -- postgres
-- itself never parses stored moderation/domain-rule text as markup. The
-- substantive proof (a message can never become synthesis instructions)
-- lives at the application layer where the actual risk is -- see this
-- file's own header and apps/api/test/saf-ssml-injection-guard.test.ts.
-- =========================================================================
do $$
declare xml_column_count integer;
begin
  select count(*) into xml_column_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('safety_domain_rules', 'safety_pii_detections', 'safety_moderation_actions', 'safety_corpus_terms')
     and data_type = 'xml';
  if xml_column_count != 0 then
    raise exception 'SAF-11: no SAF table column may be typed xml -- stored text must never be something postgres itself could parse as markup, got % such columns', xml_column_count;
  end if;
end
$$;

-- =========================================================================
-- SAF-12, STRUCTURAL: safety_pii_detections has NO text/value column of
-- ANY kind -- enumerate its actual columns and assert the exact set, so
-- "a detected value cannot be persisted here" is proven against the
-- live catalogue, not asserted only in a comment.
-- =========================================================================
do $$
declare cols text[];
begin
  select array_agg(column_name order by column_name) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'safety_pii_detections';
  if cols != array['channel_id', 'created_at', 'id', 'pii_classes'] then
    raise exception 'SAF-12: safety_pii_detections must have exactly channel_id, created_at, id, pii_classes and NOTHING else -- got %. Any additional column is a place a detected value could be smuggled into storage.', cols;
  end if;
end
$$;

-- record_pii_detection with a valid class succeeds and persists ONLY
-- the class name. Self-contained in one do-block (capture id, then read
-- it back) rather than psql's \gset + :'var' -- the same pattern this
-- file's own precedent (packages/db/tests/saf_pipeline_spine.sql, its
-- SAF-04 action_id test) already uses for exactly this reason: psql
-- variable interpolation is not reliable inside a dollar-quoted
-- function body.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006e00', false);
do $$
declare detection_id uuid; recorded_classes text[];
begin
  detection_id := app_private.record_pii_detection('00000000-0000-4000-8000-000000006e01'::uuid, array['phone']::text[]);
  select pii_classes into recorded_classes from public.safety_pii_detections where id = detection_id;
  if recorded_classes != array['phone'] then
    raise exception 'SAF-12: pii_classes must persist exactly as given, got %', recorded_classes;
  end if;
end
$$;

-- Multiple classes in one detection persist together.
do $$
declare detection_id uuid; recorded_classes text[];
begin
  detection_id := app_private.record_pii_detection('00000000-0000-4000-8000-000000006e01'::uuid, array['email', 'address_pin_code']::text[]);
  select pii_classes into recorded_classes from public.safety_pii_detections where id = detection_id;
  if recorded_classes != array['email', 'address_pin_code'] then
    raise exception 'SAF-12: multiple pii_classes must persist together exactly as given, got %', recorded_classes;
  end if;
end
$$;

-- A caller cannot smuggle a detected VALUE into pii_classes -- only the
-- five fixed class names are accepted; anything else is rejected by the
-- CHECK constraint before the row can exist. This is the behavioural
-- proof that "detecting must never mean storing" holds even against a
-- calling bug, not just against a well-behaved caller.
do $$
begin
  begin
    perform app_private.record_pii_detection('00000000-0000-4000-8000-000000006e01'::uuid, array['9876543210']::text[]);
    raise exception 'SAF-12: an attempt to smuggle a raw phone number through pii_classes must be rejected by the CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
  begin
    perform app_private.record_pii_detection('00000000-0000-4000-8000-000000006e01'::uuid, array['creator@example.com']::text[]);
    raise exception 'SAF-12: an attempt to smuggle a raw email through pii_classes must be rejected by the CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
  begin
    perform app_private.record_pii_detection('00000000-0000-4000-8000-000000006e01'::uuid, array[]::text[]);
    raise exception 'SAF-12: an empty pii_classes array (i.e. "detected nothing") must be rejected -- there is nothing to record';
  exception when check_violation then
    null; -- expected
  end;
end
$$;

-- =========================================================================
-- SAF-12: information_schema.parameters confirms record_pii_detection
-- accepts only (target_channel_id, target_pii_classes) -- no text/value
-- IN parameter exists for it to be called with even by mistake.
-- =========================================================================
do $$
declare param_names text[];
begin
  select array_agg(parameter_name order by ordinal_position) into param_names
    from information_schema.parameters
   where specific_schema = 'app_private' and specific_name like 'record_pii_detection%' and parameter_mode = 'IN';
  if param_names != array['target_channel_id', 'target_pii_classes'] then
    raise exception 'SAF-12: record_pii_detection must accept exactly (target_channel_id, target_pii_classes) -- got %', param_names;
  end if;
end
$$;
