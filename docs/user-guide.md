# Entomatical user guide

This guide covers Entomatical 0.8.25. Availability and native verification vary by provider, editor and operating system. Start with the [README](https://github.com/r-spring/wyarden#readme) for prerequisites and VSIX installation.

## Set up the workspace

Entomatical needs three things in the window before the board runs: a folder open, that folder a git repository's top folder (`git init`), and the window saved as a workspace (**File → Save Workspace As…**, a `.code-workspace` file). If any is missing, the board shows "Entomatical needs a saved workspace with a git repository folder." followed by the steps to fix it; reload the window afterwards. In a multi-folder workspace the first folder holds the board.

All worktrees and temporary folders stay inside that folder, under the git-ignored `.entomatical/`: worktrees in `.entomatical/wt/<card>`, temporary folders in `.entomatical/tmp/`. Each card's sessions and acceptance checks get `.entomatical/tmp/<card>` as `TMP`, `TEMP` and `TMPDIR`, deleted when the card is finished or deleted; helper calls use `.entomatical/tmp/helpers`, dictation `.entomatical/tmp/speech`, and `npm test` in Entomatical's own repository `.entomatical/tmp/t-*`. A marker file, `.entomatical/tmp/ENTOMATICAL-TEMP-ROOT`, makes git (through `GIT_CEILING_DIRECTORIES`), `board.js` and the board's own searches stop there, so nothing made below it is taken for the repository or board above.

## Set up a provider

Install the provider's CLI and complete its sign-in before starting work. It must be reachable from the editor's environment. An editor extension alone does not supply the standalone CLI Entomatical needs. Use available model/effort choices rather than a fixed model list. Provider access and usage remain your responsibility.

| Provider | Session setup | Limits |
|---|---|---|
| Claude Code | Use `claude`. Panel mode also needs its editor extension and **Entomatical: Open Tasks in Claude Code Panel**. **Entomatical: Use Terminal Instead** switches back. | Panel mode configures Entomatical's process wrapper. CLI/editor upgrades can change this integration. |
| Codex | Use a separately installed `codex`. Sign in through **Entomatical: Add Codex Account** or the CLI. Editor mode also needs the Codex extension; `entomatical.codexStart: "terminal"` selects terminal mode. | One local Codex account. Hook and repository-trust approvals may be needed. |
| Grok | Use its CLI and signed-in profile; the board's Grok connection controls start browser login. | Ordinary tasks use a card terminal and the agent's default model/effort. Unattended runs use the agent protocol and advertised choices. |
| Antigravity | Use `agy` and **+ Connect Antigravity** for its Google sign-in. | Shared local sign-in; ordinary tasks use a card terminal, unattended runs the agent protocol. Choices depend on CLI discovery. |

Grok and Antigravity terminals clear inherited API credentials to use their selected local sign-in. Initial prompts travel as process arguments, visible to local processes with permission to inspect them. Card-terminal output is held in memory and can be lost after reload or a new terminal start.

### Claude panel and history

Entomatical sets `claudeCode.claudeProcessWrapper`. A Windows launcher starts the shared Node wrapper; Linux runs the wrapper directly. Ordinary calls pass through; board launches receive the task worktree, hooks, account folder and prompt. A pre-existing wrapper is recorded and chained; **Use Terminal Instead** restores it.

Entomatical hard-links Claude transcripts into the repository's project history and, where needed, the selected account's history. These are additional names for the same transcript, not copies or transferred logins. Board conversations can therefore appear in local panel history before and after worktree cleanup. Launch files retain task/account information for reopening.

**Entomatical: Switch Claude Account** or **Use in IDE** changes the account for new Claude panel chats by updating `CLAUDE_CONFIG_DIR` in Claude Code's `environmentVariables`, preserving other entries. Existing sessions keep their accounts; reload if the panel shows the previous one. Browser login can land on the account already signed into the website: verify the reported identity. Login management runs the provider CLI; web settings open with the browser's current account.

### Codex startup and approval

On Windows with `chatgpt.runCodexInWindowsSubsystemForLinux` enabled, Entomatical discovers the first WSL distribution whose name starts with Ubuntu and uses `codex` on its login PATH. Otherwise discovery uses `entomatical.codexPath`, then `chatgpt.cliExecutable`, then `codex` on PATH. It does not use the Codex extension's bundled CLI. Reload after changing the CLI path or WSL setting.

If WSL does not answer at startup, Codex tasks fail to start rather than silently switching to Windows Codex. **Check Now** requests another check; Entomatical also retries in the background at thirty-second intervals. When WSL answers again, use **Reload Window**. Windows Codex also refuses to resume a session recorded in WSL; enable the WSL setting and reload to resume it there.

When the WSL distribution has a running systemd user manager and `systemd-run`, Entomatical launches Codex in a scope with a memory limit of 33% of the VM and a 2 GiB swap limit. It requests an 85% combined memory limit for its Codex slice and sets `OOMPolicy=continue`. Without that user manager or command, Codex launches directly without these limits. These settings do not guarantee recovery from every out-of-memory condition.

Identity, models, effort and rate limits come from the CLI's app-server protocol. Entomatical can ask you to approve its status hook and trust the repository. Codex writes approved settings through its configuration API. Declining leaves the card queued; unrelated hooks retain their own approval requirements. A changed Entomatical hook definition asks again.

In **editor** mode, Ask and Auto open the interactive Codex terminal so you can answer approval requests. Ask starts read-only and Auto starts with workspace-write. Bypass starts with full access and approval set to never. Judge and research cards always start with a read-only sandbox. For Bypass, the permission-aware panel bridge opens the editor before the turn. With an older or absent bridge, the turn runs in the background and the editor opens afterward. **Terminal** mode runs interactively in the worktree, with follow-up, Stop and Resume.

When resuming an older editor conversation, the board reapplies the selected permissions in a terminal on the same thread if it cannot confirm the editor started that thread with the required sandbox and approval policy. An ordinary older card without a permission selection can still reopen in the editor. An unrecognized saved permission blocks Start and Resume until corrected.

**Entomatical: Enable Immediate Codex Panel** is an optional private, reversible patch for a specific checked Codex extension build. It refuses unknown versions or changed files; **Entomatical: Restore Original Codex Panel** restores its original. Updates may remove the patch. Recorded exercise used an isolated Linux host with a simulated model, not general Windows acceptance. Ordinary use does not require it.

## Create a task

Choose a title, prompt, account and optional model/effort. **Default** leaves the provider's choice. The session's own model picker can still change that session.

New cards auto-start unless `entomatical.autoStart` is off. Positive `entomatical.maxRunning` limits automatic starts; `0` means no limit. Manual **Start** can go ahead despite that limit. A failed auto-start leaves the card saved for retry.

Start creates or reuses `.entomatical/wt/<id>` on `task/<id>`. Subtasks branch from their parent. Worktrees separate working copies; they do not restrict tools, accounts or access beyond the session's permission settings. Found external sessions need not have board-created worktrees.

**Card terminal** embeds a resizable terminal; Grok and Antigravity ordinary tasks always use it. Claude can also use its panel or a normal terminal. **Open** brings the session into view. Terminal follow-ups support multiline text and **Ctrl+Enter**, but are refused during Needs input; answer that request in the session. In an editor panel, type there.

**Plan first** is Claude-only for an ordinary card's first turn. It restores the selected permission mode after that turn or plan approval. It is unavailable for other providers and does not replace orchestrator approval. Ticked, the form shows the **Planning prompt** the card is sent (`docs/orchestrator/PLANNER.md` with your task last): after you approve the plan, the card writes it as a plan file in `workflows/`, so **Run a plan…** lists it.

### Titles and prompt helpers

The automatic-title checkbox currently reads **Haiku title**. A typed title wins and avoids its helper call. With no title, the checked option generates a name using a provider-specific helper; unchecked, the prompt's first line is used. The UI label does not imply one helper model across providers.

**Rename** and **Generate title with Haiku** use provider-specific naming paths. Claude terminal sessions can use `/rename` while idle; a session in another window must be renamed there. Saved-title readback does not guarantee immediate live-tab synchronization; reopening a Claude tab may be needed.

**Refine draft** proposes a goal and milestones, with up to three clarification questions when needed. It runs in a separate editor tab; **Show progress** returns there. Apply, keep the draft or restore the original. The helper model is shown separately from task settings. Refinement does not start the task, times out after ten minutes, and can be cancelled. Drafts/proposals survive a webview reload; interrupted calls require retry.

**Improve prompt** prepares an execution prompt on the selected account's refinement helper. Apply and Restore refuse to overwrite intervening edits; contradictions are reported without applying anything. It uses quota, does not start work, and has no established guarantee of improving results.

**Entomatical: Review Prompt (Experimental)** compares two Codex rewrites with a third helper's review. Output is read-only, never applied automatically. It needs a signed-in Codex account, uses quota and may take many minutes.

### Completion rules

**Done When: Fable** optionally generates the task's goal and “Done when” sentences before adding the card (Fable at high effort; a Codex task uses the Claude IDE default account, and a Grok or Antigravity task its own agent's default model). The card shows “Done when: …” and who wrote it. Ordinary cards get no check commands; with **Orchestrator** ticked it also writes commands that check the run's work when it reaches Review. Generation failure warns and allows a task without a rule; cancelling restores the draft.

An orchestrator's checks run in the worktree at Review, with running/passed/failed states, **Retry checks** and logs under `.entomatical/checks/<id>`. Generated commands judged to change files or reach the network are dropped with a warning. This is not a general sandbox for sessions or workflow commands. Passing checks do not prove task acceptance by themselves.

### Review against Done when

**Review** appears on a card that has a Done when and work to look at. A reviewer model (Fable on Claude, the newest Astra on Codex, at medium effort; the agent's default model on Grok and Antigravity) reads the card's diff and untracked files against each Done when condition. It uses account usage and runs only when you press it. While it runs the card shows “Reviewing…”.

- **Done** (green chip), **Not done** or **Unsure** (orange chip) is the verdict; the card lists the findings.
- On Not done, **Accept prompt** sends the reviewer's prompt to the card's session, or puts it on the clipboard when the session cannot take it.
- On Unsure, answer the reviewer's questions (each starts with a suggested answer) and press **Send answers** to review again. It is off while the card is not in Review (its session is running again, say); your answers are kept until it is back.
- **Open findings** opens the review's findings, reasoning and prompt in an editor tab.

An orchestrator that runs `board.js finish self` is reviewed the same way at its Stop, and on Done the board finishes the run by itself (“Finishing: …” on the card, then **Open report**). The verdict is a model's judgement, not proof the work is right.

## Status, review and integration

| State or hint | Meaning |
|---|---|
| Queued | Saved; waiting for start, dependency or capacity. |
| Running | Session activity is being observed. |
| Needs input | Open the session to address a permission or interaction request. |
| Review | A turn ended or the session stopped without its normal completion hook. Assess the work. |
| Done | Marked done or completed through integration/cleanup; discarded work is distinguished in dependency handling. |
| Asked you something | A heuristic detected a question in the last reply. |
| Quiet / Repeating | No recent activity or repeated identical tool input. Neither stops work or changes state. |

Prompt/tool hooks generally indicate Running, permission requests Needs input, and turn completion Review. Exits/interrupts have provider-specific handling. Cards show prompt/reply excerpts, latest reply, activity times and recorded workers. Quiet starts after ten minutes without activity and becomes orange at twenty; Repeating detects five identical consecutive calls. These hints are not diagnoses. A worker ending a turn does not establish its goal was achieved.

Notifications open board-created sessions that need input or ended a turn; found sessions do not notify. `entomatical.notifications` controls them. The Done column starts collapsed. Secondary actions are in **More** or the card's native context menu; use source control for diffs.

### Stop, resume and switching

**Stop** ends ordinary terminal sessions and their children; closing a Claude panel ends that panel session. Background/editor interruption is provider-specific. Stopping does not integrate work.

Claude/Codex can resume provider conversations when the session identity is available. Codex terminal Resume uses the tracked thread ID, otherwise the newest session for that worktree. A resume without SessionStart retains the original ID; a different thread selected through `--last` is not necessarily followed.

**Grok/Antigravity card-terminal Resume starts a new conversation in the same worktree**, with a reminder that earlier work remains. It does not reopen the terminal's conversation. Existing agent-protocol conversations have separate resume/history behavior.

**Switch account** is an operational recovery control on unfinished cards. Terminal sessions require confirmation before stopping; other panels/windows must be closed there. Cross-provider changes start a new conversation in the existing worktree after confirmation. Claude account changes can retain the conversation through a transcript hard link. An unavailable assigned login causes start to fail rather than silently selecting another.

### Integration actions

Inspect the worktree's actual diff and untracked files first.

| Action | Consequences |
|---|---|
| Mark done / Reopen | Change status without committing, merging or pushing. |
| Merge | Integrate the committed branch into the repository's current branch, then remove its worktree/branch. Refuses live sessions, running checks, uncommitted task work or tracked destination changes. Does not push. Parent commits may be included with a subtask. |
| Finish | Confirm a concrete plan that can close an idle session, commit remaining files, integrate upstream, **push**, update the local branch, notify related sessions and remove the worktree. Without upstream, integration is local. Refuses work in progress. |
| Discard worktree | Remove worktree/branch and discard unmerged work after confirmation. |
| Delete task | Remove the card, optionally discarding the worktree too. |

Finish can invoke Claude for commit messages or conflict resolution, even for another provider's task; those calls require Claude access and use quota. A later failure reports the step and earlier actions, keeping the worktree where applicable. Earlier commits/pushes are not automatically undone. Finish/Merge can also write to linked context below.

## Larger jobs

Use one card for a bounded job. **Run a plan…** executes known steps in `workflows/<name>.plan.json` or private `.entomatical/workflows/<name>.plan.json`; starter plans live in `workflows/`. Variables and per-item steps are supported. Choose a plan to open its setup. **Setup** contains variables, worker defaults and optional review roles; **Steps** shows each step and its exceptions; **Dependencies** and **Presets** hold the optional editors. The run status and **Review effective run settings** stay available as you switch sections; **Run plan** creates a plan card and its step cards only when validation succeeds. The dependency editor supports drag or move buttons and explicit dependency changes; **Save dependency edits as new plan** saves those edits separately. Personal settings presets contain execution choices, not task text or variables. Cancel returns to your ordinary task draft. A changed source must be selected again. A version 2 plan (governed assignments, typed inputs) does not use the setup: it asks for each input, then shows a preview with dependencies, checks, roles and the effective manifest, and **Run** there is the approval.

Ready steps may wait for capacity. Check-based review can automatically integrate passing steps into the plan branch; model review adds a reviewer. Final Finish remains separate. When a run finishes, its plan file normally moves to `archive/` in its folder (committed on main for `workflows/`), so the list shows only plans not yet run. A plan with variables stays available for reuse, a version 2 plan stays where it is (another run is refused unless it is marked `reusable`), and a changed source file is not archived by that run. A plan chosen outside the workflow folders stays where it is.

An **Orchestrator** plans and divides work as results arrive. Approve its root plan, scope and caps before workers open. Limits cover open/total cards, depth and follow-ups; budgets depend on available measurements. Automatic watchers require explicit approval opt-in, consume slots/model calls and are not enabled by older approvals. Optional judge, scribe and research roles have scoped duties. A judge verdict does not mark work Done. Board child cards and provider-native subagents are distinct.

Some unattended paths default to **Bypass permissions**. Scope instructions do not create a technical sandbox. Run policy `noSync` exports `ENTOMATICAL_NO_SYNC=1` for cooperating external hooks; it does not block networking, suppress hooks that ignore it, or disable linked Asana/Obsidian writebacks.

Run menus offer Pause, Resume, Stop and Archive run. The installed board supplies CLI instructions to its task sessions. Source contributors can inspect `tools/board.js`, `src/plan.ts`, `workflows/` and the runtime role briefs `docs/orchestrator/BRIEF.md` and `docs/orchestrator/REVIEWER.md` for advanced behavior.

## Optional context links

Ordinary cards need neither Asana nor Obsidian. Choose the source with **Entomatical: Choose Context Source** or `entomatical.contextSource` (`none`, `asana`, `obsidian`). Changing the selection does not unlink existing cards or stop their completion writebacks. Unlink cards separately.

**Asana:** use **Entomatical: Set Asana Token** and **Entomatical: Choose Asana Project**. `ASANA_PAT` takes precedence over SecretStorage. Link an existing task or create one when requested. Bounded descriptions/recent comments enter session context. **Finish or Merge posts a comment with up to 3,000 characters of the last reply; Mark done does not.** Existing task names/descriptions are not edited/deleted. Lists are bounded and report truncation. Clearing the project stops list refresh but does not unlink cards.

**Obsidian:** choose a vault/folder accessible to the extension host, link a Markdown note or choose **New Obsidian note**. Up to 6,000 characters enter session context. **Finish or Merge appends up to 3,000 characters of the last reply; Mark done does not.** Existing text stays and deleted notes are not recreated. Discovery lists up to 500 notes, excluding hidden folders/symlinks. **Entomatical: Refresh Obsidian Notes** reloads it; the card's **Obsidian note** menu changes/unlinks a note.

Linking after a conversation started does not retroactively send its context. A writeback failure warns without undoing integration. Using linked context sends that content to the selected coding provider in the prompt.

## Optional speech

Speech is separate from coding-provider access. Select Local Whisper, Local Parakeet, OpenAI, Groq or Deepgram in Dictation or **Entomatical: Speech Settings**. Enable editor microphone access. Linux needs `arecord` from `alsa-utils`; Windows uses the packaged recorder. Local engines/models are separately installed.

### Dictate into a terminal

Focus a running VS Code terminal and press **F8**, or run **Entomatical: Dictate into Terminal**. F8 again stops recording and inserts any final transcript. The transcript goes to the terminal selected when recording began, even if focus moves. Entomatical inserts it as pasted text without pressing Enter. Review it before submitting it to a shell or coding agent. Closing that terminal cancels dictation and discards late text.

This uses the same saved speech provider, model, API key and microphone as board dictation. The status bar shows recording/transcription progress; **Entomatical: Cancel Dictation** cancels it. F8 is bound while a VS Code terminal has focus; it is not a shortcut inside the board's embedded card terminal. If `terminal.integrated.sendKeybindingsToShell` is on, turn it off to use the shortcut. Entomatical adds its command to the global `terminal.integrated.commandsToSkipShell` setting so the shortcut stays in the editor. Live microphone acceptance for this shortcut remains pending on Windows and Linux.

### Dictate into a terminal

Focus a running VS Code terminal and press **F8**, or run **Entomatical: Dictate into Terminal**. F8 again stops recording and inserts any final transcript. The transcript goes to the terminal selected when recording began, even if focus moves. Entomatical inserts it as pasted text without pressing Enter. Review it before submitting it to a shell or coding agent. Closing that terminal cancels dictation and discards late text.

This uses the same saved speech provider, model, API key and microphone as board dictation. The status bar shows recording/transcription progress; **Entomatical: Cancel Dictation** cancels it. F8 is bound while a VS Code terminal has focus; it is not a shortcut inside the board's embedded card terminal. If `terminal.integrated.sendKeybindingsToShell` is on, turn it off to use the shortcut. Entomatical adds its command to the global `terminal.integrated.commandsToSkipShell` setting so the shortcut stays in the editor. Live microphone acceptance for this shortcut remains pending on Windows and Linux.

**Whisper:** **Entomatical: Choose Local Speech Folder**, then **Entomatical: Choose Local Speech Model**. Live dictation needs compatible `whisper-cli` and `whisper-stream` plus a Whisper GGML model. Parakeet/VAD models are excluded; a recognized header cannot establish full-file integrity.

**Parakeet:** select its own folder and TDT GGML model; files beside Whisper can be discovered automatically. It never substitutes the Whisper executable/model. It records until Stop, silence or its limit, then transcribes locally with automatic language detection. **Entomatical: Parakeet Tools** exposes threads/GPU/device, segment diagnostics, quiet output, multi-file transcription and text export. Use **Entomatical: Parakeet: Show Installed CLI Help** to inspect the executable's options; codec support varies by build.

**Cloud:** select the service and run **Entomatical: Set Speech API Key**. Keys are per-provider in SecretStorage; **Entomatical: Remove Speech API Key** removes the selected key. Audio uploads after recording stops. Charges, quota, retention and model availability follow that service. Coding sign-in does not supply speech API credentials.

`entomatical.speech.language` accepts a language code or `auto`; Parakeet detects automatically and ignores it. `entomatical.speech.silenceSeconds` sets local silence stopping, from 0.5 to 60 seconds. Microphone recording is bounded to two minutes, with a separate transcription timeout. Failure never silently switches engines/services. Retired saved providers, including Claude dictation, resolve to Local Whisper without deleting the old setting; this migration behavior is distinct from failure fallback.

Local record-then-transcribe uses temporary audio/transcript files and attempts cleanup afterward. Parakeet details contain speech and local paths; capture is in memory until replaced/shutdown, but opened/saved documents may persist in editor backups. Local audio processing does not keep later submitted coding prompts local.

## Usage and settings

**Claude usage.** The Accounts row and picker label tiers such as `max_20x` as reported by Claude Code. The CLI tier alone cannot confirm account verification. The board shows account-wide percentages and withholds a window when its meters disagree. Model-specific meters such as Fable’s weekly limit are outside these totals.

Automatic account switching requires measured usage below 95% for both windows, or a CLI meter list that reports only weekly meters with account-wide weekly usage below 95%. If a valid list reports no applicable meters, Refresh clears the earlier numbers. A missing endpoint in any finished run makes that window’s total unknown for the task. Other windows with complete readings still contribute to their own totals.

Refresh records when Entomatical received the CLI reply. Claude Code 2.1.331 can reuse a snapshot less than 60 seconds old. After a failed upstream fetch it can also return cached named readings without the original observation time. Two successful refreshes can therefore repeat one observation. They cannot independently establish how much allowance a turn consumed. The board marks its local reading stale after fifteen minutes and awaits another reading when a reset passes. If the CLI request itself fails, the board shows the error and retains the earlier reading.

Codex reports its own windows. Grok/Antigravity local token totals are not provider plan limits; measurements report gaps, and Antigravity needs SQLite in the editor's Node runtime. Windows verification remains incomplete.

**Session details** separates available input/cache/output measurements from context fullness. Codex counts reasoning inside output and does not report cache writes. Worker model/effort appears only when recorded. The Claude ledger's **Efficiency summary** reports calls per prompt, mean/last context and token share after the first completed turn, not quality. Unsupported/unread ledgers show **No ledger data yet**. The local ledger CLI, `node ~/.entomatical/ledger/ledger.js`, supports `summary <session>` and `compare --since <date>`; use your home-directory equivalent on Windows.

**Model efficiency** summarizes retained, non-discarded Done cards by their dominant measured model. Removed cards are not counted. Different tasks, missing measurements and review outcomes limit comparison; this is not a provider benchmark.

| Setting | Purpose |
|---|---|
| `entomatical.autoStart`, `entomatical.maxRunning` | Automatic starts and capacity. |
| `entomatical.notifications` | Session notifications. |
| `entomatical.quietStartup` | Restore board/session focus, close secondary sidebar and turn off Codex open-on-startup; on by default. |
| `entomatical.codexStart`, `entomatical.codexPath` | Codex mode and CLI override. |
| `entomatical.contextSource`, `entomatical.asana.project`, `entomatical.obsidian.folder` | Context selection/locations; existing links remain. |
| `entomatical.speech.*` | Provider, paths, models, language, silence and Parakeet controls. |
| `entomatical.orchestrator.enabled`, `entomatical.orchestrator.caps` | Enable coordination and set enforced limits/optional measured budgets. |
| `entomatical.orchestrator.childNotifications` | Child notifications; off by default. |
| `entomatical.orchestrator.claimAfterMinutes` | Idle-holder takeover threshold. Takeover (F95) is checked live on Windows; the Linux check is still pending. |

## Troubleshooting

- **Missing CLI/account:** verify installation/sign-in in the editor environment and refresh Accounts. Check Codex path/WSL settings. An editor extension alone is insufficient.
- **WSL is not answering:** use **Check Now**, recover WSL if necessary, then accept **Reload Window** when it answers. Shutting WSL down also ends its other running processes; preserve work before doing so. Entomatical will not switch these tasks to Windows Codex.
- **WSL is not answering:** use **Check Now**, recover WSL if necessary, then accept **Reload Window** when it answers. Shutting WSL down also ends its other running processes; preserve work before doing so. Entomatical will not switch these tasks to Windows Codex.
- **Waiting at start:** inspect provider folder-trust and hook approval in the session. One hook approval does not approve others.
- **Worktree start failure:** inspect Git's error, existing branches/worktrees and Windows path length. Preserve remaining files before cleanup.
- **Read-only board:** another editor window owns the repository's board. Use it or close that owner; ownership transfers when it closes or stops refreshing.
- **Generic Codex tab:** saved thread naming and tab naming differ. The observed Codex extension may show the correct conversation header but a generic tab. Use header/card identity. Terminal mode gives new tasks a separate task terminal; it does not migrate or repair existing editor tabs.
- **Missing found session:** Claude discovery uses undocumented session registry files. Codex discovery uses Linux process/session matching and is Linux-only; it is not universal discovery. Found Codex sessions can move to Done when closed.
- **Speech error:** check recorder/microphone, executable/model compatibility or selected cloud key/quota. Failure does not trigger fallback.
- **Passed checks, wrong result:** examine the requirements and actual output; checks prove their assertions, not the entire goal.

For development checks and their limits, see the [development guide](https://github.com/r-spring/wyarden/blob/main/docs/development.md). Report reproducible bugs in [GitHub Issues](https://github.com/r-spring/wyarden/issues); use the [security policy](https://github.com/r-spring/wyarden/blob/main/SECURITY.md) for suspected vulnerabilities.
