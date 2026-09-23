-- 0030 ARB-340: a variant's sends and replies, counted from the stored rows (D-064).
-- 0006 gave template_variants two counters, sends and replies, but nothing ever wrote
-- them, so every variant read 0 of 0 and the drafter's "best reply rate" was the label
-- order. A count kept beside the rows can drift from them; a view cannot. The counters
-- go, and this view gives the same two figures under the same names, with the same reply
-- rule as analytics_job_facts (0028): a client message on the job's thread at or after
-- the bid went. It runs with the reader's rights, so RLS keeps each organisation to its
-- own variants.
alter table template_variants drop constraint replies_cannot_exceed_sends;
alter table template_variants drop column sends, drop column replies;

create view template_variant_stats with (security_invoker = true) as
select
  v.org_id,
  v.id as variant_id,
  v.template_id,
  count(p.id)::integer as sends,
  (count(p.id) filter (
    where exists (
      select 1
        from threads t
        join messages m on m.thread_id = t.id
       where t.job_id = p.job_id
         and m.direction = 'in'
         and coalesce(m.sent_at, m.created_at) >= p.submitted_at
    )
  ))::integer as replies
from template_variants v
left join proposals p
  on p.template_variant_id = v.id
 and p.status = 'submitted'
 and p.submitted_at is not null
group by v.org_id, v.id, v.template_id;

grant select on template_variant_stats to authenticated;
