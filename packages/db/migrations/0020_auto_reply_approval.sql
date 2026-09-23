-- 0020 who approved the auto-reply wording (ARB-121, docs/02 D-08; DECISIONS.md D-047)
--
-- An auto-reply the worker sends is an outbound message, and 0003 lets none leave
-- without an approval record. The approval is the person who saved the wording with the
-- switch on; each sent reply carries it as `messages.approved_by`, `approved_via = 'auto'`.
alter table auto_replies add column approved_by uuid references users (id) on delete set null;
