-- L07 Companion action-contract hardening.
--
-- The original L03 table check included approve_alert, hold_alert and
-- replay_alert while the v1 Companion API never implemented those effects.
-- Preserve any historical rows, but reject those legacy actions for all new
-- rows. NOT VALID is intentional: validating old command history would make
-- the migration fail or require rewriting append-only evidence.
alter table public.companion_commands
  drop constraint if exists companion_commands_v1_action_check;

alter table public.companion_commands
  add constraint companion_commands_v1_action_check
  check (action in ('pause_queue', 'resume_queue', 'send_test_alert')) not valid;

comment on constraint companion_commands_v1_action_check on public.companion_commands is
  'v1 accepts only implemented Companion actions; legacy historical rows remain preserved and the constraint is intentionally not validated against them';
