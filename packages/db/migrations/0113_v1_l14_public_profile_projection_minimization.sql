-- L14 public profile privacy hardening: public profile URLs are the stable
-- public identifier. Do not disclose the immutable viewer account primary key
-- alongside them; it enables unnecessary cross-surface correlation.
--
-- PostgreSQL does not permit CREATE OR REPLACE to change a function's OUT
-- column shape, so these two unreferenced API boundary functions are dropped
-- and recreated in this forward migration. Their input signatures and grants
-- remain unchanged.

drop function app_private.search_public_viewer_profiles(text);
drop function app_private.get_public_viewer_profile(text);

create function app_private.search_public_viewer_profiles(query text)
returns table (
  display_name text,
  profile_slug text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select va.display_name, va.profile_slug
    from viewer_accounts va
   where va.profile_visibility = 'public'
     and va.closed_at is null
     and va.profile_slug is not null
     and (
       query is null or length(trim(query)) = 0
       or va.display_name ilike '%' || query || '%'
       or va.profile_slug ilike '%' || query || '%'
     )
   order by va.display_name asc, va.profile_slug asc
   limit 25
$$;

create function app_private.get_public_viewer_profile(target_slug text)
returns table (
  display_name text,
  profile_slug text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select va.display_name, va.profile_slug
    from viewer_accounts va
   where lower(va.profile_slug) = lower(target_slug)
     and va.profile_visibility = 'public'
     and va.closed_at is null
$$;

revoke execute on function app_private.search_public_viewer_profiles(text) from public;
revoke execute on function app_private.get_public_viewer_profile(text) from public;
grant execute on function app_private.search_public_viewer_profiles(text) to bsa_app;
grant execute on function app_private.get_public_viewer_profile(text) to bsa_app;
