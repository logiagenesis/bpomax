import { recordEvent } from '@arbitron/db';
import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows, tenantRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channelOf, decideChannel } from './context.js';
import { buildServer } from './server.js';

/** ARB-014: the audit log viewer API, over the same policies the rest of the app uses. */
let db: PGlite;
let app: FastifyInstance;

const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
/** APP_URL in .env: the one origin a browser may call the API from. */
const WEB_ORIGIN = 'http://localhost:5173';

/** Stands in for Supabase JWT verification, which needs B-06. */
function authenticateFromHeader(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers['x-test-auth-user'];
  return typeof header === 'string' ? header : null;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  for (const row of tenantRows(ORG_A, 'a', 'a')) await db.exec(row.sql);
  for (const row of tenantRows(ORG_B, 'b', 'b')) await db.exec(row.sql);

  await recordEvent(db, { orgId: ORG_A, type: 'proposal.drafted' });
  await recordEvent(db, { orgId: ORG_A, type: 'proposal.submitted', outcome: 'error' });
  await recordEvent(db, { orgId: ORG_B, type: 'proposal.drafted' });

  app = buildServer({
    db,
    authenticate: (request) =>
      authenticateFromHeader(request as unknown as { headers: Record<string, unknown> }),
    webOrigin: WEB_ORIGIN,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /health', () => {
  it('answers without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'arbitron-api' });
  });
});

describe('the approval channel (ARB-500, the owner audit S-06)', () => {
  const KEY = 'channel-key-for-tests';
  const as = (headers: Record<string, string>) => ({ headers });

  it('is web without the header, and mcp only with the key the API was given', () => {
    expect(decideChannel(as({}), KEY)).toBe('web');
    expect(decideChannel(as({ 'x-arbitron-channel': 'mcp' }), KEY)).toBe('refused');
    expect(
      decideChannel(
        as({ 'x-arbitron-channel': 'mcp', 'x-arbitron-channel-key': 'a wrong guess' }),
        KEY,
      ),
    ).toBe('refused');
    expect(
      decideChannel(as({ 'x-arbitron-channel': 'mcp', 'x-arbitron-channel-key': KEY }), KEY),
    ).toBe('mcp');
    expect(decideChannel(as({ 'x-arbitron-channel': 'telegram' }), KEY)).toBe('refused');
    // No key configured: nobody can claim the MCP channel, whatever they send.
    expect(
      decideChannel(as({ 'x-arbitron-channel': 'mcp', 'x-arbitron-channel-key': '' }), undefined),
    ).toBe('refused');
  });

  it('refuses a request that claims the MCP channel without the key, before any route runs', async () => {
    const keyed = buildServer({ db, authenticate: () => null, mcpChannelKey: KEY });
    let seen: string | undefined;
    keyed.get('/channel-probe', async (request) => {
      seen = channelOf(request);
      return { channel: seen };
    });
    await keyed.ready();
    const forged = await keyed.inject({
      method: 'GET',
      url: '/channel-probe',
      headers: { 'x-arbitron-channel': 'mcp' },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ error: string }>().error).toMatch(/ARBITRON_MCP_CHANNEL_KEY/);
    expect(seen).toBeUndefined();

    const web = await keyed.inject({ method: 'GET', url: '/channel-probe' });
    expect(web.json()).toEqual({ channel: 'web' });
    const mcp = await keyed.inject({
      method: 'GET',
      url: '/channel-probe',
      headers: { 'x-arbitron-channel': 'mcp', 'x-arbitron-channel-key': KEY },
    });
    expect(mcp.json()).toEqual({ channel: 'mcp' });
    await keyed.close();
  });
});

describe('GET /v1/events', () => {
  it('turns away a request with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/events' });
    expect(response.statusCode).toBe(401);
  });

  it('returns only the caller s own org', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: { 'x-test-auth-user': AUTH_B },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { events: { org_id: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((event) => event.org_id === ORG_B)).toBe(true);
  });

  it('filters by type, and by more than one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events?type=proposal.submitted',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    const body = response.json() as { events: { type: string }[] };
    expect(body.events.every((event) => event.type === 'proposal.submitted')).toBe(true);

    const both = await app.inject({
      method: 'GET',
      url: '/v1/events?type=proposal.submitted,proposal.drafted',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    expect((both.json() as { events: unknown[] }).events.length).toBeGreaterThan(1);
  });

  it('rejects an unknown type rather than answering with nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events?type=proposal.invented',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toMatch(/unknown event type/i);
  });

  it('rejects a filter it cannot read', async () => {
    for (const url of [
      '/v1/events?from=not-a-date',
      '/v1/events?limit=-1',
      '/v1/events?outcome=maybe',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-test-auth-user': AUTH_A },
      });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('pages, and never hands back more than a page', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events?limit=1',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    const body = response.json() as { events: unknown[]; page: { limit: number; offset: number } };
    expect(body.events).toHaveLength(1);
    expect(body.page).toEqual({ limit: 1, offset: 0 });

    const huge = await app.inject({
      method: 'GET',
      url: '/v1/events?limit=100000',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    expect((huge.json() as { events: unknown[] }).events.length).toBeLessThanOrEqual(100);
  });

  it('does not leave the session role behind for the next caller', async () => {
    await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: { 'x-test-auth-user': AUTH_A },
    });
    const { rows } = await db.query<{ current_user: string }>('select current_user');
    expect(rows[0]?.current_user).toBe('postgres');
  });
});

describe('cross-origin calls from the web app', () => {
  it('answers a preflight from the web app s own origin', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/events.csv',
      headers: { origin: WEB_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-methods']).toContain('GET');
    // Bearer tokens, not cookies: the browser must never be told to send credentials.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('lets the page read what the export says about its file', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events.csv',
      headers: { origin: WEB_ORIGIN, 'x-test-auth-user': AUTH_A },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    const exposed = String(response.headers['access-control-expose-headers']);
    for (const name of ['content-disposition', 'x-export-rows', 'x-export-truncated']) {
      expect(exposed).toContain(name);
    }
  });

  it('gives another origin nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://elsewhere.example' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows no origin at all when none is configured', async () => {
    const closed = buildServer({ db, authenticate: () => null });
    await closed.ready();
    try {
      const response = await closed.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: WEB_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await closed.close();
    }
  });
});
