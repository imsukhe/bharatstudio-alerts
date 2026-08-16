-- L02 account-consent boundary proof. Synthetic rows only.
--
-- Deactivates any pre-existing active terms_of_service/privacy_notice row
-- first. Migration 0068_v1_l02_seed_terms_documents.sql seeds real v1.0
-- active rows so the product isn't permanently fail-closed; this test
-- exercises the zero-active-documents case explicitly and then publishes
-- its own synthetic version, exactly mirroring what a real version bump
-- (deactivate old, activate new) does. Safe because this test always runs
-- against a disposable per-run container (see run-l03-application-behavior.sh)
-- — there is no "restore the seed afterward" step because the container is
-- destroyed at the end of the run.
\set ON_ERROR_STOP on

update terms_documents set active = false where document_key in ('terms_of_service', 'privacy_notice') and active;

do $$
begin
  if app_private.has_accepted_active_terms('00000000-0000-4000-8000-000000000001') then
    raise exception 'no active legal documents must fail closed';
  end if;
end
$$;

insert into terms_documents (document_key, version, content_hash, active, published_at)
values
  ('terms_of_service', 'test-2026-08-16', repeat('a', 64), true, current_timestamp),
  ('privacy_notice', 'test-2026-08-16', repeat('b', 64), true, current_timestamp);

select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true);
select app_private.accept_terms_document('00000000-0000-4000-8000-000000000001', 'terms_of_service', 'test-2026-08-16', repeat('a', 64));
select app_private.accept_terms_document('00000000-0000-4000-8000-000000000001', 'privacy_notice', 'test-2026-08-16', repeat('b', 64));

do $$
begin
  if not app_private.has_accepted_active_terms('00000000-0000-4000-8000-000000000001') then
    raise exception 'accepted active documents were not recognized';
  end if;
end
$$;

select 'L02_TERMS_CONSENT=PASS' as result;
