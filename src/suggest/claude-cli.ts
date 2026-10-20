import { spawn } from 'node:child_process';

export interface ClaudeRequest {
  prompt: string;
  systemPrompt: string;
  /** JSON Schema the reply must match; the CLI validates it and returns the parsed object. */
  schema: object;
  /** Model alias or ID; omitted, the CLI uses the model Claude Code is configured with. */
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeReply {
  output: unknown;
  /** Models that served the request, as the CLI reports them. */
  models: string[];
  /** List-price value of the request; on a subscription this is not billed. */
  costUsd: number | null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the `claude` binary with `args`, writing `stdin` to it. Replaceable in tests. */
export type Runner = (args: string[], stdin: string, timeoutMs: number) => Promise<RunResult>;

export class ClaudeCliError extends Error {}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Arguments for one headless, tool-free request. Settings, CLAUDE.md, memory and MCP servers are
 * not loaded, so the request carries only Sundance's prompt and none of the user's own context.
 */
export function claudeArgs(req: ClaudeRequest): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--system-prompt', req.systemPrompt,
    '--json-schema', JSON.stringify(req.schema),
    ...(req.model ? ['--model', req.model] : []),
  ];
}

/**
 * Sends one request through the locally installed Claude Code CLI, which runs under whatever
 * account it is signed in with (a Claude subscription or an API key). The prompt goes on stdin.
 */
export async function askClaude(req: ClaudeRequest, run: Runner = spawnClaude): Promise<ClaudeReply> {
  const res = await run(claudeArgs(req), req.prompt, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    const detail = (res.stderr || res.stdout).trim().slice(0, 500);
    throw new ClaudeCliError(`claude exited with code ${res.code} and no JSON result${detail ? `: ${detail}` : ''}`);
  }
  if (parsed.is_error || parsed.subtype !== 'success') {
    const detail = typeof parsed.result === 'string' ? parsed.result : String(parsed.subtype ?? 'unknown error');
    throw new ClaudeCliError(`claude reported an error: ${detail}`);
  }
  if (parsed.structured_output === undefined) throw new ClaudeCliError('claude returned no structured output');
  const usage = parsed.modelUsage;
  return {
    output: parsed.structured_output,
    models: usage && typeof usage === 'object' ? Object.keys(usage) : [],
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
  };
}

export const spawnClaude: Runner = (args, stdin, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'ENOENT'
        ? new ClaudeCliError('Claude Code CLI not found on PATH. Install it and sign in (run `claude` once) to use suggest.' +
            // Node can only start .exe files without a shell, and the npm install provides claude.cmd
            (process.platform === 'win32' ? ' On Windows, use the native installer, which provides claude.exe.' : ''))
        : err));
    child.on('close', (code, signal) =>
      signal === 'SIGTERM' && !stdout
        ? reject(new ClaudeCliError(`claude timed out after ${Math.round(timeoutMs / 1000)}s`))
        : resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
