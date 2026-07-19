# Development guide

## Setup

Use Node.js 20 or newer and npm:

```bash
npm install
npm run check
```

The package is ESM TypeScript. `npm run dev -- <command>` runs source through `tsx`; `npm run build` emits `dist/` and the `aurous` binary entry.

## Useful commands

| Command                 | Purpose                           |
| ----------------------- | --------------------------------- |
| `npm run dev -- --help` | Run the development CLI           |
| `npm run format:check`  | Check Prettier formatting         |
| `npm run lint`          | Run type-aware ESLint             |
| `npm run typecheck`     | Check TypeScript without emitting |
| `npm test`              | Run Vitest once                   |
| `npm run build`         | Produce `dist/`                   |
| `npm run check`         | Run lint, types, tests, and build |

## Adapter development

Agent adapters must implement detection, readiness, plan generation, execution, manual fallback, timeout/cancellation, and structured capture. Never assume flags: inspect `<agent> --help` during diagnostics or invocation and gate optional behavior on the advertised output.

Productivity adapters should express the target tool's native model. Notion actions should describe pages, databases, properties, relations, statuses, and views. Linear actions should describe projects, milestones/cycles, issues, labels, and priorities.

Every optional external path needs a mock equivalent or a failure that leaves the rest of the CLI usable.

## Testing

Tests use temporary directories and the built-in mock agent. They must not rely on GitHub, installed agent authentication, or a live MCP. For a manual smoke test:

```bash
workdir="$(mktemp -d)"
cd "$workdir"
printf '# Demo\n' > README.md
node /path/to/aurous/dist/index.js init --agent mock --tool notion
node /path/to/aurous/dist/index.js plan --context . --prompt "Manage this demo"
node /path/to/aurous/dist/index.js runs
```

Copy the emitted run ID into `apply <run-id> --yes` and `diagnose <run-id> --verbose`.

## Adding an error

Use `AurousError` with a stable `AUR-CATEGORY-NNN` code, plain summary, probable cause, and executable next action. Persist classified failures to the run when a run ID exists. Avoid placing secrets in the error before redaction.
