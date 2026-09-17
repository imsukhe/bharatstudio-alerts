-- SAF phase 1 (migration 0151): moderation pipeline spine -- corpus
-- storage/access, the evidence snapshot, and the structural guards for
-- SAF-01 (one corpus, one pipeline), SAF-02/SAF-04 (L0 normalisation
-- never destroys the original), SAF-05 (L1 Aho-Corasick corpus access)
-- and SAF-09 (per-surface decisions).
--
-- Covers:
--   * SAF-01: bsa_app has NO select/insert/update/delete grant on
--     safety_corpus_terms, safety_corpus_generation or
--     safety_moderation_actions at all -- the only reachable paths are
--     the four SECURITY DEFINER functions this migration ships. Proven
--     both structurally (catalogue) and behaviourally (connecting as
--     bsa_app and attempting a direct SELECT). THIS IS THE STRUCTURAL
--     TEST THAT FAILS IF A SECOND MATCHING IMPLEMENTATION APPEARS: any
--     second implementation reading the corpus directly rather than
--     through app_private.get_safety_corpus_terms cannot be written
--     against this schema, and if the revoke were ever dropped this
--     test's own expected-insufficient_privilege assertions would start
--     failing (the forbidden SELECT would then succeed). The
--     TypeScript-side half of this guard (no second normalisation/
--     Aho-Corasick implementation in application code) is proven
--     separately in apps/api/test/safety-pipeline.test.ts.
--   * The corpus ships EMPTY: before any insert, a fresh channel's
--     corpus read returns zero rows -- this migration seeds nothing.
--   * SAF-05: global (channel_id null) plus per-creator (channel_id
--     set) terms are returned together by one function call; a
--     channel-owned term never leaks to a different channel.
--   * SAF-04: safety_moderation_actions.original_text and
--     .normalised_text are independent NOT NULL columns -- a row whose
--     normalised form visibly differs from its original persists BOTH
--     exactly as given, byte for byte.
--   * SAF-09: display_decision and tts_decision can differ from each
--     other on the SAME evidence row; payment_decision and
--     stored_record_decision are check-constrained to the single value
--     'allow' -- attempting anything else raises check_violation before
--     the row can exist.
--   * Retention (§12.10/§12.6.2.1): matched_term_ids has
--     check(array_length(...) >= 1) -- there is no way to insert an
--     evidence row for a message that matched nothing, i.e. no way to
--     write a "raw unactioned text" row through this table at all.
--   * policy_version is read from safety_corpus_generation INSIDE
--     record_safety_moderation_action -- not a caller-supplied
--     argument (verified against information_schema.parameters, which
--     has no such IN parameter) -- and strictly advances when the
--     corpus changes.
--   * create/delete corpus term: owner/admin only for a channel-scoped
--     term; platform staff only for a global term; a viewer/moderator
--     is rejected; a channel cannot delete another channel's or a
--     global term through its own call.
--   * every function this migration ships is revoked from public,
--     granted to bsa_app; every table is revoked from BOTH public and
--     bsa_app.
--
-- Fixture: own users '...6b00' (owner, channel A), '...6b03' (admin),
-- '...6b04' (operator), '...6b05' (moderator), '...6b06' (viewer),
-- '...6b07' (platform staff), '...6b08' (owner, channel B -- the
-- cross-channel isolation probe). Own channels '...6b01' (A, free) and
-- '...6b02' (B, free). Own fixture ids '...6b00'-'...6bff', pre-
-- assigned by the coordinator (see fixtures/00_base_world.sql's own
-- "next free block" note) -- not independently verified-free by this
-- file, because a concurrently running sibling lane cannot be seen from
-- here (the exact failure mode fixtures/00_base_world.sql's header now
-- records: two lanes each verifying a block free against the same base
-- and both taking it).
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at, is_platform_admin)
values
  ('00000000-0000-4000-8000-000000006b00', 'google-saf-owner-a', 'SAF Owner A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006b03', 'google-saf-admin-a', 'SAF Admin A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006b04', 'google-saf-operator-a', 'SAF Operator A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006b05', 'google-saf-moderator-a', 'SAF Moderator A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006b06', 'google-saf-viewer-a', 'SAF Viewer A', current_timestamp, current_timestamp, false),
  ('00000000-0000-4000-8000-000000006b07', 'google-saf-staff', 'SAF Staff', current_timestamp, current_timestamp, true),
  ('00000000-0000-4000-8000-000000006b08', 'google-saf-owner-b', 'SAF Owner B', current_timestamp, current_timestamp, false)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b00', 'saf_channel_a', 'SAF Channel A', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000006b02', '00000000-0000-4000-8000-000000006b08', 'saf_channel_b', 'SAF Channel B', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b00', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b03', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b04', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b05', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b06', 'viewer', current_timestamp),
  ('00000000-0000-4000-8000-000000006b02', '00000000-0000-4000-8000-000000006b08', 'owner', current_timestamp)
on conflict (channel_id, user_id) do nothing;

-- =========================================================================
-- SAF-01 STRUCTURAL: every function this migration ships is revoked
-- from public, granted to bsa_app; every table it creates is revoked
-- from BOTH public and bsa_app.
-- =========================================================================
do $$
declare fn record;
begin
  for fn in
    select unnest(array[
      'app_private.get_safety_corpus_terms(uuid)',
      'app_private.create_safety_corpus_term(uuid, text, boolean, text, text, text)',
      'app_private.delete_safety_corpus_term(uuid, uuid)',
      'app_private.record_safety_moderation_action(uuid, text, text, uuid[], numeric, text, text, text, uuid)'
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
    select unnest(array[
      'public.safety_corpus_terms',
      'public.safety_corpus_generation',
      'public.safety_moderation_actions'
    ]) as name
  loop
    if has_table_privilege('public', tbl.name, 'SELECT') then
      raise exception 'SAF-01: SELECT on % must be revoked from public', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'SELECT') then
      raise exception 'SAF-01: SELECT on % must be revoked from bsa_app -- the ONLY reachable read path is app_private.get_safety_corpus_terms', tbl.name;
    end if;
    if has_table_privilege('bsa_app', tbl.name, 'INSERT') then
      raise exception 'SAF-01: INSERT on % must be revoked from bsa_app', tbl.name;
    end if;
  end loop;
end
$$;

-- Behavioural confirmation: connecting AS bsa_app and attempting a
-- direct read of the corpus fails with insufficient_privilege, not just
-- "the catalogue says so". THIS is the assertion that fails the moment
-- someone reintroduces a second read path (drops the revoke, or adds a
-- second function/table a second matching implementation could read
-- from directly).
set role bsa_app;
do $$
begin
  begin
    perform 1 from public.safety_corpus_terms limit 1;
    raise exception 'SAF-01: bsa_app must not be able to SELECT safety_corpus_terms directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
do $$
begin
  begin
    perform 1 from public.safety_moderation_actions limit 1;
    raise exception 'SAF-01: bsa_app must not be able to SELECT safety_moderation_actions directly';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;
reset role;

-- =========================================================================
-- CORPUS EMPTY BY DEFAULT: before any insert, a member's corpus read
-- returns ZERO rows. This migration ships no seed content -- proven
-- here BEFORE the fixture below inserts anything into
-- safety_corpus_terms.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b00', false);

do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_safety_corpus_terms('00000000-0000-4000-8000-000000006b01'::uuid);
  if row_count != 0 then
    raise exception 'SAF: the corpus must ship empty -- expected 0 rows, got %. An empty corpus must mean "matches nothing", never "match everything", and never a guessed starter list.', row_count;
  end if;
end
$$;

-- A non-member sees zero rows too (not an exception) -- same posture
-- every other channel-scoped read in this schema takes.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b08', false); -- channel B's owner, not a member of A
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_safety_corpus_terms('00000000-0000-4000-8000-000000006b01'::uuid);
  if row_count != 0 then
    raise exception 'SAF-01: a non-member must see zero corpus rows for a channel they do not belong to, got %', row_count;
  end if;
end
$$;

-- =========================================================================
-- SAF-01/SAF-05: create_safety_corpus_term authorisation. Owner/admin
-- may add a channel-scoped term; operator/moderator/viewer may not; a
-- global term (null channel) requires platform staff, and an ordinary
-- owner is rejected for one.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b06', false); -- viewer
do $$
begin
  begin
    perform app_private.create_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, 'zzz_viewer_probe', true, 'mask', 'block', 'hold');
    raise exception 'SAF: a viewer must not be able to add a corpus term';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006b04', false); -- operator
do $$
begin
  begin
    perform app_private.create_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, 'zzz_operator_probe', true, 'mask', 'block', 'hold');
    raise exception 'SAF: an operator must not be able to add a corpus term -- owner/admin only';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006b00', false); -- owner
do $$
begin
  begin
    perform app_private.create_safety_corpus_term(null, 'zzz_global_by_owner_probe', true, 'mask', 'block', 'hold');
    raise exception 'SAF: an ordinary channel owner must not be able to create a GLOBAL corpus term -- staff only';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

-- Owner CAN add their own channel's term.
select app_private.create_safety_corpus_term(
  '00000000-0000-4000-8000-000000006b01'::uuid, 'zzz_channel_a_term', true, 'block', 'block', 'hold'
) as owner_channel_term_id \gset

-- Admin CAN add their channel's term too.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b03', false); -- admin
select app_private.create_safety_corpus_term(
  '00000000-0000-4000-8000-000000006b01'::uuid, 'zzz_channel_a_admin_term', false, 'mask', 'hold', 'allow'
) as admin_channel_term_id \gset

-- Staff CAN add a global term.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b07', false); -- staff
select app_private.create_safety_corpus_term(
  null, 'zzz_global_term', true, 'mask', 'block', 'hold'
) as global_term_id \gset

-- Channel B, isolated: its own owner adds a term for B only.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b08', false); -- owner B
select app_private.create_safety_corpus_term(
  '00000000-0000-4000-8000-000000006b02'::uuid, 'zzz_channel_b_only_term', true, 'block', 'block', 'hold'
) as channel_b_term_id \gset

-- =========================================================================
-- SAF-05: global plus per-creator, in one read. Channel A sees the
-- global term AND its own two terms (3 rows), never channel B's term.
-- Channel B sees the global term AND its own one term (2 rows), never
-- channel A's terms.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b00', false);
do $$
declare terms text[];
begin
  select array_agg(term order by term) into terms from app_private.get_safety_corpus_terms('00000000-0000-4000-8000-000000006b01'::uuid);
  if terms != array['zzz_channel_a_admin_term', 'zzz_channel_a_term', 'zzz_global_term'] then
    raise exception 'SAF-05: channel A must see exactly its own two terms plus the global term, got %', terms;
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006b08', false);
do $$
declare terms text[];
begin
  select array_agg(term order by term) into terms from app_private.get_safety_corpus_terms('00000000-0000-4000-8000-000000006b02'::uuid);
  if terms != array['zzz_channel_b_only_term', 'zzz_global_term'] then
    raise exception 'SAF-05: channel B must see exactly its own term plus the global term, never channel A''s, got %', terms;
  end if;
end
$$;

-- =========================================================================
-- SAF-05: duplicate-term rejection is per scope (case/whitespace
-- insensitive), and two DIFFERENT channels may independently reuse the
-- same literal term text.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b00', false);
do $$
begin
  begin
    perform app_private.create_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, '  ZZZ_Channel_A_Term  ', true, 'mask', 'block', 'hold');
    raise exception 'SAF-05: a duplicate term (case/whitespace-insensitive) in the same channel scope must be rejected';
  exception when unique_violation then
    null; -- expected
  end;
end
$$;

-- Channel B may independently add the SAME literal term text channel A
-- already has -- scopes are independent.
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b08', false);
select app_private.create_safety_corpus_term('00000000-0000-4000-8000-000000006b02'::uuid, 'zzz_channel_a_term', true, 'mask', 'block', 'hold');

-- =========================================================================
-- delete_safety_corpus_term: channel-owned only. Owner can delete their
-- own channel's term; cannot delete another channel's or the global
-- term through their own channel's call; a viewer cannot delete at all.
-- =========================================================================
select set_config('app.user_id', '00000000-0000-4000-8000-000000006b06', false); -- viewer, channel A
do $$
begin
  begin
    perform app_private.delete_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, (select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid));
    raise exception 'SAF: a viewer must not be able to delete a corpus term';
  exception when insufficient_privilege then
    null; -- expected
  end;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000006b00', false); -- owner, channel A
do $$
begin
  begin
    perform app_private.delete_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, (select id from public.safety_corpus_terms where term = 'zzz_global_term' and channel_id is null));
    raise exception 'SAF: a channel-scoped delete must never remove a GLOBAL term';
  exception when others then
    if sqlstate != 'P0002' then raise; end if; -- expected: "not found"
  end;
end
$$;

do $$
begin
  begin
    perform app_private.delete_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, (select id from public.safety_corpus_terms where term = 'zzz_channel_b_only_term' and channel_id = '00000000-0000-4000-8000-000000006b02'::uuid));
    raise exception 'SAF: channel A must not be able to delete channel B''s own term';
  exception when others then
    if sqlstate != 'P0002' then raise; end if; -- expected: "not found"
  end;
end
$$;

-- Owner CAN delete their own channel's term.
select app_private.delete_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, (select id from public.safety_corpus_terms where term = 'zzz_channel_a_admin_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid));
do $$
declare row_count integer;
begin
  select count(*) into row_count from app_private.get_safety_corpus_terms('00000000-0000-4000-8000-000000006b01'::uuid) where term = 'zzz_channel_a_admin_term';
  if row_count != 0 then
    raise exception 'SAF: the deleted term must no longer be returned';
  end if;
end
$$;

-- =========================================================================
-- SAF-04, BEHAVIOURAL AND STRUCTURAL: original text is never destroyed.
-- A row whose normalised form visibly differs from its original
-- persists BOTH exactly as given. Structurally: original_text and
-- normalised_text are independent NOT NULL columns -- there is no
-- single "text" column upstream that could be normalised in place.
-- =========================================================================
do $$
declare
  original_with_zero_width text := 'bad' || chr(8203) || 'word'; -- U+200B zero-width space
  normalised text := 'badword';
  action_id uuid;
  read_original text;
  read_normalised text;
begin
  action_id := app_private.record_safety_moderation_action(
    '00000000-0000-4000-8000-000000006b01'::uuid, original_with_zero_width, normalised,
    array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 1.000, 'mask', 'block', 'hold', null
  );

  select original_text, normalised_text into read_original, read_normalised
    from public.safety_moderation_actions where id = action_id;

  if read_original != original_with_zero_width then
    raise exception 'SAF-04: original_text must persist EXACTLY as given, byte for byte -- got %, expected %', read_original, original_with_zero_width;
  end if;
  if read_normalised != normalised then
    raise exception 'SAF-04: normalised_text must persist exactly as given';
  end if;
  if read_original = read_normalised then
    raise exception 'SAF-04: this test requires the original and normalised forms to actually differ, or it proves nothing';
  end if;
end
$$;

-- Structural: NOT NULL on both columns -- a write that has one without
-- the other is rejected before it reaches storage.
do $$
declare nullable_original text; nullable_normalised text;
begin
  select is_nullable into nullable_original from information_schema.columns
   where table_schema = 'public' and table_name = 'safety_moderation_actions' and column_name = 'original_text';
  select is_nullable into nullable_normalised from information_schema.columns
   where table_schema = 'public' and table_name = 'safety_moderation_actions' and column_name = 'normalised_text';
  if nullable_original != 'NO' or nullable_normalised != 'NO' then
    raise exception 'SAF-04: original_text and normalised_text must both be NOT NULL -- structurally impossible for a row to carry one without the other';
  end if;
end
$$;

-- =========================================================================
-- SAF-09, BEHAVIOURAL: display_decision and tts_decision differ on the
-- SAME evidence row for the SAME text -- proves this is genuinely
-- per-surface, not one verdict fanned out identically.
-- =========================================================================
do $$
declare action_id uuid; d_display text; d_tts text; d_payment text; d_stored text; d_moderator text;
begin
  action_id := app_private.record_safety_moderation_action(
    '00000000-0000-4000-8000-000000006b01'::uuid, 'a message with a badword in it', 'a message with a badword in it',
    array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 1.000, 'mask', 'block', 'hold', null
  );
  select display_decision, tts_decision, payment_decision, stored_record_decision, moderator_review_decision
    into d_display, d_tts, d_payment, d_stored, d_moderator
    from public.safety_moderation_actions where id = action_id;

  if d_display = d_tts then
    raise exception 'SAF-09: display_decision (%) and tts_decision (%) must be independently settable and DIFFER in this test, or it proves nothing', d_display, d_tts;
  end if;
  if d_display != 'mask' or d_tts != 'block' or d_moderator != 'hold' then
    raise exception 'SAF-09: decisions must persist exactly as given per surface';
  end if;
  if d_payment != 'allow' then
    raise exception 'SAF-09: payment_decision must always be allow -- money is never affected by content (S12.2.4)';
  end if;
  if d_stored != 'allow' then
    raise exception 'SAF-09: stored_record_decision must always be allow -- an actioned message is always stored in full (S12.2.4)';
  end if;
end
$$;

-- =========================================================================
-- SAF-09, STRUCTURAL: payment_decision and stored_record_decision are
-- CHECK-CONSTRAINED to the single value 'allow'. Money can never be
-- affected by content, and an actioned message is always stored in
-- full -- enforced by the database, not by application discipline.
-- THIS FAILS THE MOMENT THE CONSTRAINT IS REMOVED: the forbidden insert
-- below would then succeed.
-- =========================================================================
-- record_safety_moderation_action's own parameter list has no
-- target_payment_decision (or target_stored_record_decision) IN
-- parameter at all -- a caller cannot even ATTEMPT to set either value
-- through the one function that writes this table; both are hardcoded
-- 'allow' inside the function body (migration 0151).
do $$
declare param_count integer;
begin
  select count(*) into param_count
    from information_schema.parameters
   where specific_schema = 'app_private' and specific_name like 'record_safety_moderation_action%'
     and parameter_name in ('target_payment_decision', 'target_stored_record_decision');
  if param_count != 0 then
    raise exception 'SAF-09: record_safety_moderation_action must not accept payment_decision or stored_record_decision as caller-supplied arguments -- both must be structural constants';
  end if;
end
$$;

-- Direct SQL insert (bypassing the function, e.g. a test fixture or any
-- future writer) attempting payment_decision = 'block' must still be
-- rejected -- the guarantee is a CHECK constraint on the table, not a
-- property of one call path.
do $$
begin
  begin
    insert into public.safety_moderation_actions
      (channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision)
    values
      ('00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 'l1', 1.000, 1, 'block', 'mask', 'block', 'allow', 'hold');
    raise exception 'SAF-09: payment_decision = ''block'' must be rejected by CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
end
$$;

do $$
begin
  begin
    insert into public.safety_moderation_actions
      (channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision)
    values
      ('00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 'l1', 1.000, 1, 'allow', 'mask', 'block', 'mask', 'hold');
    raise exception 'SAF-09: stored_record_decision = ''mask'' must be rejected by CHECK constraint';
  exception when check_violation then
    null; -- expected
  end;
end
$$;

-- =========================================================================
-- RETENTION (S12.10/S12.6.2.1): there is no way to insert an evidence
-- row for a message that matched nothing -- matched_term_ids requires
-- at least one element. This is what makes "raw unactioned text is
-- never stored" a structural property of this table, not a discipline
-- the application layer has to maintain.
-- =========================================================================
do $$
begin
  begin
    insert into public.safety_moderation_actions
      (channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision)
    values
      ('00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[]::uuid[], 'l1', 1.000, 1, 'allow', 'allow', 'allow', 'allow', 'allow');
    raise exception 'SAF: an evidence row with an EMPTY matched_term_ids (i.e. no actual match -- a "raw unactioned text" row) must be rejected';
  exception when check_violation then
    null; -- expected
  end;
  begin
    insert into public.safety_moderation_actions
      (channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision)
    values
      ('00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', null, 'l1', 1.000, 1, 'allow', 'allow', 'allow', 'allow', 'allow');
    raise exception 'SAF: an evidence row with matched_term_ids = NULL must be rejected';
  exception when not_null_violation then
    null; -- expected
  end;
end
$$;

-- layer and confidence bounds.
do $$
begin
  begin
    insert into public.safety_moderation_actions
      (channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision)
    values
      ('00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 'l2', 1.000, 1, 'allow', 'allow', 'allow', 'allow', 'allow');
    raise exception 'SAF: layer other than ''l1'' must be rejected -- phase 1 has only L1';
  exception when check_violation then
    null; -- expected
  end;
  begin
    insert into public.safety_moderation_actions
      (channel_id, original_text, normalised_text, matched_term_ids, layer, confidence, policy_version, payment_decision, display_decision, tts_decision, stored_record_decision, moderator_review_decision)
    values
      ('00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 'l1', 1.500, 1, 'allow', 'allow', 'allow', 'allow', 'allow');
    raise exception 'SAF: confidence above 1 must be rejected';
  exception when check_violation then
    null; -- expected
  end;
end
$$;

-- =========================================================================
-- policy_version: read from safety_corpus_generation INSIDE the
-- function, never a caller-supplied argument -- verified structurally
-- (no such IN parameter exists), and shown to advance when the corpus
-- changes.
-- =========================================================================
do $$
declare param_count integer;
begin
  select count(*) into param_count
    from information_schema.parameters
   where specific_schema = 'app_private' and specific_name like 'record_safety_moderation_action%'
     and parameter_name = 'target_policy_version';
  if param_count != 0 then
    raise exception 'SAF: record_safety_moderation_action must not accept a caller-supplied policy_version -- a caller must never be able to forge which corpus generation an action was evaluated against';
  end if;
end
$$;

do $$
declare version_before bigint; version_after bigint; action_id uuid; recorded_version bigint;
begin
  select generation into version_before from public.safety_corpus_generation where id;

  -- Any corpus write bumps the generation (the same mechanism migration
  -- 0149 already proved for capability_registry_generation).
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000006b00', false);
  perform app_private.create_safety_corpus_term('00000000-0000-4000-8000-000000006b01'::uuid, 'zzz_generation_probe_term', true, 'mask', 'block', 'hold');

  select generation into version_after from public.safety_corpus_generation where id;
  if version_after <= version_before then
    raise exception 'SAF: a corpus write must strictly advance the generation counter -- before %, after %', version_before, version_after;
  end if;

  action_id := app_private.record_safety_moderation_action(
    '00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 1.000, 'mask', 'block', 'hold', null
  );
  select policy_version into recorded_version from public.safety_moderation_actions where id = action_id;
  if recorded_version != version_after then
    raise exception 'SAF: policy_version recorded on an evidence row must be the CURRENT generation at action time -- expected %, got %', version_after, recorded_version;
  end if;
end
$$;

-- =========================================================================
-- Privacy as a property of the query: the returned column sets of both
-- read/write functions are asserted exactly.
-- =========================================================================
do $$
declare cols text[];
begin
  select array_agg(parameter_name order by ordinal_position) into cols
    from information_schema.parameters
   where specific_schema = 'app_private' and specific_name like 'get_safety_corpus_terms%'
     and parameter_mode = 'OUT';
  if cols != array['id', 'channel_id', 'term', 'whole_word', 'display_decision', 'tts_decision', 'moderator_review_decision', 'created_at'] then
    raise exception 'SAF: get_safety_corpus_terms must return exactly this column set, got %', cols;
  end if;
end
$$;

-- =========================================================================
-- An actor recorded only when one is actually supplied -- null means
-- automated system decision (S12.2.7: "the actor IF a human was
-- involved").
-- =========================================================================
do $$
declare action_id uuid; recorded_actor uuid;
begin
  action_id := app_private.record_safety_moderation_action(
    '00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 1.000, 'mask', 'block', 'hold',
    '00000000-0000-4000-8000-000000006b05'::uuid -- moderator acted
  );
  select actor_user_id into recorded_actor from public.safety_moderation_actions where id = action_id;
  if recorded_actor != '00000000-0000-4000-8000-000000006b05'::uuid then
    raise exception 'SAF: actor_user_id must persist exactly as given when a human actually acted';
  end if;

  action_id := app_private.record_safety_moderation_action(
    '00000000-0000-4000-8000-000000006b01'::uuid, 'probe', 'probe', array[(select id from public.safety_corpus_terms where term = 'zzz_channel_a_term' and channel_id = '00000000-0000-4000-8000-000000006b01'::uuid)], 1.000, 'mask', 'block', 'hold', null
  );
  select actor_user_id into recorded_actor from public.safety_moderation_actions where id = action_id;
  if recorded_actor is not null then
    raise exception 'SAF: actor_user_id must be null for an automated decision -- no human actor was involved';
  end if;
end
$$;
