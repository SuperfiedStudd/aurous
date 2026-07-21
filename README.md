# Aurous

**Aurous turns project context into a reviewed, ready-to-use productivity workspace—without asking you to learn each tool’s setup.**

[Read the public Aurous guide](https://aurous-guide.superfiedstudd.chatgpt.site/) · [Judge quickstart](docs/JUDGE_GUIDE.md) · [Architecture](ARCHITECTURE.md)

## The problem

Starting a project workspace is slow and error-prone. You have to decide how to structure work, find the right destination, and manually create pages, issues, fields, or cards—often while copying IDs and hoping you do not create duplicates.

Aurous is a local-first CLI that makes that process deliberate. It uses your project context and an existing local AI agent to prepare the workspace, while keeping every write visible and under your control.

## How Aurous works

For the persistent `aurous` command, install the package once from this repository:

```bash
npm install
npm run build
npm link
```

Start with the interactive shell:

```bash
aurous
# During development:
npm run dev -- shell
```

Then choose an agent and destination, provide context, and describe the outcome in plain language. Aurous follows one explicit path:

```text
project context → inspect workspace → plan → preview → approve → apply → safe rerun
```

1. **Project context** — Aurous reads only the paths you choose and makes a bounded Context Pack.
2. **Inspect workspace** — it uses the connected integration read-only to find a safe destination.
3. **Plan** — your local Codex or Claude Code creates a validated, saved plan.
4. **Preview** — every intended write is shown before anything changes.
5. **Approve** — you type the approval phrase yourself.
6. **Apply** — Aurous executes only the saved plan.
7. **Safe rerun** — exact compatible objects are reused or skipped; ambiguous matches stop instead of guessing.

## Supported integrations

The validated integrations are:

- **Notion** — pages, databases, properties, relations, statuses, and views.
- **Linear** — projects, milestones, issues, labels, priorities, and relationships.
- **Airtable** — bases, tables, fields, records, and typed record relationships when supported by the connected MCP.
- **Trello** — boards, lists, cards, checklists, and approved card updates.

Use either a locally authenticated **Codex CLI** or **Claude Code CLI**. Aurous uses that existing local authentication; it does not collect, copy, or store AI or integration credentials.

## 60-second local demo

This mock run needs no external account, MCP connection, or credentials. From the Aurous repository:

```bash
npm install
npm run build
npm run dev -- init --agent mock --tool notion
npm run dev -- plan --agent mock --tool notion --context . --prompt "Create a workspace that helps me manage this project"
npm run dev -- runs
```

Copy the run ID printed by `plan`, then apply the previewed plan:

```bash
npm run dev -- apply <run-id> --yes
```

The result is saved locally under `.aurous/runs/`. For a fuller judge path, see [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md).

## Live integration setup

For a live run, install and authenticate Codex CLI or Claude Code CLI, then configure the productivity tool’s MCP connection in that local agent. Aurous checks readiness before it plans:

```bash
aurous doctor --agent codex --verbose
# or
aurous doctor --agent claude --verbose
```

When the doctor check is ready, open `aurous` and select your agent, target, and context. A scripted live plan uses the same explicit arguments:

```bash
aurous plan --agent codex --tool linear --context . --prompt "Set up a workspace for this project"
```

Do not add workspace, page, team, board, record, or token IDs during normal onboarding. Aurous resolves one safe destination or presents friendly choices. The public guide explains the flow without exposing credentials.

## Safety and approval model

- **Inspect before writing:** destination discovery is read-only.
- **Typed approval:** every saved plan is previewed; writes wait for explicit confirmation.
- **Exact-ID binding:** existing objects are verified by their external IDs, never names alone.
- **Duplicate prevention:** compatible exact matches are reused or skipped on rerun.
- **Safe failure:** ambiguous, incompatible, or unverified matches stop visibly rather than expanding scope.
- **Auditable results:** plans, previews, results, and redacted diagnostics are preserved locally in the run artifacts.

## How Codex and GPT-5.6 were used

Codex accelerated Aurous from planning through packaging: it helped plan the CLI flow, implement adapters and safety boundaries, debug edge cases, analyze exact-ID behavior, and validate integrations. GPT-5.6 was used through the local agent workflow for structured planning and implementation assistance, debugging, safety analysis, and integration validation. Aurous still requires a human-reviewed plan and explicit approval before external writes.

## Testing and validated results

Run the current automated suite with:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The final packaging check passed **241 automated tests**. Live smoke validation has exercised Notion, Linear, Airtable, and Trello, including rerun behavior. The external smoke harness and preserved artifacts are described in [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md).

## Supported platforms

- macOS and Windows with Node.js 20+ and npm 10+.
- A locally installed Codex CLI or Claude Code CLI for live runs.
- Any of the four validated MCP-connected integrations listed above.

## Architecture links

- [Architecture](ARCHITECTURE.md) — boundaries, plan/apply contracts, and integration model.
- [Judge guide](docs/JUDGE_GUIDE.md) — fastest mock evaluation and optional live smoke path.
- [Development guide](docs/DEVELOPMENT.md) — contributor commands and implementation notes.
- [Known issues](docs/KNOWN_ISSUES.md) — current constraints and operational caveats.
