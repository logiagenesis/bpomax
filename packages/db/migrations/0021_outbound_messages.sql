-- 0021 outbound messages that wait for a person (ARB-122, docs/01 section H; DECISIONS.md D-048)
--
-- An app-written outbound message (0019's origin = 'app') moves through: drafted
-- (approved_by null), approved (approved_by and approved_via set, sent_at null), sent
-- (sent_at and external_message_id set), rejected (rejected_at set) or failed
-- (failure_reason set and never sent). 0003's constraint already refuses a sent app
-- message without its approval; these two columns hold the other two outcomes.
alter table messages
  add column rejected_at timestamptz,
  add column failure_reason text;

create index messages_org_outbound_idx on messages (org_id, created_at desc)
  where direction = 'out' and origin = 'app';
