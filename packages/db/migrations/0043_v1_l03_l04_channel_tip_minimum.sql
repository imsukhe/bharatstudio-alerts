-- BharatStudio Alerts v1 channel-specific public tip minimum.
--
-- The platform floor remains ₹10. A creator may configure a higher channel
-- minimum, which must be visible on the public tip surface and enforced again
-- at the payment-intent boundary so a stale or bypassed client cannot create a
-- below-minimum order.

drop function if exists app_private.get_public_channel(text);
create function app_private.get_public_channel(target_handle text)
returns table (
  channel_id uuid,
  handle text,
  display_name text,
  accepting_tips boolean,
  minimum_tip_paise bigint,
  public_config_version bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select channel.id,
         channel.handle,
         channel.display_name,
         channel.accepting_tips,
         greatest(1000, coalesce(
           case
             when config.values->>'minimumTipPaise' ~ '^[0-9]+$'
               then (config.values->>'minimumTipPaise')::bigint
             else null
           end,
           1000
         )),
         channel.public_config_version
    from public.channels channel
    left join lateral (
      select values
        from public.channel_configs
       where channel_id = channel.id
       order by version desc
       limit 1
    ) config on true
   where lower(channel.handle) = lower(target_handle)
     and channel.closed_at is null
   limit 1
$$;

create or replace function app_private.enforce_channel_tip_minimum()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  configured_minimum bigint := 1000;
begin
  select coalesce(
           case
             when config.values->>'minimumTipPaise' ~ '^[0-9]+$'
               then (config.values->>'minimumTipPaise')::bigint
             else null
           end,
           1000
         )
    into configured_minimum
    from public.channel_configs config
   where config.channel_id = new.channel_id
   order by config.version desc
   limit 1;

  configured_minimum := greatest(1000, configured_minimum);
  if new.gross_amount_paise < configured_minimum then
    raise exception 'tip amount is below channel minimum' using errcode = '22023';
  end if;
  return new;
end
$$;

drop trigger if exists payment_order_intents_channel_minimum on public.payment_order_intents;
create trigger payment_order_intents_channel_minimum
before insert on public.payment_order_intents
for each row execute function app_private.enforce_channel_tip_minimum();

revoke execute on function app_private.get_public_channel(text) from public;
revoke execute on function app_private.enforce_channel_tip_minimum() from public;
grant execute on function app_private.get_public_channel(text) to bsa_app;
