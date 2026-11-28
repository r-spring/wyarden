# 3D agent monitor: start here

**What this is:** the results of the plan "3D agent monitor: critique, approach, wiring plan": five documents and two simulated mock-ups, and since then one **working mock-up** (section 6).
**The working mock-up:** real Claude Code sessions, live in a VS Code or VSCodium tab, with a chip for each open workspace. It is its own small extension; nothing in the main extension changed.
**What you need to do:** install its VSIX and open it (section 6). The seven decisions at the bottom of this page still stand for the full build; the mock-up took the recommended answer to each, except where section 6 says so.

Written 26 November 2026. Section 6 was added the same day.

## The results

### 1. The critique of the seven NEXUS mock-ups

[01-mockup-critique.md](01-mockup-critique.md)

- **None of the seven can be wired as it is.** All of them redraw 11 to 50 times a second while nothing changes.
- **None has a class for files, URLs or MCP servers.** MCP is one tool node, and a call is a number.
- **Their layouts cannot take live data.** One new node moves 11 to 15 others, and labels already overlap at 40 nodes.
- **The concept to build on:** Glasshouse's floors (one per class) crossed with Circuit City's column per agent, on slots that never move.
- **NEXUS stays as the default look,** because you accepted it by eye. The document lists 21 improvements; step 4 built them.

### 2. The live signals

[02-live-signals.md](02-live-signals.md)

- **All four agents have per-user hooks** that report every tool call. That is the one source that covers any workspace, including sessions the board did not start.
- **Claude Code reports the most:** start, end, failure, duration, the subagent and the MCP server. Codex, Grok Build and Antigravity each miss some of that; a table says which is exact, derived or missing.
- **Today's hooks are not enough:** they record a call's end only, and they are installed per card.
- **Cost, measured:** a hook that starts Node costs 55 ms per event. A loopback HTTP post costs 0.13 ms on the receiving side.
- **A privacy rule:** a fixed list of fields is kept. Command lines, file content, prompts, replies and absolute paths never are. One exception since the working mock-up's 0.1.7, your decision of 27 November: the thinking of the agent you select, which can repeat any of these, is shown in that monitor only and written nowhere. Since 0.2.1, at your request of 28 November, it covers a Codex, Grok Build or Antigravity agent as well as a Claude Code one ([05 section 8.6](05-working-mockup.md#86-thinking-for-the-selected-agent-since-017)).

### 3. The recommendation

[03-build-approach.md](03-build-approach.md)

- **Build it with three.js in a VS Code tab,** inside the extension, with the Canvas renderer as the fallback.
- **Not Godot, and not a separate app.** Measured: a Godot app costs about 190 MB and a second, unsigned installer. The tab costs 28 MB and one process.
- **What only Godot would give:** a view that lives while VS Code is closed.
- **Drawing nothing at rest is kept:** the tab drew 0 frames when nothing changed.
- **Not yet measured:** Linux and VSCodium. A two-minute probe settles it before any building starts.

### 4. The improved mock-ups

[The mock-ups' README](../../ui-concepts/monitor-3d/README.md) · screenshots: [NEXUS](img/after/nexus.png), [Glasshouse](img/after/glasshouse.png), [twelve agents](img/after/nexus-12-agents.png)

- **To open them:** run `node ui-concepts/monitor-3d/serve.js` from the repository's top folder, then open `http://127.0.0.1:4330/`. Or open `ui-concepts/monitor-3d/index.html` straight from the folder.
- **Two looks on one layout:** NEXUS (dark, the default) and Glasshouse (light). Switching the look moves nothing.
- **Four floors:** agents, MCP servers, tools, resources. One column per agent, for up to twelve.
- **Everything in them is invented:** a seeded simulator stands where the live feed will. The originals stay untouched beside them.
- **Measured:** 0 frames at rest; about 1.5 ms a frame with twelve busy agents; 82 checks pass (`node ui-concepts/monitor-3d/check.js`).

### 5. The wiring plan

[04-wiring-plan.md](04-wiring-plan.md)

- **How it joins up:** a per-user hook for each agent posts to one small hub on the machine. The hub keeps only the allowed fields and feeds the tab. A click becomes an ordinary VS Code command.
- **Seven phases, about 20 sessions.** Phase 1 is Claude Code only: a tool call, a file and an MCP call reach the view, and a double-click opens the file.
- **It works in any window,** with or without a board. The board's own workspace rule is not loosened.
- **It carries a budget:** 0 frames at rest, at most 5 ms added per tool-call event, 50 ms from event to pixel. Each is measured before and after.
- **It disagrees with the recommendation on two points** (its section 12): three.js may not be needed yet, and the hub cannot be files alone.

### 6. The working mock-up

[05-working-mockup.md](05-working-mockup.md) · the extension: [ui-concepts/monitor-3d-live/](../../ui-concepts/monitor-3d-live/README.md) · screenshots from real editors: [VS Code](img/live/vscode-live-session.png), [VSCodium](img/live/vscodium-hooks.png)

- **To use it:** run `node ui-concepts/monitor-3d-live/tools/pack.js`, install the VSIX it writes (`code --install-extension <file>`, or `codium --install-extension <file>`), then click **3D Monitor** in the status bar. After an update, reload each window: the update is complete when every window has been reloaded.
- **It works with nothing set up.** Live sessions come from Claude Code's own session files, their calls from their transcripts (marked derived). "Set Up Collectors…" adds hooks for exact calls, after showing each change as a diff.
- **You choose the workspace** with a chip: one for each editor window that is open right now, named as the window is titled. A window that closes takes its chip with it. A session that ends leaves after 20 seconds.
- **Changed on 27 November, after your first look (version 0.1.1):** the chips are windows, not folders (it had shown eight for your six windows); agents are icosahedrons and subagents dodecahedrons, coloured by provider; captions have no background; the tile an agent stands on carries its workspace's name; pointing at an agent shows its tab's title.
- **One build for every editor and system:** plain JavaScript, no package, no native code.
- **Verified:** 300 tests on Windows and on Linux (the page tests need a browser and ran on Windows only); the real extension in VS Code 1.148 and VSCodium 1.143 side by side on Windows, sharing one hub, with a real Claude Code session posting to it, and the hub handed over when its window closed.
- **Reviewed:** four independent reviewers tried to break its privacy rule, its hub, its installer and its page. What they found is fixed; section 9.4 of the document lists it, and what was left as it is.
- **Not verified:** any editor on Linux; Code - OSS; a remote window; a screen reader. Section 9.3 of the document has the full list.
- **Not on a shared machine:** do not set up collectors where other people log in. While no editor is open, another user's program could listen on the hub's port and receive what the hooks post.
- **Claude Code only.** Codex, Grok Build and Antigravity, the three.js renderer, the tree view and the native menu are the later phases of the wiring plan.
- **Measured on the way** (section 9.2): Claude Code never sends SessionStart to an HTTP hook, and a refused SessionEnd hook prints on the session's stderr. So the collector registers neither; a session's start and end come from its session file.

**The seven decisions, as the mock-up took them:** 1 the worker thread. 2 `settings.json`, shown as a diff, one confirmation. 3 no recording with no window open. 4 the Canvas renderer; three.js not built. 5 this window's folder first, every open workspace one chip away. 6 it differs: as its own extension it also runs in a restricted window, because it runs nothing from a workspace. 7 not touched.

## The decisions you must make

Details and reasons are in [section 11 of the wiring plan](04-wiring-plan.md#11-open-decisions-for-the-owner).

| # | Decision | Recommended |
|---|---|---|
| 1 | **Where the hub runs:** a worker thread in one VS Code window, files only, or a separate background program? | The worker thread. |
| 2 | **How Claude Code's collector is installed:** entries in each account folder's `settings.json`, or a plugin? | `settings.json`, shown as a diff first, with one confirmation. |
| 3 | **Record calls while no VS Code window is open?** | No. The view says "not recorded" for that time. |
| 4 | **three.js now, or on evidence?** And: a locked dependency, or a vendored file? | Measure the Canvas renderer at the end of phase 1; build three.js only if it misses its budget. A locked dependency. |
| 5 | **Which sessions the view shows at first:** this window's folders, or every workspace on the machine? | This window's folders, with "All workspaces" one click away. |
| 6 | **Untrusted workspaces:** leave the extension off there, or support the monitor in restricted windows? | Leave it off for version 1. |
| 7 | **Should the board later take its tool lines from the hub** and drop its own 55 ms hook? | Not in this plan. Decide after phase 5. |

**Before phase 1, half a session:** the probe on Linux and VSCodium, the "before" measurements, and three checks of how Claude Code treats the new hook.

## Other files in this folder

| File | What |
|---|---|
| [bench/README.md](bench/README.md) | How the measurements behind the recommendation were made, and how to run them again. |
| [probe-results.json](probe-results.json), [probe/](probe/) | The measurements behind the critique. |
| [img/before/](img/before/), [img/after/](img/after/) | Screenshots of the seven originals and of the improved mock-ups. |
