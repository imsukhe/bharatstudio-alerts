-- HISTORICAL MIGRATION — superseded by 0047_v1_l02_soft_archive_only.sql.
-- Do not invoke the function created here as a current-state operation: this
-- historical version physically deleted its source row. The effective v1
-- retention policy retains and marks the source row instead.
--
-- BharatStudio Alerts v1 archival-transfer primitive (historical).
--
-- This is an atomic relocation mechanism for operational records only. It is
-- intentionally not a generic table-name API and is not a payment/refund
-- deletion mechanism. The archive row is inserted and verified before the
-- source row is relocated, in the same transaction. Both functions are
-- private worker operations and are disabled from PUBLIC.

create or replace function app_private.archive_operational_record(
  target_table text,
  target_id uuid
)
returns table (
  result text,
  source_table text,
  source_record_id uuid,
  archive_id uuid,
  record_digest text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  source_record jsonb;
  existing_archive public.archive_records%rowtype;
  computed_digest text;
  computed_archive_id uuid;
  source_exists boolean;
begin
  if target_table not in ('audit_events', 'event_processing_attempts') then
    raise exception 'unsupported archival source table';
  end if;

  computed_archive_id := md5('archive:' || target_table || ':' || target_id::text)::uuid;

  execute format(
    'select to_jsonb(s) from public.%I s where s.id = $1 for update',
    target_table
  ) into source_record using target_id;

  if source_record is null then
    select ar.* into existing_archive
      from public.archive_records ar
     where ar.id = computed_archive_id
       and ar.source_table = target_table
       and ar.source_record_id = target_id
     for update;

    if found then
      return query select
        'already_archived'::text,
        existing_archive.source_table,
        existing_archive.source_record_id,
        existing_archive.id,
        existing_archive.record_digest;
      return;
    end if;

    raise exception 'archival source record not found';
  end if;

  computed_digest := md5(source_record::text);

  insert into public.archive_records (
    id, source_table, source_record_id, record_digest, record,
    archived_at, archived_by
  ) values (
    computed_archive_id, target_table, target_id, computed_digest,
    source_record, current_timestamp, 'bsa_alert_worker'
  ) on conflict on constraint archive_records_source_table_source_record_id_key do nothing;

  select * into existing_archive
    from public.archive_records ar
   where ar.source_table = target_table
     and ar.source_record_id = target_id
   for update;

  if existing_archive.record_digest <> computed_digest
     or existing_archive.record <> source_record then
    raise exception 'archive verification mismatch';
  end if;

  execute format('delete from public.%I where id = $1', target_table)
    using target_id;

  return query select
    'relocated'::text,
    target_table,
    target_id,
    existing_archive.id,
    existing_archive.record_digest;
end
$$;

create or replace function app_private.restore_operational_record(
  target_archive_id uuid
)
returns table (
  result text,
  source_table text,
  source_record_id uuid,
  archive_id uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  archived public.archive_records%rowtype;
  source_exists boolean;
begin
  select * into archived
    from public.archive_records
   where id = target_archive_id
   for update;

  if not found then
    raise exception 'archive record not found';
  end if;
  if archived.source_table not in ('audit_events', 'event_processing_attempts') then
    raise exception 'unsupported archival source table';
  end if;
  if archived.record ->> 'id' <> archived.source_record_id::text then
    raise exception 'archive identity mismatch';
  end if;

  execute format(
    'select exists(select 1 from public.%I where id = $1)',
    archived.source_table
  ) into source_exists using archived.source_record_id;

  if source_exists then
    return query select
      'already_present'::text,
      archived.source_table,
      archived.source_record_id,
      archived.id;
    return;
  end if;

  execute format(
    'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)',
    archived.source_table,
    archived.source_table
  ) using archived.record;

  return query select
    'restored'::text,
    archived.source_table,
    archived.source_record_id,
    archived.id;
end
$$;

-- A separate NOLOGIN owner keeps source-table DELETE privileges out of the
-- worker's direct SQL surface. The worker is still the only runtime identity
-- allowed to invoke the approved transfer.
grant select, insert, update, delete on public.audit_events, public.event_processing_attempts
  to bsa_archive_owner;
grant select, insert, update, delete on public.archive_records
  to bsa_archive_owner;
alter function app_private.archive_operational_record(text, uuid) owner to bsa_archive_owner;
alter function app_private.restore_operational_record(uuid) owner to bsa_archive_owner;
revoke execute on function app_private.archive_operational_record(text, uuid) from public;
revoke execute on function app_private.restore_operational_record(uuid) from public;
grant execute on function app_private.archive_operational_record(text, uuid) to bsa_alert_worker;
grant execute on function app_private.restore_operational_record(uuid) to bsa_alert_worker;
