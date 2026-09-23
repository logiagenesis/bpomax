-- 0024 ARB-202: a sourcing post's title. Freelancer.com's project and the manual
-- drafts both need one; it is written from the brief's outcome, never the client's
-- public job title (D-054).
alter table sourcing_posts add column title text not null default '';
