-- L16 vote-option cardinality proof. The definition-level FOR UPDATE lock is
-- the serialization primitive: every creation call locks the same parent row
-- before counting/inserting, so the 17th concurrent caller re-counts only
-- after the 16th committed. This test proves the stated cap and keeps that
-- lock in the function definition as a regression requirement.
\set ON_ERROR_STOP on

insert into channel_entitlement_versions (channel_id, version, tier, source, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000012', 1, 'creator', 'individual_plan', '{}'::jsonb, current_timestamp, current_timestamp)
on conflict (channel_id, version) do nothing;

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values ('00000000-0000-4000-8000-000000001916', '00000000-0000-4000-8000-000000000012', 'L16 cardinality queue', false, current_timestamp, current_timestamp)
on conflict (id) do nothing;

select set_config('app.user_id', '00000000-0000-4000-8000-000000000002', false);

do $$
declare
  v_definition_id uuid;
  v_count integer;
  v_function text;
  v_index integer;
begin
  v_definition_id := app_private.create_interaction_definition(
    '00000000-0000-4000-8000-000000000012'::uuid, 'support_vote', 'L16 cardinality poll', null,
    '00000000-0000-4000-8000-000000001916'::uuid, false, 'none', '{}'::jsonb, '{}'::jsonb
  );

  for v_index in 1..16 loop
    perform app_private.create_vote_option(
      '00000000-0000-4000-8000-000000000012'::uuid, v_definition_id,
      'option-' || v_index, 'Option ' || v_index
    );
  end loop;

  select count(*) into v_count from public.interaction_vote_options where interaction_definition_id = v_definition_id;
  if v_count <> 16 then
    raise exception 'expected exactly 16 accepted options, got %', v_count;
  end if;

  begin
    perform app_private.create_vote_option(
      '00000000-0000-4000-8000-000000000012'::uuid, v_definition_id, 'option-17', 'Option 17'
    );
    raise exception 'a seventeenth option must be rejected';
  exception when others then
    if sqlerrm <> 'support vote option limit reached' then
      raise exception 'unexpected seventeenth-option error: %', sqlerrm;
    end if;
  end;

  select count(*) into v_count from public.interaction_vote_options where interaction_definition_id = v_definition_id;
  if v_count <> 16 then
    raise exception 'rejected seventeenth option changed persisted count to %', v_count;
  end if;

  select pg_get_functiondef('app_private.create_vote_option(uuid, uuid, text, text)'::regprocedure) into v_function;
  if position('for update' in lower(v_function)) = 0 then
    raise exception 'option-cap procedure lost the parent-row serialization lock';
  end if;
end
$$;
