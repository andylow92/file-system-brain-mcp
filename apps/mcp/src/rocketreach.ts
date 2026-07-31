/**
 * RocketReach MCP tools — the agent-facing surface of the optional
 * prospect-research integration (issue #97).
 *
 * These tools are only registered when the integration is *enabled* (the MCP
 * server checks the integration status at startup). Even so, every tool is a
 * thin proxy to the API's `/api/integrations/rocketreach/*` routes, which
 * re-read the enabled flag and the API key on each call — so a tool **fails
 * closed** if the integration is disabled or the key is removed after the
 * server started, and paid lookups are bounded server-side by a required cap.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type Register = McpServer['tool'];
type ApiRequest = <T>(pathname: string, init?: RequestInit & { actor?: boolean }) => Promise<T>;

/** Same result envelope + error handling as the core vault tools. */
function wrap<Args>(handler: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
    }
  };
}

/**
 * Register the four RocketReach tools onto the MCP server. Call only when the
 * integration is enabled. `register` is the counted registrar so these tools
 * are reflected in the server's tool count.
 */
export function registerRocketReachTools(register: Register, apiRequest: ApiRequest): void {
  register(
    'rocketreach_get_account_status',
    'RocketReach: report account status, remaining paid lookup credits, and ' +
      'whether the key connects. Read-only — spends no credits. Fails closed ' +
      'with a clear message if the integration is disabled or no API key is set. ' +
      'Call this before a lookup to check the credit budget.',
    {},
    wrap(async () =>
      apiRequest('/api/integrations/rocketreach/test', { method: 'POST', actor: true }),
    ),
  );

  register(
    'rocketreach_start_intake',
    'RocketReach: return the standardized prospect-research intake questions to ' +
      'ask the user BEFORE searching or spending any credits (who to contact, ' +
      'regions, titles, target companies, a lookup-credit budget, whether to ' +
      'require work emails, and where to save results). Read-only.',
    {},
    wrap(async () => apiRequest('/api/integrations/rocketreach/intake')),
  );

  register(
    'rocketreach_search_contacts',
    'RocketReach: search for candidate people by structured criteria. ' +
      'Search-only — spends NO paid lookup credits and returns identity fields ' +
      '(name / title / company / location), not emails. Run ' +
      '`rocketreach_start_intake` first and confirm criteria with the user. ' +
      'Optionally save the run as a provenance note in the vault.',
    {
      audience: z.string().optional().describe('One-line description of the ideal contact.'),
      titles: z.array(z.string()).optional().describe('Target job titles/roles.'),
      regions: z.array(z.string()).optional().describe('Countries or regions.'),
      companies: z.array(z.string()).optional().describe('Target companies.'),
      industries: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      maxCandidates: z
        .number()
        .optional()
        .describe('Cap on returned candidates (default 25, hard max 100).'),
      requireWorkEmail: z.boolean().optional(),
      dedupe: z.boolean().optional().describe('Skip people already present in the vault.'),
      save: z
        .enum(['fsbrain', 'none'])
        .optional()
        .describe('Save the run as a vault note with provenance (default none).'),
      project: z.string().optional().describe('Project / company / sender label for provenance.'),
    },
    wrap(async (args: Record<string, unknown>) =>
      apiRequest('/api/integrations/rocketreach/search', {
        method: 'POST',
        body: JSON.stringify(args),
        actor: true,
      }),
    ),
  );

  register(
    'rocketreach_lookup_contacts',
    'RocketReach: enrich selected candidates with emails/phones. This SPENDS ' +
      'paid lookup credits. You MUST pass an explicit positive `maxLookups` cap — ' +
      'no more than that many candidates are ever enriched; the rest are reported ' +
      'as skipped. Confirm the spend with the user first. Reports credit balance ' +
      'before/after. Optionally saves the run as a provenance note.',
    {
      ids: z
        .array(z.string())
        .describe('RocketReach profile ids from a prior rocketreach_search_contacts call.'),
      maxLookups: z
        .number()
        .describe('REQUIRED hard cap on paid lookups (integer ≥ 1). Never exceeded.'),
      save: z.enum(['fsbrain', 'none']).optional(),
      project: z.string().optional(),
      audience: z.string().optional(),
      titles: z.array(z.string()).optional(),
      regions: z.array(z.string()).optional(),
      companies: z.array(z.string()).optional(),
    },
    wrap(async (args: Record<string, unknown>) =>
      apiRequest('/api/integrations/rocketreach/lookup', {
        method: 'POST',
        body: JSON.stringify(args),
        actor: true,
      }),
    ),
  );
}
