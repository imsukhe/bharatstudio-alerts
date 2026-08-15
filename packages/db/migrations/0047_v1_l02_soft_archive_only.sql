-- L02 retention correction: archive operational records without physical
-- deletion. The original 0024 primitive copied rows and then deleted the
-- source row; v1 retains the source internally and marks it archived instead.

alter table public.audit_events
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

alter table public.event_processing_attempts
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

-- The SECURITY DEFINER owner is a NOLOGIN, NOBYPASSRLS role.  Its direct
-- grants are therefore still constrained by RLS; give it only the rows and
-- mutations required by the two whitelisted archival functions.  The role
-- has no credential and the runtime worker receives EXECUTE only.
drop policy if exists audit_archive_owner_select on public.audit_events;
create policy audit_archive_owner_select
  on public.audit_events for select to bsa_archive_owner
  using (true);

drop policy if exists audit_archive_owner_insert on public.audit_events;
create policy audit_archive_owner_insert
  on public.audit_events for insert to bsa_archive_owner
  with check (true);

drop policy if exists audit_archive_owner_update on public.audit_events;
create policy audit_archive_owner_update
  on public.audit_events for update to bsa_archive_owner
  using (true)
  with check (true);

drop policy if exists attempts_archive_owner_select on public.event_processing_attempts;
create policy attempts_archive_owner_select
  on public.event_processing_attempts for select to bsa_archive_owner
  using (true);

drop policy if exists attempts_archive_owner_insert on public.event_processing_attempts;
create policy attempts_archive_owner_insert
  on public.event_processing_attempts for insert to bsa_archive_owner
  with check (true);

drop policy if exists attempts_archive_owner_update on public.event_processing_attempts;
create policy attempts_archive_owner_update
  on public.event_processing_attempts for update to bsa_archive_owner
  using (true)
  with check (true);

drop policy if exists archive_owner_select on public.archive_records;
create policy archive_owner_select
  on public.archive_records for select to bsa_archive_owner
  using (true);

drop policy if exists archive_owner_insert on public.archive_records;
create policy archive_owner_insert
  on public.archive_records for insert to bsa_archive_owner
  with check (true);

drop policy if exists audit_channel_select on public.audit_events;
create policy audit_channel_select
  on public.audit_events for select to bsa_app
  using (
    archived_at is null
    and (channel_id is null or app_private.can_access_channel(channel_id))
  );

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
begin
  if target_table not in ('audit_events', 'event_processing_attempts') then
    raise exception 'unsupported archival source table';
  end if;

  computed_archive_id := md5('archive:' || target_table || ':' || target_id::text)::uuid;

  execute format(
    'select to_jsonb(s) from public.%I s where s.id = $1 for update',
    target_table
  ) into source_record using target_id;

  select * into existing_archive
   from public.archive_records ar
   where ar.id = computed_archive_id
     and ar.source_table = target_table
     and ar.source_record_id = target_id;

  if source_record is null then
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

  if source_record ->> 'archived_at' is not null then
    if not found then
      raise exception 'soft-archived source has no archive record';
    end if;
    if existing_archive.record ->> 'id' <> target_id::text then
      raise exception 'archive identity mismatch';
    end if;
    return query select
      'already_archived'::text,
      existing_archive.source_table,
      existing_archive.source_record_id,
      existing_archive.id,
      existing_archive.record_digest;
    return;
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
     and ar.source_record_id = target_id;

  if existing_archive.record_digest <> computed_digest
     or existing_archive.record <> source_record then
    raise exception 'archive verification mismatch';
  end if;

  execute format(
    'update public.%I
        set archived_at = current_timestamp,
            archived_by = $2
      where id = $1',
    target_table
  ) using target_id, 'bsa_alert_worker';

  return query select
    'archived'::text,
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
  source_record jsonb;
begin
  select * into archived
   from public.archive_records
   where id = target_archive_id;

  if not found then
    raise exception 'archive record not found';
  end if;
  if archived.source_table not in ('audit_events', 'event_processing_attempts') then
    raise exception 'unsupported archival table';
  end if;
  if archived.record ->> 'id' <> archived.source_record_id::text then
    raise exception 'archive identity mismatch';
  end if;

  execute format(
    'select to_jsonb(s) from public.%I s where s.id = $1 for update',
    archived.source_table
  ) into source_record using archived.source_record_id;

  if source_record is not null then
    if source_record ->> 'archived_at' is not null then
      execute format(
        'update public.%I
            set archived_at = null,
                archived_by = null
          where id = $1',
        archived.source_table
      ) using archived.source_record_id;
      return query select
        'restored'::text,
        archived.source_table,
        archived.source_record_id,
        archived.id;
      return;
    end if;
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

-- The archive owner needs to mark source rows, but never physically delete
-- source or archive rows. The worker still has only function EXECUTE.
revoke delete on public.audit_events, public.event_processing_attempts from bsa_archive_owner;
revoke update, delete on public.archive_records from bsa_archive_owner;
grant select, insert on public.archive_records to bsa_archive_owner;

revoke execute on function app_private.archive_operational_record(text, uuid) from public;
revoke execute on function app_private.restore_operational_record(uuid) from public;
grant execute on function app_private.archive_operational_record(text, uuid) to bsa_alert_worker;
grant execute on function app_private.restore_operational_record(uuid) to bsa_alert_worker;
