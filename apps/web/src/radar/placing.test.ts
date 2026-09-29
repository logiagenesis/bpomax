import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestTimeout } from './freelancer.js';
import { placeBid, statusOf } from './placing.js';

/**
 * Place now itself (LI-PROMPT-BPOMAX-BIDSAFETY-20260929, B-07). `placeBid` asks Freelancer.com
 * for a bid of the owner's on the project and sends nothing if there is one, else sends the
 * bid. Every call here goes to a stand-in `fetch`, so the tests need no network.
 */
const TOKEN = 'a-token-of-more-than-twenty-characters';
const BID = {
  projectId: 40735834,
  bidderId: 1234567,
  price: 450,
  days: 7,
  description: 'Hello. I can do this for USD 450 in 7 days.',
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Each call the stand-in saw: its address and what it was sent. */
function standIn(...answers: Response[]) {
  const replies = [...answers];
  const fetchImpl = vi.fn<typeof fetch>(() => {
    const next = replies.shift();
    if (!next) throw new Error('an unexpected extra call');
    return Promise.resolve(next);
  });
  const calls = () =>
    fetchImpl.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    }));
  return { fetchImpl, calls };
}

const NO_BIDS = () => answer(200, { status: 'success', result: { bids: [], users: {} } });
const EARLIER = () =>
  answer(200, {
    status: 'success',
    result: {
      bids: [{ id: 777, bidder_id: 1234567, project_id: 40735834, amount: 400 }],
      users: {},
    },
  });

describe('placeBid', () => {
  it('finds an earlier bid, sends no POST, and says so: outcome already', async () => {
    const { fetchImpl, calls } = standIn(EARLIER());
    const result = await placeBid(TOKEN, BID, fetchImpl);

    expect(result).toEqual({ outcome: 'already', bidId: '777', status: 200 });
    expect(calls()).toHaveLength(1);
    const [lookup] = calls();
    expect(lookup!.method).toBe('GET');
    expect(lookup!.url.pathname).toBe('/api/projects/0.1/bids/');
    expect(lookup!.url.searchParams.getAll('projects[]')).toEqual(['40735834']);
    expect(lookup!.url.searchParams.getAll('bidders[]')).toEqual(['1234567']);
    expect(calls().filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('sends one POST for a new bid, with the six fields Freelancer.com asks for', async () => {
    const { fetchImpl, calls } = standIn(
      NO_BIDS(),
      answer(200, { status: 'success', result: { id: 900000001 } }),
    );
    const result = await placeBid(TOKEN, BID, fetchImpl);

    expect(result).toEqual({ outcome: 'placed', bidId: '900000001', status: 200 });
    const posts = calls().filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.pathname).toBe('/api/projects/0.1/bids/');
    expect(posts[0]!.body).toEqual({
      project_id: 40735834,
      bidder_id: 1234567,
      amount: 450,
      period: 7,
      milestone_percentage: 100,
      description: 'Hello. I can do this for USD 450 in 7 days.',
    });
    // The token goes in the header Freelancer.com reads, on the lookup and on the bid.
    for (const call of calls()) expect(call.headers['freelancer-oauth-v1']).toBe(TOKEN);
  });

  it('throws when Freelancer.com refuses the bid, and statusOf gives the HTTP status', async () => {
    const { fetchImpl, calls } = standIn(
      NO_BIDS(),
      answer(400, { status: 'error', message: 'Refused in the test', error_code: 'E2E' }),
    );
    const error = await placeBid(TOKEN, BID, fetchImpl).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Freelancer.com refused placing the bid (HTTP 400: Refused in the test)',
    );
    expect(statusOf(error)).toBe(400);
    expect(calls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('throws a 401 from the lookup too, before any POST', async () => {
    const { fetchImpl, calls } = standIn(
      answer(401, { status: 'error', message: 'You must be logged in' }),
    );
    const error = await placeBid(TOKEN, BID, fetchImpl).catch((e: unknown) => e);

    expect(statusOf(error)).toBe(401);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.method).toBe('GET');
  });

  it('throws when nothing comes back at all: status 0', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await placeBid(TOKEN, BID, fetchImpl).catch((e: unknown) => e);

    expect(statusOf(error)).toBe(0);
    expect((error as Error).message).toContain('Could not reach Freelancer.com');
  });

  it('refuses a proposal with text in curly braces, before any call to Freelancer.com', async () => {
    const { fetchImpl, calls } = standIn();
    await expect(
      placeBid(
        TOKEN,
        { ...BID, description: 'Hello. Skills: {skills}. Also { name }.' },
        fetchImpl,
      ),
    ).rejects.toThrow(
      'Fill or remove {skills}, { name } before bidding. Any text in curly braces is blocked.',
    );
    expect(calls()).toHaveLength(0);
  });
});

describe('statusOf', () => {
  it('reads the status of the package’s errors and the page’s, and nothing else', () => {
    expect(statusOf({ status: 403 })).toBe(403);
    expect(statusOf({ status: null })).toBeNull();
    expect(statusOf(new Error('no status'))).toBeNull();
    expect(statusOf(undefined)).toBeNull();
    expect(statusOf('401')).toBeNull();
  });
});

describe('when Freelancer.com does not answer (B-10)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch whose first answers are given and which then never answers at all. */
  function silentAfter(...answers: Response[]) {
    const replies = [...answers];
    return vi.fn<typeof fetch>(() => {
      const next = replies.shift();
      return next ? Promise.resolve(next) : new Promise<Response>(() => undefined);
    });
  }

  it('gives up on the lookup after 15 seconds: a time-out, not a refusal, and no bid sent', async () => {
    vi.useFakeTimers();
    const fetchImpl = silentAfter();
    let settled = false;
    const outcome = placeBid(TOKEN, BID, fetchImpl).catch((e: unknown) => e);
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;

    expect(error).toBeInstanceOf(RequestTimeout);
    expect((error as Error).message).toBe('No answer from Freelancer after 15 seconds.');
    expect(statusOf(error)).toBeNull();
    // Only the lookup was made, and it was aborted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.method ?? 'GET').toBe('GET');
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('gives up on the bid itself after 15 seconds, and does not try again', async () => {
    vi.useFakeTimers();
    const fetchImpl = silentAfter(NO_BIDS());
    const outcome = placeBid(TOKEN, BID, fetchImpl).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(15_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(RequestTimeout);
    // The lookup, then the one POST. The bid may or may not have gone through.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![1]?.method).toBe('POST');
    expect(fetchImpl.mock.calls[1]![1]?.signal?.aborted).toBe(true);

    // And nothing tries again by itself, however long it waits.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('leaves no timer running when Freelancer.com answers in time', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = standIn(
      NO_BIDS(),
      answer(200, { status: 'success', result: { id: 900000001 } }),
    );
    await expect(placeBid(TOKEN, BID, fetchImpl)).resolves.toMatchObject({ outcome: 'placed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a refusal that arrives in time is still a refusal, not a time-out', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = standIn(
      NO_BIDS(),
      answer(403, { status: 'error', message: 'Refused in the test' }),
    );
    const error = await placeBid(TOKEN, BID, fetchImpl).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RequestTimeout);
    expect(statusOf(error)).toBe(403);
    expect(vi.getTimerCount()).toBe(0);
  });
});
