-- L03 acceptance: the public featured-creator listing
-- (app_private.list_featured_channels) is self-serve opt-in with an
-- automatic eligibility filter — featured_consent AND accepting_tips AND
-- not closed — never admin curation, and exposes only the approved narrow
-- projection (no channelId, no billing tier, no avatar). Unauthenticated:
-- no app.user_id is set, matching every other public read. Synthetic
-- identifiers only; runs inside begin/rollback so it never changes what
-- other tests in this shared disposable database see.

\set ON_ERROR_STOP on

begin;

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000801', 'google-featured-owner', 'Synthetic Featured Owner', current_timestamp, current_timestamp);

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, featured_consent, created_at, updated_at)
values
  -- Eligible, newest.
  ('00000000-0000-4000-8000-000000000811', '00000000-0000-4000-8000-000000000801', 'featured_newest', 'Featured Newest', true, 1, true, current_timestamp, current_timestamp),
  -- Eligible, oldest — must rank after the newest one.
  ('00000000-0000-4000-8000-000000000812', '00000000-0000-4000-8000-000000000801', 'featured_oldest', 'Featured Oldest', true, 1, true, current_timestamp - interval '1 day', current_timestamp - interval '1 day'),
  -- Opted out — must never appear.
  ('00000000-0000-4000-8000-000000000813', '00000000-0000-4000-8000-000000000801', 'not_opted_in', 'Not Opted In', true, 1, false, current_timestamp, current_timestamp),
  -- Opted in but not accepting tips — must never appear.
  ('00000000-0000-4000-8000-000000000814', '00000000-0000-4000-8000-000000000801', 'featured_tips_closed', 'Featured Tips Closed', false, 1, true, current_timestamp, current_timestamp),
  -- Opted in, accepting tips, but the channel itself is closed — must never appear.
  ('00000000-0000-4000-8000-000000000815', '00000000-0000-4000-8000-000000000801', 'featured_channel_closed', 'Featured Channel Closed', true, 1, true, current_timestamp, current_timestamp);

update channels set closed_at = current_timestamp where id = '00000000-0000-4000-8000-000000000815';

insert into channel_configs (channel_id, version, values, effective_at, created_at)
values ('00000000-0000-4000-8000-000000000811', 1, '{"locale":"hi-IN"}'::jsonb, current_timestamp, current_timestamp);

do $$
declare
  listed_handles text[];
  newest_locale text;
  oldest_locale text;
  limited_count integer;
begin
  set role bsa_app;

  select array_agg(handle order by seq) into listed_handles
    from app_private.list_featured_channels(100)
      with ordinality as t(channel_id, handle, display_name, accepting_tips, locale, seq)
   where handle in ('featured_newest', 'featured_oldest', 'not_opted_in', 'featured_tips_closed', 'featured_channel_closed');
  if listed_handles is distinct from array['featured_newest', 'featured_oldest'] then
    raise exception 'featured listing eligibility/order was wrong: %', listed_handles;
  end if;

  select locale into newest_locale from app_private.list_featured_channels(100) where handle = 'featured_newest';
  select locale into oldest_locale from app_private.list_featured_channels(100) where handle = 'featured_oldest';
  if newest_locale <> 'hi-IN' then
    raise exception 'featured listing did not project the channel''s configured locale: %', newest_locale;
  end if;
  if oldest_locale <> 'en-IN' then
    raise exception 'featured listing did not default locale to en-IN when unconfigured: %', oldest_locale;
  end if;

  select count(*) into limited_count from app_private.list_featured_channels(1);
  if limited_count <> 1 then
    raise exception 'featured listing did not respect a limit of 1: %', limited_count;
  end if;
exception when others then
  reset role;
  raise;
end
$$;
reset role;
rollback;

select 'L03_FEATURED_CREATOR_LISTING=PASS' as result;
