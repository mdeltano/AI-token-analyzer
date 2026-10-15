import { z } from 'zod';
import { makeEvent } from '../adapters/event.ts';
import { isoTime, tokens } from '../adapters/util.ts';
import type { UsageEvent } from '../schema/usage-event.ts';
import { ConnectorError, getJson } from './http.ts';
import type { UsageConnector } from './types.ts';

const ENDPOINT = 'https://api.openai.com/v1/organization/usage/completions';
const GROUP_BY = ['model', 'project_id', 'api_key_id', 'batch', 'service_tier'];

const count = z.number().nullish();
const id = z.string().nullish();

const pageSchema = z.object({
  data: z.array(z.object({
    start_time: z.number(),
    results: z.array(z.object({
      input_tokens: count,
      input_cached_tokens: count,
      input_cache_write_tokens: count,
      input_cache_write_12h_tokens: count,
      input_uncached_tokens: count,
      output_tokens: count,
      num_model_requests: count,
      model: id,
      project_id: id,
      api_key_id: id,
      batch: z.boolean().nullish(),
      service_tier: id,
    })),
  })),
  has_more: z.boolean(),
  next_page: z.string().nullish(),
});

/**
 * OpenAI organization Usage API (`/v1/organization/usage/completions`), in daily buckets grouped
 * by model, project, API key, batch and service tier. OpenAI's `input_tokens` includes cached and
 * cache-write tokens; they are split out here to match the normalized schema.
 */
export const openaiApi: UsageConnector = {
  id: 'openai-api',
  displayName: 'OpenAI Usage API',
  keyEnv: 'OPENAI_ADMIN_KEY',
  async fetchUsage({ key, since, until, http }) {
    const events: UsageEvent[] = [];
    let page: string | null | undefined;
    do {
      const url = new URL(ENDPOINT);
      url.searchParams.set('start_time', String(Math.floor(since.getTime() / 1000)));
      url.searchParams.set('end_time', String(Math.floor(until.getTime() / 1000)));
      url.searchParams.set('bucket_width', '1d');
      url.searchParams.set('limit', '31');
      for (const g of GROUP_BY) url.searchParams.append('group_by', g);
      if (page) url.searchParams.set('page', page);

      const parsed = pageSchema.safeParse(await getJson(url, { authorization: `Bearer ${key}` }, http));
      if (!parsed.success) throw new ConnectorError(`Unexpected usage response shape: ${parsed.error.message}`);

      for (const bucket of parsed.data.data) {
        const ts = isoTime(bucket.start_time);
        if (!ts) continue;
        for (const r of bucket.results) {
          const model = r.model ?? 'unknown';
          const cached = tokens(r.input_cached_tokens);
          const write = tokens(r.input_cache_write_tokens);
          const write12h = tokens(r.input_cache_write_12h_tokens);
          const uncached = r.input_uncached_tokens ?? Math.max(0, tokens(r.input_tokens) - cached - write - write12h);
          const e = makeEvent({
            dedupeKey: [this.id, ts, model, r.project_id, r.api_key_id, r.batch, r.service_tier].map((v) => v ?? '').join(':'),
            source: this.id,
            providerId: 'openai',
            model,
            ts,
            project: r.project_id ?? null,
            inputTokens: tokens(uncached),
            outputTokens: tokens(r.output_tokens),
            cacheReadTokens: cached,
            cacheWriteTokens: write + write12h,
            granularity: 'aggregate',
            sourceFile: ENDPOINT,
            meta: {
              requests: tokens(r.num_model_requests),
              ...(r.api_key_id && { apiKeyId: r.api_key_id }),
              ...((r.batch || r.service_tier) && { serviceTier: r.batch ? 'batch' : r.service_tier }),
              ...(write12h && { cacheWrite12h: write12h }),
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
