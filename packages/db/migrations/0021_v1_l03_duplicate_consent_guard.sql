-- BharatStudio Alerts v1 D-2 duplicate-routing consent guard.
--
-- The payment service selects one route by default. It may submit multiple
-- delivery rows only when every participating binding explicitly opted in to
-- duplicate delivery. Enforce that invariant at the durable delivery-row
-- boundary so a binding edit or a malformed internal payload cannot create an
-- unapproved second delivery.

create or replace function app_private.guard_duplicate_delivery_consent()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  new_binding_allows boolean;
  new_binding_exists boolean;
  existing_binding_exists boolean;
begin
  if exists (
    select 1
      from public.event_outbox_deliveries existing
     where existing.outbox_id = new.outbox_id
  ) then
    select exists (
      select 1 from public.queue_bindings binding where binding.id = new.binding_id
    ) into new_binding_exists;
    select exists (
      select 1
        from public.event_outbox_deliveries existing
        join public.queue_bindings binding on binding.id = existing.binding_id
       where existing.outbox_id = new.outbox_id
    ) into existing_binding_exists;

    -- Manual/test alerts may intentionally target several queues directly and
    -- use a deterministic synthetic binding ID. There is no source binding to
    -- consent against in that case; the explicit queue selection is itself the
    -- operator's consent. Binding-backed payment/source routing still enters
    -- the guard below.
    if not coalesce(new_binding_exists, false) and not coalesce(existing_binding_exists, false) then
      return new;
    end if;

    select binding.allow_duplicates
      into new_binding_allows
      from public.queue_bindings binding
     where binding.id = new.binding_id
     limit 1;

    if coalesce(new_binding_allows, false) is not true
       or exists (
         select 1
           from public.event_outbox_deliveries existing
           join public.queue_bindings binding on binding.id = existing.binding_id
          where existing.outbox_id = new.outbox_id
            and binding.allow_duplicates is not true
       ) then
      raise exception 'duplicate delivery requires explicit consent on every binding'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists event_outbox_delivery_duplicate_consent on public.event_outbox_deliveries;
create trigger event_outbox_delivery_duplicate_consent
before insert on public.event_outbox_deliveries
for each row execute function app_private.guard_duplicate_delivery_consent();

revoke execute on function app_private.guard_duplicate_delivery_consent() from public;
grant execute on function app_private.guard_duplicate_delivery_consent() to bsa_payment;
grant execute on function app_private.guard_duplicate_delivery_consent() to bsa_alert_worker;
