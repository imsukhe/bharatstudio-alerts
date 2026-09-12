-- L16: the overlay/browser v1 contract accepts at most 16 options. Enforce
-- that same bound at the sole option-creation authority. The definition row
-- lock is deliberately held across the count and insert so two concurrent
-- owner/admin requests cannot both observe slot 16 and create a 17th row.

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
  option_count integer;
begin
  if not app_private.has_channel_role(target_channel_id, array['owner', 'admin']::text[]) then
    raise exception 'not authorized to manage this channel''s interactions' using errcode = '42501';
  end if;

  select * into def from public.interaction_definitions
   where id = target_definition_id and channel_id = target_channel_id and interaction_type = 'support_vote'
   for update;
  if not found then
    raise exception 'interaction definition not found' using errcode = 'P0002';
  end if;
  if def.closed_at is not null then
    raise exception 'a closed support vote cannot be edited' using errcode = '22023';
  end if;
  if target_option_key !~ '^[a-z0-9_-]{1,40}$' or target_label is null or char_length(target_label) not between 1 and 120 then
    raise exception 'invalid vote option' using errcode = '22023';
  end if;

  select count(*) into option_count
    from public.interaction_vote_options
   where interaction_definition_id = target_definition_id;
  if option_count >= 16 then
    raise exception 'support vote option limit reached' using errcode = '22023';
  end if;

  new_id := gen_random_uuid();
  insert into public.interaction_vote_options (id, interaction_definition_id, option_key, label)
  values (new_id, target_definition_id, target_option_key, target_label);
  return new_id;
end
$$;

revoke execute on function app_private.create_vote_option(uuid, uuid, text, text) from public;
grant execute on function app_private.create_vote_option(uuid, uuid, text, text) to bsa_app;
