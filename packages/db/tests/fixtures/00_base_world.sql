-- Shared base world for the SQL test suite.
--
-- Six of the test files (l03_payment_ledger_read, l03_tts_event_enrichment,
-- l04_payment_account_onboarding, l04_reconciliation_quarantine,
-- l05_queue_policy_enforcement, l07_notification_preferences) reference users
-- '...0001'-'...0006' and channels '...0011'/'...0012' without seeding them.
-- They were only ever passing because l03_application_behavior.sql happened to
-- run earlier in the same shared database and left those rows behind — an
-- accident of alphabetical order, not a property of the tests.
--
-- run-sql-suite.sh applies this file to the template database so every test
-- starts from the same explicitly documented world. Every statement is
-- idempotent, so a test that also seeds these rows itself still works.
--
-- Synthetic identifiers only; no provider or production data is permitted.

insert into app_users (id, external_subject, display_name, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000001', 'google-a', 'Synthetic A', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000002', 'google-b', 'Synthetic B', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000003', 'google-admin', 'Synthetic Admin', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000004', 'google-operator', 'Synthetic Operator', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000005', 'google-moderator', 'Synthetic Moderator', current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000006', 'google-viewer', 'Synthetic Viewer', current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channels (id, owner_user_id, handle, display_name, accepting_tips, public_config_version, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'synthetic_a', 'Synthetic A Channel', true, 1, current_timestamp, current_timestamp),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'synthetic_b', 'Synthetic B Channel', true, 1, current_timestamp, current_timestamp)
on conflict (id) do nothing;

insert into channel_memberships (channel_id, user_id, role, created_at)
values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'owner', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000003', 'admin', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000004', 'operator', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000005', 'moderator', current_timestamp),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000006', 'viewer', current_timestamp)
on conflict (channel_id, user_id) do nothing;


-- RESOLVED (was a known limitation): l04_reconciliation_quarantine and
-- l05_queue_policy_enforcement used to depend on payment '...0131', payment
-- account '...0041' and alert queue '...0021' / binding '...0031', which only
-- l03_application_behavior.sql created. Pre-seeding those exact ids here
-- broke l03 (it asserts on the trigger side effects of creating them: the
-- default-payment-binding trigger and the queue-binding identity guard), so
-- each of those two tests now carries its own self-contained fixture instead,
-- under its own id block (below).
--
-- ID ALLOCATION REGISTRY
--
-- This suite has no automated id registry, and a collision is invisible
-- until two files' rows land in the same database (a shared fixture, or a
-- future move away from run-sql-suite.sh's per-file isolation). Before adding
-- a synthetic uuid anywhere under packages/db/tests/, grep every
-- packages/db/tests/*.sql for the literal suffix you're about to use, and
-- record any new block here.
--
--   ...0001-...0006, ...0011-...0014          base_world / l03 shared users+channels
--   ...0021-...0099, ...00a1-...00c4          l03_application_behavior (queues/bindings/payments/etc.)
--   ...0101-...0238                           l03_application_behavior (continued)
--   ...01a1-...01da, ...01f1-...01f2          l03_application_behavior / l04_reconciliation_quarantine intents
--   ...0201-...0238, ...02e1-...02fc          l03_application_behavior / l05_queue_policy_enforcement
--   ...0301-...0404                           l03_application_behavior (operator/moderator commands)
--   ...0501-...0512, ...0601-...0612          l03_entitlement_retier_and_dimensions / l03_tts_usage_metering (check per-file)
--   ...0701-...0704                           l03_referral_growth_engine
--   ...0801-...0815                           l03_lottie_branding_upload / l03_admin_* (check per-file)
--   ...0901-...0962                           l07_companion_device_pairing
--   ...0a01-...0a05                           l07_companion_device_pairing (fingerprint fixtures)
--   ...1001-...1122                           l07_notification_preferences / l03_featured_creator_listing (check per-file)
--   ...1201-...1311                           l03_queue_mode_ladder / l04_downgrade_enforcement (check per-file)
--   ...1400-...1406                           l04_reconciliation_quarantine OWN fixture (channel, account-scoped and legacy payments/refunds)
--   ...1501-...1502                           l05_queue_policy_enforcement OWN fixture (alert_queue, queue_binding)
--   ...1601-...1602, ...1611                  l16_security_boundary OWN fixture (viewer accounts, device pairing)
--   ...c001-...c002, ...ec101-...ec102        l14_viewer_identity
--   ...1701-...1702, ...1710-...1711          l02b-reputation-signals OWN fixture (viewer accounts, payment+refund)
--   ...5500-...55ff                           prf02_slice5_moderator_status OWN fixture
--   ...5700-...57ff                           prf02_slice6_reaction_cloud OWN fixture (channels, catalogue entries, creator packs, overlay sessions)
--   ...5800-...58ff                           prf02_slice6_lobby_status OWN fixture (channels, memberships, entitlement versions, overlay sessions)
--   ...5a00-...5aff                           prf02_slice6_giveaway_tournament OWN fixture (channels, memberships, entitlement versions, lobby sessions, overlay sessions)
--   ...6600-...66ff                           prf02_slice7_qr_smart_card OWN fixture (overlay sessions)
--
-- Next free block for a new test's own fixture: ...1720 upward.
