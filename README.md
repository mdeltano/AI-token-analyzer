# Sundance

Sundance finds wasted LLM tokens and suggests how to cut them. It runs locally: it reads the
logs your AI coding tools already write, normalizes them into one usage format, and stores
them in a local SQLite database. Nothing leaves your machine.

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
npm test          # node:test: adapter fixtures, synthetic workload, analyzers
npm run typecheck
```
