# Contributing

## Workflow

1. Update local `main` and create a focused branch: `feat/<name>`, `fix/<name>`, `docs/<name>`, or `chore/<name>`.
2. Keep commits small and use imperative Conventional Commit messages such as `feat: add run diagnostics`.
3. Run `npm run check` before pushing.
4. Open a pull request against `main`, complete the template, and request review from the other collaborator.
5. Prefer squash merge after CI and review pass. Do not force-push shared branches without coordinating first.

## Local setup

```bash
npm install
npm run build
npm run dev -- doctor --verbose
```

Use mock mode for deterministic development:

```bash
npm run dev -- init --agent mock --tool notion
npm run dev -- plan --agent mock --tool notion --context . --prompt "Build a project command center"
npm run dev -- apply <run-id> --yes
```

## Change expectations

- Add or update tests for behavior changes.
- Preserve the `AgentAdapter`, `ProductivityAdapter`, and `RunStore` boundaries.
- Never commit `.aurous/`, user context, logs, MCP configuration, credentials, or `.env` files.
- Inspect an installed external CLI's help before changing invocation flags.
- Keep planning free of external writes and applying bound to saved action IDs.
- Document new stable error codes and user recovery steps.

## Review checklist

- Does context access stay inside explicit paths without following symlinks?
- Can the behavior be tested with no external auth?
- Are stdout, stderr, metadata, and errors redacted before persistence?
- Is any external mutation previewed and explicitly confirmed?
- Are partial outcomes and manual fallbacks visible?
