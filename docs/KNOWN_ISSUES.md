# Known issues

## Local environment observed during foundation work

- Codex CLI 0.144.1 is installed and authenticated with ChatGPT, but neither Notion nor Linear is currently listed in `codex mcp list`. Live apply correctly stops with `AUR-MCP-001`; mock mode remains fully usable.
- Claude Code is not installed in the observed development environment. Its adapter gates noninteractive use on flags found in the installed help and emits a paste-ready prompt when unavailable, but a live Claude invocation has not yet been exercised here.
- GitHub CLI reported an invalid stored token even though Git HTTPS push credentials worked. Re-authenticate with `gh auth login -h github.com` before attempting to create a pull request through `gh`.

## Product limitations

- MCP list output is human-oriented. Readiness detection is intentionally conservative and may require updates if agent output changes.
- Planning relies on agent compliance with the structured schema. Invalid output fails visibly with `AUR-AGENT-005`; there is no automatic repair loop yet.
- The local state store does not yet use a cross-process lock. A run marked `applying` blocks a second apply, but two processes started at nearly the same instant can race.
- The execution result can prove that reported action IDs stayed in scope, but it cannot independently audit an MCP that performed an unreported side effect. Users should review the target tool and diagnostic result.
- Existing Notion/Linear object discovery is deliberately omitted during planning to guarantee no tool calls. Name collisions are surfaced during apply rather than silently resolved by scope expansion.
- Context selection uses safe file-type heuristics and size budgets; unsupported but useful file types may be skipped and shown in the preview.
