-- L22c: review timestamps use current_timestamp, which is deliberately stable
-- within one transaction.  Timestamp plus a random UUID therefore cannot
-- express the causal order of two decisions made in that transaction.  Add a
-- monotonic, write-time audit order for every new decision; retain legacy rows
-- and assign their one-off sequence by their only available historical order.

create sequence public.staff_creator_pack_review_audit_order_seq;

alter table public.staff_creator_pack_review_audit
  add column review_order bigint;

with ordered as (
  select id, row_number() over (order by reviewed_at asc, id asc)::bigint as review_order
    from public.staff_creator_pack_review_audit
)
update public.staff_creator_pack_review_audit audit
   set review_order = ordered.review_order
  from ordered
 where ordered.id = audit.id;

alter table public.staff_creator_pack_review_audit
  alter column review_order set default nextval('public.staff_creator_pack_review_audit_order_seq'),
  alter column review_order set not null;

select setval(
  'public.staff_creator_pack_review_audit_order_seq',
  greatest(coalesce((select max(review_order) from public.staff_creator_pack_review_audit), 0), 1),
  true
);

alter table public.staff_creator_pack_review_audit
  add constraint staff_creator_pack_review_audit_review_order_unique unique (review_order);

create index staff_creator_pack_review_audit_latest_idx
  on public.staff_creator_pack_review_audit (pack_sticker_id, review_order desc);

create or replace function app_private.staff_list_creator_pack_review_audit(
  target_pack_sticker_id uuid
)
returns table (id uuid, reviewer_id uuid, decision text, reason text, reviewed_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app_private
as $$
begin
  if not app_private.is_platform_admin() then
    raise exception 'platform staff access required' using errcode = '42501';
  end if;

  return query
    select audit.id, audit.reviewer_id, audit.decision, audit.reason, audit.reviewed_at
      from public.staff_creator_pack_review_audit audit
     where audit.pack_sticker_id = target_pack_sticker_id
     order by audit.review_order desc;
end
$$;

revoke all on sequence public.staff_creator_pack_review_audit_order_seq from public;
revoke all on sequence public.staff_creator_pack_review_audit_order_seq from bsa_app;
revoke execute on function app_private.staff_list_creator_pack_review_audit(uuid) from public;
grant execute on function app_private.staff_list_creator_pack_review_audit(uuid) to bsa_app;
