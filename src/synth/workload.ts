import { makeEvent } from '../adapters/event.ts';
import { totalTokens, type UsageEvent } from '../schema/usage-event.ts';
import { createRng, subSeed, type Rng } from './random.ts';

/**
 * Synthetic workload for a fictional company, Northwind Labs, running several LLM features in
 * production. Some features are healthy; others carry one known kind of waste. The returned
 * manifest records exactly what was planted, so the dataset works both as a reproducible demo
 * and as ground truth for analyzer tests.
 *
 * Request-level fields that the normalized schema has no column for (max_tokens, stop reason,
 * prompt prefix hash, latency, retry linkage) go in `meta`, the same place adapters put them.
 */

export const SYNTHETIC_SOURCE = 'synthetic';

export type WasteKind = 'uncached-prefix' | 'oversized-model' | 'truncated-output' | 'retry-storm' | 'batch-eligible';

export interface PlantedWaste {
  kind: WasteKind;
  project: string;
  model: string;
  /** Calls affected by the waste. */
  events: number;
  /** Tokens on those calls that the waste accounts for (not yet a savings estimate). */
  tokens: number;
  detail: string;
}

export interface GenerateOptions {
  seed?: number;
  /** Number of days of traffic, ending on `end`. */
  days?: number;
  /** Last day covered, as YYYY-MM-DD (UTC). Defaults to yesterday. */
  end?: string;
  /** Multiplies call volume. */
  scale?: number;
}

export interface Workload {
  options: Required<GenerateOptions>;
  events: UsageEvent[];
  planted: PlantedWaste[];
}

interface Call {
  /** Epoch ms. */
  at: number;
  model?: string;
  sessionId?: string | null;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  meta?: Record<string, unknown>;
}

interface DayContext {
  rng: Rng;
  /** UTC midnight of the day, epoch ms. */
  day: number;
  date: string;
  weekday: boolean;
  /** Scaled call count with day-to-day jitter. */
  volume(base: number): number;
  emit(call: Call): UsageEvent;
  /** Attribute `tokens` of an emitted event to this feature's planted waste. */
  waste(event: UsageEvent, tokens?: number): void;
}

interface Feature {
  project: string;
  team: string;
  model: string;
  waste?: { kind: WasteKind; detail: string };
  day(ctx: DayContext): void;
}

const HOUR = 3_600_000;
const SECOND = 1000;

/** A time during the working day, weighted toward late morning and early afternoon (UTC). */
function workHour(rng: Rng): number {
  const h = 9 + (rng.next() + rng.next() + rng.next()) / 3 * 9;
  return h * HOUR;
}

const SUPPORT_PREFIX = 7200;

const features: Feature[] = [
  {
    project: 'support-bot',
    team: 'customer-success',
    model: 'claude-sonnet-5-5',
    waste: {
      kind: 'uncached-prefix',
      detail: `${SUPPORT_PREFIX}-token system prompt and tool schemas re-sent on every turn with no cache breakpoint`,
    },
    day(ctx) {
      const { rng } = ctx;
      for (let c = 0, n = ctx.volume(ctx.weekday ? 45 : 15); c < n; c++) {
        const sessionId = `support-${ctx.date}-${c}`;
        let at = ctx.day + workHour(rng);
        let history = 0;
        for (let turn = 0, turns = rng.int(2, 6); turn < turns; turn++) {
          const user = rng.around(150, 0.5);
          const output = rng.around(220, 0.4);
          const e = ctx.emit({
            at, sessionId, input: SUPPORT_PREFIX + history + user, output,
            meta: { maxTokens: 1024, stopReason: 'end_turn', promptPrefixHash: 'sp-support-v3', systemPromptTokens: SUPPORT_PREFIX, historyTurns: turn },
          });
          ctx.waste(e, SUPPORT_PREFIX);
          history += user + output;
          at += rng.around(80, 0.6) * SECOND;
        }
      }
    },
  },
  {
    project: 'ticket-triage',
    team: 'customer-success',
    model: 'claude-opus-5-5',
    waste: { kind: 'oversized-model', detail: 'single-label ticket classification (2-8 output tokens) on a frontier model' },
    day(ctx) {
      const { rng } = ctx;
      for (let i = 0, n = ctx.volume(ctx.weekday ? 320 : 60); i < n; i++) {
        const e = ctx.emit({
          at: ctx.day + workHour(rng), input: rng.around(850, 0.2), output: rng.int(2, 8),
          meta: { maxTokens: 16, stopReason: 'end_turn', promptPrefixHash: 'sp-triage-v1' },
        });
        ctx.waste(e);
      }
    },
  },
  {
    project: 'doc-summarizer',
    team: 'knowledge',
    model: 'claude-sonnet-5-5',
    waste: { kind: 'truncated-output', detail: 'max_tokens=512 cuts long summaries off, and each truncated call is re-run with a higher limit' },
    day(ctx) {
      const { rng } = ctx;
      for (let i = 0, n = ctx.volume(ctx.weekday ? 70 : 10); i < n; i++) {
        const at = ctx.day + workHour(rng);
        const input = rng.around(11000, 0.4);
        const wanted = rng.around(450, 0.4);
        if (wanted < 512) {
          ctx.emit({ at, input, output: wanted, meta: { maxTokens: 512, stopReason: 'end_turn' } });
          continue;
        }
        const cut = ctx.emit({ at, input, output: 512, meta: { maxTokens: 512, stopReason: 'max_tokens' } });
        ctx.waste(cut);
        ctx.emit({
          at: at + rng.around(20, 0.3) * SECOND, input, output: wanted,
          meta: { maxTokens: 2048, stopReason: 'end_turn', retryOf: cut.dedupeKey },
        });
      }
    },
  },
  {
    project: 'invoice-extractor',
    team: 'finance-ops',
    model: 'gpt-5',
    waste: { kind: 'retry-storm', detail: 'client times out at 10s and retries identical requests that the provider still bills' },
    day(ctx) {
      const { rng } = ctx;
      for (let i = 0, n = ctx.volume(ctx.weekday ? 55 : 5); i < n; i++) {
        let at = ctx.day + workHour(rng);
        const requestHash = `inv-${ctx.date}-${i}`;
        const input = rng.around(2200, 0.25);
        const storm = rng.chance(0.1);
        const attempts = storm ? rng.int(4, 8) : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const e = ctx.emit({
            at, input, cacheRead: 1024, output: rng.around(420, 0.2),
            meta: { maxTokens: 4096, stopReason: 'stop', requestHash, attempt, latencyMs: storm ? rng.int(10_500, 14_000) : rng.int(3000, 7000) },
          });
          if (attempt > 1) ctx.waste(e);
          at += rng.int(10, 14) * SECOND;
        }
      }
    },
  },
  {
    project: 'nightly-digest',
    team: 'growth',
    model: 'claude-sonnet-5-5',
    waste: { kind: 'batch-eligible', detail: 'cron job sends ~240 independent requests every night at 02:00 synchronously instead of via the Batch API' },
    day(ctx) {
      const { rng } = ctx;
      let at = ctx.day + 2 * HOUR;
      for (let i = 0, n = ctx.volume(240); i < n; i++) {
        const e = ctx.emit({
          at, sessionId: `digest-run-${ctx.date}`, input: rng.around(5000, 0.3), output: rng.around(600, 0.3),
          meta: { maxTokens: 1500, stopReason: 'end_turn', trigger: 'cron', serviceTier: 'standard' },
        });
        ctx.waste(e);
        at += rng.around(8, 0.3) * SECOND;
      }
    },
  },
  {
    // healthy: agentic coding sessions that cache their growing context. Shape matches real Claude
    // Code transcripts: a few fresh input tokens, ~4k cache writes and ~1.5k output per call.
    project: 'code-assistant',
    team: 'platform',
    model: 'claude-opus-5-5',
    day(ctx) {
      const { rng } = ctx;
      for (let s = 0, n = ctx.volume(ctx.weekday ? 18 : 3); s < n; s++) {
        const sessionId = `code-${ctx.date}-${s}`;
        let at = ctx.day + workHour(rng);
        let context = 0;
        for (let i = 0, calls = rng.int(8, 35); i < calls; i++) {
          const write = i === 0 ? rng.around(25000, 0.2) : rng.around(4000, 0.6);
          const output = rng.around(1500, 0.7);
          ctx.emit({
            at, sessionId, input: rng.around(3, 0.5), cacheRead: context, cacheWrite: write, output,
            meta: { maxTokens: 32000, stopReason: i === calls - 1 ? 'end_turn' : 'tool_use' },
          });
          context += write;
          at += rng.around(25, 0.6) * SECOND;
        }
      }
    },
  },
  {
    // healthy: short scoring calls on a small model with a cached instruction prefix
    project: 'search-rerank',
    team: 'search',
    model: 'claude-haiku-5-5',
    day(ctx) {
      const { rng } = ctx;
      for (let i = 0, n = ctx.volume(ctx.weekday ? 450 : 150); i < n; i++) {
        ctx.emit({
          at: ctx.day + workHour(rng), input: rng.around(400, 0.3), cacheRead: 1100, output: rng.around(25, 0.3),
          meta: { maxTokens: 64, stopReason: 'end_turn', promptPrefixHash: 'sp-rerank-v2' },
        });
      }
    },
  },
];

function yesterday(): string {
  return new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
}

export function generateWorkload(opts: GenerateOptions = {}): Workload {
  const options = { seed: opts.seed ?? 42, days: opts.days ?? 30, end: opts.end ?? yesterday(), scale: opts.scale ?? 1 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.end) || Number.isNaN(Date.parse(options.end))) {
    throw new Error(`end must be a date as YYYY-MM-DD, got "${options.end}"`);
  }
  if (!Number.isInteger(options.days) || options.days < 1) throw new Error('days must be a positive integer');
  if (!(options.scale > 0)) throw new Error('scale must be positive');

  const endDay = Date.parse(`${options.end}T00:00:00Z`);
  const firstDay = endDay - (options.days - 1) * 24 * HOUR;
  const events: UsageEvent[] = [];
  const planted: PlantedWaste[] = [];

  for (const feature of features) {
    // each feature has its own stream, so editing one never changes another's data
    const rng = createRng(subSeed(options.seed, feature.project));
    const record: PlantedWaste | undefined = feature.waste && {
      ...feature.waste, project: feature.project, model: feature.model, events: 0, tokens: 0,
    };
    let n = 0;

    for (let day = firstDay; day <= endDay; day += 24 * HOUR) {
      const dow = new Date(day).getUTCDay();
      const date = new Date(day).toISOString().slice(0, 10);
      const ctx: DayContext = {
        rng,
        day,
        date,
        weekday: dow !== 0 && dow !== 6,
        volume: (base) => Math.max(1, Math.round(base * options.scale * (0.85 + 0.3 * rng.next()))),
        emit(call) {
          const event = makeEvent({
            dedupeKey: `${SYNTHETIC_SOURCE}:${options.seed}:${options.end}:${feature.project}:${n++}`,
            source: SYNTHETIC_SOURCE,
            model: call.model ?? feature.model,
            ts: new Date(call.at).toISOString(),
            sessionId: call.sessionId ?? null,
            project: feature.project,
            inputTokens: call.input,
            outputTokens: call.output,
            cacheReadTokens: call.cacheRead ?? 0,
            cacheWriteTokens: call.cacheWrite ?? 0,
            sourceFile: `synthetic://northwind-labs?seed=${options.seed}`,
            meta: { feature: feature.project, team: feature.team, ...call.meta },
          });
          events.push(event);
          return event;
        },
        waste(event, tokens = totalTokens(event)) {
          if (!record) throw new Error(`${feature.project} has no planted waste`);
          record.events++;
          record.tokens += tokens;
        },
      };
      feature.day(ctx);
    }
    if (record) planted.push(record);
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts) || a.dedupeKey.localeCompare(b.dedupeKey));
  return { options, events, planted };
}
