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

## Adding a source

Implement `SourceAdapter` (`src/adapters/types.ts`), with `defaultRoots`, `discover` and
`parse`, and register it in `src/adapters/index.ts`. Every event needs a `dedupeKey` that stays
the same when the file is parsed again, so re-imports never double-count.

## Development

```sh
npm test          # node:test, fixture-based adapter tests
npm run typecheck
```
