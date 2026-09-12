-- Security fix: a new SECURITY DEFINER helper shipped executable by PUBLIC.
--
-- 0088 added app_private.enqueue_viewer_password_reset_email as SECURITY
-- DEFINER (0088_v1_l14_viewer_password_reset.sql:120) but its revoke/grant
-- block at the end of that file only covers request_viewer_password_reset and
-- consume_viewer_password_reset_token. In PostgreSQL a newly created function
-- carries a default EXECUTE grant to PUBLIC, so this one was callable by any
-- role — including roles that must never be able to enqueue mail on a viewer's
-- behalf. Because it runs SECURITY DEFINER, calling it executes with the
-- definer's privileges, not the caller's.
--
-- Caught by the repo's own standing invariant in
-- packages/db/tests/l02_security_remediations.sql:63 — "app_private SECURITY
-- DEFINER helper remains executable by PUBLIC". That test is the reason this
-- was found within minutes of the migration landing rather than in review, and
-- it is worth keeping green for exactly that reason.
--
-- app_private.claim_pending_emails is NOT affected: 0088 re-created it with
-- CREATE OR REPLACE, and CREATE OR REPLACE preserves the existing privileges,
-- so the revoke it received when it was first created in
-- 0075_v1_l02_l03_l04_email_delivery.sql still stands. Only genuinely new
-- functions lose their boundary this way, which is what makes the omission
-- easy to miss by eye.
--
-- 0088 is left untouched; migration history is never rewritten.

revoke execute on function app_private.enqueue_viewer_password_reset_email(uuid, uuid, jsonb) from public;

-- The email enqueue path is driven by the viewer password-reset request flow,
-- which already runs as bsa_app, so that is the only role that needs it.
grant execute on function app_private.enqueue_viewer_password_reset_email(uuid, uuid, jsonb) to bsa_app;
