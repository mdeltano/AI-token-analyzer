import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropicApi } from '../src/connectors/anthropic.ts';
import { fetchAll } from '../src/connectors/index.ts';
import { openaiApi } from '../src/connectors/openai.ts';
import { eventCost, priceFor } from '../src/pricing/prices.ts';
import { summarize } from '../src/report/summary.ts';
import { UsageStore } from '../src/store/db.ts';

const since = new Date('2026-10-01T00:00:00Z');
const until = new Date('2026-10-03T00:00:00Z');

/** An HTTP error response for `fakeFetch` to serve. */
class Fail {
  status: number;
  body: string;
  retryAfter?: string;
  constructor(status: number, body = '', retryAfter?: string) {
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/** A fake `fetch` that serves `pages` in order and records each request. */
function fakeFetch(pages: unknown[]) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (url: URL, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers as Record<string, string> });
    const next = pages.shift();
    if (next instanceof Fail) {
      const headers = next.retryAfter ? { 'retry-after': next.retryAfter } : undefined;
      return new Response(next.body, { status: next.status, headers });
    }
    return Response.json(next);
  }) as typeof fetch;
  return { fn, requests };
}

const anthropicPage1 = {
  data: [{
    starting_at: '2026-10-01T00:00:00Z',
    ending_at: '2026-10-02T00:00:00Z',
    results: [{
      account_id: null, api_key_id: 'apikey_01', service_account_id: null, inference_geo: null,
      cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 4000 },
      cache_read_input_tokens: 90000, context_window: '0-200k', model: 'claude-opus-5-5', output_tokens: 2000,
      server_tool_use: { web_search_requests: 3 }, service_tier: 'standard', uncached_input_tokens: 5000, workspace_id: 'wrkspc_01',
    }, {
      api_key_id: 'apikey_02', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_read_input_tokens: 0, context_window: '0-200k', model: 'claude-haiku-5-5', output_tokens: 0,
      server_tool_use: { web_search_requests: 0 }, service_tier: 'standard', uncached_input_tokens: 0, workspace_id: null,
    }],
  }],
  has_more: true,
  next_page: 'page_2',
};
const anthropicPage2 = {
  data: [{
    starting_at: '2026-10-02T00:00:00Z',
    ending_at: '2026-10-03T00:00:00Z',
    results: [{
      api_key_id: 'apikey_02', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_read_input_tokens: 0, context_window: '0-200k', model: 'claude-haiku-5-5', output_tokens: 100,
      server_tool_use: { web_search_requests: 0 }, service_tier: 'batch', uncached_input_tokens: 1000, workspace_id: null,
    }],
  }],
  has_more: false,
  next_page: null,
};

const openaiPage = {
  object: 'page',
  data: [{
    object: 'bucket',
    start_time: 1790812800, // 2026-10-01
    end_time: 1790899200,
    results: [{
      object: 'organization.usage.completions.result',
      input_tokens: 5000, input_cached_tokens: 1800, input_cache_write_tokens: 150, input_cache_write_12h_tokens: 50,
      input_uncached_tokens: 3000, output_tokens: 1000, num_model_requests: 5,
      project_id: 'proj_abc', user_id: null, api_key_id: 'key_abc', model: 'gpt-5.5', batch: false, service_tier: 'default',
    }, {
      // older responses have no uncached or cache-write fields
      object: 'organization.usage.completions.result',
      input_tokens: 1000, input_cached_tokens: 400, output_tokens: 200, num_model_requests: 2,
      project_id: 'proj_abc', api_key_id: 'key_abc', model: 'gpt-5-mini', batch: true, service_tier: null,
    }],
  }],
  has_more: false,
  next_page: null,
};

describe('anthropicApi', () => {
  it('requests daily grouped buckets, follows pages and normalizes token fields', async () => {
    const { fn, requests } = fakeFetch([anthropicPage1, anthropicPage2]);
    const events = await anthropicApi.fetchUsage({ key: 'sk-ant-admin01-test', since, until, http: { fetch: fn } });

    assert.equal(requests.length, 2);
    const first = requests[0]!;
    assert.equal(first.url.pathname, '/v1/organizations/usage_report/messages');
    assert.equal(first.url.searchParams.get('starting_at'), '2026-10-01T00:00:00.000Z');
    assert.equal(first.url.searchParams.get('ending_at'), '2026-10-03T00:00:00.000Z');
    assert.equal(first.url.searchParams.get('bucket_width'), '1d');
    assert.deepEqual(first.url.searchParams.getAll('group_by[]'), ['model', 'workspace_id', 'api_key_id', 'service_tier', 'context_window']);
    assert.equal(first.headers['x-api-key'], 'sk-ant-admin01-test');
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[1]!.url.searchParams.get('page'), 'page_2');

    assert.equal(events.length, 2, 'the all-zero row is dropped');
    const [opus, haiku] = events;
    assert.equal(opus!.ts, '2026-10-01T00:00:00.000Z');
    assert.equal(opus!.vendor, 'anthropic');
    assert.equal(opus!.project, 'wrkspc_01');
    assert.equal(opus!.granularity, 'aggregate');
    assert.deepEqual(
      [opus!.inputTokens, opus!.outputTokens, opus!.cacheReadTokens, opus!.cacheWriteTokens],
      [5000, 2000, 90000, 5000],
    );
    assert.deepEqual(opus!.meta, { apiKeyId: 'apikey_01', serviceTier: 'standard', contextWindow: '0-200k', cacheWrite1h: 1000, webSearchRequests: 3 });
    assert.equal(haiku!.project, null, 'default workspace has no ID');

    // 1h writes bill at 2x input, 5m writes at 1.25x
    const p = priceFor('claude-opus-5-5')!;
    assert.equal(eventCost(opus!), (5000 * p.input + 2000 * p.output + 90000 * p.cacheRead + 4000 * p.cacheWrite + 1000 * p.cacheWrite1h!) / 1e6);
    assert.equal(eventCost(haiku!), ((1000 * 0.1 + 100 * 0.5) / 1e6) * 0.5, 'batch tier is discounted');
  });
});

describe('openaiApi', () => {
  it('splits cached and cache-write tokens out of input', async () => {
    const { fn, requests } = fakeFetch([openaiPage]);
    const events = await openaiApi.fetchUsage({ key: 'sk-admin-test', since, until, http: { fetch: fn } });

    const url = requests[0]!.url;
    assert.equal(url.pathname, '/v1/organization/usage/completions');
    assert.equal(url.searchParams.get('start_time'), '1790812800');
    assert.equal(url.searchParams.get('end_time'), '1790985600');
    assert.deepEqual(url.searchParams.getAll('group_by'), ['model', 'project_id', 'api_key_id', 'batch', 'service_tier']);
    assert.equal(requests[0]!.headers.authorization, 'Bearer sk-admin-test');

    const [gpt, mini] = events;
    assert.equal(gpt!.ts, '2026-10-01T00:00:00.000Z');
    assert.equal(gpt!.vendor, 'openai');
    assert.equal(gpt!.project, 'proj_abc');
    assert.deepEqual([gpt!.inputTokens, gpt!.cacheReadTokens, gpt!.cacheWriteTokens, gpt!.outputTokens], [3000, 1800, 200, 1000]);
    assert.deepEqual(gpt!.meta, { requests: 5, apiKeyId: 'key_abc', serviceTier: 'default', cacheWrite12h: 50 });
    assert.deepEqual([mini!.inputTokens, mini!.cacheReadTokens, mini!.cacheWriteTokens], [600, 400, 0]);
    assert.equal(mini!.meta.serviceTier, 'batch');
  });

  it('retries rate limits and reports other errors', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const retried = fakeFetch([new Fail(429, '', '2'), new Fail(503), openaiPage]);
    const events = await openaiApi.fetchUsage({ key: 'k', since, until, http: { fetch: retried.fn, sleep } });
    assert.equal(events.length, 2);
    assert.deepEqual(waits, [2000, 2000]);

    const denied = fakeFetch([new Fail(401, '{"error":{"message":"Invalid admin key"}}')]);
    await assert.rejects(
      openaiApi.fetchUsage({ key: 'k', since, until, http: { fetch: denied.fn, sleep } }),
      /HTTP 401: .*Invalid admin key/,
    );
  });
});

describe('fetchAll', () => {
  it('skips connectors without a key and replaces stored days on re-fetch', async () => {
    const store = new UsageStore(':memory:');
    const env = { ANTHROPIC_ADMIN_KEY: 'sk-ant-admin01-test' };

    const first = fakeFetch([anthropicPage1, anthropicPage2]);
    const results = await fetchAll(store, env, { since, until, http: { fetch: first.fn } });
    assert.deepEqual(results.map((r) => [r.source, r.status]), [['anthropic-api', 'ok'], ['openai-api', 'skipped']]);
    assert.equal(results[0]!.tokens, 5000 + 2000 + 90000 + 5000 + 1100);

    // the second day's usage grew after the first fetch; re-fetching overwrites it
    const grown = structuredClone(anthropicPage2);
    grown.data[0]!.results[0]!.output_tokens = 500;
    const again = fakeFetch([anthropicPage1, grown]);
    await fetchAll(store, env, { since, until, http: { fetch: again.fn } });
    const [row] = summarize(store, 'source', { source: 'anthropic-api' });
    assert.equal(row!.events, 2);
    assert.equal(row!.output, 2500);

    const failing = fakeFetch([new Fail(403, 'forbidden')]);
    const [failed] = await fetchAll(store, env, { since, until, http: { fetch: failing.fn } });
    assert.equal(failed!.status, 'failed');
    assert.equal(summarize(store, 'source', { source: 'anthropic-api' })[0]!.events, 2, 'a failed fetch keeps stored usage');
    store.close();
  });
});
