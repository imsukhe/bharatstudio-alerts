-- v1 L03/L07 role boundary hardening.
-- Overlay session credentials are operational secrets, not ordinary channel
-- membership data. Only roles that can operate the channel may create,
-- rotate, revoke or read a session row. The browser overlay itself continues
-- to authenticate with its scoped token and does not use this policy.
drop policy if exists overlay_sessions_member_manage on public.overlay_sessions;
create policy overlay_sessions_operator_manage
  on public.overlay_sessions for all to bsa_app
  using (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]))
  with check (app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[]));

-- Moderation remains available to moderators through the moderation route, but
-- Companion queue controls are deliberately limited to operational roles.
drop policy if exists companion_operator_insert on public.companion_commands;
create policy companion_operator_insert
  on public.companion_commands for insert to bsa_app
  with check (
    actor_user_id = app_private.current_user_id()
    and app_private.has_channel_role(channel_id, array['owner', 'admin', 'operator']::text[])
  );
