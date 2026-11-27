# Wyarden user guide

Wyarden 0.1.2 is a preview for watching live Claude Code work inside a desktop editor. You can use the monitor with a normal terminal session or a Claude Code editor session that is working in an open local folder.

## Install and check the download

Download **wyarden-monitor-3d-0.1.2.vsix** and **SHA256SUMS** from the release page. Open your editor's Command Palette and select **Extensions: Install from VSIX…**. Select the VSIX, then reload the window if prompted. [Release downloads](https://github.com/r-spring/wyarden/releases/tag/v0.1.2)

You can also install from a shell in the directory containing the download:

```sh
code --install-extension wyarden-monitor-3d-0.1.2.vsix
codium --install-extension wyarden-monitor-3d-0.1.2.vsix
```

Use the command for the editor you want. Install the extension in each editor or profile where you want Wyarden to see the windows. You can compare the downloaded file's SHA-256 with the value in **SHA256SUMS**:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\wyarden-monitor-3d-0.1.2.vsix
```

```sh
sha256sum -c SHA256SUMS
```

## Find your first Claude Code session

1. Open a local project folder in VS Code or VSCodium. Use a small test folder with a file you can ask Claude Code to read.
2. Start Claude Code in that same folder and complete its sign-in. Ask it to read the test file while the session remains open.
3. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Select that window's chip above the scene.
4. Look for the session's agent and tool nodes. The monitor reads Claude Code's session files and available transcripts. Calls from transcripts are marked **derived**.

Run **Wyarden 3D Monitor: Choose Workspace** if you prefer a list. Every chip represents one open editor window. A window can hold several project folders and still uses one chip. **All open** includes sessions from all windows connected to the monitor's local hub.

## Read and navigate the scene

- An agent is an icosahedron, and a subagent is a dodecahedron. The workspace name appears on the tile beneath the agent. Point to an agent to see its session title.
- The view arranges each session's activity in a column with related tool, MCP server, and resource nodes. Lines show calls between nodes. The preview draws up to 12 sessions per view and reports how many are left out.
- Select a node to see its details. Double-click a file or press **Ctrl+Enter** on it to open it beside the monitor. For a grouped set of files Wyarden offers a picker. It asks before opening a URL in your browser.
- Switch between **NEXUS** and **Glasshouse** to change the appearance while keeping the layout. New sessions are framed automatically until you move the camera.

## Optional collectors

Transcript mode is the simplest setup. When you want direct Claude Code events for supported calls, run **Wyarden 3D Monitor: Set Up Collectors…**. It lists the Claude Code settings files it plans to edit and shows a diff. Use **Show every change** to review all diffs before confirming. Typical locations include the settings in `~/.claude`, `~/.claude-accounts`, and the directory selected by `CLAUDE_CONFIG_DIR` when set.

Use collectors only on a single-user machine. Claude Code sends the local hook request before Wyarden can filter its contents, so transcript mode is the appropriate choice on a shared machine. Keep an editor window with Wyarden open while using collectors. Restart an existing Claude Code session if its new events remain derived after setup.

To undo the settings changes, run **Wyarden 3D Monitor: Remove Collectors**. Review the target files before confirming.

## Privacy and local state

Wyarden's hub listens on loopback on the machine where the editor extension runs. The monitor filters transcript and hook data to the fields needed by the scene, including names, relative paths, timestamps, and call outcomes. Prompts, file contents, and command lines are dropped from the view. Session titles may appear in the view, so check them before sharing a screenshot.

The hub keeps connection details in `~/.wyarden-monitor/hub.json`. The editor remembers the scope and view for each workspace. When no monitor tab is open, Wyarden pauses its session and transcript polling. Remote editor environments have their own sessions and hub.

## Troubleshoot

| Symptom | Check |
| --- | --- |
| No **3D Monitor** command | Open **Extensions** in this editor profile and confirm `r-spring.wyarden-monitor-3d` is installed and enabled. Try **Developer: Reload Window** after active work finishes. |
| The window has a chip but no sessions | Run Claude Code from an open local project folder. Keep its session running while you open the monitor, then ask it to read a file. Try **All open** to verify the scope. |
| The first calls are marked **derived** | This is expected in transcript mode. After configuring collectors, start a new Claude Code session if you want direct events. |
| Files or commands appear incomplete | The view depends on the events the provider supplies. Shell calls do not say which files a script read or wrote. |
| New and old windows show different views after an update | Reload every window with the extension, or restart the editor after work finishes. One of the windows hosts the shared hub. |
| A session stays briefly after exit | The hub detects the exit from the session file and retains the ended session for 20 seconds. |

Run **Wyarden 3D Monitor: Status** to open the Output panel. For a bug report, include your editor and extension versions, operating system, transcript or collector mode, and steps to reproduce with a disposable folder. Remove credentials, prompts, session titles, and private paths before posting. [Open an issue](https://github.com/r-spring/wyarden/issues)

## Update or uninstall

Install the newer VSIX into each editor profile you use. Reload every active window when convenient so they all run the new version. To remove Wyarden, run **Remove Collectors** first if you enabled them, then uninstall the extension in each profile. After closing the relevant windows, you can remove the `~/.wyarden-monitor` directory to clear Wyarden's hub state.

For optional source builds, the simulated browser preview, and the license, see the repository overview. [Wyarden README](https://github.com/r-spring/wyarden#readme)
