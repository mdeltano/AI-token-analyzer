import { z } from 'zod';
import { analyzers, type Finding } from '../analyze/index.ts';
import { askClaude, type Runner } from './claude-cli.ts';

/** A drafted fix for one finding. Savings stay the analyzer's estimate; the model never sets them. */
export const suggestionSchema = z.strictObject({
  summary: z.string().describe('One sentence: the change to make.'),
  changes: z.array(z.strictObject({
    where: z.string().describe('The file, prompt, config or call site to change.'),
    what: z.string().describe('What to change there and why it removes the waste.'),
    snippet: z.string().describe('The rewritten text, code or config, ready to paste; empty if the change has no text form.'),
  })).min(1),
  verify: z.string().describe('How to confirm the saving and check that output quality holds.'),
  caveats: z.string().describe('Risks or conditions under which the change does not apply; empty if none.'),
});

export type Suggestion = z.infer<typeof suggestionSchema>;

export interface SuggestContext {
  /** Shown to the model as the file's name. */
  name: string;
  text: string;
}

export interface SuggestOptions {
  model?: string;
  /** A prompt, config or source file the waste comes from, for the model to rewrite directly. */
  context?: SuggestContext;
  run?: Runner;
}

export interface SuggestResult {
  suggestion: Suggestion;
  models: string[];
  costUsd: number | null;
}

/** Larger context files are refused rather than cut, so a rewrite never works from a partial file. */
export const MAX_CONTEXT_CHARS = 200_000;

// Kept free of per-request details so repeated requests share a cacheable prefix.
export const SYSTEM_PROMPT = `You are the suggestion step of Sundance, a tool that finds wasted LLM tokens.
Sundance's rule-based analyzers have already found one case of waste and estimated what fixing it saves.
Your job is to draft the concrete change that removes it.

- Work from the finding as given. Do not re-estimate or restate dollar savings; Sundance reports its own estimate.
- If a context file is attached, base every change on it: name the exact lines or sections to change and put
  the rewritten version in the snippet (for example the reordered prompt with its cache breakpoint, the lowered
  model name, or the batch-API call). Keep its behaviour the same except for the fix.
- If no context file is attached, say which file or setting the user should look for, and give a short template
  snippet they can adapt. Do not invent the user's code or prompt text.
- Prefer the smallest change that removes the waste. Mention a quality check whenever the change could alter
  outputs (a smaller model, a shorter prompt).`;

export function buildPrompt(finding: Finding, context?: SuggestContext): string {
  const analyzer = analyzers.find((a) => a.kind === finding.kind);
  const lines = [
    '<finding>',
    `kind: ${finding.kind}${analyzer ? ` (${analyzer.title})` : ''}`,
    `project: ${finding.project ?? '(none)'}`,
    `model: ${finding.model}`,
    `calls affected: ${finding.events}`,
    `tokens affected: ${finding.tokens}`,
    `evidence: ${finding.evidence}`,
    `analyzer's recommendation: ${finding.recommendation}`,
    '</finding>',
  ];
  if (context) {
    lines.push('', `<context file="${context.name}">`, context.text, '</context>');
  }
  lines.push('', context
    ? 'Draft the change to the attached file that removes this waste.'
    : 'No context file is attached. Draft the change, and say where in their code or prompts the user will find it.');
  return lines.join('\n');
}

const jsonSchema = (() => {
  const { $schema: _, ...schema } = z.toJSONSchema(suggestionSchema) as Record<string, unknown>;
  return schema;
})();

export async function suggestFix(finding: Finding, opts: SuggestOptions = {}): Promise<SuggestResult> {
  if (opts.context && opts.context.text.length > MAX_CONTEXT_CHARS) {
    throw new Error(`Context file ${opts.context.name} is over ${MAX_CONTEXT_CHARS.toLocaleString('en-US')} characters; ` +
      'pass the part that contains the prompt or call instead.');
  }
  const reply = await askClaude({
    prompt: buildPrompt(finding, opts.context),
    systemPrompt: SYSTEM_PROMPT,
    schema: jsonSchema,
    model: opts.model,
  }, opts.run);
  const parsed = suggestionSchema.safeParse(reply.output);
  if (!parsed.success) throw new Error(`claude's suggestion did not match the expected shape: ${parsed.error.message}`);
  return { suggestion: parsed.data, models: reply.models, costUsd: reply.costUsd };
}
