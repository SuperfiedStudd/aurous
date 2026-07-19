# Aurous architecture

## Purpose and boundary

Aurous is an orchestration CLI, not a credential broker and not a productivity API client. It packages only user-approved local context, asks an existing local AI CLI to return a validated plan, persists that plan locally, and later asks the same agent to carry out the exact approved actions through its already-configured official MCP.

```text
explicit paths -> guarded context ingestion -> context preview
                                               |
                                               v
                                       local agent adapter
                                               |
                                       validated AurousPlan
                                               |
                                     local .aurous/runs state
                                               |
                                  preview + explicit confirmation
                                               |
                                               v
                            agent -> official Notion/Linear MCP
```

## Modules

- `src/cli.ts` defines the seven user commands and terminal confirmation.
- `src/core/context.ts` is the path allowlist and context budget boundary.
- `src/domain/schemas.ts` and `src/domain/recovery.ts` define versioned Zod contracts for plans, results, runs, diagnostics, exact-ID inspection, recovery classifications, and checkpoints.
- `src/core/services.ts` owns plan/apply/recovery state transitions and scope validation.
- `src/core/run-store.ts` implements the `RunStore` interface with atomic, permission-restricted local JSON files. A future shared-state implementation can satisfy this interface without changing command orchestration.
- `src/adapters/agents/` contains the shared `AgentAdapter` contract and Codex, Claude Code, and mock implementations.
- `src/adapters/productivity/` keeps Notion- and Linear-native planning/execution guidance separate.

## State model

Each run lives under `.aurous/runs/<run-id>/`:

```text
run.json                    lifecycle metadata
context.json                approved summary and selected content
plan.json                   immutable validated plan
result.json                 apply outcome, object references, warnings, failures
recovery-plan.json          exact-ID classifications and separately approvable actions
recovery-checkpoints.jsonl  append-only external IDs from inspection and each action result
events.jsonl                redacted timestamped diagnostic events
logs/*.json                 redacted stdout/stderr captures
*-response-schema.json      structured local-agent response contract
*-manual-prompt.txt         paste-ready fallback when automation is unavailable
```

`.aurous/` is gitignored. Writes use restrictive file modes and JSON files are replaced atomically.

## Plan and apply contracts

Planning sends an embedded copy of selected context to the chosen local agent. It instructs the agent not to call tools or MCPs; Codex runs with a read-only sandbox and Claude Code disables tools when its inspected help advertises that flag. The returned proposal must pass both the Zod shape and semantic checks for sequential IDs, valid dependencies, and disclosed destructive actions.

Codex transport schemas use the strict Structured Outputs subset: every object is closed, every declared key is required, and application-optional values are nullable. Boundary Zod schemas remove those nulls before persistence. Planned action configuration is transported as a strict list of unique string `{key, value}` entries; namespaced keys and JSON-encoded list values preserve Notion and Linear detail without an unsupported free-form object.

Apply loads `plan.json`; it never regenerates the plan. Approved action IDs are an allowlist. The result is rejected if it references any unknown action ID. Adapter prompts prohibit discovery and scope expansion, and failures become a saved `result.json` plus stable `AUR-*` events.

## Partial-run recovery contract

`recover <partial-run-id>` is read-only. It requires a persisted partial or failed result with external IDs, fetches only those exact IDs, and classifies every original action as completed, partially completed, pending, blocked, or drifted. Same-name discovery is forbidden. Verified completed work is skipped; a partially created page or database becomes an update against its persisted external ID. Attempted work without an ID is blocked because replay could duplicate an object.

Recovery capability decisions are saved as part of a separate immutable approval boundary. In particular, when the Notion MCP cannot define custom Status options but can define explicit Select options, the recovery plan rewrites approved Status schemas to Select and discloses the loss of Status groups and Status-specific semantics. Existing filtered views are blocked when the inspected MCP cannot repair their filters. Recovery never schedules deletion.

View-filter verification uses a typed `none` / `configured` / `unknown` state. Configured filters carry an exact condition count and deterministic structural fingerprint; explanatory prose is excluded. Legacy prose is converted only at the inspection parsing boundary. Identical unknown states remain unchanged with a persisted warning; mixed or structurally changed unknown states block writes.

`recover <recovery-run-id> --apply` prints the complete saved recovery plan and requires the exact typed phrase shown by the CLI; there is no noninteractive confirmation flag. After confirmation, Aurous performs another read-only exact-ID inspection and rejects any drift before writing. Execution uses one agent invocation per action. Each returned external ID is appended to `recovery-checkpoints.jsonl` before the next action, the cumulative result is replaced after each action, and any partial, cancelled, invalid, or ambiguous result stops subsequent work. A recovery execution plan is also persisted so a safely checkpointed partial recovery can itself be reconciled without replaying completed actions.

Codex recovery inspection and pre-write verification keep a read-only filesystem sandbox. Once Aurous has received its typed approval, each isolated one-action recovery subprocess sets only the selected MCP server's tool approval mode to `approve` for that invocation. This prevents a second invisible MCP approval prompt in noninteractive `codex exec`; the no-deletion recovery contract, saved plan, single-action prompt, exact-ID verification, and checkpoint validation remain the authorization boundary. Existing update targets may be checkpointed as identity evidence but are never counted as newly created objects.

No local checkpoint can make an external MCP write transactional. If the agent process exits after a remote write but before returning the ID, Aurous marks the attempt partial and ambiguous, refuses to replay that recovery run, and requires fresh exact-state inspection.

## Adapter matrix

| Agent       | Notion    | Linear    | Noninteractive strategy                               |
| ----------- | --------- | --------- | ----------------------------------------------------- |
| Codex       | Supported | Supported | `codex exec` flags verified from installed help       |
| Claude Code | Supported | Supported | `--print`/`--output-format` used only when advertised |
| Mock        | Simulated | Simulated | Built in, no auth or external writes                  |

The productivity adapter supplies tool-native structure while the agent adapter supplies process invocation, readiness, timeout, cancellation, stdout/stderr capture, and fallbacks.

## Error model

Errors carry a stable code, severity, summary, probable cause, and next action. Categories currently include `AUR-CTX`, `AUR-STATE`, `AUR-PLAN`, `AUR-AGENT`, `AUR-MCP`, `AUR-APPLY`, `AUR-RECOVERY`, `AUR-TOOL`, and `AUR-CORE`. Diagnostics are safe to paste back into Codex after redaction, but users should still review output before sharing it.

## Security invariants

- No AI subscription, Notion, or Linear credential is read or stored.
- No implicit path scanning: every context root comes from `--context`.
- Symlinks are skipped; `.git`, `.aurous`, dependencies, build outputs, secret-like filenames, env files, large files, and known binary formats are excluded.
- Context has per-file, total-byte, and file-count budgets.
- Prompts are passed over stdin, not command-line arguments.
- Optional adapter failure cannot break mock mode or other adapters.
