# Wyarden changelog

## Unreleased

- 0.2.1: the **Thinking** section now works for Codex, Grok Build, and Antigravity agents too; their reasoning is read from each tool's own record of the session, by the editor window that opened the monitor, and written nowhere. Codex keeps reasoning text only while its reasoning summaries are on (`model_reasoning_summary`); in the Codex sessions measured, every turn since October ran with them off, so those show a count and no text.
- 0.2.0 adds live Codex, Grok Build, and Antigravity sessions alongside Claude Code. The collector setup command previews the required provider configuration. The status command shows whether each provider is configured and whether Codex is waiting for hook approval.

- 0.1.7: select a Claude Code agent to see the thinking its session has done, newest first, in a **Thinking** section under its details; it is read by the editor window that opened the monitor and by no other, kept current while the agent stays selected, and written nowhere. In the 14 transcripts measured, most thinking left only a count; in six probe sessions, Claude Code wrote the text only when started with `--thinking-display summarized`.
- 0.1.6 opens **3D Monitor** in a dedicated floating window. Open files, reveal searched folders, and show agent sessions across open workspaces from that window.
- 0.1.5: a new version number for the same code as 0.1.4, so that an installed copy can be told from an older 0.1.4 build. Nothing behaves differently.
- 0.1.4: the output channel no longer logs "onState failed: ReferenceError" each time the extension starts. Nothing else was affected.

## 0.1.3 preview

- First public preview of the standalone Wyarden 3D Monitor.
- See active Claude Code sessions and subagents alongside the tools, files, URLs, and MCP servers they use.
- Switch among open editor windows or use **All open**. Transcript mode works as soon as you install the extension. Optional collectors add direct call events after approval.
- Identify agents by provider colour and shape, see the window name on the tile, and point to an agent to see the session title.
- Open a session from its agent node when Wyarden can confirm its terminal or Claude Code panel is in the current window.
- Switch between NEXUS and Glasshouse, choose a file from the scene, and open it beside the monitor.

[Download and release notes](https://github.com/r-spring/wyarden/releases/tag/v0.1.3)

## Earlier prototypes

Versions 0.1.0 through 0.1.2 introduced the live Claude Code feed, the per-window scene, and the provider colours shown in the monitor. The design record includes build details, screenshots, and the list of remaining work. [Design and verification notes](https://github.com/r-spring/wyarden/blob/main/docs/monitor-3d/05-working-mockup.md)
