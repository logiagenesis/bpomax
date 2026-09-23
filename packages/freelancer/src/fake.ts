import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process stand-in for Freelancer.com (D-036): the three endpoints ARB-020 calls,
 * with the request and response shapes of the official docs cited in `oauth.ts` and
 * `users.ts`. Tests start one on a free port. `pnpm --filter @arbitron/freelancer fake`
 * runs one for local development. Set FREELANCER_BASE_URL to its URL; nothing else
 * changes. It is never used unless FREELANCER_BASE_URL points at it.
 *
 * It keeps the one rule the product relies on: a code is good once, for the client and
 * redirect URI it was issued to.
 */
export interface FakeUser {
  readonly id: number;
  readonly username: string;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly form: Record<string, string>;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface FakeFreelancer {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly calls: FakeCall[];
  /** Who "signs in" at the authorise page next. */
  signInAs(user: FakeUser): void;
  /** The code the authorise page would put on the redirect, without a browser. */
  issueCode(redirectUri: string, user?: FakeUser): string;
  /** Every access token issued so far stops working, as after 30 days. */
  expireAccessTokens(): void;
  /** Every refresh token stops working, as after the owner revokes the app. */
  revokeRefreshTokens(): void;
  close(): Promise<void>;
}

export interface FakeOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly user?: FakeUser;
  readonly port?: number;
  /** Seconds, as `expires_in`. The docs' figure by default. */
  readonly expiresIn?: number;
}

const DEFAULT_USER: FakeUser = { id: 1_000_001, username: 'sandbox-freelancer' };

function token(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiError(response: ServerResponse, status: number, message: string, code: string): void {
  json(response, status, {
    status: 'error',
    message,
    error_code: code,
    request_id: randomBytes(16).toString('hex'),
  });
}

export async function startFakeFreelancer(options: FakeOptions = {}): Promise<FakeFreelancer> {
  const clientId = options.clientId ?? 'fake-client-id';
  const clientSecret = options.clientSecret ?? 'fake-client-secret';
  const expiresIn = options.expiresIn ?? 2_592_000;
  let current = options.user ?? DEFAULT_USER;
  const codes = new Map<string, { redirectUri: string; user: FakeUser }>();
  const access = new Map<string, FakeUser>();
  const refresh = new Map<string, FakeUser>();
  const calls: FakeCall[] = [];

  const issueCode = (redirectUri: string, user: FakeUser = current) => {
    const code = token('code');
    codes.set(code, { redirectUri, user });
    return code;
  };

  const issueTokens = (response: ServerResponse, user: FakeUser) => {
    const accessToken = token('access');
    const refreshToken = token('refresh');
    access.set(accessToken, user);
    refresh.set(refreshToken, user);
    json(response, 200, {
      scope: 'basic',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      token_type: 'Bearer',
    });
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');
      const raw = request.method === 'POST' ? await readBody(request) : '';
      const form = Object.fromEntries(new URLSearchParams(raw));
      const query = Object.fromEntries(url.searchParams);
      calls.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        query,
        form,
        headers: request.headers,
      });

      if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
        if (query.response_type !== 'code' || query.client_id !== clientId || !query.redirect_uri) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          response.end('bad authorisation request');
          return;
        }
        const target = new URL(query.redirect_uri);
        target.searchParams.set('code', issueCode(query.redirect_uri));
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/oauth/token') {
        if (form.client_id !== clientId || form.client_secret !== clientSecret) {
          json(response, 401, { status: 'error', message: 'Invalid client credentials' });
          return;
        }
        if (form.grant_type === 'authorization_code') {
          const issued = form.code ? codes.get(form.code) : undefined;
          if (!issued || issued.redirectUri !== form.redirect_uri) {
            json(response, 400, { status: 'error', message: 'Invalid authorisation code' });
            return;
          }
          codes.delete(form.code!);
          issueTokens(response, issued.user);
          return;
        }
        if (form.grant_type === 'refresh_token') {
          const user = form.refresh_token ? refresh.get(form.refresh_token) : undefined;
          if (!user) {
            json(response, 400, { status: 'error', message: 'Invalid refresh token' });
            return;
          }
          refresh.delete(form.refresh_token!);
          issueTokens(response, user);
          return;
        }
        json(response, 400, { status: 'error', message: 'Unsupported grant type' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/users/0.1/self/') {
        const header = request.headers['freelancer-oauth-v1'];
        const user = typeof header === 'string' ? access.get(header) : undefined;
        if (!user) {
          apiError(
            response,
            401,
            'You must be logged in to perform this request',
            'RestExceptionCodes.NOT_AUTHENTICATED',
          );
          return;
        }
        json(response, 200, {
          status: 'success',
          result: {
            id: user.id,
            username: user.username,
            display_name: null,
            status: { email_verified: true, payment_verified: null, phone_verified: null },
          },
          request_id: randomBytes(16).toString('hex'),
        });
        return;
      }

      apiError(response, 404, `The fake has no ${url.pathname}`, 'RestExceptionCodes.NOT_FOUND');
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    clientId,
    clientSecret,
    calls,
    signInAs(user) {
      current = user;
    },
    issueCode,
    expireAccessTokens() {
      access.clear();
    },
    revokeRefreshTokens() {
      refresh.clear();
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
