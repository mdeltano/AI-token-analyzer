import type { UsageEvent } from '../schema/usage-event.ts';

/**
 * List prices in USD per million tokens, first-party API, standard tier.
 *
 * Anthropic rates are from Anthropic's model documentation as of 2026-10-06. 5-minute cache writes
 * bill at 1.25x input and 1-hour writes at 2x; cache reads are 0.1x input except where noted.
 * OpenAI rates are from third-party price trackers as of 2026-10 and are not yet confirmed against
 * openai.com. OpenAI caching is automatic with no write surcharge, so `cacheWrite` equals `input`.
 * Both vendors discount the Batch API by 50% on every token type.
 */

export type ModelTier = 'frontier' | 'mid' | 'small';

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. */
  cacheWrite: number;
  /** 1-hour cache write, where the vendor offers one. */
  cacheWrite1h?: number;
}

export interface ModelPrice extends Rates {
  model: string;
  vendor: string;
  tier: ModelTier;
  /** Fraction taken off every token type by the vendor's batch API. */
  batchDiscount: number;
  /** A cheaper model from the same vendor that handles short, simple tasks well. */
  downshift?: string;
  /** Rates that apply instead when the prompt (all input-side tokens) is longer than `threshold`. */
  longContext?: Rates & { threshold: number };
}

function anthropic(model: string, tier: ModelTier, input: number, output: number, cacheRead = input / 10): ModelPrice {
  return {
    model, vendor: 'anthropic', tier, input, output, cacheRead,
    cacheWrite: input * 1.25, cacheWrite1h: input * 2, batchDiscount: 0.5,
    downshift: tier === 'small' ? undefined : 'claude-haiku-5-5',
  };
}

function openai(model: string, tier: ModelTier, input: number, output: number, cacheRead: number, downshift?: string): ModelPrice {
  return { model, vendor: 'openai', tier, input, output, cacheRead, cacheWrite: input, batchDiscount: 0.5, downshift };
}

const table: ModelPrice[] = [
  anthropic('claude-fable-5-1', 'frontier', 10, 50, 0.25),
  anthropic('claude-mythos-5-1', 'frontier', 10, 50, 0.25),
  anthropic('claude-fable-5', 'frontier', 10, 50, 1),
  anthropic('claude-mythos-5', 'frontier', 10, 50, 1),
  anthropic('claude-opus-5-5', 'frontier', 4, 20, 0.2),
  anthropic('claude-opus-5', 'frontier', 5, 25),
  anthropic('claude-opus-4-8', 'frontier', 5, 25),
  anthropic('claude-opus-4-7', 'frontier', 5, 25),
  anthropic('claude-opus-4-6', 'frontier', 5, 25),
  anthropic('claude-opus-4-5', 'frontier', 5, 25),
  anthropic('claude-opus-4-1', 'frontier', 15, 75),
  anthropic('claude-opus-4', 'frontier', 15, 75),
  anthropic('claude-sonnet-5-5', 'mid', 2, 10),
  anthropic('claude-sonnet-5', 'mid', 2, 10),
  anthropic('claude-sonnet-4-6', 'mid', 3, 15),
  anthropic('claude-sonnet-4-5', 'mid', 3, 15),
  anthropic('claude-sonnet-4', 'mid', 3, 15),
  {
    ...anthropic('claude-haiku-5-5', 'small', 0.1, 0.5),
    longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 },
  },
  anthropic('claude-haiku-4-5', 'small', 1, 5),
  openai('gpt-5.5', 'frontier', 5, 30, 0.5, 'gpt-5.4-mini'),
  openai('gpt-5.4-mini', 'small', 0.75, 4.5, 0.075),
  openai('gpt-5', 'frontier', 1.25, 10, 0.125, 'gpt-5-nano'),
  openai('gpt-5-mini', 'small', 0.25, 2, 0.025),
  openai('gpt-5-nano', 'small', 0.05, 0.4, 0.005),
];

const byModel = new Map(table.map((p) => [p.model, p]));

/** Fold the spellings tools and platforms use for one model into its first-party id. */
export function canonicalModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[\w+\]$/, '') // Claude Code context-window suffix, e.g. [1m]
    .replace(/^(?:[a-z]+\/)+/, '') // router prefixes such as anthropic/ or openrouter/openai/
    .replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '') // Bedrock
    .replace(/-v\d+(?::\d+)?$/, '') // Bedrock version suffix
    .replace(/(?:@|-)\d{8}$/, ''); // dated snapshots (Vertex uses @)
}

export function priceFor(model: string): ModelPrice | undefined {
  return byModel.get(canonicalModel(model));
}

export type TokenCounts = Pick<UsageEvent, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> & {
  /** Part of `cacheWriteTokens` written with the 1-hour TTL. */
  cacheWrite1hTokens?: number;
};

/** List-price cost of one call's tokens on `price`, in USD. */
export function tokenCost(t: TokenCounts, price: ModelPrice): number {
  const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const r: Rates = price.longContext && prompt > price.longContext.threshold ? price.longContext : price;
  const write1h = Math.min(t.cacheWrite1hTokens ?? 0, t.cacheWriteTokens);
  return (
    t.inputTokens * r.input +
    t.outputTokens * r.output +
    t.cacheReadTokens * r.cacheRead +
    (t.cacheWriteTokens - write1h) * r.cacheWrite +
    write1h * (r.cacheWrite1h ?? r.cacheWrite)
  ) / 1e6;
}

/** Estimated cost of an event at list price, or null when the model is not in the price table. */
export function eventCost(e: UsageEvent, price = priceFor(e.model)): number | null {
  if (!price) return null;
  const write1h = e.meta.cacheWrite1h;
  const cost = tokenCost({ ...e, cacheWrite1hTokens: typeof write1h === 'number' ? write1h : 0 }, price);
  return e.meta.serviceTier === 'batch' ? cost * (1 - price.batchDiscount) : cost;
}
