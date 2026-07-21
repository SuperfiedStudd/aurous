# Aurous — Productivity Resolved

**Aurous is a developer tool for building safe agentic workflows across productivity platforms.** It turns repository, project, and personal context into a structured, human-reviewed Notion, Linear, Airtable, or Trello workspace—without asking people to learn each platform's setup or hand-copy opaque IDs.

**Demo:** [watch Aurous in action](https://youtu.be/PQ555x5A6LM) · [Public product guide](https://aurous-guide.superfiedstudd.chatgpt.site/) · [Judge guide](docs/JUDGE_GUIDE.md)

## For judges

- [Demo video](https://youtu.be/PQ555x5A6LM)
- [Judge quickstart and mock demo](docs/JUDGE_GUIDE.md)
- [Installation](#installation)
- [Testing and verification](#testing-and-verification)

## The problem and solution

Creating a useful project workspace is usually slow, manual, and fragile: teams translate context into pages, issues, records, and cards while guessing at destinations and risking duplicate work. Aurous packages only approved local context, uses an already-authenticated local agent to propose a validated plan, and executes only after a human reviews and approves the exact actions. It is an orchestration CLI with durable local run artifacts—not a generic AI wrapper, credential broker, or direct productivity API client.

## What Aurous supports

| Category | Supported |
| --- | --- |
| Productivity platforms | **Notion**, **Linear**, **Airtable**, **Trello** |
| Local agents | **Codex**, **Claude Code** |
| Safe evaluation | Built-in mock agent; no credentials, MCP connection, or external writes |

Validated platform capabilities include Notion pages, databases, properties, relations, statuses, and views; Linear projects, milestones, issues, labels, priorities, and relationships; Airtable bases, tables, fields, records, and supported typed relationships; and Trello boards, lists, cards, checklists, and approved updates.

## Core workflow

```text
context → plan → preview → approval → execution → structured results
```

1. **Context:** select bounded repository, project, or personal context.
2. **Plan:** a local Codex or Claude Code agent returns a typed, validated plan.
3. **Preview:** inspect every intended action before any external write.
4. **Approval:** provide the explicit approval phrase yourself.
5. **Execution:** Aurous allows only the saved, approved action IDs.
6. **Structured results:** persist redacted diagnostics, exact external IDs, results, and recovery evidence locally under `.aurous/runs/`.

## Architecture overview

Aurous separates safety-critical responsibilities:

- **Context layer** creates a bounded, user-approved Context Pack and preset state without collecting credentials.
- **Agent adapters** invoke the existing local Codex or Claude Code CLI and validate structured output.
- **Productivity adapters** supply platform-specific discovery, destination, exact-ID, and execution rules.
- **Service and run-store layers** persist immutable plans, approval boundaries, action results, diagnostics, and recovery checkpoints.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries, state transitions, recovery guarantees, and security invariants.

## Installation

Requires Node.js 20+ and npm. For live runs, install and authenticate either Codex CLI or Claude Code CLI, then configure the relevant productivity platform through that agent's MCP connection.

```bash
git clone https://github.com/SuperfiedStudd/aurous.git
cd aurous
npm install
npm run build
npm link
```

Start the persistent shell with `aurous`, or run it during development with:

```bash
npm run dev -- shell
```

## Quick start: no-auth mock demo

This complete workflow requires no external account or credentials:

```bash
npm install
npm run build
npm run dev -- init --agent mock --tool notion
npm run dev -- plan --agent mock --tool notion --context . --prompt "Create a workspace that helps me manage this project"
npm run dev -- runs
# Copy the run ID printed by plan, then:
npm run dev -- apply <run-id> --yes
```

The mock run saves a validated plan, preview, result, and redacted diagnostics under `.aurous/runs/`.

## Real integration demo

With an authenticated local agent and configured MCP connection, first verify readiness:

```bash
aurous doctor --agent codex --verbose
# or
aurous doctor --agent claude --verbose
```

Then create a plan against a real platform. Review the generated plan and provide typed approval before applying it:

```bash
aurous plan --agent codex --tool linear --context . --prompt "Set up a workspace for this project"
```

The same flow works with Notion, Airtable, and Trello by selecting the corresponding supported tool. Aurous resolves a safe destination or presents a choice; normal onboarding does not require users to supply workspace, page, team, board, record, or token IDs.

## Safety and rerun behavior

- **Read before write:** destination discovery is read-only.
- **Explicit approval:** saved plans are previewed and require a typed confirmation.
- **Exact-ID tracking:** existing objects are verified by external ID rather than name alone.
- **Rerun safety:** compatible exact matches are reused or skipped; ambiguity, incompatibility, or unverified state stops visibly.
- **Recovery:** partial runs are inspected by exact ID before any separately approved recovery action.
- **Local evidence:** immutable plans, results, checkpoints, and redacted diagnostics make every run auditable.

## How Codex and GPT-5.6 were used

Codex and GPT-5.6 were used as development collaborators throughout Aurous—not as independent builders or decision makers. They helped design and implement the TypeScript CLI, the interactive shell and visual interface, the context and preset layer, and the Notion, Linear, Airtable, and Trello adapters. They were also used to debug integration and state-management failures; expand automated tests; run iterative test, diagnose, fix, and retest loops; improve exact-ID tracking, rerun safety, validation, recovery, and diagnostics; and build the supporting website and documentation.

The project retains human-controlled architecture, review, and approval boundaries. It currently passes ESLint, TypeScript checks, **322 automated tests**, and the production build.

## Testing and verification

Run the complete verified suite:

```bash
npm run check
```

This runs ESLint, TypeScript type checking, Vitest, and the production TypeScript build. The project currently has 322 passing automated tests.

## Current limitations

- Live integrations depend on the user's locally configured MCP tools, agent authentication, and workspace permissions.
- Agent planning relies on structured-schema compliance; invalid output fails visibly rather than being automatically repaired.
- The local state store has no cross-process lock, so near-simultaneous applies can race.
- A remote write that succeeds before its external ID is returned is treated as ambiguous and requires a fresh read-only inspection; Aurous will not replay it automatically.

For the full operational caveats, see [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

## License

Released under the [MIT License](LICENSE).
