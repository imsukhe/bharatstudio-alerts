-- L02 archive-owner hardening.
--
-- 0047 documents the archive SECURITY DEFINER owner as NOBYPASSRLS, but the
-- original role bootstrap accidentally created bsa_archive_owner with
-- BYPASSRLS.  Enforce the documented least-privilege contract for existing
-- installations as well as for fresh role provisioning.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bsa_archive_owner') then
    raise exception 'bsa_archive_owner role must be provisioned before migration 0058';
  end if;

  execute 'alter role bsa_archive_owner nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
end
$$;
