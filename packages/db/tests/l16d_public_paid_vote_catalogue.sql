-- L16d: public paid-vote catalogue. Synthetic, isolated, and read-only.
\set ON_ERROR_STOP on

insert into alert_queues (id, channel_id, name, is_paused, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001720', '00000000-0000-4000-8000-000000000011', 'L16d A', false, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001721', '00000000-0000-4000-8000-000000000012', 'L16d B', false, current_timestamp, current_timestamp);

insert into interaction_definitions (id, channel_id, interaction_type, label, amount_paise, queue_id, tts_enabled, moderation_rule, visual, config, is_enabled, closed_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001722', '00000000-0000-4000-8000-000000000011', 'support_vote', 'Active paid poll', null, '00000000-0000-4000-8000-000000001720', false, 'none', '{}'::jsonb, '{"votingMode":"paid"}'::jsonb, true, null, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001723', '00000000-0000-4000-8000-000000000011', 'support_vote', 'Free poll', null, '00000000-0000-4000-8000-000000001720', false, 'none', '{}'::jsonb, '{}'::jsonb, true, null, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001724', '00000000-0000-4000-8000-000000000011', 'support_vote', 'Closed paid poll', null, '00000000-0000-4000-8000-000000001720', false, 'none', '{}'::jsonb, '{"votingMode":"paid"}'::jsonb, true, current_timestamp, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001725', '00000000-0000-4000-8000-000000000011', 'support_vote', 'Disabled paid poll', null, '00000000-0000-4000-8000-000000001720', false, 'none', '{}'::jsonb, '{"votingMode":"paid"}'::jsonb, false, null, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001726', '00000000-0000-4000-8000-000000000012', 'support_vote', 'Other channel paid poll', null, '00000000-0000-4000-8000-000000001721', false, 'none', '{}'::jsonb, '{"votingMode":"paid"}'::jsonb, true, null, current_timestamp, current_timestamp);

insert into interaction_vote_options (id, interaction_definition_id, option_key, label, created_at)
values
  ('00000000-0000-4000-8000-000000001727', '00000000-0000-4000-8000-000000001722', 'a', 'Option A', current_timestamp),
  ('00000000-0000-4000-8000-000000001728', '00000000-0000-4000-8000-000000001722', 'b', 'Option B', current_timestamp),
  ('00000000-0000-4000-8000-000000001729', '00000000-0000-4000-8000-000000001723', 'free', 'Free', current_timestamp),
  ('00000000-0000-4000-8000-000000001730', '00000000-0000-4000-8000-000000001724', 'closed', 'Closed', current_timestamp),
  ('00000000-0000-4000-8000-000000001731', '00000000-0000-4000-8000-000000001725', 'disabled', 'Disabled', current_timestamp),
  ('00000000-0000-4000-8000-000000001732', '00000000-0000-4000-8000-000000001726', 'other', 'Other', current_timestamp);

set role bsa_app;
do $$
declare row_count integer; payload jsonb;
begin
  select count(*) into row_count from app_private.list_public_paid_support_votes('00000000-0000-4000-8000-000000000011'::uuid);
  if row_count <> 2 then raise exception 'expected exactly two active paid options for channel A, got %', row_count; end if;
  select jsonb_agg(to_jsonb(row)) into payload from app_private.list_public_paid_support_votes('00000000-0000-4000-8000-000000000011'::uuid) row;
  if payload::text like '%queue%' or payload::text like '%config%' or payload::text like '%amount%' then
    raise exception 'public paid-vote projection leaked an internal field: %', payload;
  end if;
  select count(*) into row_count from app_private.list_public_paid_support_votes('00000000-0000-4000-8000-000000000012'::uuid);
  if row_count <> 1 then raise exception 'expected exactly one scoped option for channel B, got %', row_count; end if;
end $$;
reset role;

select 'PUBLIC_PAID_VOTE_CATALOGUE=PASS' as result;
