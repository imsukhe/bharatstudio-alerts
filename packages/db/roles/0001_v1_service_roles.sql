-- BharatStudio Alerts v1 service-role prerequisites — DRAFT, DO NOT RUN.
--
-- Apply only in an isolated database before the v1 baseline/security drafts.
-- Runtime login identities and credentials are provisioned by deployment/IAM;
-- these group roles contain no passwords and do not expose secrets.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bsa_app') then
    create role bsa_app nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_payment') then
    create role bsa_payment nologin nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_alert_worker') then
    create role bsa_alert_worker nologin nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_migrator') then
    create role bsa_migrator nologin nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bsa_archive_owner') then
    create role bsa_archive_owner nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
end
$$;

-- Login/service identities, connection limits, memberships and passwords are
-- deployment-owned and must be added only after the security review.
