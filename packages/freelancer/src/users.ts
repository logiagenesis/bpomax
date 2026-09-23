import type { FreelancerConfig } from './config.js';
import { FreelancerError, readJson, send, type Fetch } from './http.js';

/**
 * `GET /users/0.1/self/` — the person the token belongs to
 * (https://developers.freelancer.com/docs/users/authenticated-users). It needs the
 * `basic` scope and the advanced scope `fln:user_information`. The token goes in the
 * `freelancer-oauth-v1` header
 * (https://developers.freelancer.com/docs/authentication/generating-access-tokens,
 * "Using Access Token with API"). A success is `{ status: "success", result: { id,
 * username, ... }, request_id }`
 * (https://developers.freelancer.com/docs/api-overview/errors-and-responses).
 *
 * The user id is what makes "one account per verified identity" enforceable: it is
 * `platform_accounts.external_user_id`, unique per platform across every org (0002).
 */
export interface FreelancerSelf {
  readonly id: string;
  readonly username: string | null;
  readonly requestId: string | null;
}

export async function getSelf(
  config: FreelancerConfig,
  accessToken: string,
  deps: { readonly fetch?: Fetch } = {},
): Promise<FreelancerSelf> {
  const what = 'the account lookup';
  const response = await send(
    deps.fetch ?? fetch,
    `${config.apiUrl}/users/0.1/self/`,
    { method: 'GET', headers: { 'freelancer-oauth-v1': accessToken } },
    what,
  );
  const body = await readJson(response, what);
  const result = (body.result ?? {}) as Record<string, unknown>;
  const id = result.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new FreelancerError(
      'Freelancer.com answered the account lookup without a user id',
      response.status,
      null,
      typeof body.request_id === 'string' ? body.request_id : null,
    );
  }
  return {
    id: String(id),
    username: typeof result.username === 'string' ? result.username : null,
    requestId: typeof body.request_id === 'string' ? body.request_id : null,
  };
}
