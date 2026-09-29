import { describe, expect, it, vi } from 'vitest';
import { placeBid } from './placing.js';

/**
 * The last stop before a bid leaves this page (R-01): whatever calls `placeBid`, a proposal
 * with a `{placeholder}` still in it sends nothing, not even the look for an earlier bid.
 */
const BID = { projectId: 40735834, bidderId: 1234567, price: 450, days: 7 };

describe('placeBid', () => {
  it('refuses a proposal with an unfilled placeholder, before any call to Freelancer.com', async () => {
    const fetchImpl = vi.fn();
    await expect(
      placeBid(
        'a-token-of-more-than-twenty-characters',
        { ...BID, description: 'Hello. Skills: {skills}. Also {made_up}.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Fill or remove {skills} and {made_up} before bidding.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a mistyped placeholder too', async () => {
    const fetchImpl = vi.fn();
    await expect(
      placeBid(
        'a-token-of-more-than-twenty-characters',
        { ...BID, description: 'About {Title}: hello.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Fill or remove {Title} before bidding.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets a clean proposal through to Freelancer.com (here the call fails, offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      placeBid(
        'a-token-of-more-than-twenty-characters',
        { ...BID, description: 'Hello. I can do this for USD 450 in 7 days.' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalled();
  });
});
