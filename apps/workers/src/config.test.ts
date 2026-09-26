import { describe, expect, it } from 'vitest';
import { workersConfig } from './config.js';
import { EnvProblems, describeProblems } from './env.js';

/** ARB-510 (the owner's audit E-01, E-03): the workers start only with what they need. */
const BASE = {
  DATABASE_URL: 'postgresql://arbitron:pw@db.example.test:5432/postgres',
  REDIS_URL: 'rediss://default:pw@redis.example.test:6380',
};

describe('workersConfig', () => {
  it('refuses to start without the database and Redis, naming both', () => {
    const result = workersConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      'DATABASE_URL is not set: the Postgres the workers read and write (docs/02 B-06)',
      'REDIS_URL is not set: the queues (docs/02 B-07)',
    ]);
    expect(describeProblems('arbitron-workers', result.problems)).toMatch(
      /^arbitron-workers did not start\. Set these and start it again/,
    );
  });

  it('refuses a malformed value without repeating it', () => {
    const secret = 'mysql://root:hunter2@db';
    const result = workersConfig({
      ...BASE,
      DATABASE_URL: secret,
      LIVE_MODE: 'yes',
      PORT: '99999',
      QUEUE_PREFIX: 'has space',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      'DATABASE_URL must be a postgres:// or postgresql:// URL',
      'PORT must be a whole number from 1 to 65535',
      'LIVE_MODE must be true or false',
      'QUEUE_PREFIX must be 1 to 64 characters of A-Z, a-z, 0-9, _ or -',
    ]);
    expect(result.problems.join('\n')).not.toContain('hunter2');
  });

  it('starts with the model, Freelancer.com and Upwork off, saying why, and live mode off', () => {
    const result = workersConfig(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      port: 3001,
      liveMode: false,
      queuePrefix: null,
      llm: null,
      freelancer: null,
      upwork: null,
    });
    expect(result.config.off.model).toMatch(
      /^ANTHROPIC_API_KEY is not set \(docs\/02-BLOCKERS.md B-08\).*scoring, estimating, drafting, discovery and briefs are off$/,
    );
    expect(result.config.off.freelancer).toMatch(/docs\/02 B-03/);
    expect(result.config.off.upwork).toMatch(/docs\/02 B-14/);
  });

  it('turns the model on with a key and two priced models', () => {
    const result = workersConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'sk-test',
      LLM_MODEL_SCORE: 'claude-opus-5',
      LLM_MODEL_DRAFT: 'claude-opus-5',
      LIVE_MODE: 'false',
      PORT: '8080',
      QUEUE_PREFIX: 'staging',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.llm).toEqual({
      apiKey: 'sk-test',
      scoreModel: 'claude-opus-5',
      draftModel: 'claude-opus-5',
    });
    expect(result.config.off.model).toBeUndefined();
    expect(result.config).toMatchObject({ port: 8080, queuePrefix: 'staging' });
  });

  it('refuses to start with a model that has no price, rather than meter it at nothing', () => {
    const result = workersConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'sk-test',
      LLM_MODEL_SCORE: 'claude-imaginary-9',
      LLM_MODEL_DRAFT: 'claude-opus-5',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      expect.stringMatching(/^LLM_MODEL_SCORE names "claude-imaginary-9", which has no price/),
    ]);
  });

  it('reads LIVE_MODE=true only as written', () => {
    const on = workersConfig({ ...BASE, LIVE_MODE: 'true' });
    expect(on.ok && on.config.liveMode).toBe(true);
    const problems = new EnvProblems();
    expect(problems.liveMode({ LIVE_MODE: 'TRUE' })).toBe(false);
    expect(problems.problems).toEqual(['LIVE_MODE must be true or false']);
  });
});
