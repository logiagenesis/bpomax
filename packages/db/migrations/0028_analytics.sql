-- 0028 ARB-320: one row per job with a submitted bid, with what analytics counts about it.
-- docs/01 section E gives the rollup worker "analytics tables/views"; a view is computed
-- when read, so every figure is always the stored rows' own (D-061). It runs with the
-- reader's rights (security_invoker), so RLS keeps each organisation to its own jobs.
create view analytics_job_facts with (security_invoker = true) as
select
  j.org_id,
  j.id as job_id,
  j.category_slug,
  category.name as category_name,
  j.scanner_id,
  scanner.name as scanner_name,
  bid.template_id,
  template.name as template_name,
  supplier.supplier_key,
  supplier.supplier_name,
  bid.submitted_at,
  -- A reply: a client message on the job's thread at or after the bid went.
  exists (
    select 1
      from threads t
      join messages m on m.thread_id = t.id
     where t.job_id = j.id
       and m.direction = 'in'
       and coalesce(m.sent_at, m.created_at) >= bid.submitted_at
  ) as replied,
  coalesce(item.stage in ('won', 'in_delivery', 'delivered', 'paid'), false) as won,
  coalesce(item.stage = 'lost', false) as lost,
  coalesce(money.in_zar, 0)::bigint as in_zar_minor,
  coalesce(money.out_zar, 0)::bigint as out_zar_minor,
  coalesce(money.unconverted, 0)::integer as unconverted_payments,
  coalesce(cost.nano_usd, 0)::bigint as model_cost_nano_usd
from jobs j
-- The latest submitted bid on the job.
join lateral (
  select p.submitted_at, v.template_id
    from proposals p
    left join template_variants v on v.id = p.template_variant_id
   where p.job_id = j.id and p.status = 'submitted' and p.submitted_at is not null
   order by p.submitted_at desc, p.id
   limit 1
) bid on true
left join service_categories category on category.slug = j.category_slug
left join scanners scanner on scanner.id = j.scanner_id
left join templates template on template.id = bid.template_id
left join pipeline_items item on item.job_id = j.id
-- The supplier of the job's live delivery order (ARB-310), if it has one.
left join lateral (
  select coalesce(o.supplier_id::text, o.supplier_candidate_id::text) as supplier_key,
         coalesce(s.name, c.display_name) as supplier_name
    from delivery_orders o
    left join suppliers s on s.id = o.supplier_id
    left join supplier_candidates c on c.id = o.supplier_candidate_id
   where o.pipeline_item_id = item.id and o.status <> 'cancelled'
   order by o.created_at desc
   limit 1
) supplier on true
-- Payments in and out in rand (ARB-311); one with no rand figure is counted apart.
left join lateral (
  select sum(case when y.direction = 'in'
                  then case when y.currency = 'ZAR' then y.amount_minor else y.amount_zar_minor end
             end) as in_zar,
         sum(case when y.direction = 'out'
                  then case when y.currency = 'ZAR' then y.amount_minor else y.amount_zar_minor end
             end) as out_zar,
         count(*) filter (where y.currency <> 'ZAR' and y.amount_zar_minor is null) as unconverted
    from payments y
   where y.pipeline_item_id = item.id
) money on true
-- Model spend on the job and its bids (llm_calls, D-021), in nano-US-dollars.
left join lateral (
  select sum(l.cost_nano_usd) as nano_usd
    from llm_calls l
   where l.org_id = j.org_id
     and ((l.subject_table = 'jobs' and l.subject_id = j.id)
       or (l.subject_table = 'proposals'
           and l.subject_id in (select p.id from proposals p where p.job_id = j.id)))
) cost on true;

grant select on analytics_job_facts to authenticated;
