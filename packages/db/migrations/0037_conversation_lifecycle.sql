-- 0037 conversation lifecycle, from the owner's audit LI-AUDIT-BPOMAX-TASKS-20260925 (ARB-520)

-- P-06. A marketplace thread is unique per org, not across orgs. 0003 made
-- (platform, external_thread_id) unique, so when two orgs' accounts took part in the same
-- Freelancer.com thread, the second org's inbox sync upserted into the first org's thread
-- and filed its messages there. The key becomes per org; then any message filed in another
-- org's thread is moved to a thread of its own org, made here if need be.
alter table threads drop constraint threads_platform_external_thread_id_key;
alter table threads
  add constraint threads_org_platform_external_thread_key
  unique (org_id, platform, external_thread_id);

insert into threads (org_id, platform, external_thread_id, status, last_message_at)
select m.org_id, t.platform, t.external_thread_id, 'awaiting_operator',
       max(coalesce(m.sent_at, m.created_at))
  from messages m
  join threads t on t.id = m.thread_id
 where m.org_id <> t.org_id
 group by m.org_id, t.platform, t.external_thread_id
on conflict do nothing;

update messages m
   set thread_id = own.id
  from threads theirs, threads own
 where m.thread_id = theirs.id
   and m.org_id <> theirs.org_id
   and own.org_id = m.org_id
   and own.platform = theirs.platform
   and own.external_thread_id = theirs.external_thread_id;

-- And the database now refuses a message filed in another org's thread, however it is
-- written. An after trigger, so row-level security has already refused a write into
-- another org before this runs.
create or replace function app.message_in_own_org() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from threads t where t.id = new.thread_id and t.org_id = new.org_id) then
    raise exception 'a message must belong to a thread of its own org'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger messages_in_own_org after insert or update of org_id, thread_id on messages
  for each row execute function app.message_in_own_org();

-- P-02. The model's notes to the operator on a drafted bid ("anything the operator should
-- check before approving", ARB-043) were kept only in the audit log, which retention
-- cannot reach. They now live on the bid, and the log keeps a fingerprint.
alter table proposals
  add column operator_notes text check (operator_notes is null or length(operator_notes) <= 500);
