-- L02 account-control QA regression. Synthetic identities only.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000001701', 'l02-account-controls-a', 'Account Controls A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000001702', 'l02-account-controls-b', 'Account Controls B', current_timestamp, current_timestamp);

insert into privacy_requests (id, user_id, request_type, details, status, created_at, updated_at)
select gen_random_uuid(), '00000000-0000-4000-8000-000000001701', 'access',
       'own-' || lpad(n::text, 3, '0'), 'open',
       current_timestamp - (n * interval '1 second'), current_timestamp - (n * interval '1 second')
  from generate_series(1, 257) as n;
insert into privacy_requests (id, user_id, request_type, details, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-4000-8000-000000001702', 'access', 'foreign-request', 'open', current_timestamp, current_timestamp);

select set_config('app.user_id', '00000000-0000-4000-8000-000000001701', false);
do $$
begin
  if (select count(*) from app_private.list_privacy_requests('00000000-0000-4000-8000-000000001701')) <> 256 then
    raise exception 'privacy history must be capped at 256 rows';
  end if;
  if not exists (select 1 from app_private.list_privacy_requests('00000000-0000-4000-8000-000000001701') where details = 'own-001') then
    raise exception 'newest privacy request missing from capped list';
  end if;
  if exists (select 1 from app_private.list_privacy_requests('00000000-0000-4000-8000-000000001701') where details in ('own-257', 'foreign-request')) then
    raise exception 'privacy history cap or owner scope leaked a forbidden row';
  end if;
  begin
    perform app_private.close_current_account('00000000-0000-4000-8000-000000001701', '   ');
    raise exception 'blank closure reason was accepted';
  exception when sqlstate '22023' then null;
  end;
  if app_private.close_current_account('00000000-0000-4000-8000-000000001701', 'Synthetic QA closure') is null then
    raise exception 'non-blank closure reason did not close account';
  end if;
end
$$;

select set_config('app.user_id', '00000000-0000-4000-8000-000000001702', false);
do $$
begin
  if exists (select 1 from app_private.list_privacy_requests('00000000-0000-4000-8000-000000001701')) then
    raise exception 'another user can read privacy history';
  end if;
end
$$;

select 'L02_ACCOUNT_CONTROLS_BOUNDS=PASS' as result;
