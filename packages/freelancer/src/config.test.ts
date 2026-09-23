import { describe, expect, it } from 'vitest';
import { freelancerConfig } from './config.js';

const ENV = {
  FREELANCER_BASE_URL: 'https://www.freelancer-sandbox.com',
  FREELANCER_CLIENT_ID: 'id',
  FREELANCER_CLIENT_SECRET: 'secret',
  FREELANCER_REDIRECT_URI: 'http://localhost:5173/freelancer-callback.html',
};

describe('freelancerConfig', () => {
  it('names every variable that is missing, and B-03', () => {
    const result = freelancerConfig({ FREELANCER_BASE_URL: ENV.FREELANCER_BASE_URL });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missing).toEqual([
      'FREELANCER_CLIENT_ID',
      'FREELANCER_CLIENT_SECRET',
      'FREELANCER_REDIRECT_URI',
    ]);
    expect(!result.ok && result.reason).toMatch(/docs\/02 B-03/);
  });

  it('points the sandbox at the documented sandbox hosts', () => {
    const result = freelancerConfig(ENV);
    expect(result.ok && result.config).toEqual({
      environment: 'sandbox',
      baseUrl: 'https://www.freelancer-sandbox.com',
      apiUrl: 'https://www.freelancer-sandbox.com/api',
      accountsUrl: 'https://accounts.freelancer-sandbox.com',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:5173/freelancer-callback.html',
    });
  });

  it('points production at the documented production hosts, trailing slash or not', () => {
    const result = freelancerConfig({ ...ENV, FREELANCER_BASE_URL: 'https://www.freelancer.com/' });
    expect(result.ok && result.config).toMatchObject({
      environment: 'production',
      apiUrl: 'https://www.freelancer.com/api',
      accountsUrl: 'https://accounts.freelancer.com',
    });
  });

  it('treats any other host as a stand-in serving both from one origin', () => {
    const result = freelancerConfig({ ...ENV, FREELANCER_BASE_URL: 'http://127.0.0.1:4010' });
    expect(result.ok && result.config).toMatchObject({
      environment: 'stand-in',
      apiUrl: 'http://127.0.0.1:4010/api',
      accountsUrl: 'http://127.0.0.1:4010',
    });
  });

  it('refuses a base URL that is not a URL', () => {
    const result = freelancerConfig({ ...ENV, FREELANCER_BASE_URL: 'sandbox' });
    expect(result).toEqual({
      ok: false,
      missing: ['FREELANCER_BASE_URL'],
      reason: 'FREELANCER_BASE_URL is not a URL.',
    });
  });
});
