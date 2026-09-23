import { buildServer } from '@arbitron/api';
import { insertBriefVersion, lockBrief } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpApiClient } from './api.js';
import { TOOL_NAMES, createArbitronMcpServer } from './server.js';

/**
 * ARB-330 acceptance: "Each tool callable in an automated test". Each tool is called the
 * way Claude Desktop or Claude Code calls it: an MCP client over the SDK's in-memory
 * transport, the server's HTTP client, and the real API listening on a port, over real
 * Postgres with RLS on. The token the client sends is the one the API authenticates;
 * here it stands for the signed-in person's Supabase token (docs/02 B-06).
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const AUTH_VIEWER = fixtureId('c', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const USER_VIEWER = fixtureId('c', ENTITY.user);
const JOB_A = fixtureId('a', ENTITY.job);
const THREAD_A = fixtureId('a', ENTITY.thread);
const PROPOSAL_A = fixtureId('a', ENTITY.proposal);
const MARGIN_A = fixtureId('a', ENTITY.margin);
const ESTIMATE_A = fixtureId('a', ENTITY.estimate);
const PIPELINE_A = fixtureId('a', ENTITY.pipelineItem);
const JOB_NEW = fixtureId('e', 90); // never scored
const PROPOSAL_WAITING = fixtureId('e', 91); // queued, on JOB_NEW
const JOB_BARE = fixtureId('e', 92); // never scored, no bid
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = new Date('2026-09-23T10:00:00Z');

const enqueue = {
  submit: vi.fn(async () => undefined),
  draft: vi.fn(async () => undefined),
  score: vi.fn(async () => undefined),
  sendMessage: vi.fn(async () => undefined),
};

let db: PGlite;
let app: ReturnType<typeof buildServer>;
let baseUrl: string;
let freshThread: string;
let sourcingRequest: string;
let outbound: string;
const clients: Client[] = [];

/** An MCP client connected to a fresh server that calls the API with `token`. */
async function connect(token: string): Promise<Client> {
  const server = createArbitronMcpServer(httpApiClient({ baseUrl, token }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'arbitron-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return client;
}

interface CallResult {
  readonly isError: boolean;
  readonly text: string;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: content.map((c) => c.text).join('\n') };
}

const json = (r: CallResult): Record<string, unknown> => {
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text) as Record<string, unknown>;
};

async function lastEvent(type: string, subjectId: string) {
  const { rows } = await db.query<{ actor_user_id: string; payload: Record<string, unknown> }>(
    `select actor_user_id, payload from events where type = $1 and subject_id = $2
      order by created_at desc limit 1`,
    [type, subjectId],
  );
  return rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);
  await db.exec(`insert into users (id, auth_user_id, email, full_name) values
    ('${USER_VIEWER}', '${AUTH_VIEWER}', 'c@example.test', 'Viewer C')`);
  await db.exec(
    `insert into memberships (org_id, user_id, role) values ('${ORG_A}', '${USER_VIEWER}', 'viewer')`,
  );

  // The fixture bid, made the one the approvals page would show: queued, priced from the
  // stored evaluation, which is priced from the stored estimate.
  await db.exec(
    `update margin_evaluations set delivery_estimate_id = '${ESTIMATE_A}' where id = '${MARGIN_A}'`,
  );
  await db.exec(
    `update proposals set status = 'queued', margin_evaluation_id = '${MARGIN_A}' where id = '${PROPOSAL_A}'`,
  );
  await db.exec(`insert into jobs (id, org_id, platform, external_id, raw, title, budget_max_minor, currency)
    values ('${JOB_NEW}', '${ORG_A}', 'freelancer', 'job-new', '{}'::jsonb, 'Nobody has looked', 300000, 'ZAR'),
           ('${JOB_BARE}', '${ORG_A}', 'freelancer', 'job-bare', '{}'::jsonb, 'Nothing yet', 300000, 'ZAR')`);
  await db.exec(`insert into proposals (id, org_id, job_id, body, amount_minor, currency, delivery_days, status)
    values ('${PROPOSAL_WAITING}', '${ORG_A}', '${JOB_NEW}', 'Waiting', 250000, 'ZAR', 5, 'queued')`);

  // A conversation with no brief yet, for build_brief.
  const t = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id, client_handle)
     values ($1, $2, 'freelancer', '7001', 'new-client') returning id`,
    [ORG_A, JOB_NEW],
  );
  freshThread = t.rows[0]!.id;
  // A reply waiting for approval on the fixture conversation, for approve_item.
  const m = await db.query<{ id: string }>(
    `insert into messages (org_id, thread_id, direction, body) values ($1, $2, 'out', 'Thanks, Monday works.') returning id`,
    [ORG_A, THREAD_A],
  );
  outbound = m.rows[0]!.id;

  // A locked brief with a sourcing request, for create_sourcing_post.
  const briefThread = await db.query<{ id: string }>(
    `insert into threads (org_id, job_id, platform, external_thread_id) values ($1, $2, 'freelancer', '7002') returning id`,
    [ORG_A, JOB_A],
  );
  const brief = await insertBriefVersion(db, {
    orgId: ORG_A,
    threadId: briefThread.rows[0]!.id,
    brief: {
      title: 'Landing page',
      outcome: 'A page that collects sign-ups',
      users: 'Visitors',
      mustHaves: ['Sign-up form'],
      later: [],
      references: [],
      assetsProvided: [],
      assetsMissing: [],
      techConstraints: [],
      deadline: '2026-10-31',
      deadlineFixed: false,
      budget: { minMinor: 500000, maxMinor: 800000, currency: 'ZAR', type: 'fixed' },
      acceptanceCriteria: ['A sign-up is stored'],
      signOff: { name: 'Sipho Dlamini', responseTime: 'same day' },
      risks: [],
      category: 'web-design',
      deliveryRoute: 'supplier',
    },
  });
  const locked = await lockBrief(db, brief, NOW);
  if (!locked.ok) throw new Error('the fixture brief should lock');
  const r = await db.query<{ id: string }>(
    `insert into sourcing_requests (org_id, brief_id) values ($1, $2) returning id`,
    [ORG_A, locked.brief.id],
  );
  sourcingRequest = r.rows[0]!.id;

  app = buildServer({
    db,
    // Stands in for the Supabase token check: a bearer token that is an auth user's id is
    // that user; anything else is not signed in.
    authenticate: (request) => {
      const header = request.headers.authorization;
      const token =
        typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
      return UUID.test(token) ? token : null;
    },
    enqueue,
    now: () => NOW,
    liveMode: false,
  });
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);

afterAll(async () => {
  for (const client of clients) await client.close();
  await app.close();
  await db.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the tool list', () => {
  it('offers the eleven tools of docs/01 section I, the read-only ones marked so', async () => {
    const client = await connect(AUTH_A);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual(
      ['estimate_delivery', 'get_thread', 'list_suppliers', 'search_jobs'].sort(),
    );
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'approve_item')?.inputSchema.required).toEqual([
      'kind',
      'itemId',
    ]);
  });
});

describe('each tool, as the owner', () => {
  it('search_jobs lists the organisation’s jobs, and filters by verdict', async () => {
    const client = await connect(AUTH_A);
    const all = json(await call(client, 'search_jobs')) as { jobs: { id: string }[] };
    expect(all.jobs.map((j) => j.id).sort()).toEqual([JOB_A, JOB_NEW, JOB_BARE].sort());
    const unscored = json(await call(client, 'search_jobs', { verdict: 'unscored' })) as {
      jobs: { id: string }[];
    };
    expect(unscored.jobs.map((j) => j.id).sort()).toEqual([JOB_NEW, JOB_BARE].sort());
    const paged = json(await call(client, 'search_jobs', { limit: 1, offset: 1 })) as {
      jobs: unknown[];
    };
    expect(paged.jobs).toHaveLength(1);
  });

  it('score_job asks for a score, logged as asked through MCP', async () => {
    const client = await connect(AUTH_A);
    expect(json(await call(client, 'score_job', { jobId: JOB_NEW }))).toEqual({
      action: 'scoring',
      jobId: JOB_NEW,
    });
    expect(enqueue.score).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_NEW }));
    expect(await lastEvent('job.score_requested', JOB_NEW)).toMatchObject({
      actor_user_id: USER_A,
      payload: { via: 'mcp' },
    });
  });

  it('estimate_delivery gives the stored estimate and margin, and says when there is none', async () => {
    const client = await connect(AUTH_A);
    // The fixture rows: rate card method, R1 000,00 / R1 500,00 / R2 000,00; margin
    // R750,00 at 37,5 %, passed.
    expect(json(await call(client, 'estimate_delivery', { jobId: JOB_A }))).toMatchObject({
      estimate: {
        method: 'rate_card',
        currency: 'ZAR',
        lowMinor: '100000',
        expectedMinor: '150000',
        highMinor: '200000',
      },
      margin: { marginMinor: '75000', currency: 'ZAR', passed: true },
    });
    const none = await call(client, 'estimate_delivery', { jobId: JOB_NEW });
    expect(none.isError).toBe(false);
    expect(none.text).toMatch(/^No delivery estimate is stored for this job yet\./);
  });

  it('draft_bid queues a bid: a job never scored is scored first', async () => {
    const client = await connect(AUTH_A);
    expect(json(await call(client, 'draft_bid', { jobId: JOB_BARE }))).toMatchObject({
      action: 'scoring',
    });
    expect(enqueue.score).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_BARE }));
    expect(await lastEvent('proposal.draft_requested', JOB_BARE)).toMatchObject({
      payload: { action: 'scoring', via: 'mcp' },
    });
    // A job whose bid is already waiting is refused, in the API's words.
    const refused = await call(client, 'draft_bid', { jobId: JOB_A });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/already/i);
  });

  it('submit_bid refuses a bid still waiting for approval', async () => {
    const client = await connect(AUTH_A);
    const r = await call(client, 'submit_bid', { proposalId: PROPOSAL_WAITING });
    expect(r).toEqual({
      isError: true,
      text: 'This bid is waiting for approval. Approve it first.',
    });
    expect(enqueue.submit).not.toHaveBeenCalled();
  });

  it('approve_item approves a bid in the operator’s name, recorded as through MCP, and hands it to the sender', async () => {
    const client = await connect(AUTH_A);
    const body = json(await call(client, 'approve_item', { kind: 'bid', itemId: PROPOSAL_A }));
    expect(body).toMatchObject({ proposal: { id: PROPOSAL_A, status: 'approved' } });
    const { rows } = await db.query<{ approved_by: string; approved_via: string }>(
      'select approved_by, approved_via::text from proposals where id = $1',
      [PROPOSAL_A],
    );
    expect(rows[0]).toEqual({ approved_by: USER_A, approved_via: 'mcp' });
    expect(await lastEvent('proposal.approved', PROPOSAL_A)).toMatchObject({
      actor_user_id: USER_A,
      payload: { via: 'mcp' },
    });
    expect(enqueue.submit).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_A }),
    );
  });

  it('submit_bid hands an approved bid to the sender again, and nothing is sent here', async () => {
    const client = await connect(AUTH_A);
    expect(json(await call(client, 'submit_bid', { proposalId: PROPOSAL_A }))).toEqual({
      queued: true,
    });
    expect(enqueue.submit).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_A }),
    );
    expect(await lastEvent('proposal.submit_requested', PROPOSAL_A)).toMatchObject({
      payload: { via: 'mcp' },
    });
    const { rows } = await db.query<{ status: string; submitted_at: string | null }>(
      'select status, submitted_at from proposals where id = $1',
      [PROPOSAL_A],
    );
    expect(rows[0]).toEqual({ status: 'approved', submitted_at: null });
  });

  it('approve_item approves a reply, recorded as through MCP', async () => {
    const client = await connect(AUTH_A);
    const body = json(await call(client, 'approve_item', { kind: 'reply', itemId: outbound }));
    expect(body).toMatchObject({ message: { id: outbound, approvedVia: 'mcp' } });
    expect(enqueue.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: outbound }),
    );
  });

  it('get_thread reads a conversation with its messages', async () => {
    const client = await connect(AUTH_A);
    const body = json(await call(client, 'get_thread', { threadId: THREAD_A }));
    expect(JSON.stringify(body)).toContain('Hello');
    expect(JSON.stringify(body)).toContain('Thanks, Monday works.');
  });

  it('build_brief drafts version 1, and refuses a conversation that has a brief', async () => {
    const client = await connect(AUTH_A);
    expect(json(await call(client, 'build_brief', { threadId: freshThread }))).toMatchObject({
      brief: { version: 1, locked: false },
    });
    const refused = await call(client, 'build_brief', { threadId: freshThread });
    expect(refused).toEqual({
      isError: true,
      text: 'This thread already has a brief. Edit it, or start a new version from the locked one.',
    });
  });

  it('create_sourcing_post drafts a post with none of the client’s details, and approve_item approves it', async () => {
    const client = await connect(AUTH_A);
    const created = json(
      await call(client, 'create_sourcing_post', {
        sourcingRequestId: sourcingRequest,
        platform: 'upwork',
      }),
    ) as { post: { id: string; status: string; title: string; body: string } };
    expect(created.post.status).toBe('draft');
    expect(`${created.post.title}\n${created.post.body}`).not.toMatch(/Sipho|Dlamini/);
    expect(await lastEvent('sourcing.post_drafted', created.post.id)).toMatchObject({
      payload: { via: 'mcp', platform: 'upwork' },
    });
    const approved = json(
      await call(client, 'approve_item', { kind: 'sourcing_post', itemId: created.post.id }),
    );
    expect(approved).toMatchObject({ post: { id: created.post.id, status: 'approved' } });
    const { rows } = await db.query<{ approved_via: string }>(
      'select approved_via::text from sourcing_posts where id = $1',
      [created.post.id],
    );
    expect(rows[0]?.approved_via).toBe('mcp');
  });

  it('list_suppliers lists the organisation’s suppliers only', async () => {
    const client = await connect(AUTH_A);
    const text = JSON.stringify(json(await call(client, 'list_suppliers')));
    expect(text).toContain('Supplier a');
    expect(text).not.toContain('Supplier b');
  });

  it('update_pipeline moves the stage and sets a retainer, logged as through MCP', async () => {
    const client = await connect(AUTH_A);
    const body = json(
      await call(client, 'update_pipeline', {
        pipelineItemId: PIPELINE_A,
        stage: 'won',
        retainer: true,
        retainerMonthlyMinor: 150000,
        currency: 'ZAR',
      }),
    );
    expect(JSON.stringify(body)).toContain('"won"');
    const { rows } = await db.query<{
      stage: string;
      retainer: boolean;
      retainer_monthly_minor: string;
    }>(
      'select stage::text, retainer, retainer_monthly_minor::text from pipeline_items where id = $1',
      [PIPELINE_A],
    );
    expect(rows[0]).toEqual({ stage: 'won', retainer: true, retainer_monthly_minor: '150000' });
    expect(await lastEvent('pipeline.stage_changed', PIPELINE_A)).toMatchObject({
      payload: { via: 'mcp', to: 'won' },
    });
    expect(await lastEvent('pipeline.retainer_changed', PIPELINE_A)).toMatchObject({
      payload: { via: 'mcp' },
    });
    // A refusal carries the API's field message.
    const refused = await call(client, 'update_pipeline', { pipelineItemId: PIPELINE_A });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('stage: send a stage, a retainer, or both');
  });
});

describe('the API decides, not the tool', () => {
  it('a viewer’s token may read but not approve; nothing changes', async () => {
    const client = await connect(AUTH_VIEWER);
    expect(json(await call(client, 'search_jobs')).jobs).toBeInstanceOf(Array);
    const refused = await call(client, 'approve_item', { kind: 'bid', itemId: PROPOSAL_WAITING });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/permission|role/i);
    const { rows } = await db.query<{ status: string }>(
      'select status from proposals where id = $1',
      [PROPOSAL_WAITING],
    );
    expect(rows[0]?.status).toBe('queued');
  });

  it('another organisation’s token sees none of this one', async () => {
    const client = await connect(AUTH_B);
    const jobs = json(await call(client, 'search_jobs')) as { jobs: { id: string }[] };
    expect(jobs.jobs.map((j) => j.id)).not.toContain(JOB_A);
    const refused = await call(client, 'get_thread', { threadId: THREAD_A });
    expect(refused.isError).toBe(true);
    const bid = await call(client, 'approve_item', { kind: 'bid', itemId: PROPOSAL_WAITING });
    expect(bid.isError).toBe(true);
  });

  it('a token the API does not accept gets the API’s refusal', async () => {
    const client = await connect('not-a-token');
    expect(await call(client, 'list_suppliers')).toEqual({
      isError: true,
      text: 'not signed in',
    });
  });

  it('arguments that do not fit the tool never reach the API', async () => {
    const client = await connect(AUTH_A);
    const before = await db.query<{ n: number }>('select count(*)::int as n from events');
    const r = await call(client, 'approve_item', { kind: 'invoice', itemId: 'nope' });
    expect(r.isError).toBe(true);
    const after = await db.query<{ n: number }>('select count(*)::int as n from events');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
