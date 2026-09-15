-- L16 public paid-vote reachability. Additive, read-only, and deliberately
-- narrower than creator interaction configuration. No existing relation or
-- function is modified; disabling the public route/UI is a safe rollback.

create or replace function app_private.list_public_paid_support_votes(target_channel_id uuid)
returns table (
  definition_id uuid,
  label text,
  option_key text,
  option_label text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select def.id, def.label, opt.option_key, opt.label
    from public.interaction_definitions def
    join public.interaction_vote_options opt
      on opt.interaction_definition_id = def.id
   where def.channel_id = target_channel_id
     and def.interaction_type = 'support_vote'
     and def.is_enabled
     and def.closed_at is null
     and def.config ->> 'votingMode' = 'paid'
   order by def.created_at asc, opt.created_at asc
$$;

revoke execute on function app_private.list_public_paid_support_votes(uuid) from public;
grant execute on function app_private.list_public_paid_support_votes(uuid) to bsa_app;
