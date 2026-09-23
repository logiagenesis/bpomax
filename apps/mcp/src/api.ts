/**
 * The MCP server's way to the Arbitron API (ARB-330). Every tool is one call to an API
 * route with the operator's own token, so row-level security, roles, the approval rules
 * and the live gate hold exactly as they do on the web. The channel header marks an
 * approval as made through MCP; the person approving is still the token's.
 */
export interface ApiRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ApiClient {
  request(request: ApiRequest): Promise<ApiResponse>;
}

export const CHANNEL_HEADER = 'x-arbitron-channel';

/** The query string of a request, leaving out what is not set. */
export function queryString(query: ApiRequest['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export interface HttpApiOptions {
  /** The API's base URL, such as https://api.example.test (API_URL in .env). */
  readonly baseUrl: string;
  /** The operator's Supabase access token (docs/02 B-06). */
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/** The API over HTTP, as the MCP process uses it. */
export function httpApiClient(options: HttpApiOptions): ApiClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    async request(request) {
      const response = await doFetch(`${base}${request.path}${queryString(request.query)}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          [CHANNEL_HEADER]: 'mcp',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { error: text };
        }
      }
      return { status: response.status, body };
    },
  };
}
