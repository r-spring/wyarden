# Wyarden user guide

Wyarden shows coding-agent sessions already running in your editor's open workspace folders. It uses each session's working directory to decide where it belongs. For live monitoring, this preview supports Claude Code.

## Install and check the download

Download **wyarden-monitor-3d-0.1.3.vsix** and **SHA256SUMS** from the release page. Open your editor's Command Palette and select **Extensions: Install from VSIX…**. Select the VSIX, then reload the window if prompted. [Release downloads](https://github.com/r-spring/wyarden/releases/tag/v0.1.3)

You can also install from a shell in the directory containing the download:

```sh
code --install-extension wyarden-monitor-3d-0.1.3.vsix
codium --install-extension wyarden-monitor-3d-0.1.3.vsix
```

Use the command for the editor you want. Install the extension in each editor or profile where you want Wyarden to see the windows. You can compare the downloaded file's SHA-256 with the value in **SHA256SUMS**:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\wyarden-monitor-3d-0.1.3.vsix
```

```sh
sha256sum -c SHA256SUMS
```

## See the agents already running in a workspace

1. In VS Code or VSCodium, open the folder where the agent is working, or a parent folder that contains it.
2. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Pick the workspace chip above the scene, or choose **All open**.
3. Give the monitor a few seconds to discover sessions. It can find a running Claude Code terminal, editor chat, or session launched outside the editor. It uses the session files it can read from the same environment. An idle session can appear before it has new tool activity.
4. Select an agent to inspect its session. Tool activity sourced from transcripts is marked **derived**. The collectors are optional.

Run **Wyarden 3D Monitor: Choose Workspace** if you prefer a list. A chip represents a connected editor workspace, which can contain several folders. **All open** combines these scopes. When two open folders overlap, Wyarden uses the closest matching folder. A Git worktree outside those folders has its own path, so add that worktree folder to the workspace or open it in another connected window.

| Session | Where to find it |
| --- | --- |
| Claude Code already running in an open folder or subfolder | Its workspace chip and **All open**. |
| Claude Code launched in a separate terminal | The same workspace chip, provided Wyarden can read its session files and its working directory matches the open folder. |
| Claude Code in WSL, SSH, or a container | The editor environment where the session runs. Each environment has its own session files and hub. |
| Codex, Grok, or Antigravity | The simulated view can illustrate these providers. Live discovery in this preview covers Claude Code. |

## Read and navigate the scene

- An agent is an icosahedron, and a subagent is a dodecahedron. The workspace name appears on the tile beneath the agent. Point to an agent to see its session title.
- The view arranges each session's activity in a column with related tool, MCP server, and resource nodes. Lines show calls between nodes. The preview draws up to 12 sessions per view and reports how many are left out.
- Select a node to see its details. Double-click a file or press **Ctrl+Enter** on it to open it beside the monitor. For a grouped set of files Wyarden offers a picker. It asks before opening a URL in your browser.
- Since 0.1.7, select a Claude Code agent to see the thinking its session has done, newest first, in the **Thinking** section under its details. It stays current while the agent is selected. In the 14 transcripts measured, most thinking left only a count. In six probe sessions, Claude Code wrote thinking text only when the session was started with the hidden `--thinking-display summarized` flag. For a session that has thought without that flag, the section counts the thoughts and says no text was recorded. A subagent's thinking is not shown.
- Double-click an agent or press **Ctrl+Enter** to show its terminal or Claude Code panel when Wyarden can confirm the session is in this editor window. A subagent opens its parent session. For a session in another window, switch to that window first.
- Switch between **NEXUS** and **Glasshouse** to change the appearance while keeping the layout. New sessions are framed automatically until you move the camera.

## Optional collectors

Transcript mode is the simplest setup. When you want direct Claude Code events for supported calls, run **Wyarden 3D Monitor: Set Up Collectors…**. It lists the Claude Code settings files it plans to edit and shows a diff. Use **Show every change** to review all diffs before confirming. Typical locations include the settings in `~/.claude`, `~/.claude-accounts`, and the directory selected by `CLAUDE_CONFIG_DIR` when set.

Use collectors only on a single-user machine. Claude Code sends the local hook request before Wyarden can filter its contents, so transcript mode is the appropriate choice on a shared machine. Keep an editor window with Wyarden open while using collectors. Restart an existing Claude Code session if its new events remain derived after setup.

To undo the settings changes, run **Wyarden 3D Monitor: Remove Collectors**. Review the target files before confirming.

## Privacy and local state

Wyarden's hub listens on loopback on the machine where the editor extension runs. The monitor filters transcript and hook data to the fields needed by the scene, including names, relative paths, timestamps, and call outcomes. Prompts, file contents, and command lines are dropped from the view, except where an agent's thinking repeats them (see below). Session titles and the **Thinking** section may appear in the view, so check them before sharing a screenshot.

The hub keeps connection details in `~/.wyarden-monitor/hub.json`. The editor remembers the scope and view for each workspace. When no monitor tab is open, Wyarden pauses its session and transcript polling. Remote editor environments have their own sessions and hub.

When you open a session from its agent node, the monitor checks the local process list to match the session to this window. It keeps that information in memory only for the lookup.

Since 0.1.7, when you select a Claude Code agent, the editor window that opened the monitor reads that session's thinking from its Claude Code transcript and shows it in that monitor only. Thinking is the model's own text, not yours, and it can repeat a prompt, a file's contents, or a command line. Wyarden sends it neither to another window nor to the shared hub, writes it nowhere, and clears it when you select something else. Check the **Thinking** section before you share a screenshot or paste it into a bug report.

## Troubleshoot

| Symptom | Check |
| --- | --- |
| No **3D Monitor** command | Open **Extensions** in this editor profile and confirm `r-spring.wyarden-monitor-3d` is installed and enabled. Try **Developer: Reload Window** after active work finishes. |
| An existing session doesn't appear | Confirm that it is a live Claude Code process in the same environment. Open the folder that contains its working directory and wait for discovery. Try **All open** if a closer open folder may own the session. |
| An agent is working in a sibling Git worktree | Add that worktree's folder to the workspace or open it in another window with Wyarden installed. |
| The first calls are marked **derived** | This is expected in transcript mode. After configuring collectors, start a new Claude Code session if you want direct events. |
| Files or commands appear incomplete | The view depends on the events the provider supplies. Shell calls do not say which files a script read or wrote. |
| An agent node can't open its session | Switch to the window that owns the session. Wait a moment if its terminal is still starting. If Wyarden can't match a Claude Code panel to its process, use the editor's existing panel or terminal. |
| New and old windows show different views after an update | Reload every window with the extension, or restart the editor after work finishes. One of the windows hosts the shared hub. |
| A session stays briefly after exit | The hub detects the exit from the session file and retains the ended session for 20 seconds. |

Run **Wyarden 3D Monitor: Status** to open the Output panel. For a bug report, include your editor and extension versions, operating system, transcript or collector mode, and steps to reproduce with a disposable folder. Remove credentials, prompts, session titles, thinking text, and private paths before posting. [Open an issue](https://github.com/r-spring/wyarden/issues)

## Update or uninstall

Install the newer VSIX into each editor profile you use. Reload every active window when convenient so they all run the new version. To remove Wyarden, run **Remove Collectors** first if you enabled them, then uninstall the extension in each profile. After closing the relevant windows, you can remove the `~/.wyarden-monitor` directory to clear Wyarden's hub state.

For optional source builds, the simulated browser preview, and the license, see the repository overview. [Wyarden README](https://github.com/r-spring/wyarden#readme)
