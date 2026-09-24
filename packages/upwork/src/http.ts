/**
 * How every Upwork call reports a refusal. The GraphQL endpoint answers
 * `{ data, errors }`; a missing permission comes back as an error reading "The client or
 * authentication token doesn't have enough oauth2 permissions/scopes to access <list of
 * fields>" (DOC.permissions). Beyond "300 requests per minute per IP address" the API
 * answers HTTP 429 "Too Many Requests" (DOC.permissions). The token endpoint's error body
 * is not documented, so for it only the HTTP status is relied on.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class UpworkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when Upwork said the key or token lacks a permission the call needs. */
    readonly permission = false,
  ) {
    super(message);
    this.name = 'UpworkError';
  }

  /** 429: over the per-minute limit; the same call will do later. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** 401 and 403, or a missing permission: asking again with the same token will not help. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403 || this.permission;
  }
}

/** A network failure, as distinct from a refusal: worth trying again later. */
export async function send(fetchImpl: Fetch, url: string, init: RequestInit, what: string) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new UpworkError(
      `Could not reach Upwork for ${what}: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }
}

async function body(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const PERMISSION = /permissions\/scopes/i;

export interface GraphqlOptions {
  readonly fetch?: Fetch;
  /** `X-Upwork-API-TenantId`: without it the user's default organisation is used (DOC.tenant). */
  readonly tenantId?: string | null;
}

/**
 * One GraphQL call: `POST` the query and its variables as JSON with the access token as a
 * Bearer token ("the Authorization header (recommended) with the Bearer schema",
 * DOC.authentication). A token never appears in an error.
 */
export async function graphql<T>(
  url: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  what: string,
  options: GraphqlOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (options.tenantId) headers['x-upwork-api-tenantid'] = options.tenantId;
  const response = await send(
    options.fetch ?? fetch,
    url,
    { method: 'POST', headers, body: JSON.stringify({ query, variables }) },
    what,
  );
  const record = await body(response);
  const errors = Array.isArray(record?.errors) ? (record.errors as { message?: unknown }[]) : [];
  const messages = errors
    .map((e) => (typeof e.message === 'string' ? e.message.trim() : ''))
    .filter(Boolean);
  if (!response.ok) {
    throw new UpworkError(
      `Upwork refused ${what} (HTTP ${String(response.status)}${messages[0] ? `: ${messages[0]}` : ''})`,
      response.status,
      messages.some((m) => PERMISSION.test(m)),
    );
  }
  const data = record?.data;
  if (messages.length > 0 && (data === null || data === undefined)) {
    throw new UpworkError(
      `Upwork refused ${what}: ${messages.join('; ')}`,
      response.status,
      messages.some((m) => PERMISSION.test(m)),
    );
  }
  if (typeof data !== 'object' || data === null) {
    throw new UpworkError(`Upwork answered ${what} without data`, response.status);
  }
  return data as T;
}

/** The form-encoded token endpoint (DOC.token, DOC.refresh). */
export async function tokenCall(
  url: string,
  fields: Record<string, string>,
  what: string,
  fetchImpl: Fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await send(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(fields).toString(),
    },
    what,
  );
  const record = await body(response);
  if (!response.ok || record === null) {
    const detail =
      typeof record?.error_description === 'string'
        ? record.error_description
        : typeof record?.error === 'string'
          ? record.error
          : null;
    throw new UpworkError(
      `Upwork refused ${what} (HTTP ${String(response.status)}${detail ? `: ${detail}` : ''})`,
      response.status,
    );
  }
  return record;
}
