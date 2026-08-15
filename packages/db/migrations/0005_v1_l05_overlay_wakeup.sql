-- BharatStudio Alerts v1 overlay wake-up notification — DRAFT.
-- Notifications are only an optimisation. Overlay replay remains the
-- correctness path and is scoped by the API's overlay token/session.

create or replace function app_private.notify_overlay_wakeup(
  target_channel_id uuid,
  target_event_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  perform pg_notify(
    'bharatstudio_overlay_events',
    json_build_object('channelId', target_channel_id, 'eventId', target_event_id)::text
  );
end
$$;

revoke execute on function app_private.notify_overlay_wakeup(uuid, uuid) from public;
grant execute on function app_private.notify_overlay_wakeup(uuid, uuid) to bsa_alert_worker;
