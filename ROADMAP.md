# Roadmap

## Milestone 1 — CLI foundation

- [x] Local init, doctor, plan, apply, runs, and diagnose commands
- [x] Validated plan/result contracts and gitignored run storage
- [x] Guarded explicit-path context ingestion and preview
- [x] Codex and Claude Code adapter architecture with runtime flag inspection
- [x] Notion- and Linear-native instructions
- [x] Complete mock planning/apply flow
- [x] Redacted diagnostics, stable errors, timeouts, cancellation, and partial results
- [x] CI, tests, documentation, and collaboration templates

## Milestone 1 follow-ups

- Exercise live Notion and Linear MCPs in isolated test workspaces
- Add adapter contract fixtures captured from supported Codex and Claude Code versions
- [x] Add exact-ID, checkpointed interrupted-run recovery with a separate approval boundary
- Add an explicit cross-process stale-apply lock
- Improve duplicate/name-collision handling without expanding approved scope
- Add configurable context budgets with previewed estimates

## Later milestones

- Optional shared-state implementation behind `RunStore` (without making Supabase a core runtime dependency)
- Reconciliation and safe updates to previously created workspace objects
- Team policy packs and reusable workspace recipes
- Additional productivity tools through isolated adapters

Not planned for the current milestone: frontend UI, direct productivity API tokens, Google authentication, or Vercel deployment.
