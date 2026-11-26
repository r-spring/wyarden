# Third-party notices

Entomatical adapts three small pieces of code from other projects. Each place in `src/` carries a comment naming the source file, commit and license, and saying what was changed. The full license texts are in `licenses/`.

| Used in | What | Source | Commit | License |
|---|---|---|---|---|
| `src/board.ts` (`paste`) | Bracketed-paste wrapper for sending multi-line text into the Claude TUI | [cline/kanban](https://github.com/cline/kanban) `src/terminal/agent-session-adapters.ts` | `abd4912c` | Apache-2.0, `licenses/kanban-LICENSE.txt` |
| `src/sessions.ts` (`writeFileAtomic`) | Write-temp-then-rename file write. Modified: trimmed to the core, rename retries added | [vishalguptax/claude-code-manager](https://github.com/vishalguptax/claude-code-manager) `src/core/atomicWrite.ts` | `0e2d85f3` | Apache-2.0, `licenses/claude-code-manager-LICENSE.txt` |
| `src/extension.ts` (webview HTML) | Nonce-based Content Security Policy pattern | [salam/claudine](https://github.com/salam/claudine) `src/providers/KanbanViewProvider.ts`, Copyright (c) 2025 Claudine Contributors | `c6cbb01d` | MIT, `licenses/claudine-LICENSE.txt` |

The full source snapshots used during development (`borrowed/`, `reference/`) are not included in this public repository. The upstream source is available at the commits above.

Interactive card terminals include [node-pty](https://github.com/microsoft/node-pty), [xterm.js](https://github.com/xtermjs/xterm.js), xterm.js's fit addon, and xterm.js's headless build (`@xterm/headless`, which reads a card terminal's screen in the extension host so a parent card can see it). All four are distributed under the MIT license; their license texts are included alongside their packaged runtime files, except `@xterm/headless`, whose package has no license file: it is the same xterm.js project, whose MIT license ships as `node_modules/@xterm/xterm/LICENSE`. The Windows node-pty package also carries ConPTY binaries from [Windows Terminal](https://github.com/microsoft/terminal), whose MIT license is in `licenses/windows-terminal-LICENSE.txt`.

node-pty's native binaries (`pty.node` in the Linux package, `conpty.node` and `conpty_console_list.node` in the Windows package) are compiled with [node-addon-api](https://github.com/nodejs/node-addon-api), a C++ header library (`napi.h`) for Node-API addons, so code from its headers is inside those binaries. The version is the one `package-lock.json` locks, 7.1.1. Its MIT license, Copyright (c) 2017 Node.js API collaborators, ships unchanged in both packages as `node_modules/node-addon-api/LICENSE.md`. Nothing loads node-addon-api at run time.
