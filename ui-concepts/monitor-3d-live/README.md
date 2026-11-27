# Wyarden 3D Monitor: the working mock-up

A live 3D view of the coding-agent sessions in your open workspaces. It is the simulated mock-up of [ui-concepts/monitor-3d/](../monitor-3d/README.md), wired to real sessions. The contract it was built against, and what was verified, is [docs/monitor-3d/05-working-mockup.md](../../docs/monitor-3d/05-working-mockup.md).

- **What it shows:** each live Claude Code session as a column: the agent, its subagents, the tools it calls, the files, folders and addresses those calls touch, and its MCP servers. A call is a line from its start to its end.
- **Which sessions:** only sessions whose folder is inside a workspace that is open in an editor window right now. Close the window and its workspace leaves the list.
- **Which editors:** VS Code, VSCodium and Code - OSS, on Windows and Linux. One VSIX for all of them: plain JavaScript, no package, no native code.
- **This slice is Claude Code only.** Codex, Grok Build and Antigravity are later phases of [the wiring plan](../../docs/monitor-3d/04-wiring-plan.md).

## Use it

1. Install the VSIX in each editor you use: **Extensions: Install from VSIX…**, or `code --install-extension <file>` (`codium --install-extension <file>` for VSCodium). To make the file: `node tools/pack.js`, which writes `dist/wyarden-monitor-3d-<version>.vsix`.
2. Click **3D Monitor** in the status bar, or run **Wyarden 3D Monitor: Open**.
3. Pick a workspace with the chips above the scene. "All open" shows every open workspace together.

It works at once, with nothing set up: live sessions come from Claude Code's own session files, and their calls from their transcripts. Those calls are marked *derived*.

For *exact* calls, run **Wyarden 3D Monitor: Set Up Collectors…**. It shows the first change to a Claude Code `settings.json` as a diff, names every file it would change, and asks once ("Show every change" opens the other diffs first). Then it adds eleven hook entries to each file; they post Claude Code's events to the monitor on this machine. **Remove Collectors** takes exactly those entries out again.

| Command | Does |
|---|---|
| Wyarden 3D Monitor: Open | Opens the tab. |
| Wyarden 3D Monitor: Choose Workspace | The same choice as the chips, as a list. |
| Wyarden 3D Monitor: Set Up Collectors… | Adds Claude Code's collector, after showing the change. |
| Wyarden 3D Monitor: Remove Collectors | Takes it out. |
| Wyarden 3D Monitor: Status | Prints the hub's figures to the Output panel. |

In the scene: a click selects; a double-click on a file opens it in an editor beside the monitor (Ctrl+Enter does the same); a folder group with several files asks which one; a searched folder is revealed; an address opens in the browser after it has been shown and confirmed. The keys, the list for screen readers, the two looks and the view buttons are the mock-up's. A session that starts is framed into view, unless you have moved the camera: then it stays where you put it.

## What it does on your machine

- **One connection per window.** Each window tells the hub its folders and keeps one loopback connection open. That connection is how a workspace counts as alive.
- **One hub per machine.** The first window to start runs it, in a worker thread: no new process. It listens on `127.0.0.1` only. When that window closes, another window takes over at once (measured: up again within seconds); the picture is rebuilt from the session files and the transcripts.
- **One small file of its own:** `~/.wyarden-monitor/hub.json`, with the port and two random tokens. The editor also remembers, for each workspace, which workspace you chose and how you left the view. Nothing leaves the machine.
- **No work while no tab is open.** The hub reads session files every 3 seconds and transcripts every 0.7 seconds only while a tab is showing a workspace. The page draws only when something changes.
- **Privacy.** A hook payload or a transcript line holds prompts, file contents and command lines. The hub keeps a fixed list of fields and drops the rest before anything is stored or drawn: tool and server names, a path relative to the session's folder (the base name alone for a file outside it), an address without its query, times and results. A name or an id that does not look like one is replaced by a stand-in made from its hash. See section 13 of [02-live-signals.md](../../docs/monitor-3d/02-live-signals.md).
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
- Routing an action to the window that owns the file, the tree view, the native context menu, and the three.js renderer are later phases.

## The parts

| File | What |
|---|---|
| `extension.js` | Activation: the hub client, the commands, the tab, the status bar item. |
| `lib/contract.js` | The shared rules: the hub's file, collector addresses, paths of both forms, the text that may be kept. |
| `lib/hub-client.js`, `hub-server.js`, `hub-core.js` | The hub: bind or connect and take over; the listener and timers; sessions, workspaces, one model for each scope. |
| `lib/normalise.js` | A hook payload to events, and the privacy rule. |
| `lib/discover.js`, `transcript.js` | Live sessions from the CLI's session files; a session's calls from its transcript. |
| `lib/install.js` | Collectors: plan, write, remove. |
| `lib/view.js`, `actions.js` | The tab and its policy; what a double-click does. |
| `media/` | The page: `page.html`, `page.js`, `host-feed.js`, and the mock-up's `model.js`, `layout.js`, `engine.js`, `nav.js`, the two looks and `style.css`. |
| `test/` | `node --test "test/*.test.js"` runs everything; the page tests need Edge or Chrome and skip without one. |
| `tools/pack.js` | Makes the VSIX with Node's own zlib. |

## Borrowed code

The page's engine, looks, layout and model started from [ui-concepts/monitor-3d/](../monitor-3d/README.md), whose README lists what it took from the Entridir repository (GPL v3, as this repository). Each file names its source in a comment at its top.
