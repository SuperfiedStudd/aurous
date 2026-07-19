# Aurous

Productivity, resolved. Aurous is a local-first CLI that turns explicitly approved project context and a plain-language objective into a previewable, auditable Notion or Linear workspace plan. After approval, it asks your already-authenticated Codex or Claude Code installation to execute that exact plan through its configured MCP.

No AI, Notion, or Linear credentials are requested, copied, or stored by Aurous.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- For live runs: a locally authenticated Codex CLI or Claude Code CLI with the official Notion or Linear MCP configured

Mock mode needs no external authentication and exercises the complete workflow.

## Interactive shell

Launch the persistent Aurous experience with either command:

```bash
aurous
# During development:
npm run dev -- shell
```

The shell keeps one live gold Aurous surface with the active agent/model, target, project, selected context, preset, team, state, and latest run. On compatible terminals it redraws that surface in place while committing only plans, previews, results, and real failures to normal scrollback. `NO_COLOR`, redirected output, and limited terminals use a clean append-only fallback. The readline composer supports normal terminal editing, duplicate-free Up/Down command history, Home/End navigation, context-aware Ctrl+C, and graceful EOF/exit behavior.

Start with configuration commands when needed, then ask naturally:

```text
/agent codex
/model gpt-5.6
/target linear JasjyotSingh
/context demo/linear-build-week.json
Set up Linear for this project using my current context
```

A natural-language request selects an explicitly named Notion or Linear target, generates and saves the existing Aurous plan, prints the complete preview, requires the same typed `apply` approval, executes through the existing adapter, records the result, and returns to the composer. The shell starts with the current project (`.`) visible as its context; use `/context` before planning to narrow or replace it.

`/target linear <team>` selects the destination immediately. `/target linear` intentionally leaves the team missing; the next Linear request asks for it, reprompts on blank input, accepts `cancel`, and resumes the suspended request automatically after a valid name, key, or UUID is entered.

Available slash commands are `/help`, `/agent`, `/model`, `/target`, `/context`, `/preset`, `/plan`, `/apply`, `/runs`, `/status`, `/clear`, and `/exit`. Run `/help` inside the shell for accepted arguments.

## Install

```bash
npm install
npm run build
npm link
```

During development, replace `aurous` with `npm run dev --`.

## Five-minute demo

```bash
aurous init
aurous doctor
aurous plan \
  --agent mock \
  --tool notion \
  --context . \
  --prompt "Create a workspace that helps me manage this project"
aurous runs
aurous apply <run-id> --yes
aurous diagnose <run-id>
```

`plan` prints the context summary before any live agent is invoked. `apply` reloads the saved plan, previews its exact actions, and requires confirmation (`--yes` is an explicit confirmation for automation).

## Linear Build Week demo

The polished Linear path uses a small structured launch preset and runs context loading, deterministic planning, full preview, approval, official Linear MCP execution, and the completion summary in one command:

```bash
npm run dev -- linear-demo \
  --agent codex \
  --team JasjyotSingh \
  --context demo/linear-build-week.json
```

Type `apply` only after reviewing every project, label, milestone, and issue property. For a rehearsed noninteractive run, `--yes` is the explicit approval. Exact-name checks are limited to approved targets so repeated runs skip compatible existing objects instead of duplicating them where practical. The saved result distinguishes created objects, skipped actions, compatibility notes, warnings, and failures, and prints returned Linear IDs and URLs.

If an apply ends `partial` after recording external object IDs, generate a separate read-only recovery plan before attempting more writes:

```bash
aurous recover <partial-run-id>
# Review the exact-ID classifications and any compatibility decisions.
aurous recover <recovery-run-id> --apply
# Type the displayed "recover <recovery-run-id>" phrase after the second preview.
```

Recovery has no `--yes` bypass. It fetches only persisted external IDs, never searches or reuses by name, converts unsupported custom Notion Status definitions to explicit Select options when the inspected MCP supports them, verifies live state again after approval, and checkpoints each successful action before continuing.

## Commands

| Command                                | Purpose                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `aurous` or `aurous shell`             | Open the persistent interactive shell                                  |
| `aurous init`                          | Create local `.aurous/config.json` state without credentials           |
| `aurous doctor [--verbose]`            | Check runtime, agent installations, auth, and MCP readiness            |
| `aurous plan ...`                      | Read only the provided context paths and create a validated saved plan |
| `aurous apply <run-id> [--yes]`        | Approve and execute exactly one saved plan                             |
| `aurous linear-demo ...`               | Run the context-to-Linear demo with one preview and approval flow      |
| `aurous recover <run-id> [--apply]`    | Reconcile a partial run read-only or approve its saved recovery plan   |
| `aurous runs`                          | List local runs and statuses                                           |
| `aurous diagnose <run-id> [--verbose]` | Print a redacted, shareable diagnostic report                          |

Use `aurous <command> --help` for all options. Runs and copied context are local to `.aurous/runs/`, which is gitignored.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Safety model

- Context is opt-in per path; symlinks, secrets, `.git`, dependencies, build output, and large/binary files are skipped.
- Planning cannot write to Notion or Linear and live agents receive an explicit no-tool planning instruction.
- Applying uses the saved plan as an allowlist. The execution prompt forbids scope expansion.
- Recovery reuses only exact persisted external IDs, has no automatic deletion, requires a fresh typed approval, and stops after the first partial or ambiguous action.
- Logs and errors are redacted before persistence and include stable `AUR-*` codes.
- Missing optional tools never prevent mock mode or unrelated adapters from working.

## License

No license has been selected yet.
