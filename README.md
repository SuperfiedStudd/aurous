# Aurous

Productivity, resolved. Aurous is a local-first CLI that turns explicitly approved project context and a plain-language objective into a previewable, auditable Notion or Linear workspace plan. After approval, it asks your already-authenticated Codex or Claude Code installation to execute that exact plan through its configured MCP.

No AI, Notion, or Linear credentials are requested, copied, or stored by Aurous.

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- For live runs: a locally authenticated Codex CLI or Claude Code CLI with the official Notion or Linear MCP configured

Mock mode needs no external authentication and exercises the complete workflow.

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

## Commands

| Command                                | Purpose                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `aurous init`                          | Create local `.aurous/config.json` state without credentials           |
| `aurous doctor [--verbose]`            | Check runtime, agent installations, auth, and MCP readiness            |
| `aurous plan ...`                      | Read only the provided context paths and create a validated saved plan |
| `aurous apply <run-id> [--yes]`        | Approve and execute exactly one saved plan                             |
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
- Logs and errors are redacted before persistence and include stable `AUR-*` codes.
- Missing optional tools never prevent mock mode or unrelated adapters from working.

## License

No license has been selected yet.
