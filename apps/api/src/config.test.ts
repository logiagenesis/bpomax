import { describe, expect, it } from 'vitest';
import { apiConfig } from './config.js';

/** ARB-510 (the owner's audit E-01, E-02): the API starts only with what it needs. */
const BASE = {
  DATABASE_URL: 'postgresql://arbitron:pw@db.example.test:5432/postgres',
  REDIS_URL: 'redis://redis.example.test:6379',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  APP_URL: 'https://bpomax.vercel.app/',
};

describe('apiConfig', () => {
  it('refuses to start without the database, Redis, Supabase and the web app, naming each', () => {
    const result = apiConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.split(' ')[0])).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'APP_URL',
    ]);
    // Redis is required: without it an approval would be saved and no job created (E-02).
    expect(result.problems[1]).toBe(
      'REDIS_URL is not set: the queues an approval hands its work to (docs/02 B-07)',
    );
  });

  it('takes the web origin from APP_URL, keeps live mode off, and reads the rest as before', () => {
    const result = apiConfig(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      webOrigin: 'https://bpomax.vercel.app',
      port: 3000,
      liveMode: false,
      mcpChannelKey: null,
      queuePrefix: null,
    });
    expect(result.config.freelancer.ok).toBe(false);
    expect(result.config.upwork.ok).toBe(false);
    expect(result.config.billing.paystack.ok).toBe(false);
  });

  it('takes the MCP channel key when it is set', () => {
    const result = apiConfig({ ...BASE, MCP_CHANNEL_KEY: ' k3y ' });
    expect(result.ok && result.config.mcpChannelKey).toBe('k3y');
  });

  it('never repeats a value it refuses', () => {
    const result = apiConfig({ ...BASE, SUPABASE_URL: 'ftp://secret-host', LIVE_MODE: 'maybe' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      'SUPABASE_URL must be a https:// or http:// URL',
      'LIVE_MODE must be true or false',
    ]);
  });
});
