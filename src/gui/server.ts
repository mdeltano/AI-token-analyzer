import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { adapters, findAdapter, type AdapterEnv } from '../adapters/index.ts';
import { analyze, analyzers } from '../analyze/index.ts';
import { connectors, fetchAll, findConnector } from '../connectors/index.ts';
import { importAll } from '../importer.ts';
import { groupings, summarize, type Grouping } from '../report/summary.ts';
import type { UsageStore } from '../store/db.ts';
import { suggestFix, type SuggestContext } from '../suggest/index.ts';
import { generateWorkload, SYNTHETIC_SOURCE } from '../synth/workload.ts';

const PAGE = new URL('./index.html', import.meta.url);
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GuiOptions {
  store: UsageStore;
  dbPath: string;
  ctx: AdapterEnv;
}

type Query = URLSearchParams;
type Body = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function filterFrom(q: Query): { since?: string; source?: string } {
  const since = q.get('since') || undefined;
  const source = q.get('source') || undefined;
  if (since && !DATE.test(since)) throw new HttpError(400, 'since must be a date (YYYY-MM-DD).');
  const known = [...adapters.map((a) => a.id), ...connectors.map((c) => c.id), SYNTHETIC_SOURCE];
  if (source && !known.includes(source)) throw new HttpError(400, `Unknown source "${source}".`);
  return { since, source };
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** The JSON API behind the page. Each route calls the same functions as the matching CLI command. */
function routes({ store, dbPath, ctx }: GuiOptions): Record<string, (q: Query, body: Body) => unknown> {
  return {
    'GET /api/sources': () => ({
      db: dbPath,
      adapters: adapters.map((a) => ({
        id: a.id,
        name: a.displayName,
        found: a.defaultRoots(ctx).filter((r) => existsSync(r)),
      })),
      connectors: connectors.map((c) => ({ id: c.id, name: c.displayName, keyEnv: c.keyEnv, keySet: Boolean(ctx.env[c.keyEnv]) })),
      synthetic: SYNTHETIC_SOURCE,
      groupings: Object.keys(groupings),
    }),

    'GET /api/summary': (q) => {
      const by = q.get('by') ?? 'source';
      if (!(by in groupings)) throw new HttpError(400, `by must be one of: ${Object.keys(groupings).join(', ')}`);
      return summarize(store, by as Grouping, filterFrom(q));
    },

    'GET /api/analyze': (q) => {
      const result = analyze(store.events(filterFrom(q)));
      return {
        ...result,
        findings: result.findings.map((f) => ({ ...f, title: analyzers.find((a) => a.kind === f.kind)!.title })),
      };
    },

    'POST /api/import': (_, body) => {
      const source = str(body.source);
      const adapter = source ? findAdapter(source) : undefined;
      if (source && !adapter) throw new HttpError(400, `Unknown source "${source}" for import.`);
      return importAll(store, ctx, { adapters: adapter ? [adapter] : undefined, full: body.full === true })
        .filter((r) => r.filesSeen > 0 || adapter);
    },

    'POST /api/generate': (_, body) => {
      const workload = generateWorkload({ seed: num(body.seed), days: num(body.days), scale: num(body.scale) });
      const added = store.insert(workload.events);
      return { ...workload.options, events: workload.events.length, added, planted: workload.planted };
    },

    'POST /api/fetch': async (_, body) => {
      const source = str(body.source);
      const connector = source ? findConnector(source) : undefined;
      if (source && !connector) throw new HttpError(400, `Unknown source "${source}" for fetch.`);
      const today = new Date(new Date().toISOString().slice(0, 10));
      const sinceText = str(body.since);
      const since = sinceText ? new Date(sinceText) : new Date(today.getTime() - 30 * 86_400_000);
      if ((sinceText && !DATE.test(sinceText)) || Number.isNaN(since.getTime()) || since >= today) {
        throw new HttpError(400, 'since must be a date (YYYY-MM-DD) before today.');
      }
      return fetchAll(store, ctx.env, { connectors: connector ? [connector] : undefined, since, until: today });
    },

    // Findings are numbered as /api/analyze returned them for the same filter, as in `sundance suggest --finding`.
    'POST /api/suggest': async (_, body) => {
      const { findings } = analyze(store.events(filterFrom(new URLSearchParams({
        since: str(body.since) ?? '', source: str(body.source) ?? '',
      }))));
      const n = num(body.finding);
      if (n === undefined || !Number.isInteger(n) || n < 1 || n > findings.length) {
        throw new HttpError(400, `finding must be between 1 and ${findings.length}.`);
      }
      const c = body.context as { name?: unknown; text?: unknown } | undefined;
      const context: SuggestContext | undefined = c && typeof c.text === 'string'
        ? { name: str(c.name) ?? 'context', text: c.text }
        : undefined;
      return suggestFix(findings[n - 1]!, { model: str(body.model), context });
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Body> {
  if (req.method !== 'POST') return {};
  // a JSON content type cannot be sent cross-site without a CORS preflight, which this server never answers
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Body) : {};
  } catch {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

/** A local web UI over the same store and functions the CLI uses. Listens on loopback only. */
export function createGuiServer(opts: GuiOptions): Server {
  const table = routes(opts);
  return createServer(async (req, res) => {
    try {
      // only answer requests addressed to this machine, which keeps DNS-rebinding pages out
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'Forbidden host.');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE, 'utf8'));
        return;
      }
      const handler = table[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'Not found.');
      const result = await handler(url.searchParams, await readJson(req));
      send(res, 200, 'application/json', JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, 'application/json', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
}
