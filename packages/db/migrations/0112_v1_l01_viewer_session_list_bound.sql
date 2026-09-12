-- L01 viewer-session contract hardening: response listing is intentionally
-- bounded. Keep the enforced database projection aligned with the published
-- contract and do not make the API materialise an unbounded session history.
create or replace function app_private.list_viewer_sessions(target_viewer_account_id uuid)
returns table (session_id uuid, created_at timestamptz, last_seen_at timestamptz, expires_at timestamptz, device_label text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select vs.id, vs.created_at, vs.last_seen_at, vs.expires_at, vs.device_label
    from viewer_sessions vs
   where vs.viewer_account_id = target_viewer_account_id
     and target_viewer_account_id = app_private.current_viewer_id()
     and vs.revoked_at is null
     and vs.expires_at > current_timestamp
   order by vs.last_seen_at desc, vs.id desc
   limit 100
$$;

revoke execute on function app_private.list_viewer_sessions(uuid) from public;
grant execute on function app_private.list_viewer_sessions(uuid) to bsa_app;
