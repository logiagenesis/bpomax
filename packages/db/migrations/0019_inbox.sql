-- 0019 inbox sync (ARB-120, docs/01 section E "inbox-sync"; DECISIONS.md D-046)

-- Where the last sync of this account's threads and messages reached. The next run asks
-- Freelancer.com for what changed from a little before this point (inclusive), and the
-- unique keys below turn anything seen twice into an update.
alter table platform_accounts add column inbox_synced_to timestamptz;

comment on column platform_accounts.inbox_synced_to is
  'The time_updated of the newest thread the inbox sync has stored, minus nothing; the next run asks from five minutes before it.';

-- A marketplace message is stored once per thread. Messages written by the app before
-- they are sent have no external id yet, so the key is partial.
create unique index messages_thread_external_message_idx
  on messages (thread_id, external_message_id)
  where external_message_id is not null;

-- Where a message came from. The app's own outbound messages need an approval record
-- before they are sent (0003's rule, ARB-122). A message the owner wrote on
-- Freelancer.com itself, and the sync merely observed, was not sent by the app, so the
-- rule does not apply to it: it is marked `platform`.
alter table messages add column origin text not null default 'app'
  check (origin in ('app', 'platform'));

alter table messages drop constraint outbound_requires_approval;
alter table messages add constraint outbound_requires_approval check (
  direction = 'in'
  or origin = 'platform'
  or sent_at is null
  or (approved_by is not null and approved_via is not null)
);
