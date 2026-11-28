# Wyarden 3D Monitor

Wyarden automatically finds supported coding-agent sessions already running in your open workspaces. It groups them by the folders they work in, including sessions launched from a separate terminal. The 3D view connects agents and subagents to their tools, files, URLs, and MCP servers.

The current preview discovers live **Claude Code** sessions. [Download the VSIX](https://github.com/r-spring/wyarden/releases) · [User guide](https://github.com/r-spring/wyarden/blob/main/docs/wyarden-guide.md)

![Wyarden showing a live Claude Code session in VS Code](https://raw.githubusercontent.com/r-spring/wyarden/main/docs/monitor-3d/img/live/vscode-0.1.1.png)

## Install and see the agents already running

1. Download the preview VSIX and check the editor version supported by that release. In VS Code or a compatible editor, run **Extensions: Install from VSIX…** and reload if prompted.
2. Open the project folder where your agent is running. Agents whose working directory is in an open folder or one of its subfolders are eligible. Open a sibling worktree as an additional folder if its path sits outside the workspace.
3. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Pick the workspace chip for that editor window or choose **All open**.
4. Give Wyarden a few seconds to discover existing Claude Code sessions, including idle ones. Activity from transcripts is marked **derived**.

Wyarden can discover those sessions through Claude Code's existing session files. Optional collectors add direct call events after you review and approve changes to Claude Code settings. Use collectors only on a machine where you're the only user. [Collector setup and privacy](https://github.com/r-spring/wyarden/blob/main/docs/wyarden-guide.md#optional-collectors)

## Learn and troubleshoot

- Follow the [user guide](https://github.com/r-spring/wyarden/blob/main/docs/wyarden-guide.md) for the controls, multi-window setup, updates, removal, and troubleshooting.
- See [what is in the current preview](https://github.com/r-spring/wyarden/blob/main/ui-concepts/monitor-3d-live/README.md) and the [design and verification notes](https://github.com/r-spring/wyarden/tree/main/docs/monitor-3d).
- Report a problem with the Wyarden version, editor version, OS, and steps to reproduce. Share only sanitized logs and screenshots. [Issues](https://github.com/r-spring/wyarden/issues) · [Private security reporting](https://github.com/r-spring/wyarden/security/advisories/new)

## Build or preview from source

Clone the repository. Use a current Node.js LTS from the repository root.

```sh
node ui-concepts/monitor-3d-live/tools/pack.js
node --test "ui-concepts/monitor-3d-live/test/*.test.js"
```

The packer writes one VSIX for all supported hosts under `ui-concepts/monitor-3d-live/dist/`. Install it using the same VSIX command above. The browser-dependent tests use Edge or Chrome when available.

To explore the simulated view with sample activity, run `node ui-concepts/monitor-3d/serve.js` and open `http://127.0.0.1:4330/`. The editor extension reads live sessions. [Simulated preview](https://github.com/r-spring/wyarden/tree/main/ui-concepts/monitor-3d)

## About

Wyarden is maintained by Robert Spring and licensed under the GNU General Public License v3. Entomatical, the separate VS Code task board, has its own source and release guides. [Maintainer](https://github.com/r-spring) · [Changelog](https://github.com/r-spring/wyarden/blob/main/CHANGELOG.md) · [License](https://github.com/r-spring/wyarden/blob/main/LICENSE) · [Entomatical](https://github.com/r-spring/entomatical-public)
