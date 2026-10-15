import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Finding } from '../src/analyze/index.ts';
import { askClaude, ClaudeCliError, type RunResult, type Runner } from '../src/suggest/claude-cli.ts';
import { buildPrompt, MAX_CONTEXT_CHARS, suggestFix, SYSTEM_PROMPT, type Suggestion } from '../src/suggest/index.ts';

const finding: Finding = {
  kind: 'uncached-prefix',
  project: 'support-bot',
  model: 'claude-opus-5-5',
  events: 1200,
  tokens: 4_800_000,
  savingsUsd: 17.28,
  evidence: '1,200 calls share a 4,000-token prompt prefix with a 0.4% cache hit rate.',
  recommendation: 'Put a cache_control breakpoint after the stable system prompt.',
};

const suggestion: Suggestion = {
  summary: 'Cache the support-bot system prompt.',
  changes: [{ where: 'prompts/support.txt', what: 'Move the date to the end and add a breakpoint.', snippet: 'cache_control: {type: "ephemeral"}' }],
  verify: 'Check cache_read_input_tokens on the next calls.',
  caveats: '',
};

const success = (output: unknown) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(output), structured_output: output,
  total_cost_usd: 0.0123, modelUsage: { 'claude-opus-5-5': { inputTokens: 900, outputTokens: 400 } },
});

/** A fake `claude` that answers with `results` in order and records each invocation. */
function fakeRunner(...results: RunResult[]) {
  const calls: { args: string[]; stdin: string }[] = [];
  const run: Runner = async (args, stdin) => {
    calls.push({ args, stdin });
    return results.shift()!;
  };
  return { run, calls };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe('askClaude', () => {
  it('runs one headless request with no tools, settings or MCP servers, and sends the prompt on stdin', async () => {
    const { run, calls } = fakeRunner({ code: 0, stdout: success({ ok: 1 }), stderr: '' });
    const schema = { type: 'object' };
    const reply = await askClaude({ prompt: 'hello', systemPrompt: 'sys', schema, model: 'sonnet' }, run);

    const { args, stdin } = calls[0]!;
    assert.equal(stdin, 'hello');
    assert.ok(args.includes('-p') && args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'));
    assert.equal(flag(args, '--output-format'), 'json');
    assert.equal(flag(args, '--tools'), '');
    assert.equal(flag(args, '--setting-sources'), '');
    assert.equal(flag(args, '--system-prompt'), 'sys');
    assert.deepEqual(JSON.parse(flag(args, '--json-schema')!), schema);
    assert.equal(flag(args, '--model'), 'sonnet');
    assert.deepEqual(reply, { output: { ok: 1 }, models: ['claude-opus-5-5'], costUsd: 0.0123 });
  });

  it('leaves the model to Claude Code when none is given', async () => {
    const { run, calls } = fakeRunner({ code: 0, stdout: success({}), stderr: '' });
    await askClaude({ prompt: 'p', systemPrompt: 's', schema: {} }, run);
    assert.ok(!calls[0]!.args.includes('--model'));
  });

  it('reports CLI errors, non-JSON output and missing structured output', async () => {
    const cases: [RunResult, RegExp][] = [
      [{ code: 1, stdout: '', stderr: 'Not logged in' }, /code 1.*Not logged in/],
      [{ code: 1, stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'Credit balance is too low' }), stderr: '' }, /Credit balance/],
      [{ code: 1, stdout: JSON.stringify({ subtype: 'error_max_turns', is_error: true }), stderr: '' }, /error_max_turns/],
      [{ code: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'text' }), stderr: '' }, /no structured output/],
    ];
    for (const [res, pattern] of cases) {
      const { run } = fakeRunner(res);
      await assert.rejects(askClaude({ prompt: 'p', systemPrompt: 's', schema: {} }, run), (err: Error) =>
        err instanceof ClaudeCliError && pattern.test(err.message));
    }
  });
});

describe('suggestFix', () => {
  it('sends the finding and returns the validated suggestion', async () => {
    const { run, calls } = fakeRunner({ code: 0, stdout: success(suggestion), stderr: '' });
    const res = await suggestFix(finding, { run });

    assert.deepEqual(res.suggestion, suggestion);
    assert.equal(flag(calls[0]!.args, '--system-prompt'), SYSTEM_PROMPT);
    const schema = JSON.parse(flag(calls[0]!.args, '--json-schema')!);
    assert.equal(schema.$schema, undefined);
    assert.deepEqual(schema.required, ['summary', 'changes', 'verify', 'caveats']);
    assert.equal(schema.additionalProperties, false);
  });

  it('rejects a reply that does not match the suggestion shape', async () => {
    const { run } = fakeRunner({ code: 0, stdout: success({ ...suggestion, changes: [] }), stderr: '' });
    await assert.rejects(suggestFix(finding, { run }), /expected shape/);
  });

  it('refuses an oversized context file instead of cutting it', async () => {
    const { run, calls } = fakeRunner();
    const context = { name: 'huge.txt', text: 'x'.repeat(MAX_CONTEXT_CHARS + 1) };
    await assert.rejects(suggestFix(finding, { run, context }), /huge\.txt is over/);
    assert.equal(calls.length, 0);
  });
});

describe('buildPrompt', () => {
  it('describes the finding without its dollar estimate', () => {
    const prompt = buildPrompt(finding);
    assert.match(prompt, /kind: uncached-prefix \(/);
    assert.match(prompt, /project: support-bot/);
    assert.match(prompt, /calls affected: 1200/);
    assert.match(prompt, /evidence: 1,200 calls share/);
    assert.match(prompt, /No context file is attached/);
    assert.doesNotMatch(prompt, /17\.28/);
  });

  it('attaches the context file and asks for a rewrite of it', () => {
    const prompt = buildPrompt(finding, { name: 'support.txt', text: 'You are a support agent. Today is {{date}}.' });
    assert.match(prompt, /<context file="support.txt">\nYou are a support agent\. Today is \{\{date\}\}\.\n<\/context>/);
    assert.match(prompt, /Draft the change to the attached file/);
  });
});
