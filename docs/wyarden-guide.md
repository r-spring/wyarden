# Wyarden user guide

Wyarden 0.2.0 shows live Claude Code, Codex, Grok Build, and Antigravity sessions. A session's working directory determines which workspace chip it appears under. **All open** shows the sessions across connected editor windows.

## Install and check the download

For the four-provider source build, run `node ui-concepts/monitor-3d-live/tools/pack.js` from the repository root. The packer writes `wyarden-monitor-3d-0.2.0.vsix` in `ui-concepts/monitor-3d-live/dist/`. In the Command Palette, choose **Extensions: Install from VSIX…** and select that file. After an update, reload each connected window once its active work is finished. Published previews list their own version, supported providers, and downloads. [Release downloads](https://github.com/r-spring/wyarden/releases)

You can also install the 0.2.0 build from a shell in the directory containing the VSIX.

```sh
code --install-extension wyarden-monitor-3d-0.2.0.vsix
codium --install-extension wyarden-monitor-3d-0.2.0.vsix
```

Use the command for your editor. Install the extension in each editor profile whose windows you want Wyarden to see. On Windows, the following command prints the local build's SHA-256. For a published VSIX, compare its hash with the checksum supplied for that version.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\wyarden-monitor-3d-0.2.0.vsix
```

For a release that supplies `SHA256SUMS`, run this command in the download directory.

```sh
sha256sum -c SHA256SUMS
```

## See the agents already running in a workspace

1. In VS Code or VSCodium, open the folder where the agent is working, or a parent folder that contains it.
2. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Pick the workspace chip above the scene, or choose **All open**.
3. Run **Wyarden 3D Monitor: Set Up Collectors…** for direct provider events. Review the changes, then follow the provider instructions below. Start or resume a session in the open workspace and ask it to read a file there.
4. Select the agent to inspect its calls and resources. Claude Code sessions and loaded Codex app-server threads can appear before a new call. Claude Code activity read from transcripts is marked **derived**.

Run **Wyarden 3D Monitor: Choose Workspace** if you prefer a list. A chip represents a connected editor workspace, which can contain several folders. **All open** combines these scopes. When two open folders overlap, Wyarden uses the closest matching folder. A Git worktree outside those folders has its own path, so add that worktree folder to the workspace or open it in another connected window.

| Session | Where to find it |
| --- | --- |
| Claude Code already running in an open folder or subfolder | Its workspace chip and **All open**. |
| Claude Code launched in a separate terminal | The same workspace chip, provided Wyarden can read its session files and its working directory matches the open folder. |
| Claude Code in WSL, SSH, or a container | The editor environment where the session runs. Each environment has its own session files and hub. |
| Codex | The matching workspace and **All open**. Wyarden can discover loaded threads through an available local app server. Approved hooks report new calls from CLI sessions. |
| Grok Build | The matching workspace and **All open** after the first supported event from a session with the Wyarden hooks loaded. |
| Antigravity | The matching workspace and **All open** after its command hook reports a conversation or tool step. |

## Read and navigate the scene

- An agent is an icosahedron, and a subagent is a dodecahedron. The workspace name appears on the tile beneath the agent. Point to an agent to see its session title.
- The view arranges each session's activity in a column with related tool, MCP server, and resource nodes. Lines show calls between nodes. The preview draws up to 12 sessions per view and reports how many are left out.
- Select a node to see its details. Double-click a file or press **Ctrl+Enter** on it to open it beside the monitor. For a grouped set of files Wyarden offers a picker. It asks before opening a URL in your browser.
- Since 0.1.7, select a Claude Code agent to see the thinking its session has done, newest first, in the **Thinking** section under its details. It stays current while the agent is selected. In the 14 transcripts measured, most thinking left only a count. In six probe sessions, Claude Code wrote thinking text only when the session was started with the hidden `--thinking-display summarized` flag. For a session that has thought without that flag, the section counts the thoughts and says no text was recorded. A subagent's thinking is not shown.
- Double-click an agent or press **Ctrl+Enter** to show its terminal or Claude Code panel when Wyarden can confirm the session is in this editor window. A subagent opens its parent session. For a session in another window, switch to that window first.
- Switch between **NEXUS** and **Glasshouse** to change the appearance while keeping the layout. New sessions are framed automatically until you move the camera.

## Optional collectors

Run **Wyarden 3D Monitor: Set Up Collectors…**. Wyarden lists changes to the provider profiles found on this machine. Choose **Show every change** to inspect the redacted previews, then confirm. If a provider profile is missing, start that provider once and run setup again. Codex and Antigravity command hooks require Node.js on the editor's PATH and Windows PowerShell on Windows.

| Provider | What setup changes | How to see the next call |
| --- | --- | --- |
| Claude Code | Adds monitor entries to the discovered account `settings.json` files. | Restart an existing session if its calls still show as derived. Transcript discovery also works without setup. |
| Codex | Adds Wyarden command hooks to `hooks.json` in the Codex profile. | Restart Codex, open `/hooks`, review and approve the Wyarden commands, then start or resume a session. |
| Grok Build | Adds `hooks/wyarden-monitor.json` in the Grok profile. | Restart Grok, complete its normal workspace trust review if prompted, and start a turn. |
| Antigravity | Adds the `wyarden-monitor-antigravity` group to `~/.gemini/config/hooks.json`. | Restart Antigravity, complete its normal workspace trust review if prompted, and start a turn. |

Use collectors only on a single-user machine and keep an editor window with Wyarden open. Providers send their hook payloads to the local hub, where Wyarden filters them for the scene. **Wyarden 3D Monitor: Status** shows the setup state for each provider, including Codex hooks awaiting approval.

To undo the settings changes, run **Wyarden 3D Monitor: Remove Collectors**. Review the target files, confirm, and restart the affected providers.

## Privacy and local state

Wyarden's hub listens on loopback on the machine where the editor extension runs. The monitor filters transcript and hook data to the fields needed by the scene, including names, relative paths, timestamps, and call outcomes. Prompts, file contents, and command lines are dropped from the view, except where an agent's thinking repeats them (see below). Session titles and the **Thinking** section may appear in the view, so check them before sharing a screenshot.

The hub keeps connection details in `~/.wyarden-monitor/hub.json`. The editor remembers the scope and view for each workspace. When no monitor tab is open, Wyarden pauses its session and transcript polling. Remote editor environments have their own sessions and hub.

When you open a session from its agent node, the monitor checks the local process list to match the session to this window. It keeps that information in memory only for the lookup.

Since 0.1.7, when you select a Claude Code agent, the editor window that opened the monitor reads that session's thinking from its Claude Code transcript and shows it in that monitor only. Thinking is the model's own text, not yours, and it can repeat a prompt, a file's contents, or a command line. Wyarden sends it neither to another window nor to the shared hub, writes it nowhere, and clears it when you select something else. Check the **Thinking** section before you share a screenshot or paste it into a bug report.

## Troubleshoot

| Symptom | Check |
| --- | --- |
| No **3D Monitor** command | Open **Extensions** in this editor profile and confirm `r-spring.wyarden-monitor-3d` is installed and enabled. Try **Developer: Reload Window** after active work finishes. |
| A session doesn't appear | Open the folder that contains its working directory and try **All open**. Check **Wyarden 3D Monitor: Status** for that provider, restart it after setup, and ask it to read a local project file. For Codex, review the Wyarden entries in `/hooks`. |
| An agent is working in a sibling Git worktree | Add that worktree's folder to the workspace or open it in another window with Wyarden installed. |
| The first calls are marked **derived** | This is expected in transcript mode. After configuring collectors, start a new Claude Code session if you want direct events. |
| Files or commands appear incomplete | The view depends on the events the provider supplies. Shell calls do not say which files a script read or wrote. |
| An agent node can't open its session | Switch to the window that owns the session. Wait a moment if its terminal is still starting. If Wyarden can't match a Claude Code panel to its process, use the editor's existing panel or terminal. |
| New and old windows show different views after an update | Reload every window with the extension, or restart the editor after work finishes. One of the windows hosts the shared hub. |
| A session stays after exit | Claude Code session discovery tracks process exit. Providers with a session-end hook report closure. An Antigravity conversation without an end signal expires after 30 minutes of silence. |

Run **Wyarden 3D Monitor: Status** to open the Output panel. For a bug report, include your editor and extension versions, operating system, transcript or collector mode, and steps to reproduce with a disposable folder. Remove credentials, prompts, session titles, thinking text, and private paths before posting. [Open an issue](https://github.com/r-spring/wyarden/issues)

## Update or uninstall

Install the newer VSIX into each editor profile you use. Reload every active window when convenient so they all run the new version. To remove Wyarden, run **Remove Collectors** first if you enabled them, then uninstall the extension in each profile. After closing the relevant windows, you can remove the `~/.wyarden-monitor` directory to clear Wyarden's hub state.

For optional source builds, the simulated browser preview, and the license, see the repository overview. [Wyarden README](https://github.com/r-spring/wyarden#readme)
