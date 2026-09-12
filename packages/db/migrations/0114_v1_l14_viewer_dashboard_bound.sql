-- L14 private dashboard read bound. The dashboard is authenticated but must
-- still have a deterministic ceiling so a long-lived account cannot force an
-- unbounded history query or response.

create or replace function app_private.get_viewer_dashboard(target_viewer_account_id uuid)
returns table (
  channel_id uuid, channel_handle text, channel_display_name text,
  first_supported_at timestamptz, last_supported_at timestamptz,
  lifetime_amount_paise bigint, tip_count bigint, challenge_count bigint, member_state text
)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select c.id, c.handle, c.display_name,
         csr.first_supported_at, csr.last_supported_at,
         csr.lifetime_amount_paise, csr.tip_count, csr.challenge_count, csr.member_state
    from creator_supporter_relations csr
    join channels c on c.id = csr.channel_id
    join viewer_identities vi on vi.id = csr.viewer_identity_id
   where target_viewer_account_id = app_private.current_viewer_id()
     and (vi.viewer_account_id = target_viewer_account_id or vi.merged_into_account_id = target_viewer_account_id)
   order by csr.last_supported_at desc, c.id desc
   limit 100
$$;

revoke execute on function app_private.get_viewer_dashboard(uuid) from public;
grant execute on function app_private.get_viewer_dashboard(uuid) to bsa_app;
