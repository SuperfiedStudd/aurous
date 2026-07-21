# Aurous judge guide

[Public guide](https://aurous-guide.superfiedstudd.chatgpt.site/) · [GitHub repository](https://github.com/SuperfiedStudd/aurous)

## Fastest no-auth demonstration

The mock agent exercises the same context → plan → preview → apply lifecycle without connecting to a real workspace.

```bash
npm install
npm run build
npm run dev -- init --agent mock --tool notion
npm run dev -- plan --agent mock --tool notion --context . --prompt "Create a workspace that helps me manage this project"
npm run dev -- runs
npm run dev -- apply <run-id> --yes
```

Replace `<run-id>` with the ID printed by `plan` or listed by `runs`.

**Expected output:** a saved, validated plan; a complete preview before apply; an explicit confirmation boundary; and local run artifacts under `.aurous/runs/`. No credentials or external writes are involved.

## Optional live integration demonstration

Use this only with an already authenticated Codex CLI or Claude Code CLI and an MCP connection you control:

```bash
aurous doctor --agent codex --verbose
aurous plan --agent codex --tool linear --context . --prompt "Set up a workspace for this project"
```

Review the generated plan. Aurous waits for typed approval before it applies writes. Repeat the same intent to observe exact-ID reuse or a safe skip; an ambiguous match stops visibly.

Validated integrations: **Notion, Linear, Airtable, and Trello**. Aurous uses existing local agent and MCP authentication; it never asks for integration credentials.

## Live smoke harness

The separate `aurous-smoke-test` harness preserves live-run artifacts for the four integrations. It requires an intentionally configured local environment and confirmation before remote writes:

```bash
cd aurous-smoke-test
python3 run_smoke.py --integration airtable
# optional live run; prompts for RUN LIVE SMOKE
python3 run_smoke.py --live --integration airtable
```

## Supported platforms

- macOS and Windows
- Node.js 20+ and npm 10+
- Codex CLI or Claude Code CLI for live runs

## Known limitations

- Integration connectivity depends on the user’s locally configured MCP tools and workspace permissions.
- The mock demonstration is the quickest way to evaluate behavior without external setup.
- Aurous does not manage credentials or make external writes without an approved saved plan.

## Video

Demo video: https://youtu.be/PQ555x5A6LM
