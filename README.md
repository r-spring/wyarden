# Wyarden 3D Monitor

Wyarden shows coding agents working in your open workspaces, including sessions launched from a separate terminal. The 3D view connects each session to the tools, files, URLs, and MCP servers its provider reports.

The **0.2.0 source build** supports live **Claude Code, Codex, Grok Build, and Antigravity** sessions. Build the VSIX from this checkout using the commands below. For a published build, check the provider support listed with that release. [Release downloads](https://github.com/r-spring/wyarden/releases) · [User guide](https://github.com/r-spring/wyarden/blob/main/docs/wyarden-guide.md)

![Wyarden showing a live Claude Code session in VS Code](https://raw.githubusercontent.com/r-spring/wyarden/main/docs/monitor-3d/img/live/vscode-0.1.1.png)

## Install and see the agents already running

1. Install the VSIX using **Extensions: Install from VSIX…**. After an update, reload your connected editor windows when their active work is finished.
2. Open the project folder where your agent is running. Agents whose working directory is in an open folder or one of its subfolders are eligible. Open a sibling worktree as an additional folder if its path sits outside the workspace.
3. Click **3D Monitor** in the status bar or run **Wyarden 3D Monitor: Open**. Pick the workspace chip for that editor window or choose **All open**.
4. Run **Wyarden 3D Monitor: Set Up Collectors…** and review the proposed changes. Restart Codex and approve the Wyarden commands in `/hooks`. Restart Grok Build and Antigravity to load their hooks. Give each provider a task in an open project, such as reading a project file. Its name and tool activity appear under that workspace and **All open**.

Claude Code sessions can also appear from their existing session files, with transcript activity marked **derived**. Codex can show threads loaded by a reachable local app server before hook activity arrives. Use collectors on a single-user machine and keep an editor window with Wyarden open. [Collector setup and privacy](https://github.com/r-spring/wyarden/blob/main/docs/wyarden-guide.md#optional-collectors)

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
