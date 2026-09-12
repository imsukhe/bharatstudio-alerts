-- L14 viewer password reset: happy path, single-use, expiry, enumeration
-- resistance, and post-reset session revocation. Synthetic rows only. Run
-- against a disposable per-container database — see
-- run-l14-viewer-password-reset.sh.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Fixture: one viewer account with an active session.
-- ---------------------------------------------------------------------
select viewer_account_id, viewer_identity_id
  from app_private.create_viewer_account('00000000-0000-4000-8000-0000000000d1', 'reset-target@example.com', repeat('x', 32), 'Reset Target')
\gset viewer_

select session_id, viewer_account_id
  from app_private.create_viewer_session(gen_random_uuid(), '00000000-0000-4000-8000-0000000000d1', 'pre-reset-session-hash', 'test-device', current_timestamp + interval '30 days')
\gset session_

-- ---------------------------------------------------------------------
-- Enumeration resistance: requesting a reset for an email that does not
-- match any viewer account must be a silent no-op — no exception, and no
-- row inserted anywhere.
-- ---------------------------------------------------------------------
-- psql does not substitute :'variables' inside dollar-quoted (do $$...$$)
-- blocks (same caveat l14_viewer_identity.sql notes for a session id), so
-- the before-counts cross into plpgsql via a GUC instead.
select set_config('l14.before_tokens', (select count(*) from viewer_password_reset_tokens)::text, false);
select set_config('l14.before_emails', (select count(*) from email_outbox where kind = 'viewer_password_reset')::text, false);

select app_private.request_viewer_password_reset(gen_random_uuid(), 'nobody-registered@example.com', 'unknown-token-hash', current_timestamp + interval '30 minutes', 'https://app.example.com/viewer/reset-password#token=unused');

do $$
begin
  if (select count(*) from viewer_password_reset_tokens) <> current_setting('l14.before_tokens')::bigint then
    raise exception 'unknown email must not insert a reset token row';
  end if;
  if (select count(*) from email_outbox where kind = 'viewer_password_reset') <> current_setting('l14.before_emails')::bigint then
    raise exception 'unknown email must not enqueue a reset email';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Happy path: requesting a reset for the real email inserts exactly one
-- token row and enqueues exactly one email_outbox row addressed to the
-- viewer (never to app_users), with the plaintext token nowhere in the
-- tokens table itself.
-- ---------------------------------------------------------------------
select app_private.request_viewer_password_reset(
  '00000000-0000-4000-8000-0000000000f1', 'reset-target@example.com', 'real-token-hash-one',
  current_timestamp + interval '30 minutes', 'https://app.example.com/viewer/reset-password#token=plaintext-would-go-here'
);

do $$
declare row_count int;
begin
  select count(*) into row_count from viewer_password_reset_tokens where id = '00000000-0000-4000-8000-0000000000f1';
  if row_count <> 1 then raise exception 'expected exactly one reset token row, saw %', row_count; end if;

  if exists (select 1 from viewer_password_reset_tokens where token_hash = 'plaintext-would-go-here') then
    raise exception 'reset token table must never contain a plaintext token';
  end if;

  select count(*) into row_count
    from email_outbox
   where kind = 'viewer_password_reset'
     and recipient_viewer_account_id = '00000000-0000-4000-8000-0000000000d1'
     and recipient_user_id is null;
  if row_count <> 1 then raise exception 'expected exactly one viewer-addressed reset email, saw %', row_count; end if;
end
$$;

-- claim_pending_emails must surface the viewer's own email + verified=true
-- for this recipient shape (see 0088's own comment on why).
do $$
declare claimed record;
begin
  select * into claimed from app_private.claim_pending_emails(10) where kind = 'viewer_password_reset' limit 1;
  if claimed.recipient_email <> 'reset-target@example.com' then
    raise exception 'claimed reset email must resolve the viewer''s own address, got %', claimed.recipient_email;
  end if;
  if claimed.recipient_email_verified is not true then
    raise exception 'a viewer-recipient outbox row must report recipient_email_verified = true';
  end if;
  -- Return it to pending so it doesn't interfere with later assertions in
  -- this file (a real drain would complete it; this test isn't exercising
  -- that path).
  update email_outbox set status = 'pending' where id = claimed.id;
end
$$;

-- ---------------------------------------------------------------------
-- Expiry: a token past its expires_at must not be consumable.
-- ---------------------------------------------------------------------
insert into viewer_password_reset_tokens (id, viewer_account_id, token_hash, expires_at)
values ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000d1', 'expired-token-hash', current_timestamp - interval '1 minute');

do $$
declare returned_id uuid;
begin
  select viewer_account_id into returned_id from app_private.consume_viewer_password_reset_token('expired-token-hash', repeat('q', 32));
  if returned_id is not null then raise exception 'an expired token must not be consumable';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Happy-path completion: consuming the real (non-expired) token succeeds,
-- updates the password hash, and revokes every existing session.
-- ---------------------------------------------------------------------
do $$
declare returned_id uuid;
begin
  select viewer_account_id into returned_id from app_private.consume_viewer_password_reset_token('real-token-hash-one', repeat('n', 32));
  if returned_id <> '00000000-0000-4000-8000-0000000000d1' then
    raise exception 'consuming a valid token must return the owning viewer account id';
  end if;
end
$$;

do $$
begin
  if (select password_hash from viewer_accounts where id = '00000000-0000-4000-8000-0000000000d1') <> repeat('n', 32) then
    raise exception 'password_hash must be updated after a successful reset';
  end if;
end
$$;

-- Sessions revoked: the pre-reset session must no longer be resolvable.
select set_config('app.viewer_id', '00000000-0000-4000-8000-0000000000d1', false);
do $$
begin
  if (select viewer_account_id from app_private.lookup_viewer_session('pre-reset-session-hash')) is not null then
    raise exception 'every existing viewer session must be revoked after a password reset';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Single-use: the same token must not be consumable a second time, even
-- though it has not expired.
-- ---------------------------------------------------------------------
do $$
declare returned_id uuid;
begin
  select viewer_account_id into returned_id from app_private.consume_viewer_password_reset_token('real-token-hash-one', repeat('z', 32));
  if returned_id is not null then raise exception 'a used reset token must not be consumable a second time';
  end if;
  if (select password_hash from viewer_accounts where id = '00000000-0000-4000-8000-0000000000d1') = repeat('z', 32) then
    raise exception 'a rejected second use must not overwrite the password hash';
  end if;
end
$$;

-- Unknown token hash: same generic "not found" behaviour as used/expired.
do $$
declare returned_id uuid;
begin
  select viewer_account_id into returned_id from app_private.consume_viewer_password_reset_token('never-issued-token-hash', repeat('m', 32));
  if returned_id is not null then raise exception 'an unknown token hash must not be consumable'; end if;
end
$$;

\echo 'L14 viewer password reset: all assertions passed'
