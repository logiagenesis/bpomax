-- 0018 one row per marketplace listing per org (ARB-022, D-045)
--
-- 0002 made (platform, external_id) unique across every org: the first org whose scanner
-- saw a listing would own it, and a second org's ingest would be refused. Each org has
-- its own scanners, scores, estimates and bids for the same public listing, so the
-- dedupe key the ingest worker upserts on is per org.

alter table jobs drop constraint jobs_platform_external_id_key;
alter table jobs add constraint jobs_org_platform_external_id_key
  unique (org_id, platform, external_id);
