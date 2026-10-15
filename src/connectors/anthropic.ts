import { z } from 'zod';
import { makeEvent } from '../adapters/event.ts';
import { isoTime, tokens } from '../adapters/util.ts';
import type { UsageEvent } from '../schema/usage-event.ts';
import { ConnectorError, getJson } from './http.ts';
import type { UsageConnector } from './types.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const GROUP_BY = ['model', 'workspace_id', 'api_key_id', 'service_tier', 'context_window'];

const count = z.number().nullish();
const id = z.string().nullish();

const pageSchema = z.object({
  data: z.array(z.object({
    starting_at: z.string(),
    results: z.array(z.object({
      uncached_input_tokens: count,
      cache_read_input_tokens: count,
      cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }).nullish(),
      output_tokens: count,
      server_tool_use: z.object({ web_search_requests: count }).nullish(),
      model: id,
      workspace_id: id,
      api_key_id: id,
      service_tier: id,
      context_window: id,
    })),
  })),
  has_more: z.boolean(),
  next_page: z.string().nullish(),
});

/**
 * Anthropic Admin API usage report (`/v1/organizations/usage_report/messages`), in daily buckets
 * grouped by model, workspace, API key, service tier and context window. Workspaces map to
 * `project`; the default workspace has no ID, so its usage has no project.
 */
export const anthropicApi: UsageConnector = {
  id: 'anthropic-api',
  displayName: 'Anthropic Usage API',
  keyEnv: 'ANTHROPIC_ADMIN_KEY',
  async fetchUsage({ key, since, until, http }) {
    const events: UsageEvent[] = [];
    let page: string | null | undefined;
    do {
      const url = new URL(ENDPOINT);
      url.searchParams.set('starting_at', since.toISOString());
      url.searchParams.set('ending_at', until.toISOString());
      url.searchParams.set('bucket_width', '1d');
      url.searchParams.set('limit', '31');
      for (const g of GROUP_BY) url.searchParams.append('group_by[]', g);
      if (page) url.searchParams.set('page', page);

      const parsed = pageSchema.safeParse(await getJson(url, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, http));
      if (!parsed.success) throw new ConnectorError(`Unexpected usage report shape: ${parsed.error.message}`);

      for (const bucket of parsed.data.data) {
        const ts = isoTime(bucket.starting_at);
        if (!ts) continue;
        for (const r of bucket.results) {
          const model = r.model ?? 'unknown';
          const write1h = tokens(r.cache_creation?.ephemeral_1h_input_tokens);
          const e = makeEvent({
            dedupeKey: [this.id, ts, model, r.workspace_id, r.api_key_id, r.service_tier, r.context_window].map((v) => v ?? '').join(':'),
            source: this.id,
            providerId: 'anthropic',
            model,
            ts,
            project: r.workspace_id ?? null,
            inputTokens: tokens(r.uncached_input_tokens),
            outputTokens: tokens(r.output_tokens),
            cacheReadTokens: tokens(r.cache_read_input_tokens),
            cacheWriteTokens: tokens(r.cache_creation?.ephemeral_5m_input_tokens) + write1h,
            granularity: 'aggregate',
            sourceFile: ENDPOINT,
            meta: {
              ...(r.api_key_id && { apiKeyId: r.api_key_id }),
              ...(r.service_tier && { serviceTier: r.service_tier }),
              ...(r.context_window && { contextWindow: r.context_window }),
              ...(write1h && { cacheWrite1h: write1h }),
              ...(r.server_tool_use?.web_search_requests && { webSearchRequests: r.server_tool_use.web_search_requests }),
            },
          });
          if (e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens > 0) events.push(e);
        }
      }
      page = parsed.data.has_more ? parsed.data.next_page : null;
    } while (page);
    return events;
  },
};
