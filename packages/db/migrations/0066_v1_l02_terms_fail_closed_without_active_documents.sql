-- L02 hardening: a missing legal-document seed must not be interpreted as
-- consent. Product mutations remain blocked until both active documents are
-- published and accepted by the user.

create or replace function app_private.has_accepted_active_terms(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
  select exists (
           select 1
             from public.terms_documents active_document
            where active_document.active
         )
     and not exists (
           select 1
             from public.terms_documents active_document
            where active_document.active
              and not exists (
                    select 1
                      from public.user_terms_acceptances acceptance
                     where acceptance.user_id = target_user_id
                       and acceptance.document_key = active_document.document_key
                       and acceptance.document_version = active_document.version
                       and acceptance.content_hash = active_document.content_hash
                  )
         )
$$;

revoke execute on function app_private.has_accepted_active_terms(uuid) from public;
grant execute on function app_private.has_accepted_active_terms(uuid) to bsa_app;
