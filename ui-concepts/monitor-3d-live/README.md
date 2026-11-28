# Wyarden 3D Monitor

A live 3D view of the Claude Code sessions in your open workspaces. The preview connects the simulated monitor to real sessions. [Install 0.1.3](https://github.com/r-spring/wyarden/releases/tag/v0.1.3) · [User guide](https://github.com/r-spring/wyarden/blob/main/docs/wyarden-guide.md) · [Design and verification](https://github.com/r-spring/wyarden/blob/main/docs/monitor-3d/05-working-mockup.md)

- **What it shows:** each live Claude Code session as a column: the agent, its subagents, the tools it calls, the files, folders and addresses those calls touch, and its MCP servers. A call is a line from its start to its end.
- **How to read it:** an agent is an icosahedron and a subagent a dodecahedron, both in their provider's colour: Claude orange, Codex blue, Antigravity purple, Grok green. The tile an agent stands on carries the name of its workspace. Point at an agent to see the title of its tab under its name. Captions have no background, so they hide nothing.
- **Which sessions:** the monitor discovers existing Claude Code sessions whose working directory is in an open workspace folder or one of its subfolders. This includes sessions launched in external terminals.
- **A workspace is a window.** One chip for each open editor window, named as the window is titled. A window that holds several folders (a workspace file) is still one chip.
- **Which editors:** VS Code 1.88 and later, VSCodium and Code - OSS builds based on those versions, on Windows and Linux. One VSIX for all of them.
- **This slice is Claude Code only.** Codex, Grok Build and Antigravity are later phases of [the wiring plan](../../docs/monitor-3d/04-wiring-plan.md).

## Use it

1. Install the downloaded VSIX in each editor you use with **Extensions: Install from VSIX…**. For a source build, run `node ui-concepts/monitor-3d-live/tools/pack.js` from the repository root.
2. Open the project folder that contains your agent's working directory. Add its worktree as a workspace folder if that worktree lives elsewhere.
3. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Pick a workspace chip or choose **All open**, then wait a few seconds for Wyarden to find the sessions already running there.

**After an update:** a window runs the new version once it has been reloaded (**Developer: Reload Window**), and the list of workspaces comes from whichever window runs the hub. So an update is complete when every window has been reloaded, or the editor restarted. A reload restarts every extension in that window, so do it when no agent there is in the middle of something.

Discovery uses Claude Code's existing session files. Available transcripts supply call activity marked *derived*, while already-running idle sessions can appear before any new calls.

For *exact* calls, run **Wyarden 3D Monitor: Set Up Collectors…**. It shows the first change to a Claude Code `settings.json` as a diff, names every file it would change, and asks once ("Show every change" opens the other diffs first). Then it adds eleven hook entries to each file; they post Claude Code's events to the monitor on this machine. **Remove Collectors** takes exactly those entries out again.

| Command | Does |
|---|---|
| Wyarden 3D Monitor: Open | Opens the floating monitor window. |
| Wyarden 3D Monitor: Choose Workspace | The same choice as the chips, as a list. |
| Wyarden 3D Monitor: Set Up Collectors… | Adds Claude Code's collector, after showing the change. |
| Wyarden 3D Monitor: Remove Collectors | Takes it out. |
| Wyarden 3D Monitor: Status | Prints the hub's figures to the Output panel. |

Click a node to select it. Double-click a file or press Ctrl+Enter to open it in the workspace editor. For groups with several files, pick the file first. A searched folder opens in the workspace Explorer. Wyarden asks before opening an address in the browser.

**A double-click on an agent shows its session** (since 0.1.3; Ctrl+Enter does the same, and a subagent shows the session that started it):

- **Its terminal** in the editor that owns it.
- **Its Claude Code chat panel** when the session's process can be confirmed in that editor.
- The status bar shows “3D Monitor: looking for the session…” during the lookup. Wyarden gives a message if the session has ended or has no terminal or panel it can show.

The keys, the list for screen readers, the two looks and the view buttons are the mock-up's. A session that starts is framed into view, unless you have moved the camera: then it stays where you put it.

## What it does on your machine

- **One connection per window.** Each window tells the hub its folders and keeps one loopback connection open. That connection is how a workspace counts as alive.
- **One hub per machine.** The first window to start runs it, in a worker thread: no new process. It listens on `127.0.0.1` only. When that window closes, another window takes over at once (measured: up again within seconds); the picture is rebuilt from the session files and the transcripts.
- **One small file of its own:** `~/.wyarden-monitor/hub.json`, with the port and two random tokens. The editor also remembers, for each workspace, which workspace you chose and how you left the view. Nothing leaves the machine.
- **A double-click on an agent checks the process list** to find its terminal or chat panel. Connected editors can check for the session even with their own monitor closed. The results of the process check are discarded after the lookup.
- **Polling follows the monitor.** The hub reads session files every 3 seconds and transcripts every 0.7 seconds while a monitor is showing a workspace. The status bar gives live session counts during polling.
- **Privacy.** A hook payload or a transcript line holds prompts, file contents and command lines. The hub keeps a fixed list of fields and drops the rest before anything is stored or drawn: tool and server names, a path relative to the session's folder (the base name alone for a file outside it), an address without its query, times and results. A name or an id that does not look like one is replaced by a stand-in made from its hash. One text is kept that is the owner's own words: a session's title, as its tab shows it (it is held in memory and shown in the view; it is written nowhere). See section 13 of [02-live-signals.md](../../docs/monitor-3d/02-live-signals.md).
- **Collectors change your Claude Code settings**, in every account folder (`~/.claude`, each folder in `~/.claude-accounts`, and `$CLAUDE_CONFIG_DIR`). Only on the command, only after the diff and one confirmation, and never a backup copy (a settings file can hold secrets).

To remove everything: run **Remove Collectors**, uninstall the extension, and delete `~/.wyarden-monitor`.

## Known limits

- **Do not set up collectors on a machine that other people log in to.** The hub's port is fixed. While no editor is open, another user's program could listen on it, and Claude Code's hooks would post to that program: prompts, commands and file contents. A hook cannot check who answers. The view works without collectors, from the transcripts.
- A session that was already running when the collector was set up may report exact calls only after it restarts. Until then its calls stay derived.
- A transcript does not say what a shell command read or wrote, and neither does a hook: a shell call has no file.
- At most twelve sessions are drawn for one scope; more are counted as left out.
- A session's end comes from its session file (its process is gone), a few seconds after the fact, then the session stays for 20 seconds and leaves.
- A crashed session whose process id was taken by another program can stay listed as alive.
- A remote window (WSL, SSH, a container) runs the extension on the remote side, so it has its own hub and shows that machine's sessions.
- **Cross-workspace actions require the updated extension** in the editor hosting the workspace and the editor hosting the hub.
- **A session in a board card's own terminal** is not a terminal the editor lists, so it cannot be shown from here; a message says so.
- **On Linux a chat panel may be refused.** It is shown only when the start time in the session's file equals the system's for that process. Whether Claude Code writes it so on Linux was not measured; if it does not, the message says the process "could not be confirmed". A terminal is shown either way.
- **A terminal that is still starting** when you double-click is not found: its process id is waited for 1.5 seconds. Double-click again.
- The tree view, the native context menu, and the three.js renderer are later phases.

## The parts

| File | What |
|---|---|
| `extension.js` | Hub client, commands, floating monitor and status bar item. |
| `lib/contract.js` | The shared rules: the hub's file, collector addresses, paths of both forms, the text that may be kept. |
| `lib/hub-client.js`, `hub-server.js`, `hub-core.js` | The hub: bind or connect and take over; the listener and timers; sessions, workspaces, one model for each scope. |
| `lib/normalise.js` | A hook payload to events, and the privacy rule. |
| `lib/discover.js`, `transcript.js` | Live sessions from the CLI's session files; a session's calls from its transcript. |
| `lib/install.js` | Collectors: plan, write, remove. |
| `lib/view.js`, `actions.js` | The floating webview, its policy and double-click actions. |
| `lib/procs.js` | A process and its ancestors: which terminal, or which window, runs a session. |
| `media/` | The page: `page.html`, `page.js`, `host-feed.js`, and the mock-up's `model.js`, `layout.js`, `engine.js`, `nav.js`, the two looks and `style.css`. |
| `test/` | `node --test "test/*.test.js"` runs everything; the page tests need Edge or Chrome and skip without one. |
| `tools/pack.js` | Makes the VSIX with Node's own zlib. |

## Borrowed code

The page's engine, looks, layout and model started from [ui-concepts/monitor-3d/](../monitor-3d/README.md), whose README lists what it took from the Entridir repository (GPL v3, as this repository). Each file names its source in a comment at its top.
