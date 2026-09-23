import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient, ApiRequest } from './api.js';

/**
 * The MCP server (ARB-330, docs/01 section I): the eleven tools the build prompt names,
 * each a thin call to an Arbitron API route with the operator's token. Nothing here
 * decides anything the API does not: the API checks the role, the rules and the live gate,
 * and a refusal comes back as the tool's error with the API's own words.
 */
export const TOOL_NAMES = [
  'search_jobs',
  'score_job',
  'estimate_delivery',
  'draft_bid',
  'approve_item',
  'submit_bid',
  'get_thread',
  'build_brief',
  'create_sourcing_post',
  'list_suppliers',
  'update_pipeline',
] as const;

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function errorText(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; errors?: { field: string; message: string }[] };
  const message = typeof b.error === 'string' ? b.error : `The API answered ${String(status)}.`;
  const fields = Array.isArray(b.errors)
    ? b.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
    : '';
  return fields ? `${message} (${fields})` : message;
}

async function call(api: ApiClient, request: ApiRequest): Promise<ToolResult> {
  const response = await api.request(request);
  if (response.status >= 400)
    return {
      isError: true,
      content: [{ type: 'text', text: errorText(response.status, response.body) }],
    };
  return { content: [{ type: 'text', text: JSON.stringify(response.body, null, 2) }] };
}

const id = (what: string) => z.string().uuid().describe(`The ${what}'s id`);

export function createArbitronMcpServer(api: ApiClient): McpServer {
  const server = new McpServer({ name: 'arbitron', version: '0.1.0' });

  server.registerTool(
    'search_jobs',
    {
      title: 'Search jobs',
      description:
        'Lists jobs from the feed, newest first, with the stored score, estimate, margin and bid status.',
      inputSchema: {
        verdict: z
          .enum(['go', 'caution', 'skip', 'unscored'])
          .optional()
          .describe('Only jobs with this score verdict'),
        limit: z.number().int().min(1).max(100).optional().describe('How many, 1 to 100'),
        offset: z.number().int().min(0).optional().describe('How many to skip'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ verdict, limit, offset }) =>
      call(api, { method: 'GET', path: '/v1/jobs', query: { verdict, limit, offset } }),
  );

  server.registerTool(
    'score_job',
    {
      title: 'Score a job',
      description:
        'Asks for a job to be scored now; the estimate and the margin follow in the background.',
      inputSchema: { jobId: id('job') },
    },
    ({ jobId }) => call(api, { method: 'POST', path: `/v1/jobs/${jobId}/score` }),
  );

  server.registerTool(
    'estimate_delivery',
    {
      title: 'Delivery estimate',
      description:
        'Gives the stored delivery estimate for a job (method, low, expected and high cost, turnaround) and its latest margin. It never invents one: a job with none says so.',
      inputSchema: { jobId: id('job') },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      const response = await api.request({ method: 'GET', path: `/v1/jobs/${jobId}` });
      if (response.status >= 400)
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorText(response.status, response.body) }],
        };
      const body = response.body as { estimate: unknown; job: Record<string, unknown> };
      if (!body.estimate)
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No delivery estimate is stored for this job yet. Score it with score_job; the estimate worker prices it after the score.',
            },
          ],
        };
      const job = body.job;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                estimate: body.estimate,
                margin: {
                  marginMinor: job.margin_minor ?? null,
                  marginPct: job.margin_pct ?? null,
                  currency: job.margin_currency ?? null,
                  passed: job.margin_passed ?? null,
                  reason: job.margin_reason ?? null,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'draft_bid',
    {
      title: 'Draft a bid',
      description:
        'Queues a bid for a job: drafted if its margin passed, scored first if it was never scored. The draft waits for approval.',
      inputSchema: { jobId: id('job') },
    },
    ({ jobId }) => call(api, { method: 'POST', path: `/v1/jobs/${jobId}/queue-bid` }),
  );

  server.registerTool(
    'approve_item',
    {
      title: 'Approve an outbound item',
      description:
        'Approves a waiting bid, reply or sourcing post in your name, recorded as approved through MCP. The sender still checks the live-mode switches (and, for a bid, the allowance) before anything leaves.',
      inputSchema: {
        kind: z.enum(['bid', 'reply', 'sourcing_post']).describe('What is being approved'),
        itemId: id('item'),
      },
    },
    ({ kind, itemId }) =>
      call(api, {
        method: 'POST',
        path: {
          bid: `/v1/proposals/${itemId}/approve`,
          reply: `/v1/outbound-messages/${itemId}/approve`,
          sourcing_post: `/v1/sourcing-posts/${itemId}/approve`,
        }[kind],
      }),
  );

  server.registerTool(
    'submit_bid',
    {
      title: 'Hand an approved bid to the sender',
      description:
        'Hands an approved bid to the sender again. A bid waiting for approval is refused: approve it with approve_item. The sender holds the live gate; with live mode off nothing is sent.',
      inputSchema: { proposalId: id('bid') },
    },
    ({ proposalId }) => call(api, { method: 'POST', path: `/v1/proposals/${proposalId}/submit` }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a conversation',
      description:
        'Gives a conversation with its messages and their states, its discovery and its brief.',
      inputSchema: { threadId: id('conversation') },
      annotations: { readOnlyHint: true },
    },
    ({ threadId }) => call(api, { method: 'GET', path: `/v1/threads/${threadId}` }),
  );

  server.registerTool(
    'build_brief',
    {
      title: 'Build a brief',
      description:
        "Drafts version 1 of a conversation's brief from its discovery answers. A conversation that has a brief is refused.",
      inputSchema: { threadId: id('conversation') },
    },
    ({ threadId }) => call(api, { method: 'POST', path: `/v1/threads/${threadId}/brief` }),
  );

  server.registerTool(
    'create_sourcing_post',
    {
      title: 'Draft a sourcing post',
      description:
        "Drafts a sourcing post from the locked brief's scope for one platform, checked so it cannot identify the client. It waits for approval.",
      inputSchema: {
        sourcingRequestId: id('sourcing request'),
        platform: z.enum(['freelancer', 'upwork', 'fiverr']).describe('Where it will be posted'),
      },
    },
    ({ sourcingRequestId, platform }) =>
      call(api, {
        method: 'POST',
        path: `/v1/sourcing-requests/${sourcingRequestId}/posts`,
        body: { platform },
      }),
  );

  server.registerTool(
    'list_suppliers',
    {
      title: 'List suppliers',
      description: 'Lists the supplier database with each supplier’s rate cards.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => call(api, { method: 'GET', path: '/v1/suppliers' }),
  );

  server.registerTool(
    'update_pipeline',
    {
      title: 'Update the pipeline',
      description:
        "Moves a job on the pipeline and/or sets its retainer. A retainer's monthly amount is whole cents above 0; a job with no currency needs it sent.",
      inputSchema: {
        pipelineItemId: id('pipeline item'),
        stage: z
          .enum([
            'applied',
            'replied',
            'discovery',
            'briefed',
            'sourcing',
            'won',
            'in_delivery',
            'delivered',
            'paid',
            'lost',
          ])
          .optional(),
        retainer: z.boolean().optional(),
        retainerMonthlyMinor: z.number().int().positive().optional(),
        currency: z.string().length(3).optional(),
      },
    },
    ({ pipelineItemId, ...change }) =>
      call(api, { method: 'PATCH', path: `/v1/pipeline-items/${pipelineItemId}`, body: change }),
  );

  return server;
}
