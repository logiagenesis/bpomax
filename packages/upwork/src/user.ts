import type { UpworkConfig } from './config.js';
import { graphql, UpworkError, type Fetch } from './http.js';

/**
 * Whose token it is, right after the connect: the `user` query, "Current user", which
 * needs "Common Entities - Read-Only Access", the permission every key has (DOC.user,
 * DOC.permissions). Only `id` and `name` are asked for.
 */
export const CURRENT_USER_QUERY = `query user {
  user {
    id
    name
  }
}`;

export interface UpworkUser {
  readonly id: string;
  readonly name: string | null;
}

export async function currentUser(
  config: UpworkConfig,
  accessToken: string,
  deps: { readonly fetch?: Fetch } = {},
): Promise<UpworkUser> {
  const data = await graphql<{ user?: { id?: unknown; name?: unknown } | null }>(
    config.graphqlUrl,
    accessToken,
    CURRENT_USER_QUERY,
    {},
    'the current user',
    deps,
  );
  const id = data.user?.id;
  if (typeof id !== 'string' || id.length === 0)
    throw new UpworkError('Upwork answered the current user without an id', 200);
  return { id, name: typeof data.user?.name === 'string' ? data.user.name : null };
}
