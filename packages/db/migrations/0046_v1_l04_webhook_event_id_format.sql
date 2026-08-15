-- Defense-in-depth for provider delivery identity.
--
-- The Go verifier is the normal ingress boundary. This constraint also
-- protects new rows if a trusted payment caller or private SQL function is
-- invoked directly. NOT VALID intentionally preserves historical evidence;
-- PostgreSQL still enforces the constraint for every new or updated row.
alter table public.payment_webhook_deliveries
  drop constraint if exists payment_webhook_deliveries_event_id_format;

alter table public.payment_webhook_deliveries
  add constraint payment_webhook_deliveries_event_id_format
  check (provider_event_id ~ '^[A-Za-z0-9._-]{1,200}$')
  not valid;
