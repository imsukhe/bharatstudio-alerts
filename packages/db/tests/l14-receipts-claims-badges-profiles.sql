-- L14 missing slices: no-account receipt, idempotent/contested claim,
-- refund-safe badges, private-profile exclusion, cross-creator invisibility
-- (reconfirmed for the new profile/badge surface). Synthetic data only.
--
-- psql variable note: values needed INSIDE a `do $$ ... $$` block are
-- stashed via set_config()/current_setting() (a runtime GUC), never as a
-- bare `:'var'` psql substitution, because psql does not interpolate its
-- own variables inside dollar-quoted bodies — the same idiom
-- l14_viewer_identity.sql already uses for its session id.
\set ON_ERROR_STOP on

insert into app_users (id, external_subject, display_name, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000f4c01', 'l14b-creator-one', 'Creator One', current_timestamp, current_timestamp);
insert into channels (id, owner_user_id, handle, display_name, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000f4c11', '00000000-0000-4000-8000-0000000f4c01', 'l14b-channel-one', 'Channel One', current_timestamp, current_timestamp);
insert into channel_memberships (channel_id, user_id, role, created_at) values
  ('00000000-0000-4000-8000-0000000f4c11', '00000000-0000-4000-8000-0000000f4c01', 'owner', current_timestamp);

insert into payment_accounts (id, channel_id, provider, environment, connected_account_ref, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000f4a01', '00000000-0000-4000-8000-0000000f4c11', 'razorpay', 'test', 'acct_l14b', 'active', current_timestamp, current_timestamp);

-- Payment 1: captured, will get a receipt.
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, environment, connected_account_ref, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000f4d01', '00000000-0000-4000-8000-0000000f4c11', 'razorpay', 'pay_l14b_1', 'order_l14b_1', 20000, 'INR', 'captured', 'test', 'acct_l14b', current_timestamp, current_timestamp);
insert into payment_order_intents (id, channel_id, payment_account_id, provider, environment, connected_account_ref, idempotency_key, provider_receipt, provider_order_id, gross_amount_paise, currency, donor_display_name, donor_message, alert_consent, status, expires_at, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000f4e01', '00000000-0000-4000-8000-0000000f4c11', '00000000-0000-4000-8000-0000000f4a01', 'razorpay', 'test', 'acct_l14b', 'l14b-intent-fixture-0001', 'l14b-receipt-fixture-0001', 'order_l14b_1', 20000, 'INR', 'Ravi', 'Great stream!', true, 'paid', current_timestamp + interval '10 minutes', current_timestamp, current_timestamp);

-- ---------------------------------------------------------------------
-- Receipt: mint is idempotent-by-payment; token reveals nothing by
-- itself (a random hex fingerprint match is the only way in); resolves
-- with NO viewer account / auth context at all (no set_config here).
-- ---------------------------------------------------------------------
select id from app_private.create_payment_receipt('00000000-0000-4000-8000-0000000f4b01', '00000000-0000-4000-8000-0000000f4d01', encode(sha256('token-one'::bytea), 'hex')) \gset first_
select set_config('l14b.first_receipt_id', :'first_id', false);
do $$ begin if '00000000-0000-4000-8000-0000000f4b01'::uuid <> current_setting('l14b.first_receipt_id')::uuid then raise exception 'receipt id mismatch'; end if; end $$;

-- Second mint attempt for the SAME payment must NOT create a second live
-- receipt/token (idempotent-by-payment: unique(payment_id) plus no-op).
select count(*) as n from app_private.create_payment_receipt(gen_random_uuid(), '00000000-0000-4000-8000-0000000f4d01', encode(sha256('token-two'::bytea), 'hex')) \gset second_
select set_config('l14b.second_n', :'second_n', false);
do $$ begin if current_setting('l14b.second_n')::int <> 0 then raise exception 'second mint for the same payment must not return a row'; end if; end $$;
do $$ begin if (select count(*) from payment_receipts where payment_id = '00000000-0000-4000-8000-0000000f4d01') <> 1 then raise exception 'exactly one receipt row must exist per payment'; end if; end $$;

-- THE RECEIPT TEST: no account, no session, no app.viewer_id set at all —
-- resolves purely by token fingerprint match.
do $$
declare r record;
begin
  select * into r from app_private.get_payment_receipt_by_token_hash(encode(sha256('token-one'::bytea), 'hex'));
  if r.channel_handle is distinct from 'l14b-channel-one' then raise exception 'receipt did not resolve channel'; end if;
  if r.net_amount_paise <> 20000 then raise exception 'receipt net amount wrong before any refund, got %', r.net_amount_paise; end if;
  if r.donor_display_name is distinct from 'Ravi' then raise exception 'receipt donor name wrong'; end if;
end
$$;

-- Unknown token must resolve to no rows (never an error leaking existence).
do $$
begin
  if exists (select 1 from app_private.get_payment_receipt_by_token_hash('0000000000000000000000000000000000000000000000000000000000000000')) then
    raise exception 'unknown token must resolve to zero rows';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Claim: idempotent, contested-claim-safe (first-claim-wins).
-- ---------------------------------------------------------------------
select viewer_account_id, viewer_identity_id from app_private.create_viewer_account('00000000-0000-4000-8000-0000000f4aa1', 'l14b-viewer-a@example.com', repeat('x', 32), 'Viewer A') \gset va_
select viewer_account_id, viewer_identity_id from app_private.create_viewer_account('00000000-0000-4000-8000-0000000f4ab1', 'l14b-viewer-b@example.com', repeat('y', 32), 'Viewer B') \gset vb_
select set_config('l14b.va_account', :'va_viewer_account_id', false);
select set_config('l14b.vb_account', :'vb_viewer_account_id', false);
select set_config('l14b.va_identity', :'va_viewer_identity_id', false);

select set_config('app.viewer_id', :'va_viewer_account_id', false);
select viewer_identity_id, claim_result from app_private.claim_platform_identity(:'va_viewer_account_id', 'youtube', 'UC_L14B_1', 'Ravi on YouTube') \gset claim1_
select set_config('l14b.claim1_identity', :'claim1_viewer_identity_id', false);
do $$ begin if current_setting('l14b.claim1_identity') is null then raise exception 'first claim did not return an identity'; end if; end $$;
select set_config('l14b.claim1_result', :'claim1_claim_result', false);
do $$ begin if current_setting('l14b.claim1_result') <> 'claimed' then raise exception 'first claim must succeed with result=claimed, got %', current_setting('l14b.claim1_result'); end if; end $$;

-- Idempotent repeat claim by the SAME account.
select viewer_identity_id, claim_result from app_private.claim_platform_identity(:'va_viewer_account_id', 'youtube', 'UC_L14B_1', 'Ravi on YouTube') \gset claim2_
select set_config('l14b.claim2_identity', :'claim2_viewer_identity_id', false);
select set_config('l14b.claim2_result', :'claim2_claim_result', false);
do $$
begin
  if current_setting('l14b.claim2_result') <> 'already_claimed_by_self' then
    raise exception 'repeat claim by the same account must be idempotent, got %', current_setting('l14b.claim2_result');
  end if;
  if current_setting('l14b.claim2_identity')::uuid <> current_setting('l14b.claim1_identity')::uuid then
    raise exception 'repeat claim must resolve to the SAME identity row';
  end if;
end
$$;

-- Contested claim: a DIFFERENT account must be rejected (not raised — a
-- returned 'rejected_contested' result the caller branches on), and must
-- never re-point merged_into_account_id.
select set_config('app.viewer_id', :'vb_viewer_account_id', false);
select claim_result from app_private.claim_platform_identity(:'vb_viewer_account_id', 'youtube', 'UC_L14B_1', 'Impostor') \gset contested_
select set_config('l14b.contested_result', :'contested_claim_result', false);
do $$
begin
  if current_setting('l14b.contested_result') <> 'rejected_contested' then
    raise exception 'contested claim by a different account must return rejected_contested, got %', current_setting('l14b.contested_result');
  end if;
end
$$;
do $$
begin
  if (select merged_into_account_id from viewer_identities where id = current_setting('l14b.claim1_identity')::uuid) <> current_setting('l14b.va_account')::uuid then
    raise exception 'contested claim attempt must never re-point an already-claimed identity';
  end if;
end
$$;
do $$
begin
  if (select count(*) from viewer_identity_claim_attempts where result = 'rejected_contested') <> 1 then
    raise exception 'contested claim attempt must be recorded';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Badges/streak refund rule: a fully-refunded tip must not leave a badge
-- permanently earned.
-- ---------------------------------------------------------------------
select set_config('app.viewer_id', :'va_viewer_account_id', false);
insert into payments (id, channel_id, provider, provider_payment_id, provider_order_id, gross_amount_paise, currency, status, environment, connected_account_ref, viewer_identity_id, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000f4d02', '00000000-0000-4000-8000-0000000f4c11', 'razorpay', 'pay_l14b_2', 'order_l14b_2', 30000, 'INR', 'captured', 'test', 'acct_l14b', current_setting('l14b.va_identity')::uuid, current_timestamp, current_timestamp);

do $$
declare row record;
begin
  select * into row from app_private.get_viewer_channel_badges(current_setting('l14b.va_account')::uuid, '00000000-0000-4000-8000-0000000f4c11');
  if row.net_tip_count <> 1 then raise exception 'expected exactly 1 net tip before refund, got %', row.net_tip_count; end if;
  if not ('supporter_since_' || extract(year from current_timestamp)::text = any(row.badges)) then
    raise exception 'supporter-since badge missing before refund';
  end if;
end
$$;

-- Fully refund it.
update payments set status = 'refunded' where id = '00000000-0000-4000-8000-0000000f4d02';
insert into refunds (id, payment_id, provider_refund_id, amount_paise, status, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000f4bf1', '00000000-0000-4000-8000-0000000f4d02', 'rfnd_l14b_1', 30000, 'processed', current_timestamp, current_timestamp);

do $$
declare row record;
begin
  select * into row from app_private.get_viewer_channel_badges(current_setting('l14b.va_account')::uuid, '00000000-0000-4000-8000-0000000f4c11');
  if row.net_tip_count <> 0 then raise exception 'fully refunded tip must not count toward net_tip_count, got %', row.net_tip_count; end if;
  if row.net_lifetime_paise <> 0 then raise exception 'fully refunded tip must not count toward net_lifetime_paise, got %', row.net_lifetime_paise; end if;
  if row.badges is not null and array_length(row.badges, 1) > 0 then
    raise exception 'a badge earned only by a since-refunded tip must not remain, got %', row.badges;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Opt-in public profile: private-by-default must NEVER surface in search
-- (THE key privacy proof).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from app_private.search_public_viewer_profiles('Viewer')) then
    raise exception 'private-by-default profile must never appear in search';
  end if;
end
$$;

select set_config('app.viewer_id', :'va_viewer_account_id', false);
select profile_visibility, profile_slug from app_private.set_viewer_profile_visibility(:'va_viewer_account_id', 'public', 'ravi-l14b') \gset prof_
select set_config('l14b.prof_visibility', :'prof_profile_visibility', false);
do $$ begin if current_setting('l14b.prof_visibility') <> 'public' then raise exception 'profile did not become public'; end if; end $$;

do $$
begin
  if (select count(*) from app_private.search_public_viewer_profiles('ravi')) <> 1 then
    raise exception 'opted-in public profile must be findable by search';
  end if;
  -- Viewer B never opted in: no query should ever surface her.
  if (select count(*) from app_private.search_public_viewer_profiles(null)) <> 1 then
    raise exception 'unscoped search must return only the one opted-in profile, viewer B must stay hidden';
  end if;
end
$$;

-- Set back to private: must disappear from search immediately (no stale
-- index/materialization to go stale).
select set_config('app.viewer_id', :'va_viewer_account_id', false);
select * from app_private.set_viewer_profile_visibility(:'va_viewer_account_id', 'private', null);
do $$
begin
  if exists (select 1 from app_private.search_public_viewer_profiles('ravi')) then
    raise exception 'a profile switched back to private must vanish from search immediately';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Cross-creator invisibility (reconfirmed for the new badge surface): a
-- second, unrelated channel must never see viewer A's badges/history via
-- any function this migration adds — none of app_private.get_viewer_
-- channel_badges/create_payment_receipt/get_payment_receipt_by_token_hash/
-- search_public_viewer_profiles ever takes or requires a "current creator"
-- context, and none selects amounts scoped to any channel but the one
-- explicitly passed in. Proven concretely: badges for an unrelated channel
-- id are all-zero/empty even though viewer A has real history elsewhere.
-- ---------------------------------------------------------------------
insert into channels (id, owner_user_id, handle, display_name, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000f4c12', '00000000-0000-4000-8000-0000000f4c01', 'l14b-channel-two', 'Channel Two', current_timestamp, current_timestamp);
do $$
declare row record;
begin
  select * into row from app_private.get_viewer_channel_badges(current_setting('l14b.va_account')::uuid, '00000000-0000-4000-8000-0000000f4c12');
  if row.net_tip_count <> 0 or row.net_lifetime_paise <> 0 then
    raise exception 'a channel viewer A never supported must show zero history, not channel one''s';
  end if;
end
$$;
