# Check catalogue

Agents writing plans or using the orchestrator: start with `docs/agents/README.md` (guide and JSON schemas).

`checks.json` defines deterministic acceptance commands for this repository. An orchestrator can name an entry, such as `build`, or its exact `run` command. The board resolves names before running them. Add a check only when its command exists and tests the requested outcome.

An example entry is `"build": { "run": "npm run build", "what": "Compile the TypeScript" }`. The optional `minutes` field is an estimate, not a measured run budget.

For a repository without this file, `board.js plan` creates `workflows/checks.json` containing `{}`. That permits tasks without checks and rejects every supplied check until entries are added. A malformed or unreadable file is an error; it never silently removes the catalogue restriction. Ordinary cards in repositories with no catalogue retain their existing behavior.

## Providers for plan steps and helpers

A plan file's `account` (top level, per step, or the `reviewer`'s) may name any signed-in Claude, Codex, Grok or Antigravity account, for example `"Grok · Work"`, `"Antigravity · Shared"`, or just `"grok"` when there is one Grok account. Every step runs headless and settles the same way on all four. Claude and Codex steps take the board's model and effort lists. Grok and Antigravity have no fixed model list: a step's `model` and `effort` must be ids the account last advertised (`board.js models` shows them, labelled as last seen); before the account has advertised any, the value is kept and checked when the step's session opens, and an unknown one fails that step with a clear message. Their `permission` is `ask` or `bypass`; a plan that names none gives every step `bypass`, as the preview says.

The text helpers (automatic titles, completion rules, Refine and Improve) also run on any of the four providers. On Grok and Antigravity a helper is one headless prompt with no tools, on the account's chosen model and effort or the agent's own default.

Build the Windows wrapper with `npm run build:wrapper` before the Windows test suite. Linux uses the JavaScript wrapper and does not run that Windows-only command. A passing build or test suite is local evidence; runtime acceptance in VS Code and VSCodium is separate.

## Public resource namespace

`external-worker` is the public distribution resource key for a single exclusive worker slot. It retains single-job exclusion, admission expiry, authorized scope hashing and held-step behavior. `cloud` and `vm` still have zero capacity. These examples do not authorize access to remote infrastructure.

This is a distribution namespace change. Existing private claim/attempt files cannot be imported unchanged or treated as compatible. Before migrating, stop dispatch and reconcile active claims, attempts, receipts and authorized scopes explicitly; update the resource references together and re-review any scope whose inputs change. There is no silent alias or automatic migration. Preserve `ORCHESTRATION.md` as the project plan protocol.

## Saved workflow resources

An unknown resource in a loaded workflow step, saved attempt or claim blocks workflow dispatch and continuation until the records are reconciled. Matching an old claim does not authorize a retired name or an accepted result. Records remain available for inspection. Reconcile their resource names explicitly before resuming. Recording a held or failed result still releases that attempt’s claims.

Before running a phase or updating an admission, the runner reads the dispatching board’s current `.entomatical/tasks.json` under the attempt’s phase lock. Each new board attempt records its board folder. Older attempts use the card ID and attempt ID to find a unique saved task across Git worktrees. A missing or ambiguous owning task requires reconciliation. Standalone attempts without a board record continue to use their saved resources and claims.
