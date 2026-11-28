# Wyarden 3D Monitor

A live 3D view of Claude Code, Codex, Grok Build and Antigravity activity in your open workspaces.

- **What it shows.** Each live session has one column. The view shows subagents, tool calls, files, folders, addresses and MCP servers when the provider reports them. A call is a line from its start to its end.
- **How to read it:** an agent is an icosahedron and a subagent a dodecahedron, both in their provider's colour: Claude orange, Codex blue, Antigravity purple, Grok green. The tile an agent stands on carries the name of its workspace. Point at an agent to see the title of its tab under its name. Select a Claude Code agent to read the thinking its session has done, under **Thinking** below the inspector (since 0.1.7). Captions have no background, so they hide nothing.
- **Which sessions.** A provider session belongs to an open workspace that contains its working directory. Wyarden reads Claude Code session files and can discover loaded Codex threads through an available local Codex app server. Grok Build and Antigravity appear when their hooks report activity. Sessions launched in external terminals can also appear.
- **A workspace is a window.** One chip for each open editor window, named as the window is titled. A window that holds several folders (a workspace file) is still one chip.
- **Which editors:** VS Code 1.88 and later, VSCodium and Code - OSS builds based on those versions, on Windows and Linux. One VSIX for all of them.

## Use it

1. Install the downloaded VSIX in each editor you use with **Extensions: Install from VSIX…**. For a source build, run `node ui-concepts/monitor-3d-live/tools/pack.js` from the repository root.
2. Open the project folder that contains your agent's working directory. Add its worktree as a workspace folder if that worktree lives elsewhere.
3. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Pick a workspace chip or choose **All open**, then wait a few seconds for Wyarden to find the sessions already running there.

**After an update:** a window runs the new version once it has been reloaded (**Developer: Reload Window**), and the list of workspaces comes from whichever window runs the hub. So an update is complete when every window has been reloaded, or the editor restarted. A reload restarts every extension in that window, so do it when no agent there is in the middle of something.

Run **Wyarden 3D Monitor: Set Up Collectors…** to see the changes for the provider profiles already on this machine. **Show every change** opens the remaining redacted previews before confirmation. Start a provider once if its profile has yet to be created. Codex and Antigravity command hooks require Node.js 18 or later on the editor’s PATH and Windows PowerShell on Windows.

| Provider | After confirming setup |
|---|---|
| Claude Code | `settings.json` gets Wyarden’s HTTP hooks. Restart an existing session if its calls are still marked *derived*. Available transcripts still supply derived calls without hooks. |
| Codex | Restart Codex so it sees the commands in `hooks.json`. Open `/hooks`, review and approve the Wyarden commands in Codex, then resume or start a session. The monitor can show loaded app-server threads before native calls arrive. Approval status is checked through the `codex` executable on the editor’s PATH. |
| Grok Build | Restart Grok Build so it loads `hooks/wyarden-monitor.json` in its user profile. Start or continue a turn in an open workspace. |
| Antigravity | Restart Antigravity so it loads the `wyarden-monitor-antigravity` group from `~/.gemini/config/hooks.json`. Start or continue a turn in an open workspace. |

| Command | Does |
|---|---|
| Wyarden 3D Monitor: Open | Opens the floating monitor window. |
| Wyarden 3D Monitor: Choose Workspace | The same choice as the chips, as a list. |
| Wyarden 3D Monitor: Set Up Collectors… | Previews and adds Wyarden hooks in the provider profiles it finds. |
| Wyarden 3D Monitor: Remove Collectors | Previews and removes Wyarden hooks. Restart affected providers to unload hooks. |
| Wyarden 3D Monitor: Status | Prints each collector’s status and the hub’s figures to the Output panel. |

Click a node to select it. Double-click a file or press Ctrl+Enter to open it in the workspace editor. For groups with several files, pick the file first. A searched folder opens in the workspace Explorer. Wyarden asks before opening an address in the browser.

**A double-click on an agent shows its session** (since 0.1.3; Ctrl+Enter does the same, and a subagent shows the session that started it):

- **Its Claude Code terminal** in the editor that owns it, when the session file names the process.
- **Its Claude Code chat panel** when the session's process can be confirmed in that editor.
- The status bar shows “3D Monitor: looking for the session…” during the lookup. Wyarden gives a message if the session has ended or has no terminal or panel it can show.

Use the look switcher, view buttons and keyboard controls in the monitor. The list offers the same nodes to screen readers. A session that starts is framed into view until you move the camera yourself.

## Looks

The monitor has 18 looks (since 0.2.0). Every look draws the same things in the same places; a look changes only colours, shapes, lettering and a still backdrop. A state is never a colour: it is a mark beside the shape and a word in its caption.

- **To switch:** the bar at the top says **Look**, then three buttons. The look's name opens the list of all 18, in four groups; click one, or use the arrow keys and Enter. Escape closes the list. **‹** and **›** step to the previous and the next look.
- **Until you choose,** the editor's theme picks: `nexus` in a dark theme, `glasshouse` in a light one. Once you choose, the tab keeps your look, also after a reload.
- **In a browser, with nothing installed:** `node ui-concepts/monitor-3d-live/tools/preview.js` from the repository's top folder serves the same page on invented data at a loopback address and prints it. Add `?look=<id>` to open on one look, for example `?look=synapse`. Ctrl+C stops it.
- **More:** [LOOKS.md](LOOKS.md) is how to write a look; [docs/looks/README.md](../../docs/looks/README.md) is the list, with a picture of each.

## What it does on your machine

- **One connection per window.** Each window tells the hub its folders and keeps one loopback connection open. That connection is how a workspace counts as alive.
- **One hub per machine.** The first window to start runs it in a worker thread listening on `127.0.0.1`. Another window takes over when that window closes. Claude Code files, available Codex discovery and new hook events rebuild the view.
- **Local monitor files.** `~/.wyarden-monitor/hub.json` holds the listener’s port and tokens. Codex and Antigravity share `collector-v1.js` in the same folder so installed hooks survive extension updates. The editor remembers the workspace scope and view.
- **A double-click on an agent checks the process list** to find its terminal or chat panel. Connected editors can check for the session even with their own monitor closed. The results of the process check are discarded after the lookup.
- **Selecting a Claude Code agent reads its transcript** (since 0.1.7), in the editor window that opened the monitor, for its thinking. The transcript is found once, through Claude Code's session files; then its last 4 MB is read, and read again only when the file's size or time has changed, looked at every 3 seconds while the agent stays selected and that monitor is showing. Nothing of it is kept: the text is shown on that monitor's page and is gone when the selection moves.
- **Polling follows the monitor.** While a monitor shows a workspace, the hub reads Claude Code session files every 3 seconds, checks available Codex discovery independently and reads available Claude transcripts every 0.7 seconds. The status bar shows live session counts during polling.
- **Privacy.** A hook payload or a transcript line holds prompts, file contents and command lines. The hub keeps a fixed list of fields and drops the rest before anything is stored or drawn: tool and server names, a path relative to the session's folder (the base name alone for a file outside it), an address without its query, times and results. A name or an id that does not look like one is replaced by a stand-in made from its hash. One text is kept that is the owner's own words: a session's title, as its tab shows it (it is held in memory and shown in the view; it is written nowhere). Since 0.1.7 there is a second exception, and it is not the owner's words: the thinking of the agent you select. It is the model's own text, and it can repeat a prompt, a file's content or a command line. The editor window that opened the monitor reads it from the transcript, for that one session, and shows it on that monitor's page as text. It is sent to no hub and no other window, and written nowhere: no file, log, output channel, notification, status bar, or saved state of the editor or the page. It is gone when the selection moves. So check the Thinking section before you share a screenshot or paste it into a bug report. See section 13 of [02-live-signals.md](../../docs/monitor-3d/02-live-signals.md) and section 8.6 of [05-working-mockup.md](../../docs/monitor-3d/05-working-mockup.md#86-thinking-for-the-selected-agent-since-017).
- **Collector review.** Claude Code profiles include `~/.claude`, folders in `~/.claude-accounts`, and `CLAUDE_CONFIG_DIR` when set. Codex honors `CODEX_HOME` and Grok Build honors `GROK_HOME`. The previews show Wyarden’s own entries and hide settings values and tokens. Wyarden writes after confirmation and preserves other hooks.

To remove everything: run **Remove Collectors**, uninstall the extension, and delete `~/.wyarden-monitor`.

## Known limits

- **Use collectors on a single-user machine with an editor open.** Raw hook payloads can contain prompts, commands and file contents. While the editor is closed, another local program could take the hub’s port. Claude transcript discovery remains available without collectors.
- The monitor shows whether collectors are configured and whether Codex is waiting for approval. An already-running session can need a restart before the first hook arrives. The inspector indicates when a session has reported through a hook.
- Wyarden can focus a Claude Code session when its process is known. Use the provider’s own terminal or chat panel for Codex, Grok Build and Antigravity.
- A transcript does not say what a shell command read or wrote, and neither does a hook: a shell call has no file.
- At most twelve sessions are drawn for one scope; more are counted as left out.
- Session endings come from provider hooks or discovery when available. Wyarden drops a hook-only session after 30 minutes without activity if no end arrives.
- A crashed session whose process id was taken by another program can stay listed as alive.
- A remote window (WSL, SSH, a container) runs the extension on the remote side, so it has its own hub and shows that machine's sessions.
- **Cross-workspace actions require the updated extension** in the editor hosting the workspace and the editor hosting the hub.
- **A session in a board card's own terminal** is not a terminal the editor lists, so it cannot be shown from here; a message says so.
- **On Linux a chat panel may be refused.** It is shown only when the start time in the session's file equals the system's for that process. Whether Claude Code writes it so on Linux was not measured; if it does not, the message says the process "could not be confirmed". A terminal is shown either way.
- **A terminal that is still starting** when you double-click is not found: its process id is waited for 1.5 seconds. Double-click again.
- **In the transcripts measured, most thinking left no text.** In six probe sessions, Claude Code wrote the text of its thinking into the transcript only when the session was started with `--thinking-display summarized`, a flag `claude --help` does not list. For a session that has thought without that flag, the Thinking section counts the thoughts and says no text was recorded. Measured on 27 November: in the 14 transcripts measured, 374 of 380 thinking blocks had no text. By its code, Claude Code's own VS Code extension starts its panel sessions with that flag when `showThinkingSummaries` is true in your Claude settings; that was read, not run.
- **Thinking is read for the main session only,** and only from the last 4 MB of its transcript. A subagent's thinking is not shown, and the oldest thinking of a long session is not seen.
- The tree view, the native context menu, and the three.js renderer are later phases.

## The parts

| File | What |
|---|---|
| `extension.js` | Hub client, commands, floating monitor and status bar item. |
| `lib/contract.js` | The shared rules: the hub's file, collector addresses, paths of both forms, the text that may be kept. |
| `lib/hub-client.js`, `hub-server.js`, `hub-core.js` | The hub: bind or connect and take over; the listener and timers; sessions, workspaces, one model for each scope. |
| `lib/normalise.js`, `lib/providers/` | Provider payloads, redaction and native collector configuration. |
| `lib/discover.js`, `transcript.js` | Live sessions from the CLI's session files; a session's calls from its transcript. |
| `lib/install.js`, `lib/collectors.js`, `lib/hook-bridge.js` | Reviewed setup and removal, collector status and command hook delivery. |
| `lib/view.js`, `actions.js` | The floating webview, its policy and double-click actions. |
| `lib/procs.js` | A process and its ancestors: which terminal, or which window, runs a session. |
| `lib/thinking.js`, `thinking-watch.js` | The selected agent's thinking, read from its transcript; the watch that reads it again when the file changes, every 3 seconds at most. |
| `media/` | The page, views, looks and scene model. |
| `test/` | `node --test "test/*.test.js"` runs everything; the page tests need Edge or Chrome and skip without one. |
| `tools/pack.js` | Makes the VSIX with Node's own zlib. |
| `tools/preview.js`, `shoot-looks.js`, `shoot-sheet.js` | The browser preview; a look's picture; the contact sheet of all 18 (`docs/looks/img/contact-sheet.png`). None of `tools/` ships. |

## Borrowed code

The page's engine, looks, layout and model started from [ui-concepts/monitor-3d/](../monitor-3d/README.md), whose README lists what it took from the Entridir repository (GPL v3, as this repository). Each file names its source in a comment at its top.
