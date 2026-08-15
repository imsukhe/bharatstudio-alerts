-- L02 mechanical remediation checks. Run after roles/0001 and migrations
-- 0001-0002 in an isolated database as the migration owner.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bsa_app') then
    raise exception 'missing bsa_app role prerequisite';
  end if;
  if (select rolsuper or rolbypassrls from pg_roles where rolname = 'bsa_app') then
    raise exception 'bsa_app must not bypass RLS';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_archive_owner' and not rolcanlogin and not rolsuper and not rolbypassrls) then
    raise exception 'bsa_archive_owner must be a non-login, non-bypass-RLS SECURITY DEFINER owner';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_payment' and rolbypassrls) then
    raise exception 'bsa_payment bypass scope is not provisioned';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_alert_worker' and rolbypassrls) then
    raise exception 'bsa_alert_worker bypass scope is not provisioned';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_migrator') then
    raise exception 'missing bsa_migrator role prerequisite';
  end if;
  if has_table_privilege('bsa_app', 'public.archive_records', 'SELECT')
     or has_table_privilege('bsa_app', 'public.archive_records', 'INSERT')
     or has_table_privilege('bsa_app', 'public.archive_records', 'UPDATE')
     or has_table_privilege('bsa_app', 'public.archive_records', 'DELETE') then
    raise exception 'bsa_app must not access archive_records';
  end if;
  if not has_table_privilege('bsa_alert_worker', 'public.archive_records', 'SELECT')
     or not has_table_privilege('bsa_alert_worker', 'public.archive_records', 'INSERT')
     or has_table_privilege('bsa_alert_worker', 'public.archive_records', 'UPDATE')
     or has_table_privilege('bsa_alert_worker', 'public.archive_records', 'DELETE') then
    raise exception 'archive_records grants are not append-only worker grants';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.prosecdef
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) as setting
        where setting like 'search_path=%'
      )
  ) then
    raise exception 'every app_private SECURITY DEFINER helper must set a fixed search_path';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.prosecdef
      and has_function_privilege('public', p.oid, 'EXECUTE')
  ) then
    raise exception 'app_private SECURITY DEFINER helper remains executable by PUBLIC';
  end if;
end
$$;

select 'L02_SECURITY_REMEDIATIONS=PASS' as result;
