-- 0010 data retention (ARB-015, docs/02 T-06)
--
-- POPIA obliges Logi-Ink to keep personal information no longer than necessary. What
-- "necessary" is here is a legal answer the owner has to get (T-06), so the period is a
-- setting with no default and live mode is refused until it has one. An unset period
-- means the job does nothing — it never guesses.

alter table settings
  add column retention_days integer check (retention_days > 0);

comment on column settings.retention_days is
  'Days a closed conversation keeps its client content before redaction. Set from legal advice (docs/02 T-06); null means not yet decided and the retention job stands down.';

alter table settings
  add constraint live_mode_requires_retention_period check (
    not live_mode or retention_days is not null
  );

-- Redaction, not deletion. The rows stay so the audit log, the pipeline and the
-- analytics still reconcile; what leaves is the client's own words and handle.
alter table threads add column redacted_at timestamptz;
alter table messages add column redacted_at timestamptz;
alter table discovery_sessions add column redacted_at timestamptz;

create index threads_org_redaction_idx on threads (org_id, status, last_message_at)
  where redacted_at is null;
