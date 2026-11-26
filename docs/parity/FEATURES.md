# Entomatical feature and UI contract

The `windows` and `linux` sides use one source tree. Status tokens and commit identifiers below are inherited historical records; they are not fresh native acceptance of this public distribution. Historical evidence and private environment descriptions are excluded. Local string checks cannot establish behavior, provider or native editor acceptance.

## Rules

1. Keep every feature ID and its registered UI text with the implementation. A new platform check needs its own evidence; do not promote inherited status based on a build or string check.
2. Each `ui:` string has exactly one feature owner. Shared labels stay with their first owner.
3. `only-windows:` and `only-linux:` record side-specific text. The checker rejects such a difference when both sides are `done`; leave an unverified counterpart `todo`.
4. `same-text:` lists the canonical owned string first and equivalent constructed forms afterward.
5. Status starts with `done`, `todo` or `n/a`. Preserve inherited tokens and commit identifiers; fresh acceptance must state the exercised platform and evidence.
6. Features without visible text require behavioral checks. Merge conflict markers and duplicate status lines are errors. `ignore:` under `Not UI` lists strings deliberately outside visible UI ownership.

## How to check

```sh
npm run parity
node tools/parity.js --side windows
node tools/parity.js --side linux
node tools/parity.js --status
```

The checker compares board text with this registry and helper-tab text. It reports missing and unowned strings and recorded OS differences. It does not check layout, colors, host notifications, provider behavior or runtime acceptance.

## F124 Workspace name in the board header
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done cc0e71f (inherited historical status; not revalidated for this distribution)
- what: The board view uses the current workspace name in its header, following Entomatical, instead of Board. If there is no workspace name, it retains Board. This header is supplied by the editor rather than media/board.js.

## F01 Board columns
- windows: done 4fa5ec0 (inherited historical status; not revalidated for this distribution)
- linux: done 80f4016 (inherited historical status; not revalidated for this distribution)
- what: Cards sit in five columns, Queued, Running, Needs input, Review and Done.
- ui: "Queued" "Running" "Needs input" "Review" "Done" "▾" "▸"

## F02 Collapse empty columns
- windows: done bfa178f (inherited historical status; not revalidated for this distribution)
- linux: done d4a3920 (inherited historical status; not revalidated for this distribution)
- what: A column with no cards shrinks to its header, so the columns with cards share the width.

## F03 Add task form
- windows: done ed4c615 (inherited historical status; not revalidated for this distribution)
- linux: done 089d8b6 (inherited historical status; not revalidated for this distribution)
- what: The new-task form selects a title, prompt, account, model and effort before adding a card; provider choices follow the selected account.
- ui: "Task prompt" "Account for new task" "Model for new task" "Effort for new task" "Default model" "Default effort" "{} effort" "Opus" "Sonnet" "Haiku" "Fable" "Select account" "Add task" "Ctrl+Enter" "Default model (none seen yet)" "Default effort (none seen yet)" "Models {} last advertised, {}" "{} lists no models until a session of this account has opened." "Effort levels {} last advertised, {}" "{} lists no effort levels until a session of this account has opened." "Permission mode for an unattended Grok or Antigravity card (orchestrator, plan step or worker). A card opened in the provider's own terminal uses that provider's permissions." "A card opened in the provider's own terminal uses the agent's default model and effort; this choice applies to its unattended runs and follow-ups." "Ask runs it in the agent's advertised mode {}." "{} advertises no mode that asks for approval, so Ask is not offered." "Ask runs it in a mode the agent advertises as asking first; an account that advertises none refuses Ask."

A recreated new-task draft restores its account from the board snapshot. If the saved account is unavailable, Add task waits for an explicit choice. Covered by the isolated Chromium fixture in `test/compile-webview.test.js`.
Create rechecks the selected context after rule generation. A refused submission remains recoverable while a newer draft is in the form.
- ui: "The saved account is unavailable. Choose an account for this draft." "Finish the current draft before restoring a refused draft." "Restore refused draft: {}"

## F04 Auto-start
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 1c2238a (inherited historical status; not revalidated for this distribution)
- what: A new task starts its session as soon as it is added.

## F05 Subtasks
- windows: done 1c2f0db (inherited historical status; not revalidated for this distribution)
- linux: done 9a4caed (inherited historical status; not revalidated for this distribution)
- what: A task can be a subtask of another.
- ui: "Subtask of {}" "×" "Not a subtask" "↳ {}"

A draft keeps its subtask parent across reloads. If the parent is unavailable, choose Subtask on another card or Use no parent before adding the draft.
- ui: "The saved parent is unavailable. Choose a parent with Subtask on a card, or select Use no parent." "Use no parent"

## F06 Acceptance checks and completion rule
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 9eccb69 (inherited historical status; not revalidated for this distribution)
- what: A task's acceptance checks are commands run in its worktree when its work is ready for review.
- ui: "Acceptance checks passed." "Acceptance checks running…" "Retry checks" "Logs: {}" "Fix it" "Send this failure to the task's session and ask it to fix the cause. The checks run again when its work comes back to Review." "What failed" "End of its output"

## F52 Skin: status stripes, provider edge, button weights, tokens
- windows: done d16a96b (inherited historical status; not revalidated for this distribution)
- linux: done 8a87fcc (inherited historical status; not revalidated for this distribution)
- what: Shared style tokens control status stripes, provider edges, button weight, spacing and visual hierarchy.

## F53 Haiku title tickbox
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done f0815f0 (inherited historical status; not revalidated for this distribution)
- what: A "Haiku title" tickbox beside Add task, ticked by default, switches F04's naming of an untitled task on and off.
- ui: "Title: Haiku" "Title: {}" "Title: {}·{}" "Model and effort for titles" "Effort" "A Codex task is named by Luna at low effort, so this model and effort are for Claude accounts." "A {} task is named by its agent's default model, so this model and effort are for Claude accounts." "When the title box is empty, the task is named from its prompt as it starts automatically: Haiku, Luna for a Codex task, or the agent's default model on the task's own Grok or Antigravity account." "Auto-start is off (entomatical.autoStart), so an untitled task is not named automatically. Type a title, or use Generate title with Haiku from the card's menu."

## F54 Completion rule: Fable
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done 80f4016 (inherited historical status; not revalidated for this distribution)
- what: The "Completion rule: Fable" tickbox beside Add task asks Fable at high effort to write one rule from the prompt and project context: a goal, a done-when sentence and up to five check commands.
- ui: "Done When: Fable" "Done When: {}" "Done When: {}·{}" "Model and effort for Done when" "A {} task's Done when is written by its agent's default model, so this model and effort are for Claude and Codex accounts." "Fable at high effort (on the Claude IDE default account for a Codex task; the agent's default model on the task's own account for a Grok or Antigravity task) writes the task's goal and when it is done before the card is added. With delegation enabled it also writes commands that check the run's work when it reaches Review." "Done when: {}" "Done when written by {}{}." "Checks: {}" "Previous completion-rule comparison" "{}: no rule." "{} could not write a rule: {}" "Goal: {}" "Fable could not compare the rules: {}" "Fable before the start ({}): used {}'s rule. Haiku good enough: {}." "Fable at Review: not yet. It judges once the work reaches Review and its checks have run." "Fable could not review the rules: {}" "Fable at Review ({}): Haiku good enough: {}." "Completion rules and Fable's verdicts"

## F78 Plan first
- windows: done 33dd264 (inherited historical status; not revalidated for this distribution)
- linux: todo (inherited native VSCodium check on `7c0c9956`). Launch arguments, SessionStart and provider turn metadata confirmed the newest listed Astra at ultra effort. The first turn proposed a plan and asked for approval with zero tool calls and no observed task-file writes. The Plan chip still appeared in the first Review sample after Stop and had cleared by a check about ten seconds later. Verification that the chip is gone on entry to Review remains open.
- what: Plan first starts Claude in plan mode and returns it to the selected permission mode after the first turn. On Codex it selects the newest listed Astra at ultra effort and sends a planning prompt that asks for approval before changes. The Plan chip indicates that the first turn is active.
- ui: "Plan first" "The task is sent the planning prompt shown below and starts in Claude's plan mode: it reads and proposes a plan, and asks you to approve it before it changes anything. Then it writes a plan file to workflows/, where Run a plan… lists it, or does a one-step plan itself. The next turns use the permission mode picked above." "Codex has no plan mode, so on a Codex account the task runs on the newest Astra at ultra effort, whatever model is picked. It is sent the planning prompt shown below: it proposes a plan and waits for your approval, then writes a plan file to the main checkout's workflows/, where Run a plan… lists it, or does a one-step plan itself." "Plan first on Codex runs the newest Astra at ultra effort. Untick Plan first to pick another model." "Plan" "Claude's plan mode, until the first turn ends or its plan is approved" "Planning on Astra at ultra effort, until the first turn ends" "Astra (none listed)" "Grok and Antigravity have no plan mode here, so Plan first is for Claude accounts."

## F08 Card controls
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done dee1029 (inherited historical status; not revalidated for this distribution)
- what: Start, Open, Stop and Resume on each card, plus More for the context-menu actions.
- ui: "Start" "Open" "Stop" "Resume" "More" "Task actions (also available by right-clicking this card)" "{} d ago"

## F09 Follow-up
- windows: todo (verify the two-view disappearance and deferred Codex Enter in native VS Code)
- linux: done 1ec18a2d (inherited historical status; not revalidated for this distribution)
- what: Ctrl+Enter sends a multi-line follow-up. A confirmed dispatch clears its draft. On Windows, a Codex terminal confirms after its guarded Enter. A refused send keeps the text and helper state. When its card disappears, the text returns to the new-task form or stays separately copyable if the form is busy.
- ui: "Follow-up (Ctrl+Enter sends)" "Send" "Unsent follow-up for {}"

## F10 Prompt list
- windows: done 8118686 (inherited historical status; not revalidated for this distribution)
- linux: done aa677c4 (inherited historical status; not revalidated for this distribution)
- what: Each card lists the prompts its session received, newest first; expand for more, or show all.
- ui: "Show latest only" "Show all {}" "{} prompts · {}" "Show full prompts" "↩ {}"

## F11 Answers under prompts
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 2399959 (inherited historical status; not revalidated for this distribution)
- Codex joins unfinished JSONL records at the newline, preserving Unicode across polls. On growth it checks the first and last 1 KiB of the previous content for a rewrite. A same-file rewrite that preserves those windows can look like an append.
- what: The expanded prompt list shows each prompt with the final answer of the turn that handled it, for Claude and Codex sessions.
- ui: "The answer this prompt got (first 600 characters)"

## F12 Last reply
- windows: done 3433c10 (inherited historical status; not revalidated for this distribution)
- linux: done 3433c10 (inherited historical status; not revalidated for this distribution)
- what: Each card shows the first line of the latest answer.
- ui: "Latest answer (first line)"

## F13 Subagents
- windows: done ed5fa88 (inherited historical status; not revalidated for this distribution)
- linux: done 215e272 (inherited historical status; not revalidated for this distribution)
- what: A card lists its session's subagents with their state and step count.
- ui: "{} subagent{}" "✓" "●" "○"

## F14 Session details and token measurement
- windows: done 11a1c45 (inherited historical status; not revalidated for this distribution)
- linux: done d15a327 (inherited historical status; not revalidated for this distribution)
- what: Input, cache and output token counts with explicit completeness and gaps; context-window fullness shown separately.
- ui: "Session running" "No session" "Session details" "Token consumption not yet measured." "{} tokens · complete session" "Partial measurement · full consumption unknown" "Input {} · cache read {} · cache write {} · output {}" "Measured {}" "Context window {}% full · {} (separate from consumption)"

## F15 Card actions in the context menu
- windows: todo (native ACP Rename and Cancel)
- linux: done f0815f01 (inherited native editor check on two synthetic stopped cards. Rename saved the board title for Grok and Antigravity, and Escape preserved it. Reload and stale-dialog handling have automated coverage.)
- what: Right-click or More: Rename, Generate title with Haiku, Follow-up, Switch account, New subtask, Mark done or Reopen, Merge and Discard worktree, Delete task. Rename edits the board title for Grok and Antigravity in any session state. A board reload keeps Rename on the selected card. Cancelling, losing ownership or changing the target session or title leaves the current title intact. Codex also names its thread. A started Claude session uses its terminal or panel. Mark done refuses a delegated card that never started unless it was cancelled; a cancelled one goes to Done and keeps its cancelled mark.

## F17 Found sessions
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done e9a773e (inherited historical status; not revalidated for this distribution)
- what: A Claude session already running in the repo shows up on the board by itself.

## F18 Notifications
- windows: done 3433c10 (inherited historical status; not revalidated for this distribution)
- linux: done 3433c10 (inherited historical status; not revalidated for this distribution)
- what: When a board task needs input or finishes, VS Code shows a message with an Open button.

## F70 Monitor cards through the board: status lines, live line, settle notices
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 5dd9d85 (inherited historical status; not revalidated for this distribution)
- ui: "doing: {} · {}" "What the session is doing right now, from its latest tool call" "Timeline"
- what: All managed task environments carry card, repository, runtime and session identity. A message from outside a card's controllers waits in its inbox and preserves its completion state.

## F69 A session opens cards of its own
- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: todo (inherited historical status; not revalidated for this distribution)
- ui: "Allow delegation" "After plan approval this card can open and manage child cards on any supported provider within the run limits." "Controller: {} ({})" "Controller: external session {}" "Controller: you" "This subtask is grouped under another card. You control its lifecycle." "{} open · {} done · {} cancelled · {} of {} opened"
- what: An orchestrator card on a Claude or Codex account runs in its card terminal (since 18 November 2026), where the board types its notices; Grok and Antigravity orchestrators run headless (since 6 November 2026).

The card shows its controller separately from its grouping parent. Model-reviewed v1 plans can explicitly allow additional assignments.

## F71 Master orchestrator with headless children
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 45f1cff (inherited historical status; not revalidated for this distribution)
- ui: "Cancel card" "cancelled" "delivery ready" "Launch failed: {}" "Controller: external session {} (last request {})" "headless" "taken over"
- what: Root orchestrators and descendants default to Bypass permissions, persisted on the card and mapped to each provider. A rebind from a session that is not the card's own binds only after the user clicks Allow on the board.

On board shutdown, managed ACP and Codex app-server turns record an interruption. A retry waits for the old provider process to exit. A hidden Claude terminal with matching workspace, card and session identity can continue across reload. Linux fixture coverage is in `test/acp-identity.test.js` and `test/board.test.js`. Native editor reload remains to be checked on both platforms.

## F73 Pressure watchers
- windows: done 098a7f6 (inherited historical status; not revalidated for this distribution)
- linux: done 215e272 (inherited historical status; not revalidated for this distribution)
- what: A root can opt in at plan approval to automatic watcher cards when settled notices accumulate, with editable pending, watcher and per-watcher caps.
- ui: "Allow automatic pressure watchers" "Watchers off" "Watchers on" "Notices before a watcher" "Maximum watchers" "Cards per watcher" "Allow the board to open additional watcher cards when notices accumulate (uses run slots and model usage)" "sub-orchestrator" "watcher needs attention"

## F74 Standing judge, scribe and research
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 5ab177c (inherited historical status; not revalidated for this distribution)
- what: `board.js add --role judge|scribe|research` creates fixed roles; judge and scribe sleep until a message or milestone, and research runs once in read-only mode.
- ui: "judge" "scribe" "research" "judged: {}"

## F75 Pause run, Stop run, Archive run, run row
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 9666560 (inherited historical status; not revalidated for this distribution)
- ui: "{} · {} running · {} needs you · {} done · {} pp" "Show or hide this run's cards" "paused" "Archived runs ({})" "Restore" "Put this run's cards back on the board, in Done"  "Waiting on 1 card" "Waiting on {} cards" "This card's own turn ended, but a card under it is still queued or working" "This card's own turn ended, but cards under it are still queued or working"
- what: The root run row accounts for all descendants. Stop run also ends acceptance checks still running on the run's cards, including cards in Review. Under a Done run only its Done cards stay folded in the run row; a card that is not Done is drawn in its own column.

## F76 Plan approval, reload recovery, limits handled by the board, check catalogue, run report
Board history, quota resets and CLI events use the host offset at the displayed instant. On Linux, an isolated VSCodium 1.143.1 host published the Vancouver rules. The CLI showed 10:00:00 for 15 January 2025 at 18:00 UTC and 15:39:13 for 4 November 2026 at 22:39:13 UTC. The headless Chrome board fixture in `test/local-time.test.js` covers both dates. Windows BC mapping has fixture coverage. Native Windows and visual checks inside the editor remain pending.
- windows: done 3d9e899 (inherited historical status; not revalidated for this distribution)
- linux: done 5a238b1 (inherited historical status; not revalidated for this distribution)
- ui: "Plan ready: {} steps. The {} pp estimate is a heuristic." "Open cards" "Total cards" "Maximum depth" "Run permissions: {}" "Allow: {}. Deny: {}. External sync opt-out: {}." "Approve" "Allow this card to delegate within the approved limits" "Edit plan" "Open ORCHESTRATION.md to edit the proposed run" "Run report" "No report yet." "{} · {} · {} pp" "Open report" "The run report as a document: the final reply, each card's outcome and cost, and where the plan is" "switched to {}" "waits for reset {}" "budget {}% used" "{} of {} points of the 5-hour window, measured from the readings at the start and end of each card's runs; {} cards have no measurable reading and count as unknown"
- what: Plan reads a Markdown list under ## Steps, ensures the repository workflows/checks.json template exists, and proposes root-wide caps and run policy for one approval.

## F42 Cards leave Running after Esc, a declined permission or an API error
- windows: done 1824178 (inherited historical status; not revalidated for this distribution)
- linux: done b84c7bb (inherited historical status; not revalidated for this distribution)
- what: The CLI fires no Stop when the user presses Esc mid-turn or answers "No, tell Claude…" at a permission prompt, and a turn ended by an API error fires StopFailure instead.

## F43 A session stuck on a prompt before it starts says so
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 901881c (inherited historical status; not revalidated for this distribution)
- what: When a terminal session has not reported SessionStart 20 s after the board opened its terminal, it is waiting on something in its terminal: the CLI's first-run setup, sign-in, or folder trust.
- ui: "Waiting for {} to start: answer the prompt in its terminal (Open)"

## F67 Triple-click a card title to open its session
- windows: done 630ea57 (inherited historical status; not revalidated for this distribution)
- linux: done fe0e7da (inherited historical status; not revalidated for this distribution)
- what: Triple-clicking a card title opens and focuses its terminal, Codex editor tab or Claude panel through the existing Open action.

## F68 Board as an editor tab
- windows: done c81c642 (inherited historical status; not revalidated for this distribution)
- linux: done ccfac2b (inherited historical status; not revalidated for this distribution)
- what: The board can open as its own editor tab, not only in the sidebar.

## F79 Asked you something
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 901881c (inherited historical status; not revalidated for this distribution)
- what: A detected question is surfaced on the card so the user can respond; detection alone does not establish a permission request.
- ui: "Asked you something" "The last reply ends with a question or a list of options to choose from"

## F80 Quiet and Repeating
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 901881c (inherited historical status; not revalidated for this distribution)
- what: Quiet and Repeating indicators surface inactive or repeated session activity without accepting its work.
- ui: "Repeating {} ×{}" "The same tool call with the same input, this many times in a row in this prompt" "Quiet {} min" "Minutes since the last observed session or subagent activity. A long tool call can be quiet while still running."

## F16 Worktree per task, merge and discard
- windows: done f33805a (inherited historical status; not revalidated for this distribution)
- linux: done 9a4caed (inherited historical status; not revalidated for this distribution)
- what: Each task gets its own worktree and branch.

## F55 A failed worktree checkout is undone
- windows: done 315a92d (inherited historical status; not revalidated for this distribution)
- linux: done 4fd1ca4 (inherited historical status; not revalidated for this distribution)
- what: When git cannot check out a task's worktree, Start removes what the failed checkout left and keeps a branch that existed before, so the next Start fails for the same reason again rather than with "a branch named 'task/<id>' already exists".

## F60 Finish a task with one button
- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: done e5268915 (inherited VSCodium development-host evidence across revisions). With no Finish model selected, the Haiku resolver landed both conflicting edits. After Stop, ordinary Finish refused while a surviving Claude helper held the worktree as its working directory. One retry landed the preserved files after the helper exited. A separate run showed the pending-cleanup notice after reload and the cleanup-only dialog. Removing the late file allowed cleanup with the main reflog unchanged. The Linux check takes one post-close snapshot of readable working directories under the worktree for processes with the same effective UID. It cannot identify late arrivals, inaccessible processes, other UIDs or a writer holding a file open while its working directory is elsewhere. Cleanup-only, missing-branch, automatic, governed and CLI-requested Finish and Windows do not use this snapshot.
- what: A Finish button on each card with its own worktree, also in the right-click menu. Finish deletes the worktree only once the card's own session and checks have ended and the folder holds nothing beyond what landed; otherwise the work stays merged, the worktree is kept whole, and Finish again only retries the cleanup.
- ui: "Finish" "Close the session, commit, merge with the remote's latest, push, update the local branch, then delete the worktree. Never stops work still running. Shows the plan first; stops and keeps the worktree if a step fails, and if the remote (GitHub) does not accept it, asks the task's session whether to fix the cause."

## F125 Finish to an encrypted vault, for a repo with no remote to push to
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: todo (inherited historical status; not revalidated for this distribution)
- what: The setting `entomatical.finish.vaults` (user settings only, never a workspace's) maps a repo's main folder to an upload helper outside the repo: `{ "name", "command", "args", "verifyArgs", "timeoutSeconds" }`. Finish in a listed repo merges into the local branch only and fetches or pushes no Git remote. The helper then runs in a terminal of its own, started only by the user's own Finish (its dialog shows the vault and the command), by the "Merge and upload to <name>" button of a governed Finish, or by the command "Entomatical: Upload to Vault". An automatic finish, `board.js finish <id>` and a background delivery never upload. The card records the merged commit and whether the vault has it; an upload that did not finish stays pending, and Upload to Vault tries it again. A repo that is not listed finishes as before (F60).

## F44 Use panel keeps the wrapper each profile had
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 9fd48e5 (inherited historical status; not revalidated for this distribution)
- what: `claudeCode.claudeProcessWrapper` is a per-profile setting, but the wrapper set before Entomatical's is kept in one machine-wide file, `~/.entomatical/inner-wrapper`, which the Linux panel wrapper starts claude through.

## F45 A window that does not own the board changes nothing
- windows: done 10299d5 (inherited historical status; not revalidated for this distribution)
- linux: done e22e88a (inherited historical status; not revalidated for this distribution)
- what: Only one VS Code window owns a repo's board.

## F46 Hooks keep working after an Entomatical update
- windows: done 94bd792e (inherited historical status; not revalidated for this distribution)
- linux: done f495232 (inherited historical status; not revalidated for this distribution)
- what: A task's hooks file named `hook.js` and `statusline.js` inside the versioned extension folder, which the editor deletes after an update, so every hook of a resumed session failed silently and the card stopped moving.

## F58 One panel wrapper on both machines
- windows: done e6e1451 (inherited historical status; not revalidated for this distribution)
- linux: done d961879 (inherited historical status; not revalidated for this distribution)
- what: The shared wrapper/entomatical-claude.js implements the panel wrapper on Windows and Linux, with explicit platform branches.

## F63 Quiet startup
- windows: done 788543b (inherited historical status; not revalidated for this distribution)
- linux: done 1c16150 (inherited historical status; not revalidated for this distribution)
- what: On a reload only Entomatical and the session tabs that were open come back.

## F84 Reload every window from a command
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 64125f4 (inherited historical status; not revalidated for this distribution)
- what: The reload-windows command writes a reload request consumed by running extension hosts; it can end active editor sessions.

## F19 Refine draft
- windows: done 58297eb (inherited historical status; not revalidated for this distribution)
- linux: done 80f4016 (inherited historical status; not revalidated for this distribution)
- what: Proposes a clearer goal and verifiable milestones using project context, after at most three clarification questions when needed; a clear draft can stay unchanged. Each helper keeps the newest 120,000 UTF-16 code units of streamed output across its models and up to 300 activity lines of 400 units each. Failure summaries keep up to 4,000 units. Open in editor provides the full prompt or result. Cancel and Open in editor apply to the request displayed when clicked. Show progress can reopen a closed helper while its board is open. Closing the board preserves history in an open helper tab. Closing both releases the history. A card can reopen its running work review. Once that review ends, its history lasts until its panel closes.
- ui: "Refinement interrupted. Your draft is preserved; try again." "Refine draft" "Use project context to clarify this draft only where it needs it, on the most capable model at its highest effort for the selected account's provider. May ask up to three questions or leave a clear draft unchanged. Runs in its own editor tab beside the board, which stays usable meanwhile. Review before applying. Uses account usage." "Refining your draft in its own tab. The board stays usable meanwhile." "Open in editor" "Show progress" "Bring back the tab that shows this run's progress: each model's thinking and answer as they stream in" "Cancel refinement" "Use answers" "Unanswered; preserve ambiguity." "Your draft is already clear." "Proposal from {}{}" "Proposed draft" "Assumption: {}" "Apply proposal" "Your draft changed. Refine it again to avoid overwriting your edits." "Restore original" "Your draft changed after applying. Your edits were preserved. Copy from the original below if needed." "Original draft" "Keep applied draft" "Keep original" "Uses {} · {}" "Refinement interrupted. Your answers are kept; send them again." "{} Your answers are kept." "Improve with these answers" "Your draft changed after these questions were asked. Refine it again, or improve it without these answers." "Send this draft and the answers shown, suggested ones included, straight to Improve prompt" "Both buttons send the answers as shown, including suggested answers you left in place." "Show changes" "Compare the proposal with your draft in VS Code's diff editor" "Refine draft: your draft ↔ proposal" "Check: {} ({})"

## F20 Refine with a Codex model
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done a34e692 (inherited historical status; not revalidated for this distribution)
- what: Refine draft also runs on a Codex account with its model and effort. The helper releases the turn's final structured message after `turn.completed` and a successful process exit. On reuse, it checks the cached value against the recorded turn.
- ui: "Select an account above." "The Codex CLI lists no Astra model, so Refine and Improve cannot run on Codex."

## F21 Refinement leaves an actionable draft alone; goal and milestones only for multi-stage work
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done a34e692 (inherited historical status; not revalidated for this distribution)
- what: The proposal states one achievable end state, then milestones that can each be verified.

## F22 Improve prompt
- windows: done 58297eb (inherited historical status; not revalidated for this distribution)
- linux: done 80f4016 (inherited historical status; not revalidated for this distribution)
- what: Turns the current draft and the latest submitted clarification answers into an execution prompt, shown read-only.
- ui: "Improve prompt" "For a long draft or one with pasted material: turn it into a structured execution prompt, on the most capable model at its highest effort. Obligations the model assumed are held back and listed. Flags unresolved contradictions. Review before applying. Uses account usage." "Improvement interrupted. Your draft is preserved; try again." "Improving your prompt in its own tab. The board stays usable meanwhile." "Cancel improvement" "Dismiss" "Clarification is unfinished: a consequential contradiction remains. Edit the draft to resolve it, then improve it again." "Earlier: {}" "Later: {}" "Why: {}" "Improved with {} · {} effort · {} format" "Improved prompt" "Sent with your clarification answers from Refine draft." "Apply improved prompt" "Your draft changed. Improve it again to avoid overwriting your edits." "Keep improved draft" "{} requirements · {} checks · {} held back because the model assumed them · {} assumed facts sent as unconfirmed · {} questions to ask first" "Your clarification answers were not sent: the draft changed after you answered." "The model assumed these; not sent" "Requirement" "Check" "Authorized" "Requires confirmation" "Not authorized" "Possibly not carried into the prompt: {}" "Only in pasted material, not as an instruction: {}" "This prompt is {} characters, over the {}-character limit: applied, it could not be refined, improved or given a completion rule. Copy what you need instead." "Improve prompt: your draft ↔ improved prompt"

## F59 Refinement reads the project and suggests its answers
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 05c7591 (inherited historical status; not revalidated for this distribution)
- what: Refinement receives bounded read-only project context and suggests answers to questions while leaving user decisions explicit.

## F65 Review prompt: Astra reviews Terra's and Sol's improvements
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done a34e692 (inherited historical status; not revalidated for this distribution)
- what: A "Review prompt" tickbox beside Improve prompt, one setting for every box, remembered across reloads.
- ui: "Review interrupted. Your draft is preserved; try again." "Terra and Sol are improving the prompt…" "Two max-effort improvements, then an ultra-effort review: this can take many minutes." "Cancel review" "Review by {} · {} effort" "Prompt review" "Worked: {}" "Did not work: {}" "Comparison: {}" "Takeaways:" "Astra could not review the attempts: {}" "Failed: {}" "{} attempt ({} · {} effort){}" "{} attempt" "Dismiss review"

## F83 Helper receipts, replay and a regression set
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done a34e692 (inherited historical status; not revalidated for this distribution)
- what: Helper receipts record inputs, outcomes and usage for replay. The public default regression manifest uses four authored cases and no recorded helper inputs.

## F23 Unified speech dictation
- windows: done (inherited historical status; not revalidated for this distribution)
- linux: done 9315dbc (inherited historical status; not revalidated for this distribution)
- what: One Entomatical offers local Whisper, local Parakeet, OpenAI, Groq and Deepgram. Dictation belongs to the sidebar, editor board or F8 terminal that started it. Closing another surface lets the original receive its final transcript. Closing the owner cancels the recording and discards late text. Cancel also blocks another recording until the recorder, silence meter and any local transcription have closed. Each child still running after two seconds gets a forceful termination signal. Stop keeps the final transcript. Live Whisper retains utterances containing Unicode letters or numbers, including the final utterance on Stop.
- ui: "Parakeet tools" "Speech dictation" "Local Whisper" "Dictation" "Dictation provider" "Whisper model" "Parakeet model" "Choose Whisper folder" "Choose Parakeet folder" "Model" "Set speech API key" "Speech settings" "No models found" "Choose the folder containing Whisper and its models." "Choose the folder containing Parakeet and its models." "Parakeet transcribes locally while you speak. Language is detected automatically." "Audio is sent to the selected provider when you stop recording." "Mic" "Starting microphone…" "Finishing dictation…" "Stop and put the text here"

## F24 Accounts list and IDE default
- windows: done 3433c10 (inherited historical status; not revalidated for this distribution)
- linux: done 3433c10 (inherited historical status; not revalidated for this distribution)
- what: Lists every Claude, Codex, Grok and Antigravity account with who it is signed in as, its plan, and Use in IDE for the default account of new Claude chats.
- ui: "IDE default applies to new Claude chats in all VS Code windows. Existing sessions keep their accounts. Codex accounts are picked per task." "Claude" "Codex" "Accounts · Claude IDE default: {}" "Not signed in" "Folder: {}" "Meant for {}. Log in again to fix." "Same login as folder {}; these folders share a quota." "Switching…" "IDE default" "Use in IDE" "Choose the default for new Claude chats and board tasks"

## F25 Provider names in colour
- windows: done 85a070c (inherited historical status; not revalidated for this distribution)
- linux: done d4a3920 (inherited historical status; not revalidated for this distribution)
- what: Each account row names its provider in that provider's colour.

## F26 Add, sign in and sign out
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done e9a773e (inherited historical status; not revalidated for this distribution)
- what: + Add Claude account adds a Claude folder, also for an email Codex is signed in with; it recognizes an existing login only in a usable Claude folder.
- change: Claude sign-in requires the login process to exit successfully and a fresh status from the selected folder. A bound folder also requires its expected email. Cancellation, timeout, unreadable status and identity mismatch cannot confirm a login. The final account row must agree with the fresh verification before the success notice and quota request. Add skips folders marked as belonging to another email when checking for an existing login. Linux fixtures cover these outcomes. In VSCodium 1.143.1, a synthetic Claude CLI in a disposable account folder produced a failure on exit 1, a refusal on identity mismatch and a success on a matching identity. The same editor refused a changed identity after rescan, allowed Add in the correct folder and recognized that usable login on the next Add. Native Windows and live browser sign-in remain unverified for this change.
- ui: "Add account" "Manage login" "Sign in again" "Log in" "Log out" "{} · Not supported yet" "Gemini" "Microsoft Copilot" "Perplexity" "Kimi" "Mistral" "Poe" "GitHub Copilot" "DeepSeek"

## F86 Grok profiles and shared Antigravity sign-in
- windows: done ae982f7 (inherited historical status; not revalidated for this distribution)
- linux: done 9315dbc (inherited historical status; not revalidated for this distribution)
- what: Adds labelled Grok profile folders and a row for Antigravity's shared Google sign-in.
- ui: "Uses Antigravity's shared Google sign-in" "Grok" "Antigravity" "Sign in" "Open {}" "Hide" "Move this profile and its history to the trash" "Hide this row without changing the Google sign-in" "Follow-up" "Keep agent setting" "Applied on the next follow-up. Keep agent setting leaves the provider's current setting unchanged."

## F87 Grok and Antigravity task sessions
- windows: done (inherited historical status; not revalidated for this distribution)
- linux: done 195f929 (inherited historical status; not revalidated for this distribution)
- what: New ordinary Grok and Antigravity tasks open a provider-native interactive terminal in their card.
- ui: "Partial reply:" "↩" "Partial reply; the turn has not completed (first 600 characters)" "Partial reply: {}" "Focus terminal" "Start terminal" "Continue this card in a new terminal on the same worktree. The provider's earlier terminal conversation is not reopened."

## F88 Grok and Antigravity choices on the new-task form
- windows: done b31979b (inherited historical status; not revalidated for this distribution)
- linux: done d435ecc1 (inherited native VSCodium development-host checks). Grok launched with the profile’s advertised default and permission flag, displayed that model and answered. An Antigravity terminal card added through the CLI without a model refused Start and stayed queued. Selecting Carbon low in the ordinary form launched `agy --model=gemini-4-carbon-low`. The terminal showed Gemini 4 Carbon at low effort and the data-use opt-in. The provider conversation for the card worktree contained the prompt and answer `79`. Display of the answer in the terminal viewport was unverified.
- what: Grok and Antigravity choices reflect provider-advertised models and efforts; configured supported short names resolve to the newest listed version. Provider defaults and permission checks remain unchanged.
- ui: "Opus (newest)" "Argon (newest)" "Carbon (newest)"

## F91 Stop a headless run that keeps getting refused
- windows: done 10299d5 (inherited historical status; not revalidated for this distribution)
- linux: done 1039a2c (inherited historical status; not revalidated for this distribution)
- what: A headless Claude card's own hook stops its run when the same call is refused twice in one prompt, or 8 calls in a row are refused with no successful call between.
- ui: "Stopped after {} refused calls" "This headless run needed approval that nobody can give here. Send a follow-up with another way to do it, or resume it with Bypass permissions." "Resume with Bypass" "Set this card to Bypass permissions and continue the same session: the calls refused before are allowed now." "Last refused: {}"

## F92 Model names always mean the newest version
- windows: done 8ae6b752 (inherited historical status; not revalidated for this distribution)
- linux: done d435ecc1 (inherited native VSCodium development-host checks). Unlisted Codex and Antigravity models refused Start without leaving task branches or worktrees. A cold Antigravity probe preserved both complete card records immediately and after 181 seconds. Separate Codex Default and stored Sol launches used the provider’s exact default and newest Sol ID. Four Claude cards reported their full model IDs in SessionStart and replies. Title helpers saved their results with matching model receipts for Grok and Antigravity with no model selected, and for Claude with an explicit full Haiku ID.
- what: A short model name always runs the newest version of that model on its provider, today and after every release, and a full id of any version runs the newest too.
- superseded in part by F123 (23 November 2026): the menus list exact ids, and a listed exact id runs as picked; a short name still runs the newest version.

## F89 Card terminal for Claude and Codex, read and typed by parent cards

Deleting a card during Windows Stop hides its terminal immediately. A failed tree stop falls back once on the original PTY while its native process is still running. After native exit, output can drain until the public PTY exit event reports the code and releases the ConPTY worker. Linux fixtures cover card-ID reuse, delayed tree-stop success and failure, and native exit codes 0 and 17 before the callback. Descendant exit after deletion still needs a native Windows check.

- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: todo (inherited historical status; not revalidated for this distribution)
- what: Card terminals support Claude and Codex sessions, with parent screen/type operations that refuse typing over unread user input unless override is explicit. Every card terminal watches for a selection prompt that no start-up answer matches: one that stays 30 s becomes one "Waiting at: …" event in the card's Timeline, and nothing is typed at it. The terminal permits inline cell colours and caches the board ownership check for one second during typing and output.
- ui: "Card terminal" "Run this task in a terminal inside its card instead of a VS Code terminal or the Claude panel. Its parent card (and theirs) can read that terminal and type into it, and is told when you type there." "You typed in the terminal {}" "Card {} typed in the terminal {}" "Grok and Antigravity always run in the card's terminal."

## F27 Account settings gear
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 3c02608 (inherited historical status; not revalidated for this distribution)
- what: Under Manage login, a gear opens the account's settings page on the web: claude.ai usage settings for Claude, chatgpt.com settings for Codex.
- ui: "⚙" "Open settings on {}{}. Your browser shows the account it is signed into." "Account settings on {}"

## F28 Remove an account
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done ac6ad93 (inherited historical status; not revalidated for this distribution)
- what: Under Manage login, Remove moves an extra account folder to the trash after confirmation.
- ui: "Remove" "Move this account folder to the trash"

## F29 Lock folders are not accounts
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done ac6ad93 (inherited historical status; not revalidated for this distribution)
- what: The Claude CLI's "<folder>.lock" folders, made while it refreshes a login, are never listed as accounts.

## F30 Usage per account
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 4e60d7e (inherited historical status; not revalidated for this distribution)
- what: 5-hour and weekly usage per signed-in account, with how old the reading is.
- ui: "Refresh" "Refresh sign-ins and usage. Usage also updates after sign-in." "Refreshing…" "Refreshing usage…" "Usage not available yet. Select Refresh to request it." "{} min ago" "{} h ago" "Updates when Claude reports usage." "Weekly limit"

## F36 A Claude usage limit moves to the next account
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 76f7fbd (inherited historical status; not revalidated for this distribution)
- what: When a Claude helper call hits a usage limit, it runs again on the next signed-in Claude account folder and records which account answered.

## F39 The account that answered after a usage limit becomes the default
- windows: done ee999fa (inherited historical status; not revalidated for this distribution)
- linux: done 38d6346 (inherited historical status; not revalidated for this distribution)
- what: When a Claude call hits a usage limit and another signed-in account answers, that account becomes the default Claude account, so later calls start there, and VS Code says "Entomatical: <account> hit a usage limit; <other account> is now the default account." This applies to Refine draft, Improve prompt and Generate title.

## F41 Switch a task's account
- windows: done f47fa88 (inherited historical status; not revalidated for this distribution)
- linux: done e22e88a (inherited historical status; not revalidated for this distribution)
- what: More → Switch account on any card that is not done, for example when its account has reached its usage limit.

## F48 Fable limit carries on with Opus
- windows: done a31e2d2 (inherited historical status; not revalidated for this distribution)
- linux: done 832120b (inherited historical status; not revalidated for this distribution)
- what: Once a Claude account hits its Fable limit, work carries on with Opus and below.

## F49 Provider-specific usage windows
- windows: done 284036c (inherited historical status; not revalidated for this distribution)
- linux: done 8a87fcc (inherited historical status; not revalidated for this distribution)
- what: A provider whose subscription limits differ from Claude's shows and applies its own.
- ui: "{}-hour limit" "{}-day limit"

## F50 Accounts collapse while tasks run; usage stays on the summary line
- windows: done 38a3433 (inherited historical status; not revalidated for this distribution)
- linux: done 8a87fcc (inherited historical status; not revalidated for this distribution)
- what: The Accounts section is open while no task is running, so limits can be compared and the default chosen.

## F51 What a task cost in percentage points
- windows: done ee999fa (inherited historical status; not revalidated for this distribution)
- linux: done d3832d5 (inherited historical status; not revalidated for this distribution)
- what: Each account keeps a usage history beside its latest reading.
- ui: "Account usage moved {}{}." "{}: reset during the task{}" "Percentage points of the account's usage windows between the start and end of this task's runs. Other sessions on the same account count too."

## F57 A Claude Max account shows no 5-hour limit
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 3896a63 (inherited historical status; not revalidated for this distribution)
- what: Claude Max usage readings omit a missing five-hour limit and show available provider-reported windows; the implementation follows the received plan and usage data.

## F31 Codex tasks
- windows: done 3ac7bd9 (inherited historical status; not revalidated for this distribution)
- linux: done e115bb2 (inherited historical status; not revalidated for this distribution)
- what: With entomatical.codexStart "terminal", a task on a Codex account runs the Codex CLI in its own terminal and worktree, with start, follow-up, stop and resume.

## F32 Codex status hook, approved once
- windows: done a748243 (inherited historical status; not revalidated for this distribution)
- linux: done 5915ea2 (inherited historical status; not revalidated for this distribution)
- what: Codex card status comes from per-session hook settings with one hook command for every task, the events file in ENTOMATICAL_EVENTS.

## F33 Codex tokens, spawned agents and found sessions
- windows: done 3ac7bd9 (inherited historical status; not revalidated for this distribution)
- linux: done d15a327 (inherited historical status; not revalidated for this distribution)
- what: A Codex card shows token counts, spawned agents and verified sessions already running in the repository. On Linux, discovery requires one writable rollout for the matching thread and working directory. Stop checks the writer again and uses its process descriptor. If ownership or system signal support cannot be verified, the board directs the user to the session's original terminal.
- ui: "Codex usage updates on Refresh and when the board opens."

## F37 Codex tasks continue in Codex's editor
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 1e499c9 (inherited historical status; not revalidated for this distribution)
- what: With entomatical.codexStart "editor", Ask and Auto open an interactive terminal for approvals. Bypass starts in the panel or its background fallback. Judge and research cards use a read-only sandbox on every first-turn route.
  When resuming an older editor conversation, the board reapplies the selected permissions in a terminal on the same thread if it cannot confirm the editor started that thread with the required sandbox and approval policy. An ordinary older card without a permission selection can still reopen in the editor. An unrecognized saved permission blocks Start and Resume until corrected.

## F47 Codex asks once to trust the repo
- windows: done 676c31c (inherited historical status; not revalidated for this distribution)
- linux: done 4f5b0fa (inherited historical status; not revalidated for this distribution)
- what: Codex folder trust must be completed before queued task input is sent; a waiting terminal remains visible to the user.

## F61 Codex runs the installed codex, in WSL when the Codex extension does
- windows: done 068f57c (inherited historical status; not revalidated for this distribution)
- linux: done a147963 (inherited historical status; not revalidated for this distribution)
- what: Codex uses its installed binary and follows the Codex extension’s WSL selection when configured, preserving platform path conversion.

## F64 Asana as the context store
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 013d77d (inherited historical status; not revalidated for this distribution)
- ui: "Asana task for new task" "No Asana task" "Asana: not readable" "New Asana task" "Asana project: {}{}" "Asana: {}"
- what: A card can be linked to a task in the workspace's Asana project, and context flows both ways. A linked card offers Unlink before accessing Asana. Change Asana task opens the project picker.

## F85 Obsidian as a context store
- windows: done 676c31c (inherited historical status; not revalidated for this distribution)
- linux: done 64125f4 (inherited historical status; not revalidated for this distribution)
- ui: "Choose context source" "Choose an Asana project or Obsidian folder for new cards" "Obsidian note for new task" "Obsidian: not readable" "No Obsidian note" "New Obsidian note" "Obsidian folder: {}{}" "Obsidian: {}"
- what: Choose context source offers an Asana project, an Obsidian vault or folder, or no source for new cards; existing links remain active.

## F66 Workflow: dependency scheduler with resource gates
- windows: done e529dcf (inherited historical status; not revalidated for this distribution)
- linux: done 64125f4 (inherited historical status; not revalidated for this distribution)
- what: Workflow steps separate grouping from accepted dependencies and enforce exclusive resources, admissions, scope hashes, blockers, attempt receipts and closure outcomes. The public external-worker slot remains single-job; cloud and vm have no capacity.
 Saved workflow steps, attempts and claims must use recognized resource names. An unknown name blocks dispatch and continuation pending reconciliation. An attempt with an unknown resource cannot receive an accepted result. Covered by Linux board and standalone runner fixtures.
 Changes to `entomatical.workflow.localBudget` refresh readiness in the current window. Existing preparations keep their slots until they end. New and resumed preparations must fit the current budget. Checked with a Linux activation fixture in `test/activate-selftests.test.js`.
- ui: "Ready" "Approve scope" "Remember the owner's authorization of exactly this scope, for one dispatch." "Record result" "Say how this step went: accepted, held, failed or cancelled. It frees what the step was holding. Only accepted lets the steps waiting for it start." "Outcome: {}{}{}{}" "Depends on: {}"

## F34 Codex self-test
- windows: done a440560 (inherited historical status; not revalidated for this distribution)
- linux: done d4a3920 (inherited historical status; not revalidated for this distribution)
- what: A self-test drives a Codex task through start, an approval, Esc, a spawned agent, token measurement, resume and a found session in an isolated editor window.

## F56 Every API call and every usage reading is recorded
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done efdcd68 (inherited historical status; not revalidated for this distribution)
- what: The ledger records each API call, token usage and usage-window readings, with gaps retained rather than invented measurements.

## F81 Permission mode menu
- windows: done c7dcb02 (inherited historical status; not revalidated for this distribution)
- linux: done 901881c (inherited historical status; not revalidated for this distribution)
- ui: "Permission mode for new task" "Ask permissions" "Accept edits" "Auto mode" "Bypass permissions"
- what: The permission menu applies each provider’s supported task modes and keeps their approval and unattended-execution restrictions.

## F82 A running limit, and interrupted runs

The board checks dependencies, run approval, execution leases and available slots when a run controller starts or retries a card. A launch in preparation occupies a slot. A cancellation or transfer during preparation prevents the provider from starting. Ordinary independent cards retain the manual Start override. A temporary failure before dispatch displays **Waiting to retry the launch** and schedules one retry after 15 seconds. A second failure, a refused model, a blocked profile or an unconfirmed dispatch requires inspection. An eligible held card then displays **Use Start to retry the launch**.
- windows: done 436ad91 (inherited historical status; not revalidated for this distribution)
- linux: done 7d02c29 (inherited historical status; not revalidated for this distribution)
- ui: "Interrupted: the last turn ended without finishing. Resume to continue." "Resuming…" "Resuming: waiting for the session to start its next turn."
- what: Start after gates dispatch on another card; the running limit gates automatic starts; interrupted runs remain explicit.

## F77 Efficiency summary
- windows: done 02f7004 (inherited historical status; not revalidated for this distribution)
- linux: done 64125f4 (inherited historical status; not revalidated for this distribution)
- what: Efficiency summaries fold session ledger calls and events into prompt, call, context, token and usage-window measurements, retaining gaps and counting rules.
- ui: "No ledger data yet" "The call ledger covers Claude sessions and reads them every 30 seconds" "{} prompts · {} calls · {}/prompt · ctx {} mean, {} end · tail {}%{}" "From the call ledger: calls per prompt, mean context per call (input + cache read + cache write), the last call's context, and the share of tokens spent on prompts after the first Stop. node ~/.entomatical/ledger/ledger.js summary <session> has the per-prompt table."

## F72 Plan files: one standard way to hand out work
A v1 model-reviewed plan can declare `deliveryChecks` from the repository’s check catalogue. After integration, the first `ready` starts the checks on the clean plan branch. A later `ready` requires the board worker’s passing receipt for the same commands and commit. A repair commit requires a fresh run.
- windows: done 68a3c4a (inherited historical status; not revalidated for this distribution)
- linux: done e7e7529 (inherited historical status; not revalidated for this distribution)
- ui: "Run a plan…" "Pick a plan file from workflows/ and run its steps in order. It shows the steps first; nothing starts until you press Run." "plan · a model reviews each step" "plan · checks decide each step" "Needs you: {}"
- what: Plan files define bounded steps, dependencies, checks, models, ownership and review policy; loading, discovery and schema validation remain enforced.

## F90 Curate live run view (removed)
- windows: n/a (inherited historical status; not revalidated for this distribution)
- linux: n/a (inherited historical status; not revalidated for this distribution)
- what: Removed: the read-only live run view moved out of Entomatical into a separate extension.

## F93 Grok and Antigravity tokens, sign-in and model efficiency
- windows: done 22bbc32 (inherited historical status; not revalidated for this distribution)
- linux: done 5feec9b (inherited historical status; not revalidated for this distribution)
- what: Account rows show Grok and Antigravity sign-in and token data when available; efficiency comparisons preserve measurement gaps and provenance. Unreadable call rows in a matched Antigravity conversation leave its decoded subtotal partial. Valid metadata without usage adds no gap. Grok requires both input and output counters. An explicit zero counts as measured. Incomplete models or sessions leave valid subtotals partial, and cards without a measured pair stay out of token medians.
- ui: "Grok and Antigravity rows show what their CLIs record on this computer. Neither reports plan limits." "Model efficiency" "Cards in Done, except discarded ones, grouped by the model that used most of each card's tokens (Antigravity: the card's chosen model, as its files do not name one). Medians per card, as each CLI reports them. Cards removed from the board are not counted." "Measured" "Tokens" "Without cache reads" "Output" "{} ({} partial)" "No cards in Done yet." "{}M" "{}k" "{}: 24 h {} tokens" "Signed in" "Profile {}" "Shared Google sign-in{}" "This computer: 24 h {} tokens ({} output) · 7 days {} ({} output)" "Every Grok session of this profile on this computer, from its usage.json, by each turn's end. Grok reports no plan limits." "This computer, conversations active in the last 24 h: {} tokens ({} output) · 7 days {} ({} output)" "Antigravity: conversations active in the last 24 hours" "Each Antigravity conversation's whole total, counted when it last changed: Antigravity records no time per call. Antigravity reports no plan limits."

## F94 Done-when verdict
- windows: done 28bde12 (inherited historical status; not revalidated for this distribution)
- linux: done 7569e8a (inherited historical status; not revalidated for this distribution)
- what: A completion-rule verdict reports whether the done-when condition is met without treating a finished conversation as accepted delivery.
- ui:

## F95 Take over a card another run left behind
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done f9255fd (inherited historical status; not revalidated for this distribution)
- ui: "taken over by {}" "handed to {}" "takeover asked by {}"
 Changes to `entomatical.orchestrator.claimAfterMinutes` take effect on the next claim in the same window. A Linux activation fixture in `test/activate-selftests.test.js` checks the decision for a holder idle for 45 minutes as the grace period rises from 30 to 60 minutes.
- what: Card ownership can be claimed, requested and handed off under the existing live-owner and user approval checks; operator actions retain their signed authorization boundary. Adopting a tree with a user-controlled card requires approval.

## F96 Scoped sub-agents
- windows: done a01583c (inherited historical status; not revalidated for this distribution)
- linux: done cc0e71f (inherited historical status; not revalidated for this distribution)
- what: Scoped agent roles use routing, a read-only fence and bounded receipts; public role fixtures are examples, not active configuration.

## F97 Review a card against its Done when

When automatic Finish pauses on a negative or unsure review, a submitted composer follow-up or a new user prompt from the owning session resets both round counters. User prompts can start with HTML. After Claude’s /clear, the first typed correction counts and the replacement conversation’s Stop resumes the review. On the same live Codex terminal, a correction moves the card to Running. Escape moves it to Review with Interrupted and leaves the composer available. Each automatic repair uses one round. The Markdown findings file includes the acceptance commands, coverage statement and output excerpt supplied to the reviewer.

More → Follow-up can send to the idle terminal after its own Stop. A session or child approval blocks the paste and a delayed Enter. A matching answer must have a later hook timestamp than the request, even if the hooks reach the file in a different order. An equal or missing timestamp leaves the approval pending. SessionEnd invalidates the earlier Stop. When the board resumes the terminal during a standing Finish, it assigns that launch an ID. The Stop must carry that ID and belong to the owning session. After that Stop, a user can also send from the composer after Escape interrupts a later Codex turn in the same session. An untagged child completion can answer a matching untagged approval. An approval from the replacement launch stays pending through its first SessionStart, even if the request was recorded or delivered before that start. A response from that launch or a later owning restart can clear it. A saved resume without a launch ID requires a fresh Resume for composer delivery.

A recorded promptless resume accepts the first user instruction even when Codex reports it before SessionStart. When the launch provenance is unknown, the first resumed turn leaves the counters exhausted. A later instruction can reset them. An echoed launch prompt, a provider notification, a peer-agent message or another session’s Stop leaves the standing request waiting.

Open report opens the selected card’s saved Finish report. Open findings opens the document from its latest saved review. If the selected document is unavailable, the board reports the error.

Automatic Finish allows two review corrections and two child merge retries per run. A conflict uses only a merge retry. Finish compares each unmet rule with the declaration on the master or child that owned it at review time. Reordering rules or rephrasing a finding about a fixed rule leaves the card in Needs input when the same set remains unmet. Replacing a rule or its child allows another correction within budget. An unchanged list distinguishes duplicate rules by position. Older unbound findings use unique matching wording. When opening an older run with a combined counter, Finish charges prior rounds to merge retries if there is no saved review. With a saved review, it assigns identifiable recent conflict prompts to merges and retains the remaining review charges. A manual Review, Accept prompt, or a submitted user follow-up resets both counts.

An owner that takes over during an automatic review records the interruption on both the review and Finish. The card replaces both progress messages with a Review retry. While the request waits for Review, replaying a Stop or passing check leaves local main and its remote in place. Periodic deliveries already queued for that card also wait for explicit review. A manual Done can continue the original Finish request through its usual delivery checks.

Done Review labels each log with the saved job’s command in execution order. A passing run can support the current criteria when its receipt agrees with the job and the rule, commands and clean revision still match. A stale or incomplete run remains visible as history. Retry checks records new evidence and keeps the previous run under the normal retention policy.

- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 990acbea (inherited native VSCodium development-host checks). A follow-up changed a Done chip to “Done, worked since”. The Not done panel opened automatically and stayed closed after a manual close and redraw. A plain card’s reviewer input included its passing check, and each numbered or bulleted item received one finding. A separate generated Markdown report reproduced the reviewer’s check block. Two Codex terminals each started with two seeded prior rounds. On each card a genuine Not done review reached the limit. A composer correction on one card and direct terminal input on the other kept the standing Finish request. Each next review ran at round 0 and sent one automatic repair at round 1. Both observations ended at delivery, before a final Done verdict.
- ui: "Review this card's work against its Done when, on Fable or Astra at medium effort. Uses account usage." "Reviewing… ({} · {} effort)" "Reviewing… (the agent's default model)" "Not done" "Unsure" "Done, worked since" "This review is older than the card's latest work. Press Review to review it again." "Review: {}" "Accept prompt" "Send this prompt to the card's session" "Sent to the session." "On the clipboard: paste it into the session." "Open findings" "Open the review's findings, reasoning and prompt in an editor tab" "Send answers" "The reviewer reviews this card again with your answers" "Send answers is off: {} Your answers are kept." "Prompt for the session" "Review findings" "Finishing: {}"
- what: A Review button on a card with a Done when condition asks a reviewer model to judge the card's diff and untracked files against each condition and shows a Done, Not done or Unsure verdict with its findings.

## F98 New plan files go where Run a plan… lists them
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done (inherited historical status; not revalidated for this distribution)
- what: A plan file a card writes in its worktree is also placed where Run a plan… lists it, so it can be run before the card is finished.

## F100 Toggle buttons for every on/off choice
- windows: done (inherited historical status; not revalidated for this distribution)
- linux: done 1ec18a2d (inherited historical status; not revalidated for this distribution)
- what: Every on/off choice on the board is a toggle button that shows its state by colour and explains itself on mouse-over.

## F99 Plan first writes a plan file; a finished plan is archived
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done b77fa799 (inherited native VSCodium development-host evidence across revisions). An approved two-step plan ran from its card and was archived on completion. A one-step plan ran without a file. A variables plan remained available for reuse. A later check opened inline setup from a card with a recorded plan. On the final tested build, the planning reply and forced continuation both carried the full Haiku model ID. The same session's next Stop after a one-shot hook block recorded `stop_hook_active: true`.
- what: Plan first writes the approved plan to a plan file, keeps the card's chosen Claude model during planning, and archives a finished plan.
- ui: "Planning prompt" "What a Plan first card is sent: this text with your task in it. A plan of two or more steps goes to workflows/ as a file, so Run a plan… lists it." "Run this plan now" "Run the plan this card wrote. It shows the steps first; nothing starts until you press Run."

## F101 Prompt row: Load handoff
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done 80f4016 (inherited historical status; not revalidated for this distribution)
- what: A row above the prompt box holds Run a plan… and Load handoff; Load handoff puts a chosen handoff file from the repository's handoff folder into the prompt box.
- ui: "Load handoff" "Pick a handoff doc from docs/handoffs/ and put its text in the prompt box. Nothing starts."

## F102 Right-click a helper button to pick its provider, model and effort
- windows: done 83de40a (inherited historical status; not revalidated for this distribution)
- linux: done 896ae320 (inherited native editor checks. Review showed its chosen model and effort on hover, Refine ran on its chosen model, and the Improve prompt menu showed one entry per offered family with its newest label across all four providers.)
- what: A right-click on a helper button (Refine draft, Improve prompt, Use answers, Review, Finish) opens a menu to pick the provider account, model, effort and, for Finish, permission mode that action uses by default.
- ui: "Right-click to pick another provider, model or effort." "Right-click to pick another model, effort or permission mode." "Finish runs on the card's Claude account, which holds its conversation." "This helper runs without tools, so it has no permission mode." "Your pick: {}. Right-click to change it." "{} · {} effort" "Provider, model and effort for {}" "Provider" "Card's account" "Selected account" "Default" "Permissions" "Reset to default" "Refine draft uses {} · {}; Improve prompt uses {} · {}" "Refine the draft again with the answers shown, suggested ones included"

## F103 Error log for Review and Finish
- windows: done 8845279 (inherited historical status; not revalidated for this distribution)
- linux: done a147963 (inherited historical status; not revalidated for this distribution)
- what: Every Review or Finish that ends without completing is recorded as one line in the board's error log with its stage, provider, model and redacted error output, and can be opened from the notice.
- ui: "Show log" "Open the Entomatical Output channel, where each Review or Finish that did not complete is logged"

## F104 Everything stays inside the workspace
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done ccfac2b (inherited historical status; not revalidated for this distribution)
- what: Entomatical runs only in a saved workspace whose folder is a git repository's top folder, and keeps its worktrees and temporary folders inside that workspace.

## F105 Battle Royale
- windows: done 571967b (inherited historical status; not revalidated for this distribution)
- linux: todo (inherited historical status; not revalidated for this distribution)
- what: Battle Royale starts one card per provider from one prompt, each on that provider's top model and effort, after clearing the board's running cards.
- ui: "Battle Royale" "Cards to shut down: {} · runs: {}" "Yes" "No" "Estimated water about to evaporate: {} litres" "Yes, I'm sure! Now make them fight!" "Attention, crawler! Press this and {} models fight over your one prompt at top effort, each in its own card terminal. Your wallet has been notified. It is crying." "The \"I can't write a decent prompt so I'll throw {} models at it\" button. Go on, you've earned it. Not really." "Press me, coward. {} models, one prompt, and not a single brain cell involved. Yours, specifically." "{} models doing a job one could do, because you can't make a damn decision. Classic you." "For when one model ignoring your vague garbage prompt isn't enough. Now {} of them can ignore it at once." "Click here to set fire to {} models' worth of tokens. Very mature. Very adult. Very broke." "Oh, you again? Fine. {} models, one prompt, and your bank account as the guaranteed loser." "Side effects include {} times the bill and zero times the competence on your end of the keyboard." "Hire {} geniuses to clean up the mess you typed. They'll still blame you. Rightly." "Go ahead, press it. Nothing says \"senior developer\" like {} AIs doing your homework while you eat crisps." "WARNING, CRAWLER! Put the mouse down and step away from the button, you absolute walnut." "Oh look, it's you again. Bored? Broke? Both? Let's find out." "Congratulations, genius. You found the most expensive button in this whole damn extension." "Hey, dumbass. Quick reality check before you set your money on fire." "Wow. Couldn't pick one model, so you're hiring all of them? Peak leadership." "Listen up, you magnificent waste of electricity." "Ah, Battle Royale: the button for people whose prompts are too weak for one model." "STOP. Read this. Yes, actually read it. I know that's hard for you." "Back for more? Your bank called. It wants a restraining order." "Alright, big shot. So your prompt deserves a whole damn tournament now?" "Is this a good idea? No. Proceed anyway, like you always do?" "Any sane developer would press No. So, Yes?" "Your call, champ. It's always your call, and look where that got you." "Press Yes if you hate money. Press No if you own one working brain cell." "Go on. Make the worst decision of your afternoon." "Proceed? I'm not your mother, but she'd say no too." "Think it over. Ha, kidding, you never do. Proceed?" "Yes or No. Even you can manage two buttons." "Last chance to pretend you're a responsible adult. Proceed?" "Do it. I dare you. Coward." "Here is what you're about to do. One: every running card on every board in this window gets 30 seconds to save its work. Two: they're shut down and parked in Review, where you can resume them later if you can be bothered. Three: leftover agent processes are hunted down and killed. Four: {} absurdly expensive models get your one prompt, every permission, and nobody to stop them." "Here is what you're about to do: {} absurdly expensive models get your one prompt, every permission, and nobody to stop them. Your running cards are left alone, so they get to fight the newcomers for memory and rate limits too." "New achievement: Money Is No Object! Oh, you must be SO rich. Your reward: the same answer, {} times, slightly different." "Achievement unlocked: Can't Pick A Model! {} answers incoming, and you'll still copy-paste the wrong one." "Bold. Stupid, but bold. {} models are sharpening their knives over your half-baked prompt." "You actually pressed Yes. Of course you did. {} times the tokens, same old you." "Fantastic. {} frontier models are about to read the prompt you wrote in four seconds. They're embarrassed for you." "Achievement unlocked: Climate Villain! {} data centres just sighed in unison." "Oh good, you're committed. To being wrong, mostly. {} contestants are warming up." "Brave little crawler. {} models enter, one answer survives, and you still won't read it properly." "Look at you, CEO of {} robots and still unable to name a variable." "Yes? Really? Fine. {} models, one prompt, and a bill you'll pretend not to see." "Yes, burn my money!" "Yes, I have no self-control!" "Yes, I'm an idiot, release them!" "Do it, I hate my wallet!" "Yes! Let the bloodbath begin!" "Fight, you expensive bastards!" "Yes, and I won't read any of it!" "Unleash hell (and the invoice)!" "Yes, I'm sure, stop judging me!" "The arena is being swept while you read this."

## F106 Tokens per passed task
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done 1ec18a2d (inherited historical status; not revalidated for this distribution)
- what: Model efficiency counts tokens per passed task as well as tokens spent, from each Done card's outcome. The prompt outcome report joins Create and Battle receipts by allocated card ID. A restored draft recovers its helper attribution from host evidence. A helper without supporting evidence is marked unknown. The report reserves recorded IDs first. An older receipt without an ID contributes only when its prompt prefix matches one remaining card and no other receipt competes for that card.
- ui: "{}/{} passed · {} per passed task · follow-ups {}" "Passed: acceptance checks passed, or Review said done. {} failed (discarded, or checks failed), {} unverified. Per passed task: all tokens of these cards, failed ones included, divided by the passed ones; {} without cache reads.{}" "Too few cards to compare (under 5 measured)."

## F107 Refine draft: a handoff becomes a task prompt
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: done 80f4016 (inherited historical status; not revalidated for this distribution)
- what: Refine draft recognises a handoff file in the prompt box and turns it into a task prompt.
- ui: "Handoff detected: writing a task prompt from {}." "Handoff mode: a task prompt for a new session, written from {}. Apply replaces the handoff in the box."

## F108 A card's work reaches the main folder every three turns
- windows: done c6002d0 (inherited historical status; not revalidated for this distribution)
- linux: todo (inherited historical status; not revalidated for this distribution)
- what: A card's work is delivered to the main folder at a set number of turns and at Review, so work parked in a worktree stays visible. A board delivers one card at a time; Finish, Merge and Discard wait for a delivery under way, and a Merge or Discard of a card that Finish already holds is refused.
- ui: "In main folder" "Delivered {}: {} files, commit {}. Entomatical brings this card's work into the main folder every {} turns and when it reaches Review." "Delivered {}: {} files, commit {}. {}" "Not in main folder yet: {} changes" "Next delivery in {} turns, or when this card reaches Review. Finish delivers it now." "Automatic delivery is off (entomatical.deliver.everyTurns is 0). Finish delivers it." "Not delivered: {}" "Delivery refused {}: {}" "Not in main folder yet: {} change{}" "Entomatical does not deliver this card by itself. Its work reaches the main folder when it is finished."

## F109 Improve keeps its specification through Add task and resume
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done (inherited historical status; not revalidated for this distribution)
- what: An Improve result shows the settings the task will run with, and the exact improved specification is kept through Add task and resume. Resume records one launch for the first turn or one resume for a continuation. Opening a busy or waiting session or clicking again during dispatch adds no receipt.
- ui: "Runs with your settings: {}" "Capabilities: Provider defaults (the account's own MCP servers, skills and plugins, as the provider is set up). Improve does not change these settings." "Settings changed after Improve ({}). Improve again to keep the improved specification, or send the text as written without it." "Your draft changed after Apply, so it will be sent as written, without the improved specification. Improve again to keep it." "The improved specification could not be saved, so the text will be sent as written, without it." "Improved spec r{}" "Accepted from Improve prompt: {}{}. Settings: {}.{} Capabilities: {}." "Set by the form's options: {}." "Plan first on Codex runs Astra at ultra effort." "Delegation defaults to Bypass permissions." "Settings changed since Improve" "Prompt differs from the improved specification" "The saved specification no longer renders to the text that was accepted." "The first prompt no longer contains the accepted text." "Specification unreadable"

## F110 Capability profile choice (strict profiles blocked until verified)
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done (inherited historical status; not revalidated for this distribution)
- what: Tasks can pick a capability profile (MCP servers, skills and plugins per provider); strict profiles stay blocked until their enforcement is verified.
- ui: "Capability profile for new task" "Capabilities: Provider defaults (the account's own MCP servers, skills and plugins, as the provider is set up)." "Provider defaults" "{} ({}) r{}" "Blocked: {} r{}: {}" "Show all" "{} r{} runs with exactly its manifest." "Profile {} r{} · blocked" "Profile {} r{}" "Pinned {} r{}; later edits of the profile do not change this card." "Provider defaults" "Run with Provider defaults instead" "Drop this card's strict capability profile and inherit the account's own MCP servers, skills and plugins. You see the list first; the choice is recorded on the card."

The offline strict probe follows one interactive session's main transcript from its root through its first reply. It requires an initial agent listing and an explicit deferred-tool list before that reply. An empty list can pass an empty manifest. Missing, malformed or ambiguous evidence produces an inconclusive result and a nonzero exit. The report lists declared MCP servers, failed connections, pending connections and servers requiring authentication separately. Only a server declared before the first reply can satisfy the manifest. Synthetic API and CLI checks cover this verifier. Native route verification is separate.

The new-task profile check, account-switch check and Provider defaults preview read the selected Grok home. On confirmation, the board checks ownership and reads the saved board even when its file timestamp is unchanged. It rechecks the card’s inventory, including sources it could not list. A changed account, home, strict profile or inventory requires a fresh preview. If the preview still matches, the board records the decision on the current card and preserves unrelated edits to the board. Dismissing the dialog keeps the strict profile.

A draft keeps the selected capability profile and revision across reloads. If the profile disappears or its revision changes, Add task waits for an explicit profile choice. The browser fixture checks that the held profile reaches the host and the card remains queued.
- ui: "Choose a capability profile" "The saved capability profile is unavailable or changed. Choose a capability profile for this draft."

## F111 Governed runs: delegable profiles, execution leases, assignments, submissions, project view
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 1ec18a2d (inherited historical status; not revalidated for this distribution)
- what: A root orchestrator can start a governed run with explicit limits, delegable profiles, execution leases, assignments and submissions, shown in a project view.
- ui: "Approve as a governed run" "Active executions (root, coordinators, workers, judges)" "Direct active children per card" "Delegation depth" "required" "Children may use {}" "Default child profile" "No default (each add names one)" "Governed run" "No defaults: the team limits are an open decision (O2). The master plan proposes 6 active, 3 direct children and depth 2; type your own." "Profiles children may use" "Only your Finish on the root takes a governed run to the target, after the board's readiness check; push is a separate choice there. Children reach the root's branch by Integrate (Merge on the child). Delivery and finish self stay off." "Choose at least one profile children may use" "Approve as a governed run: execution leases, delegable profiles, assignments and submissions" "Project: {} running · {} queued · {} waiting · {} blocked · {} ready to integrate · {} decisions" "Governed · {} of {} active" "Governed run: at most {} sessions at once, {} direct children per card, depth {}. Children may use {}{}. Only your Finish reaches the target, after the readiness check; delivery and finish self stay off." "Governed · submitted {}" "Governed · {}" "{}Profile {}{}{}. Merge integrates its submitted commit into its opener's branch after the readiness check; it never reaches the target by itself." "Governed run {} has no root on the board; this card is blocked." "Card of governed run {}." "Children of this governed run may use this profile; it is pinned when you press Approve" "{} · blocked" "Why {} is blocked on {}"

## F112 Governed integration and Finish: revision-bound readiness, separate push, operation recovery
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 6178625e (inherited historical status; not revalidated for this distribution)
- what: A governed run integrates each child's submitted commit and finishes only after a revision-bound readiness check; pushing is a separate step and interrupted operations can be recovered.
- Confirmations bind the card, run, action, candidate, destination and acknowledged conditions. Finish shows the push destination revision when available. A change while either dialog is open or during the final readiness check expires the choice and shows the current details. Integrate computes the merge from the two commits, locks the destination checkout and index, and updates the named branch only from its confirmed old revision. A conflict leaves both checkouts intact. An interrupted checkout keeps the child and requires inspection of the operation, branch, index and files. Governed integration requires Git support for merge-tree --write-tree and update-ref symref-verify. Finish uses the same checkout, index and named-ref locks for the local fast-forward and holds them through any selected push. A stale or obstructed local destination prevents the push. Finish records a successful push before changing local files, so an interrupted checkout can be recovered without repeating it. The push verifies fast-forward ancestry and the exact expected remote revision, including an absent branch. The local merge button grants only a local merge. Covered in disposable Git repositories by `test/governed.test.js`.
- ui: "Governed · conflict in {}" "Governed · integrated {}"

## F113 Milestone council: saved members, fixed packages, independent read-only judgments, reconciliation and the readiness gate
- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: done 0bd7c705 (inherited historical status; not revalidated for this distribution)
- what: A saved milestone council gives independent read-only judgments on fixed review packages and reconciles them before the readiness gate.
- ui: "Council: {}" "Council…" "Council" "No council" "{} r{} ({} member{})" "Council member {} · {} round {}" "Saved councils unreadable: {}" "{}. Members: {}. At most {} rounds per checkpoint without a pass; unavailable members: {}. Finish re-checks every pass against the current candidate and target." "Convene a checkpoint, read the full council record, or decide after the round limit" "A saved council (workflows/councils.json) reviews the checkpoints it lists, read-only, before your Finish; pinned when you press Approve" "Read-only review of one fixed council package for governed run {}. Its judgment counts only if its worktree stays unchanged; it opens no cards."

## F114 Run evidence: archive manifest, retained evidence, Export and measurements by role
- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: done 0df09a31 (inherited historical status; not revalidated for this distribution)
- what: Archiving a run writes a manifest of its retained evidence, which can be exported, with measurements by role. The comparison CLI accepts both task ledger formats and reports zero runs for an empty board. Archive and operations directories are optional. The CLI validates card status and outcome fields, archive evidence kinds, and operation receipts before counting runs. An archive filename must name its master, with an optional timestamp suffix. Each operation ID can occur only once per archive. Unreadable or invalid inputs produce an error naming the source.
- ui: "Export" "The run's export as JSON: exact specification, settings, profile, harness, source and review identities, retained evidence with its gaps, and tokens by role (unknown stays unknown); secrets redacted"

## F115 Identifier rename: `entomatical` settings, commands, folders and extension id; an unmoved old folder stops the board
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 430189b2 (inherited native VSCodium checks in isolated development hosts). An old workspace folder and an old home folder each blocked the board with one migration error. After each disposable cutover, reloading the same window showed its queued fixture card. The home marker survived its move. Coverage was limited to these fixtures and the development build.
- what: Settings, commands, views, data folders and environment variables use the lower-case `entomatical` identifier; a data folder left under the old identifier stops the board and names the migration step.

## F116 Run a plan setup

The picker keeps each model reviewer's source permission through preview, presets and launch. The role summary displays that permission. The editable reviewer settings are account, model and effort.
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done 7667e6f0 (inherited native checks of v1 plans in isolated VSCodium development hosts). Pointer and keyboard checks covered setup, graph edits, Save As cancellation and collision, cross-plan presets, stale-source refusal and draft restoration after cancel and reload. A checks-only run used scripted webview controls and real worker and helper sessions. In real Claude model-reviewed runs, the preset preserved the target reviewer’s edits permission at launch and resume. All four roles ran. Plan-level Stop interrupted a worker and Resume restored the original sessions through delivery readiness. A preview-only retest showed Claude plan mode for the judge in both disclosures. With an edits reviewer and no scribe, changing the sole worker from edits to bypass changed the warning count from zero to one.
- what: Selecting a plan opens a tabbed setup for variables, worker defaults, review roles, step exceptions, dependencies and presets before the run starts.
- ui: "The reviewer may open additional cards within this run’s limits." "Run a plan setup" "Cannot load this plan: {}" "View original plan file" "Worker defaults" "Apply defaults to all steps" "Review and standing roles" "Run summary" "Review effective run settings" "Run plan" "Cancel plan" "Save dependency edits as new plan" "Setup" "Steps" "Dependencies" "Presets" "Saved preset" "Preset name" "No saved presets"

## F117 Allow delegation on an existing card
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done c375855a (inherited native VSCodium development-host checks). An existing Review card received the delegation brief in its terminal, posted a note and submitted a plan that showed an Approve button. The converted card, a plan, its step and a Done card all omitted Allow delegation from their menus. A native editor session ran the staged CLI by its absolute path and received its own queued brief once. A second read returned an empty list.
- what: Allow delegation on a card's menu lets its agent propose work and manage children after approval.

## F118 A renamed or moved workspace folder keeps its cards
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done a19883b7 (inherited VSCodium development-host evidence). After the closed workspace was renamed, the saved worktree followed it. Resume restored the same conversation, Open focused its terminal and Finish landed the work after Git worktree repair. A headless board check also verified all five saved path fields.
- what: Cards keep working after the workspace folder is renamed or moved: their saved paths into the board's folder follow it.

## F119 A plan step may open its own cards
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done e390789b (inherited historical status; not revalidated for this distribution)
- what: A plan step marked `mayOpen` is a coordinator that may open its own cards; the step is accepted only when every card it opened is Done or cancelled. The effective settings identify each step with that permission.

## F120 An orchestrator closes a card whose work has landed (`board.js finish <id>`)
- windows: done d39d486e (inherited historical status; not revalidated for this distribution)
- linux: done b161fe8b (inherited native VSCodium development-host checks). An earlier real Codex root closed a landed child and received a refusal for an unmerged child. The post-merge run repeated both with a synthetic controller, approval and child records. A live writer kept its worktree through refusal. Retry after exit removed it without moving main. With a vault configured, Finish used local main, refused a child outside it and made zero helper calls.
- what: `board.js finish <id>` lets an orchestrator close a card whose work is already in the target branch; it never commits, merges or pushes. A stopped writer can delay removal. Once the writer exits, the caller can retry cleanup. In a vault-configured repository this command checks the local branch and leaves uploads to the user.

## F122 Sync models: a provider's model list from the provider
- ui: "Models" "Sync models" "Provider to sync models for" "Ask this provider which models it lists now and update its model list"
- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: done 2b6fed3e (inherited native VSCodium development-host check, Codex only). One Sync models click listed all ten IDs in CLI discovery order. The new-task, plan worker default and individual plan-step menus grew from one model to ten and showed the newly discovered default. Grok, Antigravity and Claude were untested through the sync button.
- what: A Sync models button asks one provider which models it lists now and updates that provider's model list: Codex `model/list`, Antigravity `agy models`, Grok `grok models`, and for Claude the Anthropic API `/v1/models` with ANTHROPIC_API_KEY (without the key the sync says so and nothing changes).

## F123 Model menus list every model by name and version; the default is named
- ui: "Default: {}"
- windows: todo (inherited historical status; not revalidated for this distribution)
- linux: done 1ae94645 (inherited native VSCodium development-host checks). New task and plan setup showed four versioned Claude names, ten visible Codex IDs and each account’s named default. Grok showed its profile default in the terminal form and four advertised choices plus the named default in the delegated and plan menus. Improve prompt showed the newest version of each offered family. An older listed Codex ID appeared in the launch arguments and Session details. The ordinary Antigravity form matched the 27 ordered CLI entries and selected its first concrete model. Delegated new task and plan worker setup each matched the 11 choices from the opening ACP session and displayed “Default: Gemini 4 Neon”.
- what: The new-task form and Run a plan setup list every model the provider's CLI lists, each with its name and version, and a listed exact id is stored and run as picked; a short name still runs the newest version (F92). The first entry names the account's default model where it is known ("Default: Fable 5.2") and stays "Default model" where it is not. The helper picks keep one entry per name, the newest version, labelled with it.

## Not UI
- ignore: "Enter" "Escape" "Tab" "{}px" "{}:manage"
