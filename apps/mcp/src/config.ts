/**
 * The MCP process's two settings (ARB-330). The token is the operator's own Supabase
 * access token (docs/02 B-06), so the API applies their role and their organisation's
 * row-level security exactly as it does on the web. It is never logged.
 */
export type McpConfig =
  | { readonly ok: true; readonly baseUrl: string; readonly token: string }
  | { readonly ok: false; readonly message: string };

export function mcpConfig(env: Record<string, string | undefined>): McpConfig {
  const baseUrl = env.ARBITRON_API_URL?.trim() ?? '';
  const token = env.ARBITRON_ACCESS_TOKEN?.trim() ?? '';
  const missing = [
    ...(baseUrl ? [] : ['ARBITRON_API_URL']),
    ...(token ? [] : ['ARBITRON_ACCESS_TOKEN']),
  ];
  if (missing.length > 0)
    return {
      ok: false,
      message: `The Arbitron MCP server needs ${missing.join(' and ')} set (see README, "MCP server"). The access token is your own sign-in token (docs/02 B-06).`,
    };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, message: 'ARBITRON_API_URL is not a URL.' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    return {
      ok: false,
      message:
        'ARBITRON_API_URL must be https (http only for localhost), so the token is not sent in the clear.',
    };
  return { ok: true, baseUrl, token };
}
