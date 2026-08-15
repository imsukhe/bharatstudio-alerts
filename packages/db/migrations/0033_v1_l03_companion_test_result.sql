-- L03 Companion command result linkage.
-- A send_test_alert command creates one durable synthetic alert in the same
-- transaction. The optional result event lets idempotent retries return the
-- original event without creating a second alert.

alter table public.companion_commands
  add column if not exists result_event_id uuid references public.alert_events(id);

create index if not exists companion_commands_result_event_idx
  on public.companion_commands (result_event_id)
  where result_event_id is not null;

grant select on public.companion_commands to bsa_app;
