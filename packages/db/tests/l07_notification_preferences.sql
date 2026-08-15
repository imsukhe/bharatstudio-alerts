-- L07 notification preferences/device registration behavior.
-- Executed in the isolated L03 PostgreSQL harness after all migrations.

do $$
declare
  preference_row record;
  device_row record;
  registered_device uuid;
  listed_count integer;
  revoked boolean;
begin
  perform set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);

  select * into preference_row from app_private.get_notification_preferences();
  if preference_row.connection_alerts is distinct from true
     or preference_row.security_alerts is distinct from true
     or preference_row.action_failures is distinct from false then
    raise exception 'notification preference defaults are incorrect';
  end if;

  select * into preference_row
    from app_private.set_notification_preferences(false, true, true);
  if preference_row.connection_alerts is distinct from false
     or preference_row.security_alerts is distinct from true
     or preference_row.action_failures is distinct from true then
    raise exception 'notification preference update was not persisted';
  end if;

  select device_id, platform, enabled, created_at, last_seen_at
    into device_row
    from app_private.register_notification_device(
      'android',
      'v1.a-valid-ciphertext.b-valid-tag.c-valid-ciphertext',
      repeat('a', 64)
    );
  registered_device := device_row.device_id;
  if device_row.platform <> 'android' or device_row.enabled is distinct from true then
    raise exception 'notification device registration returned invalid metadata';
  end if;

  -- Same fingerprint is an idempotent refresh, not a second device.
  select device_id into device_row
    from app_private.register_notification_device(
      'ios',
      'v1.a-refreshed.b-tag.c-refreshed',
      repeat('a', 64)
    );
  if device_row.device_id <> registered_device then
    raise exception 'notification token refresh created a duplicate device';
  end if;

  select count(*) into listed_count from app_private.list_notification_devices();
  if listed_count <> 1 then
    raise exception 'notification device list returned % rows, expected 1', listed_count;
  end if;

  select app_private.revoke_notification_device(registered_device) into revoked;
  if revoked is distinct from true then
    raise exception 'notification device revoke did not report success';
  end if;
  select count(*) into listed_count from app_private.list_notification_devices();
  if listed_count <> 0 then
    raise exception 'revoked notification device remained visible';
  end if;

  perform set_config('app.user_id', '', true);
end
$$;
