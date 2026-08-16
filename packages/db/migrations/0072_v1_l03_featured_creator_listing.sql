-- L03: featured-creator public listing.
--
-- "v1 scope addendum — 2026-08-16" in 01_MASTER_RELEASE_AUTHORITY.md:
-- "Featured-creator public listing: GET /featured and the featured_consent
-- toggle, restoring what the parent marketing site's /creators page
-- expects." The marketing site's /creators page has shipped as a static
-- empty state until this exists (see bharatstudio-requirements
-- tasks/L08-marketing-support-legal.md).
--
-- Channel-level, not user-level: the rebuild is channel-centric (unlike
-- legacy's creators table, keyed by google subject) and get_public_channel
-- already projects per-channel, so a consent flag belongs on the same row.
-- Self-serve opt-in with an automatic eligibility filter, not admin
-- curation — matching legacy's actual design (D-C079: "voluntary,
-- collected at signup") without porting its non-portable onboarding_step/
-- is_suspended columns, which don't exist in this schema. The nearest
-- honest equivalents already present: closed_at (channel is live),
-- accepting_tips (creator wants public tip traffic).
--
-- Deliberately excluded from the projection: an avatar (no such field
-- exists anywhere in this codebase — YouTube integration, the only prior
-- source of one, is an explicit v1 exclusion) and billing tier (would leak
-- financial-adjacent state onto an unauthenticated public page for no
-- product reason).

alter table public.channels add column featured_consent boolean not null default false;

-- Mirrors the actual eligibility filter below, so it's a real index rather
-- than a documentation comment.
create index channels_featured_listing_idx
  on public.channels (created_at desc, id desc)
  where featured_consent and accepting_tips and closed_at is null;

create or replace function app_private.list_featured_channels(
  target_limit integer
)
returns table (
  channel_id uuid,
  handle text,
  display_name text,
  accepting_tips boolean,
  locale text
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select channel.id,
         channel.handle,
         channel.display_name,
         channel.accepting_tips,
         coalesce(config.values ->> 'locale', 'en-IN')
    from public.channels channel
    left join lateral (
      select values
        from public.channel_configs
       where channel_id = channel.id
       order by version desc
       limit 1
    ) config on true
   where channel.featured_consent
     and channel.accepting_tips
     and channel.closed_at is null
   order by channel.created_at desc, channel.id desc
   limit greatest(least(coalesce(target_limit, 60), 100), 1)
$$;

revoke execute on function app_private.list_featured_channels(integer) from public;
grant execute on function app_private.list_featured_channels(integer) to bsa_app;
