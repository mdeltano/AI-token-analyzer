# Sundance

Sundance finds wasted LLM tokens and suggests how to cut them. It runs locally: it reads the
logs your AI coding tools already write, normalizes them into one usage format, and stores
them in a local SQLite database. It can also read an organization's usage from the Anthropic
and OpenAI usage APIs. Apart from those optional requests, nothing leaves your machine.

## Supported sources

| id            | Tool               | Default log location                                   |
|---------------|--------------------|--------------------------------------------------------|
| `claude-code` | Claude Code        | `~/.claude/projects` (`CLAUDE_CONFIG_DIR`)             |
| `codex`       | OpenAI Codex CLI   | `~/.codex/sessions`, `archived_sessions` (`CODEX_HOME`)|
| `gemini-cli`  | Gemini CLI         | `~/.gemini/tmp/*/chats`                                |
| `qwen-code`   | Qwen Code          | `~/.qwen/projects/*/chats` (`QWEN_DATA_DIR`)           |
| `opencode`    | OpenCode           | `~/.local/share/opencode` (`OPENCODE_DATA_DIR`, `XDG_DATA_HOME`) |
| `amp`         | Amp                | `~/.local/share/amp/threads` (`AMP_DATA_DIR`)          |
| `copilot-cli` | GitHub Copilot CLI | `~/.copilot/session-state` (`COPILOT_HOME`)            |

Each tool counts tokens differently. For example, OpenAI and Gemini count cached tokens as
part of input, and Gemini reports reasoning separately from output. Sundance converts every
source to one convention, defined in `src/schema/usage-event.ts`:

- input excludes cache
- cache reads and writes are counted separately
- output includes reasoning

## Usage

Requires Node.js 23.6 or later. It runs TypeScript directly, with no build step.

```sh
npm install
node src/cli/main.ts sources            # which tools were found on this machine
node src/cli/main.ts import             # import everything (re-runs only read changed files)
node src/cli/main.ts summary --by model # or: source | vendor | project | day
node src/cli/main.ts summary --since 2026-10-01 --source codex
```

The database defaults to `~/.sundance/usage.db`. Override it with `--db` or `SUNDANCE_DB`.

## Provider usage APIs

`fetch` pulls an organization's daily usage from the providers' own usage APIs. It needs an admin
key, which is read-only for usage data, and the key is only sent to that provider.

| id              | API                                                   | Key variable          |
|-----------------|-------------------------------------------------------|-----------------------|
| `anthropic-api` | Anthropic Admin API, `/v1/organizations/usage_report/messages` | `ANTHROPIC_ADMIN_KEY` (`sk-ant-admin01-...`) |
| `openai-api`    | OpenAI Usage API, `/v1/organization/usage/completions` | `OPENAI_ADMIN_KEY`    |

```sh
ANTHROPIC_ADMIN_KEY=sk-ant-admin01-... node src/cli/main.ts fetch   # last 30 days, every key that is set
node src/cli/main.ts fetch --source openai-api --since 2026-09-01
node src/cli/main.ts summary --source anthropic-api --by model
```

Each stored row is one UTC day's totals for one model, project (Anthropic workspace or OpenAI
project) and API key, with service tier, so batch usage is priced at the batch discount. Only
complete days are fetched, and fetching a day again replaces what was stored for it. In
`summary`, these rows count as one call each; OpenAI's request count is kept in `meta.requests`.

Usage APIs report totals, not requests, so they show where tokens and money go (model mix,
cache hit rate, batch share) but give the request-level analyzers nothing to work with. Calls
made through the API by a coding tool can appear both in that tool's logs and in the usage API;
use `--source` to keep them apart.

## Finding waste

```sh
node src/cli/main.ts analyze                      # all stored usage
node src/cli/main.ts analyze --source claude-code --since 2026-10-01
```

`analyze` runs a set of rule-based analyzers. Each one reports the project and model affected,
the calls and tokens involved, what in the data shows the problem, a concrete fix, and an
estimate of what the fix would have saved over the analyzed period.

| Waste              | Detected from                                              | Savings estimate |
|--------------------|------------------------------------------------------------|------------------|
| `uncached-prefix`  | calls sharing a prompt prefix hash with almost no cache reads | prefix billed at cache-read rather than input price, minus cache writes after idle gaps |
| `oversized-model`  | a frontier or mid-tier model returning ~16 tokens or fewer per call, outside agent loops | the same tokens at the vendor's small model |
| `truncated-output` | calls stopped by `max_tokens` that were then sent again      | cost of the cut-off calls |
| `retry-storm`      | identical requests repeated within two minutes              | cost of every attempt after the first |
| `batch-eligible`   | scheduled jobs, or large sessions of independent calls       | the batch API's 50% discount |

Several analyzers need request-level fields (prefix hashes, stop reasons, request hashes)
that coding-tool logs only partly record, so a source can show no findings simply because the
evidence isn't there. Findings can overlap, so their savings don't always add up.

Dollar figures use the list prices in `src/pricing/prices.ts` (first-party API, standard tier).
Models missing from that table are reported in tokens only.

## Drafting fixes

`suggest` takes the largest findings and asks Claude to draft the concrete change for each one:
where to make it, the rewritten prompt, code or config, how to verify the saving, and caveats.
Savings figures stay the analyzer's own estimate; the model is not asked to produce them.

```sh
node src/cli/main.ts suggest                          # the 3 largest findings
node src/cli/main.ts suggest --finding 2 --context src/support-bot.ts
node src/cli/main.ts suggest --top 5 --model sonnet
```

Requests go through the Claude Code CLI (`claude -p`), so they run under whatever account it is
signed in with: a Claude subscription's usage limits, or the API key it is configured with
(including `ANTHROPIC_API_KEY` in the environment). Install Claude Code and run `claude` once to
sign in. Each request runs without tools, settings, `CLAUDE.md`, memory or MCP servers, so only
Sundance's prompt is sent.

The model sees the finding (project, model, call and token counts, evidence, recommendation) and,
with `--context`, the contents of that one file. Without a context file, Sundance stores only
hashes of prompts, so the draft names what to look for and gives a template rather than an edit.
Pass the file that holds the prompt or API call for a rewrite of the actual code; files over
200,000 characters are refused rather than cut.

## Synthetic workload

`generate` adds a reproducible workload for a fictional company (source `synthetic`). It has
healthy features and features with one known kind of waste each: an uncached repeated system
prompt, a frontier model doing single-label classification, outputs truncated by `max_tokens`,
retry storms, and a nightly job that could use the Batch API. The same seed and end date always
produce the same calls, so re-running it adds nothing.

```sh
node src/cli/main.ts generate --db demo.db --seed 42 --days 30 --manifest planted.json
node src/cli/main.ts summary --db demo.db --source synthetic --by project
node src/cli/main.ts analyze --db demo.db --source synthetic
```

`--manifest` writes the planted waste (calls and tokens affected per kind) as JSON. It is the
ground truth for the analyzers: the tests check that each one reports exactly the planted calls
and tokens, and nothing on the healthy features. Use a separate `--db` to keep synthetic data apart from
your own usage.

## Adding a source

Implement `SourceAdapter` (`src/adapters/types.ts`), with `defaultRoots`, `discover` and
`parse`, and register it in `src/adapters/index.ts`. Every event needs a `dedupeKey` that stays
the same when the file is parsed again, so re-imports never double-count.

## Development

```sh
npm test          # node:test: adapter and connector fixtures, synthetic workload, analyzers, suggest
npm run typecheck
```
