/**
 * The one thing every call shares: how a refusal is reported. Freelancer.com answers
 * errors as `{ status: "error", message, error_code, request_id }` with a 4xx or 5xx
 * (https://developers.freelancer.com/docs/api-overview/errors-and-responses). The token
 * endpoint's error body is not documented, so for it only the HTTP status is relied on
 * and the body is read for a message if it has one.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The rate-limit headers every API response carries
 * (https://developers.freelancer.com/docs/api-overview/rate-limiting, "Rate limit HTTP
 * headers"): `RateLimit-Limit` names the windows, `RateLimit-Remaining` the requests
 * left in the current one.
 */
export interface RateLimit {
  readonly limit: string | null;
  readonly remaining: number | null;
}

export function readRateLimit(headers: Headers): RateLimit {
  const remaining = headers.get('ratelimit-remaining');
  return {
    limit: headers.get('ratelimit-limit'),
    remaining: remaining !== null && /^\d+$/.test(remaining.trim()) ? Number(remaining) : null,
  };
}

export class FreelancerError extends Error {
  /** Set by the calls that read the headers, so a 429 can be logged with what is left. */
  rateLimit?: RateLimit;

  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'FreelancerError';
  }

  /** 429: the endpoint's window is used up; the same call will do later. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** 401 and 403: the token is no good, and asking again will not help. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Reads a response, throwing a FreelancerError for anything but a 2xx JSON body. */
export async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok || record.status === 'error') {
    const message =
      text(record.message) ?? text(record.error_description) ?? text(record.error) ?? null;
    throw new FreelancerError(
      `Freelancer.com refused ${what} (HTTP ${String(response.status)}${message ? `: ${message}` : ''})`,
      response.status,
      text(record.error_code),
      text(record.request_id),
    );
  }
  if (body === null) {
    throw new FreelancerError(
      `Freelancer.com answered ${what} without a JSON body`,
      response.status,
      null,
      null,
    );
  }
  return record;
}

/** A network failure, as distinct from a refusal: worth trying again later. */
export async function send(fetchImpl: Fetch, url: string, init: RequestInit, what: string) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new FreelancerError(
      `Could not reach Freelancer.com for ${what}: ${error instanceof Error ? error.message : String(error)}`,
      0,
      null,
      null,
    );
  }
}
