-- BharatStudio Alerts v1 moderation event/channel integrity.
-- A moderator may act only on an event belonging to the channel in the
-- request. Membership in the requested channel alone is insufficient.

drop policy if exists moderation_operator_insert on public.alert_moderation_actions;

create policy moderation_operator_insert
  on public.alert_moderation_actions for insert to bsa_app
  with check (
    actor_user_id = app_private.current_user_id()
    and app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator', 'moderator']::text[])
    and exists (
      select 1
        from public.alert_events event
       where event.id = alert_moderation_actions.event_id
         and event.channel_id = alert_moderation_actions.channel_id
    )
  );
