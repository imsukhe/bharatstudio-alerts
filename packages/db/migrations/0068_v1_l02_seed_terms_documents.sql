-- L02: seed the two active terms_documents rows without which
-- app_private.has_accepted_active_terms/requireAuthAndTerms fail closed for
-- every user (0066_v1_l02_terms_fail_closed_without_active_documents.sql).
--
-- content_hash values are the SHA-256 hex digest of the canonical document
-- text in apps/web/app/accept-terms/terms-content.ts, computed by
-- apps/web/scripts/compute-terms-hash.ts. The two MUST stay in sync — a text
-- edit without a matching hash update here makes acceptance permanently
-- fail ("terms document is not active or hash does not match").
--
-- Text provenance (not newly drafted here):
--   terms_of_service — ported verbatim from the legacy BharatStudio Alerts
--     web app's /accept-terms page (10-section ToS, effective 1 Aug 2025).
--   privacy_notice — matches the already-published bharatstudio-marketing
--     /legal/privacy/ page for this same product.
--
-- Per governance, this carried-forward text still requires dated legal/
-- privacy review before being treated as final for production launch — see
-- terms-content.ts's header comment. A reviewed replacement must ship as a
-- new version row (e.g. 'v1.1'), never an edit of this v1.0 row's hash,
-- so no creator's existing acceptance is silently reinterpreted.

insert into public.terms_documents (document_key, version, content_hash, active, published_at)
values
  ('terms_of_service', 'v1.0', 'd2d0468e95108f2cd1185147ae3b06ced6eb354ca01c16a239897956d5702080', true, '2025-08-01T00:00:00Z'),
  ('privacy_notice', 'v1.0', '737151cee175eefd4f76b93ee8bb325cf07798a28c7ffda8d8a35d1256ffcd87', true, current_timestamp)
on conflict (document_key, version) do nothing;
