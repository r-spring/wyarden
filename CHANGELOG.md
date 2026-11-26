# Changelog

Source changes are listed below. Check [GitHub Releases](https://github.com/r-spring/wyarden/releases) for published releases and any attached packages.

## 0.8.25

### Removed

- **3D lattice tab (F121):** the command "Entomatical: Open 3D Lattice", its tab and the board code that served its Open card are gone. The lattice is being remade as a separate app (25 November 2026).

## 0.8.24

### Added

- **3D lattice tab (F121):** the command "Entomatical: Open 3D Lattice" opens one tab that draws the board's cards as a wireframe lattice, coloured by status, with lines from a subtask to its parent, from an orchestrator to the cards it opened, and from a card to the one it starts after. It follows board changes. Click a card to see its title, status, runtime, account and model; Open card does what Open does on the board. Done cards older than the newest 40 are left out and counted (18 November 2026).

### Changed

- **Claude and Codex orchestrators run in their card terminal (F69):** a card added with Orchestrator ticked on a Claude or Codex account is no longer headless. It runs in the terminal inside its card, Open shows that terminal, and the board types plan approvals and "Child settled" notices into it. Grok and Antigravity orchestrators still run headless (18 November 2026).
- **Every card terminal watches for an unknown prompt (F89):** a selection prompt that no start-up answer matches and that stays 30 s becomes one "Waiting at: …" line in the card's Timeline, on every card terminal, not only a battle card's. Nothing is typed at it (18 November 2026).

### Fixed

- **Finish of a card whose worktree folder moved (F60):** when the card's folder is gone but git has its branch checked out in another worktree folder, Finish lands the work from that folder and deletes it, instead of failing to check the branch out again.

## 0.8.23

### Added

- **An orchestrator can close a card whose work has landed (F120):** `board.js finish <id>`, for the root of an approved run. The card is one of its run or one of your own, in Review with its session ended, its worktree clean and every commit of its branch in the target already (on the remote too, when there is one). The board removes that card's worktree and branch and marks it Done. Nothing is committed, merged or pushed, and the main folder is not changed; a card that needs any of those is refused and stays your Finish. Git-ignored files in that worktree are deleted with it, as with your Finish button.
- **A plan step may open its own cards (F119):** `"mayOpen": true` on a step of a plan file makes that step a coordinator under the plan card. It opens cards with `board.js add`, accepts them itself, and the board accepts the step only when every card it opened is Done or cancelled. The plan's reviewer and its plain steps still open none (17 November 2026).
- **Make orchestrator (F117):** right-click a card of your own and choose Make orchestrator. The card gets an orchestrator's rights with the default caps, and its session is sent the orchestrator brief. Nothing is approved by it: the session still proposes its run with `board.js plan`, and you approve it on the card (17 November 2026).

### Changed

- **The project is now called Entomatical** (16 November 2026). This first step renames what people read: the extension's display name, command titles, board and dialog text, and the living documents. Settings (`entomatical.*`), command ids, the `.entomatical` and `~/.entomatical` folders, `ENTOMATICAL_*` variables, file names and the GitHub repository keep the old name for now. Dated evidence, postmortems and archived plans are left as they were recorded.

### Fixed

- **A renamed or moved workspace folder keeps its cards (F118):** the board's saved paths into its own `.entomatical` folder (a card's worktree, check run, failure log, and review file and receipt) follow the folder. Before, cards kept the old folder's path, and Finish made the old folder again and then stopped (17 November 2026, after the folder became `Entomatical`). Run `git worktree repair` once after a rename; that part is git's.
- **Finish's conflict message is plain text:** when the headless Claude run does not merge a conflict, the dialog shows the end of its reply without markdown marks (`**`, backticks, list and heading marks), and the cut starts at a word (16 November 2026).

## 0.8.22

### Changed

- **Everything stays inside the workspace (F104):** Entomatical now runs only in a window with a saved workspace file, a folder open, and that folder a git repository's top folder; otherwise the board lists the missing steps (13 November 2026). Worktrees stay in `.entomatical/wt/`, and every temporary folder moves from the system temp folder to `.entomatical/tmp/`: each card's sessions and acceptance checks get `.entomatical/tmp/<card>` as TMP, TEMP and TMPDIR (deleted with the card's worktree or the card), and helper calls, dictation and `npm test` use folders there too. A marker file stops git, `board.js` and the board's searches at that folder.
- **One Codex for Entomatical and the Codex extension (F61):** the warning that the Codex extension runs a different bundled version has a button, **Set chatgpt.cliExecutable**, which writes the Codex that Entomatical runs into the user's `chatgpt.cliExecutable` and offers Reload Window (15 November 2026).

### Fixed

- **Resume from the user's terminal (F95):** `board.js resume <id> --operator` on a card of his own now reopens its session with "Resume." as its next message, as the card's Resume button does. Before, the session reopened with no message, sat idle, and the card stayed Interrupted although the command answered "Resumed" (seen after `board.js reload-windows`, 15 November 2026). A card whose session never came up is refused instead.
- **Accounts (F41, F24):** cards start again after a restart ("Account … is not available" when two folders shared an email, or before the first login check answered), and each Claude folder keeps its own account: a login as another email is logged out at once, and a folder signed in as another email is not offered to any card.

## 0.8.21

### Added

- **Error log for Review and Finish (F103):** every Review or Finish that ends without completing (13 November 2026), whether a thrown error, a model or runner error, a usage limit, a timeout, a refusal, an invalid reply, a cancel or a window reload mid-run, is one JSON line in the board's `.entomatical/errors.jsonl` (kept under 2 MB) with the stage it reached, the card, the provider, account, model and effort, the duration, the runner's exit code and the end of its stderr, with credential-like text redacted. Each line also goes to the new "Entomatical" Output channel. A review's failure notice and a self-finish error show Show log, Finish's error dialog has it too, and "Entomatical: Open error log" opens the file.

## 0.8.20

### Added

- **Right-click a helper button (F102):** Refine draft, Improve prompt, Use answers, Improve with these answers, a card's Review and a card's Finish open one menu on a right-click (13 November 2026), in the split buttons' look, to pick the account (provider), model and effort that action runs on, and for Finish the conflict resolver's permission mode (Accept edits, Auto mode, Bypass permissions). A pick is that action's default from then on, kept per profile in VS Code's globalState and named on the button's mouse-over; Reset to default clears it, and no pick is the old behaviour exactly. Haiku title and Done when open their own ▾ menu on a right-click. A right-click elsewhere on a card still opens VS Code's card menu.

## 0.8.19

### Changed

- **Haiku title and Done when: model and effort (F53, F54):** both toggles beside Add task are split buttons (13 November 2026); ▾ opens a small menu of the Claude model (Haiku, Opus, Fable) and effort (low to max) that helper runs on, the label names a pick other than the default (for example "Opus·high title"), and the pick is remembered. It applies where the helper runs on Claude; elsewhere ▾ is greyed with the reason.

## 0.8.18

### Changed

- **Board columns in a mid-width tab (F01):** below 1180 px the columns form three stacks, Queued over Running, Needs input over Review, and Done, so Review starts right under Needs input instead of below the tallest column of the row above. At 1180 px and wider the five columns sit side by side as before; a side bar still shows one column.
- **Sub-agent models (F96):** the Opus effort cap is lifted (12 November 2026): an Opus sub-agent may run at any effort (low, medium, high, xhigh, max), and a call naming none still gets medium. Haiku stays at max only; Fable and Sonnet are still refused; a fork now also passes from an Opus session at any effort.
- **Plan first on Codex (F78):** Plan first is no longer greyed for a Codex account (12 November 2026). Ticked there, the card runs the newest Astra at ultra effort whatever model was picked, and is sent a Codex planning prompt (`docs/orchestrator/PLANNER-CODEX.md`) that asks it to wait for approval and write the plan file into the main checkout's `workflows/`.

### Fixed

- **Narrow and wide panels (F01):** the board no longer scrolls sideways when an account's usage chip is wider than the panel, and a path or identifier with no spaces wraps inside its card instead of being cut at the card's edge (Launch failed, a sub-agent's line, the timeline, chips, archived runs). Buttons and toggles are 24 px tall.

## 0.8.17

### Changed

- **Sub-agent models (F96):** the Agent hook holds every sub-agent to Opus at medium or low effort, or Haiku at max effort; it fills in a model or effort the call leaves out and refuses Fable, Sonnet and any other effort. A fork passes only from a session that is itself within that rule. The six `ab-*` agents are defined on Opus.

### Fixed

- **Review (F97):** a card whose commits are already in `main` is reviewed on its own commits instead of "Commits since the branch point: none"; an orchestrator is reviewed on its cards' merged work. The files named in Done when come first under the size cap, then source, tests, docs and data files.
- Windows headless children start when a path holds `%NAME%` (F71).

## 0.8.16

### Added

- **Toggle buttons (F100):** Haiku title, Done when: Fable, Plan first, Card terminal, Orchestrator and a plan's Watchers box are toggle buttons that change colour when on and explain themselves on mouse-over.
- **Plan first writes a plan file (F99):** a Plan first card is sent a visible planning prompt, writes its plan to `workflows/`, and a finished plan run's file moves to `workflows/archive/`.
- **Review against Done when (F97):** a Review button judges a card's work against its Done when; an orchestrator that a review finds Done finishes its run by itself.
- **Scoped sub-agents (F96)**, **takeover of cards another run left behind (F95)**, and plan files a card writes go to the main checkout's `workflows/` (F98).

### Changed

- Finish: when the remote refuses the push, the card's own session is asked to explain and offer a fix (F60).
- The board rebuilds at most once per 500 ms and not while hidden; transcripts are read from where the last read stopped (F68).
- Card terminal: Stop on Windows ends the session's whole process tree; Claude's folder-trust prompt with the "❯" cursor is answered (F89).
- Subagent lines read "1 step" / "N steps" and skip helper stops with no transcript (F13).

### Fixed

- Windows headless children: card titles with cmd.exe special characters and paths with `%` start correctly (F71).
- Windows wrapper updates copy to a `.new` file first, so a failed copy keeps the old wrapper (F58).
- Audit fixes to Finish, usage-limit fallback, auto-finish check timeouts, and operator `send` to a paused run.

## 0.8.15

### Added

- **F8 terminal dictation:** focus a running VS Code terminal and press F8, or run **Entomatical: Dictate into Terminal**. It uses the saved speech provider, inserts text into the original terminal without pressing Enter, and stops recording on a second F8. Live microphone acceptance for this shortcut remains pending on Windows and Linux.

### Fixed

- When Codex is configured for WSL and WSL does not answer at startup, Entomatical blocks Codex starts instead of silently falling back to Windows Codex. Background checks and **Check Now** detect recovery, then offer **Reload Window**.
- Windows Codex refuses to resume a session recorded in WSL and explains how to restore the WSL setting.
- WSL Codex launches request systemd memory limits: 33% of VM memory and 2 GiB swap per session, with an 85% combined memory limit for the Codex slice and `OOMPolicy=continue`. Without a running systemd user manager or `systemd-run`, sessions launch directly without these limits.

### Documentation

- Updated onboarding, provider setup, task/worktree review, speech and data-flow guidance.
- Added build, packaging, contribution and security-reporting guidance, with links to the selected GitHub repository.

## 0.8.14

- Limited each subagent transcript read to the last 8 MiB of unread data, avoiding oversized string reads. When earlier data is skipped, displayed step counts cover the portion read.
