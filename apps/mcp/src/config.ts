/**
 * The MCP process's settings (ARB-330). The token is the operator's own Supabase access
 * token (docs/02 B-06), so the API applies their role and their organisation's row-level
 * security exactly as it does on the web. The channel key is the API's MCP_CHANNEL_KEY:
 * with it the API records an approval as made through MCP (ARB-500, S-06). Neither is
 * ever logged.
 */
export type McpConfig =
  | {
      readonly ok: true;
      readonly baseUrl: string;
      readonly token: string;
      readonly channelKey: string;
    }
  | { readonly ok: false; readonly message: string };

export function mcpConfig(env: Record<string, string | undefined>): McpConfig {
  const baseUrl = env.ARBITRON_API_URL?.trim() ?? '';
  const token = env.ARBITRON_ACCESS_TOKEN?.trim() ?? '';
  const channelKey = env.ARBITRON_MCP_CHANNEL_KEY?.trim() ?? '';
  const missing = [
    ...(baseUrl ? [] : ['ARBITRON_API_URL']),
    ...(token ? [] : ['ARBITRON_ACCESS_TOKEN']),
    ...(channelKey ? [] : ['ARBITRON_MCP_CHANNEL_KEY']),
  ];
  if (missing.length > 0)
    return {
      ok: false,
      message: `The Arbitron MCP server needs ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1) ?? ''}` : (missing[0] ?? '')} set (see README, "MCP server"). The access token is your own sign-in token (docs/02 B-06); the channel key is the API's MCP_CHANNEL_KEY.`,
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
  return { ok: true, baseUrl, token, channelKey };
}
