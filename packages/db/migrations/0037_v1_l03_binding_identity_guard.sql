-- L03 binding lifecycle hardening.
-- Accepted deliveries copy binding identity/config into their own immutable
-- snapshot. Future routing edits are allowed, but the binding's identity must
-- never be rewritten through a broad table grant or an accidental SQL path.

create or replace function app_private.guard_queue_binding_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, app_private
as $$
begin
  if new.id <> old.id
     or new.channel_id <> old.channel_id
     or new.queue_id <> old.queue_id
     or new.source_type <> old.source_type
     or new.source_id <> old.source_id
     or new.created_at <> old.created_at then
    raise exception 'queue binding identity is immutable';
  end if;

  if old.source_type = 'payment'
     and old.source_id = '__channel_default__'
     and new.closed_at is not null then
    raise exception 'default payment binding cannot be closed';
  end if;

  return new;
end
$$;

drop trigger if exists queue_binding_identity_guard on public.queue_bindings;
create trigger queue_binding_identity_guard
before update on public.queue_bindings
for each row execute function app_private.guard_queue_binding_update();

revoke execute on function app_private.guard_queue_binding_update() from public;

