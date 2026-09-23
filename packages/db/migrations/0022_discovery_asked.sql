-- 0022 which discovery questions have been put to the client (ARB-130, docs/01 section F;
-- DECISIONS.md D-049)
--
-- `answers` holds what has been captured; `asked` holds when each question was drafted
-- for the client, so the next batch prefers the questions never put to them, and a
-- question is never re-asked while an answer is pending.
alter table discovery_sessions add column asked jsonb not null default '{}'::jsonb;
