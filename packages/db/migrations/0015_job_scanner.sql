-- 0015 which scanner found a job (ARB-044, docs/01 section H)

-- Auto-send is per scanner, "with a hard daily cap and minimum score". To hold a cap at
-- submission time the proposal's job has to say which scanner it came from. The ingest
-- worker (ARB-022) sets it as it upserts; a job entered any other way has none, and a
-- proposal for such a job can only be submitted by a person.
alter table jobs
  add column scanner_id uuid references scanners (id) on delete set null;

create index jobs_scanner_idx on jobs (scanner_id);
