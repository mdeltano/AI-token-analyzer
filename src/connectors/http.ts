export interface HttpOptions {
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
  /** Replaces the wait between retries, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class ConnectorError extends Error {}

const MAX_ATTEMPTS = 4;
/** Per attempt, covering the response body too, so a stalled connection cannot hang a fetch. */
const TIMEOUT_MS = 60_000;
export const USER_AGENT = 'sundance/0.1.0';

/** GET a JSON document, retrying rate limits, server errors and timeouts with backoff (or `retry-after`). */
export async function getJson(url: URL, headers: Record<string, string>, opts: HttpOptions = {}): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let body: unknown;
    try {
      res = await doFetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) body = await res.json();
    } catch (err) {
      if ((err as Error).name !== 'TimeoutError') throw err;
      if (attempt === MAX_ATTEMPTS) throw new ConnectorError(`${url.host}${url.pathname} did not respond within ${TIMEOUT_MS / 1000}s`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return body;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      const body = (await res.text()).slice(0, 300);
      throw new ConnectorError(`${url.host}${url.pathname} returned HTTP ${res.status}: ${body}`);
    }
    const after = Number(res.headers.get('retry-after'));
    await sleep(after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1));
  }
}
