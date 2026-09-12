-- L02 QA remediation: a closure reason is meaningful only when non-blank,
-- and the self-service privacy-request list must be bounded to its published
-- client capacity. This replaces only private functions; no stored record is
-- deleted or rewritten.

create or replace function app_private.list_privacy_requests(target_user_id uuid)
returns table (request_id uuid, request_type text, details text, status text, created_at timestamptz, updated_at timestamptz, resolved_at timestamptz, resolution_note text)
language sql stable security definer
set search_path = pg_catalog, public, app_private
as $$
  select request.id, request.request_type, request.details, request.status,
         request.created_at, request.updated_at, request.resolved_at, request.resolution_note
    from public.privacy_requests request
   where request.user_id = target_user_id
     and target_user_id = app_private.current_user_id()
   order by request.created_at desc, request.id desc
   limit 256
$$;

create or replace function app_private.close_current_account(
  target_user_id uuid,
  target_reason text
)
returns timestamptz
language plpgsql volatile security definer
set search_path = pg_catalog, public, app_private
as $$
declare closed_at_value timestamptz;
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id()
     or char_length(coalesce(target_reason, '')) > 500
     or char_length(btrim(coalesce(target_reason, ''))) = 0 then
    raise exception 'invalid account closure request' using errcode = '22023';
  end if;
  update public.app_users
     set closed_at = coalesce(closed_at, current_timestamp), updated_at = current_timestamp
   where id = target_user_id
   returning closed_at into closed_at_value;
  if closed_at_value is null then raise exception 'account not found' using errcode = '42501'; end if;
  update public.user_sessions set revoked_at = current_timestamp where user_id = target_user_id and revoked_at is null;
  update public.overlay_sessions session set revoked_at = current_timestamp where session.channel_id in (select channel.id from public.channels channel where channel.owner_user_id = target_user_id) and session.revoked_at is null;
  insert into public.account_lifecycle_events (id, user_id, action) values (gen_random_uuid(), target_user_id, 'closed');
  return closed_at_value;
end
$$;

revoke execute on function app_private.list_privacy_requests(uuid) from public;
revoke execute on function app_private.close_current_account(uuid, text) from public;
grant execute on function app_private.list_privacy_requests(uuid) to bsa_app;
grant execute on function app_private.close_current_account(uuid, text) to bsa_app;
