import { describe, expect, it } from 'vitest';
import { httpApiClient, queryString } from './api.js';
import { mcpConfig } from './config.js';

describe('mcpConfig', () => {
  it('names each setting that is missing', () => {
    expect(mcpConfig({})).toEqual({
      ok: false,
      message:
        'The Arbitron MCP server needs ARBITRON_API_URL and ARBITRON_ACCESS_TOKEN set (see README, "MCP server"). The access token is your own sign-in token (docs/02 B-06).',
    });
    expect(mcpConfig({ ARBITRON_API_URL: 'https://api.example.test' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('needs ARBITRON_ACCESS_TOKEN set') as string,
    });
  });

  it('sends the token over https only, or http to this machine', () => {
    const token = 'eyJ.test.token';
    expect(
      mcpConfig({ ARBITRON_API_URL: 'http://api.example.test', ARBITRON_ACCESS_TOKEN: token }),
    ).toEqual({
      ok: false,
      message:
        'ARBITRON_API_URL must be https (http only for localhost), so the token is not sent in the clear.',
    });
    expect(mcpConfig({ ARBITRON_API_URL: 'not a url', ARBITRON_ACCESS_TOKEN: token })).toEqual({
      ok: false,
      message: 'ARBITRON_API_URL is not a URL.',
    });
    expect(
      mcpConfig({ ARBITRON_API_URL: 'http://localhost:4000', ARBITRON_ACCESS_TOKEN: token }),
    ).toEqual({ ok: true, baseUrl: 'http://localhost:4000', token });
    expect(
      mcpConfig({ ARBITRON_API_URL: ' https://api.example.test ', ARBITRON_ACCESS_TOKEN: token }),
    ).toEqual({ ok: true, baseUrl: 'https://api.example.test', token });
  });

  it('never puts the token in a message', () => {
    const token = 'secret-token-value';
    const result = mcpConfig({ ARBITRON_API_URL: 'ftp://x', ARBITRON_ACCESS_TOKEN: token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(token);
  });
});

describe('httpApiClient', () => {
  it('sends the token, the MCP channel and a JSON body, and leaves out unset query values', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const api = httpApiClient({ baseUrl: 'https://api.example.test/', token: 'tok', fetch });
    expect(
      await api.request({
        method: 'GET',
        path: '/v1/jobs',
        query: { verdict: 'go', limit: undefined },
      }),
    ).toEqual({ status: 201, body: { ok: true } });
    expect(seen[0]?.url).toBe('https://api.example.test/v1/jobs?verdict=go');
    expect(seen[0]?.init.headers).toEqual({
      authorization: 'Bearer tok',
      'x-arbitron-channel': 'mcp',
    });
    await api.request({ method: 'PATCH', path: '/v1/pipeline-items/x', body: { stage: 'won' } });
    expect(seen[1]?.init).toMatchObject({
      method: 'PATCH',
      body: '{"stage":"won"}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('keeps a reply that is not JSON as the error text', async () => {
    const fetch = (async () =>
      new Response('Bad Gateway', { status: 502 })) as unknown as typeof globalThis.fetch;
    const api = httpApiClient({ baseUrl: 'https://api.example.test', token: 'tok', fetch });
    expect(await api.request({ method: 'GET', path: '/v1/suppliers' })).toEqual({
      status: 502,
      body: { error: 'Bad Gateway' },
    });
  });

  it('writes no query string when nothing is set', () => {
    expect(queryString(undefined)).toBe('');
    expect(queryString({ a: undefined })).toBe('');
    expect(queryString({ limit: 5, offset: 0 })).toBe('?limit=5&offset=0');
  });
});
