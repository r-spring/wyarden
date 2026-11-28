# 04. The wiring plan

**What gets built:** a per-user hook for each agent (the collectors) posts every tool call to one small hub on the machine. The hub cuts each event down to the fields the privacy rule allows, keeps the live picture, and feeds a three.js view in a VS Code tab. A click in the view becomes an ordinary VS Code command.
**Plans for:** option A2 of [03-build-approach.md](03-build-approach.md): three.js on WebGL2 in a webview, with the Canvas renderer as the fallback.
**First slice (phase 1):** Claude Code only. A tool call, a file and an MCP call reach the view, and a double-click on a file opens it in an editor. Four sessions.
**Whole plan:** seven phases, about 20 sessions. Nothing here is built: this step wrote documents only.
**The owner decides seven things** (section 11). The three that change the most: where the hub runs, how the collectors are installed, and whether calls are recorded while no VS Code window is open.

Written 26 November 2026 by card e44262, step 5 of plan "3D agent monitor: critique, approach, wiring plan". Line numbers are at commit `5edf2ae`.

**Words used here:**
- **Collector:** the hook that an agent runs on each event, and its configuration in that agent's per-user folder.
- **Hub:** the one place on a machine that receives events from every collector.
- **Host:** the extension host of one VS Code window.
- **Page:** the webview that draws the 3D view.
- **Contract:** the event format between collectors, hub, host and page, version 1.
- **Session (as a size):** one card run by one agent, about the size of each step of this plan.
- **02, 03:** [02-live-signals.md](02-live-signals.md) and [03-build-approach.md](03-build-approach.md). "02 §13" is section 13 of 02.

**Contents:** [1 Architecture](#1-architecture) · [2 Event contract](#2-the-event-contract-version-1) · [3 Collectors](#3-a-collector-for-each-agent) · [4 Hub](#4-the-hub) · [5 Wiring the view](#5-wiring-the-view) · [6 Actions](#6-the-action-table) · [7 Any workspace](#7-any-workspace) · [8 Budget](#8-the-resource-budget-and-how-to-measure-it) · [9 Tests](#9-tests) · [10 Phases](#10-phases) · [11 Decisions](#11-open-decisions-for-the-owner) · [12 Dissent](#12-dissent) · [13 Not verified](#13-not-verified)

---

## 1. Architecture

```
  Agents: any folder, any terminal, started by the board or not
  +-------------+  +-------------+  +-------------+  +-------------+
  | Claude Code |  |    Codex    |  | Grok Build  |  | Antigravity |
  +------+------+  +------+------+  +------+------+  +------+------+
         | http hook      | command hook   | http hook      | command hook
         |                | (post or spool)|                | (post or spool)     COLLECTORS
         +----------------+-------+--------+----------------+                     one per agent, per user
                                  |
                                  v   POST http://127.0.0.1:<port>/h/<ingest token>/<agent>
  +-------------------------------------------------------------------------------+
  | HUB: one per machine. A worker thread in the extension host of one window.    |
  |                                                                               |
  |  receive -> normalise and redact (02 §13) -> drop duplicates -> number (seq)  |
  |          -> live model (floors, columns, slots) -> ring of recent events      |
  |                                                                               |
  |  also takes: the board's own signals (ACP, Codex app-server), spool files     |
  |  writes: one checkpoint file (the live picture, no history)                   |
  +----------------+-------------------------------------------+------------------+
                   | MessagePort (the hub's own window)        | GET /v1/stream (other windows,
                   v                                           v  control token)
  +----------------------------------+        +----------------------------------+
  | HOST, window A                   |        | HOST, window B                   |
  |  Monitor: feed, actions, tree    |<------>|  Monitor: feed, actions, tree    |
  +--------+----------------^--------+ action +----------------------------------+
           | postMessage    | postMessage     routed through the hub when the
           | snapshot,      | select, act     target lives in another window
           | events,        |
           | highlight      |
           v                |
  +----------------------------------+        +----------------------------------+
  | PAGE: the 3D view, a webview tab |        | ORDINARY VS CODE UI              |
  |  three.js, Canvas as fallback    |  act   |  editor, diff editor, terminal,  |
  |  DOM labels, the list twin       |------->|  tree view, Quick Pick,          |
  |  no editing controls             |  (via  |  Claude Code panel, another      |
  +----------------------------------+  host) |  window                          |
           ^                                  +----------------+-----------------+
           |  highlight: the active editor's file, the active terminal's session, |
           +---------- the tree view's selection (selection back from VS Code) ---+
```

**The five parts:**

| Part | What it is | Where it runs |
|---|---|---|
| Collectors | One hook configuration per agent, in that agent's per-user folder. | Inside each agent, on every event. |
| Hub | Receives, redacts, orders and holds the live picture. | A worker thread in one window's host. No new process. |
| 3D view | The page: draws on change, selects, asks for actions. | A webview tab, in its own renderer process. |
| Actions into VS Code | The page asks; the host checks the request and runs a VS Code command. | The host of the window that owns the target. |
| Selection back | The active editor, active terminal and tree selection light up their nodes. | Host to page, one message, one frame. |

**Three rules that hold everywhere:**
1. **The page never names a path, a command or a window.** It sends `{action, target: {class, id}}`. The host resolves it.
2. **Raw hook payloads never leave the hub's memory.** The first code that touches a payload is the normaliser. Only its output is stored, forwarded or drawn.
3. **Nothing draws, polls or wakes when nothing happens.** One coarse timer exists, in the hub, and it runs only while a session is live (section 2.6).

---

## 2. The event contract, version 1

The contract is 02 §11 (the vocabulary, the envelope and the 13 events) plus what this section adds. 02 §11 is not repeated here.

### 2.1 Records

One JSON object per record. A record is either an **event** (it has `ev`) or a **control record** (it has `ctl`).

**What the hub adds to every event:**

| Field | Meaning |
|---|---|
| `seq` | A whole number the hub gives each event, rising by one. The only ordering key. |
| `ws` | The workspace key (section 2.3), as in 02. |
| `root` | Only on `session.start`: `{name, card?}`. `name` is the root folder's base name. `card` is the board card's id when the root is a board worktree. |

**Control records:**

| `ctl` | When | Fields |
|---|---|---|
| `snapshot` | First record on every connection, and after a `resync`. | `epoch`, `seq`, `state` (the model, section 2.4), `collectors`, `left` (what the limits dropped) |
| `gap` | The hub missed events: a hand-over, an overflow, a restart. | `from`, `to` (times), `why` |
| `collector` | A collector's state changed. | `agent`, `state`: `installed`, `missing`, `disabled`, `awaiting-approval`, `slow`, `silent` |
| `digest` | After every 500 events, and when the stream goes quiet. | `seq`, `slots`: a hash of the slot list |

### 2.2 Version rules

- `v` is a whole number, 1.
- **Not a version change:** a new optional field, a new `ctl`, a new value of `src`. A consumer ignores unknown fields and unknown `ctl` records.
- **An unknown `ev`** is counted as rejected and skipped. Today `model.js` throws on it and `app.js` counts the throw; that stays.
- **A version change (v2):** removing or renaming a field, or changing what one means.
- The hub, the host and the page ship in one VSIX, so they always agree. The version matters for recorded files (section 9) and for a second renderer.

### 2.3 Ids

| Id | Made from | Stable for |
|---|---|---|
| Session key | `<agent>:<session>` | The session's life. |
| Call | The agent's own call id (`tool_use_id`, `toolUseId`, `stepIdx` as `step-<n>`). | The session. |
| Turn | The agent's id, or the hub's count `n-<k>` when the agent gives none. | The session. |
| Node id | As `model.js` makes them today: `a:<key>` agent, `s:<key>:<sub>` subagent, `t:<key>:<tool>` tool, `m:<server>` MCP server, `r:<key>:<kind>:<group>` resource. | Until the node leaves. |
| `ws` | The first 12 hex characters of SHA-256 of the root folder's real path. Lower-cased first on Windows, as `samePath` does (`src/workspace.ts:36`). | The folder. |
| `epoch` | 8 random hex characters, made when the hub starts with no checkpoint. | Until the checkpoint is lost. |
| Window id | Made by each host at start. Lives in the hub's memory only. | The window. |

- **The root folder** of a session is the nearest folder at or above its `cwd` that holds a `.git` entry (a folder or a file), else the `cwd` itself. Found by reading folders, with no git process, once per `cwd`.
- So a board worktree is its own root, and `root.card` ties it back to its card.
- **Every window works out the same `ws` key for its own folders**, so the hub never has to store a path to know which window owns an event.

### 2.4 The snapshot

- The hub runs the one live model: `model.js` with `layout.js`, the files step 4 wrote, loaded as plain modules.
- `state` is that model, serialised: sessions, nodes with their column, floor and slot, open calls, stacks, counters, and the last 50 calls of each session.
- The page loads `state` into its own copy of the same model, then applies each event in `seq` order. Same code and same order give the same slots.
- **This is what 03 section 6 asks for:** slot positions are computed once, by the host side, and sent with the snapshot.
- `digest` proves it. The page compares its own slot hash; on a mismatch it sends `resync` and gets a new snapshot.
- **Needed in `model.js`:** `serialize()` and `load(state)`. Nothing else changes in it.
- **Size at the limits:** about 200 nodes, under 200 KB of JSON. To be measured in phase 1.

### 2.5 Ordering

- **Order is `seq`.** `t` (when the hub received the event) and `at` (the agent's own time) are for display, never for sorting.
- A synchronous hook keeps a call's start before its end, because the agent waits for the answer.
- An asynchronous command hook (Codex) may deliver an end before its start. The model's rules for that:
  - an end with no start draws the call as ended, with its start time derived from `ms` when present;
  - a start for a call that has already ended is dropped and counted.
- **Duplicates.** The same event can arrive twice: Grok Build reads `.claude/settings.json` (02 §5), and a board card has both a hook and the board's own signal. The hub keys each event and drops a repeat:

| Events | Key |
|---|---|
| `tool.*`, `mcp.*` | session key, `ev`, `call` |
| `resource.touch` | session key, `call`, `kind`, `op`, path or URL |
| `turn.*` | session key, `ev`, `turn` |
| `subagent.*` | session key, `ev`, `sub` |
| `session.*`, `wait.*` | session key, `ev`, `t` rounded to the second |

- **One source per session.** When an agent's collector is installed, the board's own ACP and app-server signals for that agent are not used. Their call ids differ from the hook's, so the two cannot be merged.
- **The agent is read from the payload's shape**, not from the URL (02 §5, the Grok risk). The `<agent>` in the URL is a hint for the error count only.

### 2.6 Events the hub makes itself

02 leaves two things open: the "stalled" state (step 4's README, "Not built") and a session end for Antigravity. Both need a clock. The clock lives in the hub, never in the page.

- **One timer, every 30 s, only while at least one session is live.** It emits an event only when something changed, so the view still draws only on change.
- **`call.stale`** (new in version 1): `{call, openMs}`, grade `derived`, src `hub:timer`. Sent once when a call has been open for 120 s with no wait open on it. The view shows the "unclear" mark.
- **`session.end`** with `reason: "silent"`, grade `derived`: for an agent with no session-end signal, after 30 minutes with no event.
- **`tool.end` and `mcp.end` with no `ok`**, grade `derived`, src `hub:gap`: closes a call whose end was never seen. Sent at that session's next `turn.start`, `turn.end` or `session.end`. The view shows "end not seen", never "failed".

### 2.7 On connect

1. The page (or another window's host) sends `ready` with the `epoch` and `seq` it last had, or nothing.
2. Same `epoch`, and the hub's ring still holds everything after that `seq`: the hub sends only the missed events.
3. Otherwise: a `snapshot`, then every event after the snapshot's `seq`.
4. No record is ever sent twice on one connection, and none is skipped without a `gap`.

### 2.8 Limits on what is kept

| What | Limit | Then |
|---|---|---|
| Columns (sessions drawn) | 12 (`layout.js` `MAX_COLUMNS`) | Counted as left out; the oldest ended session gives up its column. |
| Calls remembered per session | 50 (`HISTORY`) | Oldest dropped. |
| Nodes per floor per column | 8, plus one "+N" stack | Folded into the stack; a stack remembers 200 items, then only counts. |
| Files inside one folder group | 40 (`MEMBER_CAP`) | Counted. |
| Tools on one MCP server | 32 kept, 8 drawn | Counted. |
| The hub's ring of recent events | 5,000 events or 2 MB | A slower consumer gets a snapshot instead. |
| Ended sessions | 60 minutes, or until the column is needed | Removed. |
| One hook payload | 8 MB read, then dropped and counted | The agent still gets its answer. |
| Events from one session | 200 a second | Sampled; the count is exact. |
| Any string field | Tool and server names 80 characters, a path 400, a URL 400 | Cut; control characters removed. |
| On disk | One checkpoint file, at most 512 KB, overwritten. Spool files, deleted once read, 1 MB each. | Nothing else. No history, no database. |

- **Nothing leaves the machine.** The hub has no outgoing connection.
- **A recording** (for tests and for a bug report) is made only by a command, to a file the owner names, and holds redacted events only.

### 2.9 Messages between host and page

| Direction | Message | Purpose |
|---|---|---|
| page → host | `{v:1, type:"ready", have:{epoch, seq}, renderer}` | Ask for the feed. `renderer` is `webgl2` or `canvas`. |
| host → page | The records of 2.1, batched: `{v:1, type:"records", records:[…]}` | The feed. One message per turn of the host's event loop, never one per event. |
| host → page | `{v:1, type:"highlight", ids:[…], why}` | Selection back from VS Code (section 6.3). |
| host → page | `{v:1, type:"select", id}` | The tree view chose a node. |
| host → page | `{v:1, type:"look", look, reducedMotion}` | Theme kind changed. |
| page → host | `{v:1, type:"select", target:{class, id}}` | A click. Nothing else. |
| page → host | `{v:1, type:"act", action, target:{class, id}, member?}` | A double-click or a menu choice (section 6). |
| page → host | `{v:1, type:"resync", why}` | The digest did not match. |
| page → host | `{v:1, type:"cost", frames, frameMs, nodes, labels, eventToPixelMs}` | For the cost command (section 8). Sent on request only. |

- `action` is 03's five (`open`, `diff`, `focus`, `showCall`, `openMcpConfig`) plus four this plan adds: `openUrl`, `reveal`, `list`, `window`.
- The host rejects any message that fails the shape check, any `id` the model does not hold, and any `action` the target's class does not allow.

---

## 3. A collector for each agent

### 3.1 What all four share

- **Per user, not per card.** Today hooks are per card: `Board.writeHooks` (`src/board.ts:4281-4334`) writes a settings file that reaches Claude Code only through `--settings` (`src/board.ts:4352`). A session the board did not start has no hook. The monitor's collectors go in each agent's per-user folder instead, as Entridir's does (02 §8).
- **Board cards are covered by the same install.** A card's session reads the same per-user folder, so `Board.writeHooks` and `CODEX_HOOKS` need no monitor entry. That hooks from the per-user folder and from `--settings` both fire is to be checked in phase 1 (section 13).
- **One command installs:** "Entomatical: Set Up 3D Monitor Collectors…".
  1. It lists the agents found, and for each the files it will change.
  2. It shows each change in a diff editor (`vscode.diff`) before anything is written.
  3. One confirmation. Then atomic writes (`writeFileAtomic`, `src/sessions.ts`).
  4. Never on activation, never silently.
- **One command removes:** it deletes exactly the entries whose URL or command points at the hub. No other entry is touched.
- **Three ways into the hub:**

| Way | How | Cost per event | Used when |
|---|---|---|---|
| **HTTP hook** | The agent itself POSTs the event to the hub. | No process. Hub side 0.13 ms (02 §6, measured). Agent side not measured. | The agent has an `http` hook type: Claude Code, Grok Build. |
| **Post command** | The hook command is `curl`, sending stdin to the hub. Its URL and token come from a file (`curl -K <file>`), so the token is never on a command line. | One small process. Not measured; target 25 ms or less. | The agent has command hooks only, `curl` exists, and the hub is reachable on loopback: Codex, Antigravity. |
| **Spool** | The hook command is a Node script that normalises the event and appends one line to a spool file. The hub reads and deletes the file. | 55 ms (02 §6, measured: almost all of it is starting Node). | The fallback: no `curl`, or Codex in WSL (the hub's loopback is out of reach), or the owner wants calls recorded with no window open (decision 3). |

- **The normaliser is one file**, `hook/monitor-normalise.js`: plain CommonJS with no dependency. The hub and the spool script both load it, so the privacy rule has one implementation.
- **An argument-name recorder** (a development command) fills the gaps 02 §9 lists. For one session it stores, per tool, the names and types of the top-level arguments and never a value. Grok Build's mapping (02 §12) is completed from it before its collector ships.

### 3.2 Claude Code

| | |
|---|---|
| **Signal** | Hooks of type `http`: SessionStart, SessionEnd, UserPromptSubmit, Stop, StopFailure, PreToolUse, PostToolUse, PostToolUseFailure (matcher `*`), PermissionRequest, PermissionDenied, Notification (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`), SubagentStart, SubagentStop. |
| **Install** | Hook entries merged into `settings.json` of every Claude account folder: the default folder and each folder `accountFolders()` returns (`src/sessions.ts:119`). Each entry: `{"type": "http", "url": "http://127.0.0.1:<port>/h/<ingest token>/claude", "timeout": 1}`. A plugin is the alternative (decision 2). |
| **Why every account folder** | A card runs with `CLAUDE_CONFIG_DIR` set to its account's folder (`src/board.ts:4296`, `:4357`), and each folder has its own settings (02 §3). A folder added later gets the collector from the "Add Account" flow (`entomatical.login`, `src/extension.ts:344`). |
| **Cost per tool call** | Two events (start, end): two loopback POSTs, no process. Hub side about 0.3 ms. |
| **How it stays low** | HTTP, never a command. The hub answers as soon as the body has arrived, before it parses. A 1 s timeout bounds the worst case. With no hub listening, Claude Code treats the refused connection as a non-blocking error (02 §3). |
| **Exact** | Call start, end and failure; the pairing id; `duration_ms` when present; the MCP server (`mcp_server.name`); the subagent on every call; subagent start and stop; session and turn start and end; waiting for a permission. |
| **Derived** | Files, folders and URLs, from tool arguments (02 §12); the end of a wait; a turn ended by a user interrupt; duration when `duration_ms` is absent. |
| **Missing** | What a shell command reads or writes; what an MCP tool touches on its side; which files a search matched; files named in a prompt; context the agent loads itself. |
| **When absent** | The agent still appears, from Claude Code's own session files (`liveSessions`, `src/sessions.ts:442`): busy, idle or waiting, marked derived. Its column is empty below the agent floor and carries the caption "no collector". Board cards also show tool names, from the events the board already records. |
| **Existing code it would change** | `Board.writeHooks` (`src/board.ts:4281`): **no change**. `hook/hook.js`: **no change**; the monitor does not read its events file, which holds full prompt and reply text (02 §7). New: `src/monitor-install.ts`; a call from the account flow in `src/extension.ts`. |
| **To check first** | That hooks from the account folder and from a card's `--settings` file both fire. That a refused connection shows nothing in the session and costs under 5 ms. That `disableAllHooks` is the only switch that silences it. |

### 3.3 Codex

| | |
|---|---|
| **Signal** | Command hooks: SessionStart, SessionEnd, UserPromptSubmit, Stop, Interrupt, PreToolUse, PostToolUse, PermissionRequest, SubagentStart, SubagentStop. |
| **Install** | Entries in the per-user `hooks.json` under the Codex home (`$CODEX_HOME`). With Codex in WSL, the WSL home (`toCodexPath`, `src/codex.ts:84`). |
| **Approval** | Codex runs a hook only after the user approved it, keyed to a hash of its definition (02 §4). The installer records that approval the way the board already does for its own hook: `approveCodex` (`src/codex.ts`, the `config/batchWrite` to `hooks.state`). Until then the collector's state is `awaiting-approval`, and the view says so. |
| **A stable command** | The command must not change between updates, or the approval is lost. So it names a file at a fixed per-user path, as `CODEX_HOOK` does (`src/codex.ts:341`), placed by `placeCodexHook` (`src/codex.ts:344`). |
| **Cost per tool call** | Two events. Post command: two short `curl` runs, target 25 ms each, not measured. Spool: two Node runs, 110 ms together (02 §6). |
| **How it stays low** | Asynchronous hooks, which Codex offers (02 §6), so the cost is off the agent's path. `curl` before Node. The spool only where nothing else works, and then the view marks the collector `slow`. |
| **Exact** | Call start and end with the pairing id; waiting for a permission; subagent start and stop; session and turn start and end; an interrupt. |
| **Derived** | Failure, from the exit code in the response; duration, from the two hook times; the MCP server, by splitting `mcp__<server>__<tool>`; files written, from the headers of an `apply_patch`. |
| **Missing** | Which subagent made a call (the view draws `by: "?"`); file reads and searches (Codex uses the shell); hosted tools such as web search; a failure event. |
| **When absent** | The agent appears from running Codex processes (`liveCodexSessions`, `src/codex.ts:916`), marked derived. A card the board started as a headless app-server run also shows calls, from the board's own stream (section 3.6). |
| **Existing code it would change** | `CODEX_HOOKS` (`src/codex.ts:338`): **no change** to the list. New beside it: `MONITOR_CODEX_HOOKS` (it adds PreToolUse) and the monitor's fixed path. `hookArgs` and `hookConfig` (`src/codex.ts:357-366`): no change. |
| **To check first** | That a per-user hook and a per-session `-c hooks.<Event>=…` hook both run. That an asynchronous hook exists for PreToolUse. What a `curl` run costs. Whether WSL can reach the hub (it cannot in WSL's default network mode; then the spool). |

### 3.4 Grok Build

| | |
|---|---|
| **Signal** | Hooks of type `http`: SessionStart, SessionEnd, UserPromptSubmit, Stop, StopFailure, StopCancelled, PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, Notification, SubagentStart, SubagentStop. |
| **Install** | One file of its own, `hooks/entomatical-monitor.json`, in each Grok home the board knows (a card's profile is its `GROK_HOME`, `src/acp.ts`). Nothing is merged, and removing it is deleting the file. |
| **Cost per tool call** | As Claude Code: two loopback POSTs, no process. |
| **How it stays low** | HTTP. A 1 s timeout in place of the 5 s default. |
| **Exact** | Call start, end and failure with the pairing id; subagent start and stop; session start and end; turn start and end, also failed and cancelled. |
| **Derived** | Duration, from the two `timestamp` values; the MCP server, by splitting `<server>__<tool>`; resources, from arguments whose names are not documented; waiting, from Notification, whose types are not documented. |
| **Missing** | MCP resources; how a subagent's calls are attributed. |
| **When absent** | Only sessions the board started appear, from ACP (section 3.6). Any other Grok session is invisible: no session list is documented. |
| **Existing code it would change** | The ACP handling (`src/board.ts:6093-6144`): **no change** for the collector. New: the Grok part of `src/monitor-install.ts`. |
| **To check first** | The argument names, with the recorder (section 3.1). That a hook in a project's `.claude/settings.json` does not report a Grok session twice (the hub drops the repeat, section 2.5). |

### 3.5 Antigravity

| | |
|---|---|
| **Signal** | Command hooks, the only type: SessionStart, PreInvocation, PostInvocation, PreToolUse, PostToolUse, Stop. |
| **Install** | Entries in the global `hooks.json` (02 §5). |
| **Cost per tool call** | Two events. Post command or spool, as Codex. No asynchronous hook is documented, so the cost is on the agent's path. |
| **How it stays low** | `curl` before Node; the hub answers at once. |
| **Exact** | Call start and end (`stepIdx`); failure (`error` on PostToolUse); session start. |
| **Derived** | Turns, from PreInvocation and PostInvocation; duration; the MCP call, from `call_mcp_tool{ServerName, ToolName}`; subagents, from `invoke_subagent`; waiting, from `ask_question` and `ask_permission`; resources, from the documented arguments (02 §12); the session end, from 30 minutes of silence (section 2.6). |
| **Missing** | A session end; which subagent made a call; MCP resources. |
| **When absent** | Only sessions the board started appear, from ACP. |
| **Existing code it would change** | The ACP handling: **no change**. New: the Antigravity part of `src/monitor-install.ts`. |
| **To check first** | The format of `hooks.json` and its exit codes; how an eager MCP tool is named inside a hook (02 §9). |

### 3.6 What the board already knows, with no collector

For a session the board started, the board holds a live stream that a hook cannot give. The hub takes it in directly, in the same process, and only for an agent whose collector is not installed (section 2.5).

| Source | Today | What the monitor would add |
|---|---|---|
| ACP, Grok Build and Antigravity cards (`src/board.ts:6093-6144`) | A `tool_call` becomes one PostToolUse line with the call's title (`:6106`). `tool_call_update`, `kind`, `locations` and `rawInput` are dropped. | A second listener on the same updates: `tool_call` gives `tool.start` with `class` from `kind`; `tool_call_update` gives `tool.end`; `locations[].path` gives `resource.touch`. `session/request_permission` gives an exact `wait.start`, and its answer an exact `wait.end`. |
| Codex app-server, headless cards (`src/board.ts:6286-6299`) | Only `item/completed` and `turn/completed` are read (`:6287`). | Also `item/started`. `commandExecution.durationMs` gives an exact duration, `mcpToolCall{server, tool}` an exact MCP server, `fileChange.changes[]` exact file writes. |
| The events file, every card (`hook/hook.js`) | PostToolUse lines with `tool_name` and `hash`. | Before a collector is installed: `tool.end` only, marked derived. The fields `prompt`, `last_assistant_message` and `desc` are never read (02 §13). |

- These are additions beside the existing lines. The board's own lines and status logic stay as they are.
- They are named here so the files are known: `src/board.ts` at the two places above. Nothing in this step changes them.

---

## 4. The hub

### 4.1 Where it runs

- **One hub per machine: the machine where the agents run.**
- **A worker thread** (`worker_threads`) inside the host of one VS Code window. No daemon and no new process.
- **Why a thread and not the host's own thread.** An HTTP hook makes the agent wait for the answer. The host's thread can freeze: `src/extension.ts:512-517` records freezes of 1 to 15 s. A worker has its own event loop, so the agent gets its answer at once whatever the host is doing.
- **Which window.** The first one that binds the port. The listening socket is the lock: the system frees it the moment that window dies, and nothing has to judge whether a lock file is stale.
- **The other windows** try the port again every 10 s. When the hub's window closes, one of them binds, loads the checkpoint and carries on with the same `epoch` and the next `seq`.
- **The hand-over leaves a hole** of up to 10 s. The new hub sends a `gap`, and the view marks calls that were open as "end not seen".
- **Only when the monitor is switched on:** the setting `entomatical.monitor3d.enabled`, which the set-up command turns on. Off: no thread, no port, no timer.

### 4.2 Transport

| Path | Transport | Notes |
|---|---|---|
| Collector to hub | HTTP POST, loopback | The URL is fixed in the hook configuration, so the port is chosen once, at set-up. |
| Hub to its own window | `MessagePort` | No socket. |
| Hub to other windows | `GET /v1/stream`: server-sent events over loopback | Plain HTTP from Node's own `http` module. No WebSocket library. |
| Window to hub | `POST /v1/action`, `POST /v1/hello` | An action for a target another window owns; a window telling the hub its folders. |
| Host to page | `postMessage` | Section 2.9. |

- **Files** are used for two things only: the checkpoint (the live picture, so a hand-over or a reload does not start empty) and the spool (section 3.1).
- **The hub's folder** is `~/.entomatical/monitor/`, with an environment override for tests, as the ledger has (`src/ledger.ts:22`).
- **`hub.json`** holds the port, the two tokens and the epoch. File mode 0600 on Linux; on Windows it inherits the profile's permissions.

### 4.3 Several VS Code windows

- Each window with the view open holds one stream connection. A window without the view holds none and does no work beyond the 10 s port try.
- **Every window draws the same picture:** one model in the hub, one snapshot format, the same slots.
- **Each window tells the hub** its id, the `ws` keys of its folders and its workspace address. In the hub's memory only.
- **An action goes to the window that owns its target.**
  1. Window A posts the action to the hub.
  2. The hub forwards it on window B's stream.
  3. Window B runs it and answers.
  4. Window A brings window B forward with `vscode.openFolder` (section 6.2).
- **A target no window owns** (a session in a bare terminal, in a folder open nowhere) gets the actions that need no owner, and "Open its folder in a new window".

### 4.4 Remote (WSL, SSH, containers)

- The extension has no `extensionKind`, so it runs where the workspace is: on the remote. The agents and their hook files are there too. So the hub is on the remote, and everything in sections 3 and 4 holds unchanged.
- The page always runs on the local machine. `postMessage` crosses for free (03, appendix B). No port is forwarded.
- **A local window and a remote window are two machines**, with two hubs. Each view shows the agents of its own machine. One view across machines is not in this plan.
- **Codex in WSL under a Windows window** (the mode `src/codex.ts` already supports): the hooks run in WSL and the hub in Windows, and WSL's default network mode cannot reach the Windows loopback. That collector uses the spool, at a path both sides can reach.

### 4.5 Security

**Whom it guards against:** other users of the machine, and web pages open in a browser. A process running as the owner can already read every transcript, so it is not treated as an attacker.

| Measure | Detail |
|---|---|
| **Loopback only** | The server binds `127.0.0.1` by number, never a name and never all interfaces. A test reads the bound address back. |
| **Two tokens** | An *ingest token* sits in the hook configurations and can only post events. A *control token* sits only in `hub.json`; it opens the stream and sends actions. A leaked hook file cannot read the feed or cause an action. Each is 32 random bytes. |
| **Tokens are never** | logged, sent to the page, written into a workspace, or put on a command line (`curl -K`). |
| **A wrong token** | gets a plain 404, the same as an unknown path. |
| **Browsers are refused** | Any request with an `Origin` or `Sec-Fetch-Site` header is refused. The `Host` header must be exactly `127.0.0.1:<port>`, which stops DNS rebinding. Ingest takes POST with `application/json` only. |
| **Events are untrusted** | Every field is checked against the contract, cut to its limit and stripped of control characters. The page writes text with `textContent` only. Added 28 November 2026: the working mock-up's 0.1.5 also shows the selected agent's thinking, which its window reads from the transcript and not from the hub; that text is written with `textContent` only too (05 section 8.6). |
| **Actions are resolved, not obeyed** | An "open" names a node id. The host turns it into a file only if the path stays inside a folder a window owns (no `..`, no link out of it). A URL opens only as `http` or `https`, and only after a modal confirmation that shows it. |
| **Limits** | Body size, events per second and connection count (section 2.8). A hub that is overrun drops and counts; it never stalls the agent. |
| **A taken port** | A window that cannot bind asks `/v1/hello` with the control token. No valid answer means another program holds the port; the view says so, and set-up offers to pick a new one and rewrite the collectors. |

### 4.6 Redaction: the privacy rule from 02

- 02 §13 is the rule: a fixed list of kept fields, and everything else dropped.
- **Where it runs.** With an HTTP hook or a post command, the agent sends the whole payload over loopback, tool input and tool result included. The normaliser is the first code to touch it, in the worker. With the spool, the normaliser runs in the hook script, before the line is written.
- **What is kept from a payload:** exactly the list in 02 §13. From tool input: only the path and URL fields that 02 §12 names.
- **Raw payloads are never** written, logged, kept after the function returns, or quoted in an error. An error record holds the event name, the agent, the size and the error's class.
- **A big payload** (a Write with a whole file, a result of megabytes): up to 256 KB is parsed in the worker. Above that, a small scanner reads only the top-level keys it needs and skips the large values without building them.
- **Absolute paths** stay in the hub's memory, to route and to locate. A stored or forwarded record carries `ws` and a relative path. A path outside the root is `{outside: true, name}`.
- **The checkpoint** holds the redacted model only: no absolute path, no `cwd`, no token.
- **A test proves it** (section 9.2): marker strings planted in every field that must be dropped may not appear in any output.
- **Added 28 November 2026.** The working mock-up's 0.1.5 makes one exception, on the host side: the window that was asked reads the selected agent's thinking from its transcript and shows it on its own page only (05 sections 4 and 8.6). The hub's rule here is unchanged. Its tests are in `ui-concepts/monitor-3d-live/test/`: `thinking.test.js`, `thinking-watch.test.js`, `thinking-page.test.js`, `thinking-privacy.test.js`.

---

## 5. Wiring the view

### 5.1 Replacing the simulator

The seam is one line of `ui-concepts/monitor-3d/app.js`:

```js
const source = feed;                       // anything with subscribe(onEvent) can stand here
```

- **A new `host-feed.js`** has the same `subscribe(onEvent)`. Behind it: `acquireVsCodeApi()`, the `ready` message, loading a `snapshot` into the model, and passing each event on in `seq` order.
- **`feed.js` (the simulator) does not ship.** It stays in `ui-concepts/` and makes the recorded files for the tests (section 9.1).
- **The view never shows invented data.** With nothing live it shows the empty state of section 7.4.

**What moves, and what changes on the way:**

| From `ui-concepts/monitor-3d/` | To `media/monitor3d/` | Change |
|---|---|---|
| `layout.js`, `model.js` | the same names | `serialize()` and `load()` added. Loaded by the hub (Node) and by the page. |
| `engine.js` | `engine-canvas.js` | Put behind one scene interface: `setModel`, `dataChanged`, `setSelected`, `setHighlight`, `pick`, `frameAll`, `dispose`. This is A2's fallback renderer. |
| (new) | `engine-three.js` | The same interface on three.js and WebGL2, with DOM labels (phase 3). |
| `look-nexus.js`, `look-glasshouse.js` | the same names | The look is chosen from VS Code's theme kind (`vscode.window.activeColorTheme.kind`); the owner can override it. |
| `nav.js` | the same name | The "In VS Code" labels become `act` messages. |
| `app.js`, `index.html`, `style.css` | `page.js`, `style.css`; the HTML is built by the host | The simulated-feed buttons go. The inspector goes: its facts move to the tree view (section 6). Colours come from VS Code's theme variables. |
| `feed.js`, `serve.js`, `check.js`, `shoot.js` | not shipped | `check.js` and `shoot.js` become tests under `test/`. |

- **What stays in the page:** the scene, the list twin for screen readers, the legend, and the view buttons (Frame all, Separate floors, Isolate, Tidy, the look). Those change how the scene is shown, never the information.
- **Which renderer.** The page tries WebGL2 at start. With none, or on `webglcontextlost`, it uses the Canvas renderer and tells the host. Selection and camera carry over.
- **Hidden and moved.** `retainContextWhenHidden` is left off (03, risk 2). A hidden tab has no page, and the host sends it nothing. On show, or after a move to a new window, the page reloads, sends `ready` and gets a snapshot. Camera and selection come back from `getState()`.

### 5.2 The extension side

| New file | What |
|---|---|
| `src/monitor-contract.ts` | Types and checks for records and messages. Plain Node. |
| `hook/monitor-normalise.js` | Payload to events; the kept-field list. Shared with the spool script. |
| `hook/monitor-spool.js` | The spool collector (section 3.1). |
| `src/monitor-hub-worker.ts` | The worker: listener, ingest, duplicates, `seq`, model, ring, stream, checkpoint, the 30 s timer. |
| `src/monitor-hub.ts` | Bind or connect, reconnect, hand-over; one `subscribe` for the rest of the host. |
| `src/monitor-install.ts` | Install, remove and report the collectors. Pure functions over given folders. |
| `src/monitor-view.ts` | The tab (`createWebviewPanel` and a serializer), the HTML and its policy, the tree view, the messages. |
| `src/monitor-actions.ts` | The action table of section 6 as code. |

- **Flat file names on purpose.** The package ships `out/*.js` only (`.vscodeignore`: `!out/*.js`). A file in `out/monitor/` would be missing from the VSIX and fail at run time.
- **One event at a time.** The board sends its whole state per change, at most once in 500 ms (`coalesce`, `src/extension.ts:518`). The monitor does not go through `coalesce` or `BoardView`.

**`package.json` gains:**
- Commands: "Entomatical: Open 3D Monitor", "Entomatical: Set Up 3D Monitor Collectors…", "Entomatical: Remove 3D Monitor Collectors", "Entomatical: 3D Monitor Cost". The critique wrote "Wyarden:"; the 47 existing commands say "Entomatical:", and this plan follows them.
- A tree view, `entomatical.monitor3d.list`, in the existing Entomatical container.
- `webview/context` and `view/item/context` menu entries (section 6).
- Settings `entomatical.monitor3d.enabled` and `entomatical.monitor3d.scope`. Both are read from user settings only (`inspect().globalValue`, as `src/extension.ts:191` does), so a file in a repository cannot switch the monitor on.
- The activation event `onWebviewPanel:entomatical.monitor3d`.

### 5.3 Packaging

| Item | What must happen |
|---|---|
| **`.vscodeignore` allow-list** | `media/**` and `hook/**` are already allowed, so the page and the two hook scripts ship with no new line. three.js needs two: `!node_modules/three/build/three.module.min.js` and `!node_modules/three/LICENSE`. |
| **`tools/vsix-check.js`** | `media` and `hook` are in `MIRRORED_DIRS`, so the new files are checked byte for byte with no change. Add `extension/out/monitor-hub-worker.js` to `REQUIRED`: the worker is loaded by path, so nothing else would notice it missing. Add a list for the two three.js files, as `TERMINAL_SHARED` does for xterm; anything else under `extension/node_modules/` stays forbidden. |
| **Content security policy** | `default-src 'none'; script-src ${cspSource} 'nonce-…'; style-src ${cspSource}; img-src ${cspSource} data:; connect-src 'none'; base-uri 'none'; form-action 'none'`. No `unsafe-inline`, no `unsafe-eval`, no `wasm-unsafe-eval`, no `worker-src`. The nonce pattern is the board's (`src/extension.ts:664-670`). |
| **Why `${cspSource}` for scripts** | three.js is an ES module, and its imports carry no nonce. |
| **Styles** | Label positions are set through script (`element.style.transform`), which the policy allows. No `style` attribute in markup, so `style-src-attr 'unsafe-inline'`, which the board's policy needs for its terminals (`BOARD_CSP`, `src/cardTerminal.ts`), is not needed here. |
| **`localResourceRoots`** | Exactly two: `media/monitor3d` and `node_modules/three/build`. |
| **`tools/parity.js`, `docs/parity/FEATURES.md`** | The page's visible text is registered as a new feature, `F126` (the highest today is F125), with `- windows: todo` and `- linux: todo` until each side has been used natively. `media/monitor3d/page.js` and `nav.js` join `OTHER_UI` in `tools/parity.js`, so their strings count as present. |
| **three.js (MIT)** | An exact-version dependency in `package.json`, locked in `package-lock.json`, as xterm is. Its `LICENSE` ships beside the file. `THIRD_PARTY_NOTICES.md` gains a paragraph, as for xterm. Nothing goes into `licenses/`: that folder holds licences of adapted code. |
| **Where this differs from 03** | 03 section 5 says "vendored under `media/`". A locked dependency gives the same single local file, plus an integrity hash and the pattern the repository already checks. If the owner prefers vendoring: the file goes to `media/monitor3d/vendor/`, its licence to `licenses/three-LICENSE.txt`, and `vsix-check.js` pins its SHA-256. |
| **Borrowed code** | The moved engine and looks started from Entridir's files (the mock-up README, "Borrowed code"). Both repositories are GPL v3. `THIRD_PARTY_NOTICES.md` gains that note when the files move to `media/`. |
| **Size** | three.js adds 420,122 bytes compressed (03, measured). |

---

## 6. The action table

**The rules:**
- **A click only selects.** It moves no focus and opens nothing.
- **A double-click does the one safe, obvious thing** for that class. It never starts, stops or changes anything.
- **The menu is VS Code's own context menu**, not one drawn by the page: `webview/context` entries, with the node's class and id set in `data-vscode-context`. The board already contributes to `webview/context`.
- **Every action is also in the tree view**, the keyboard and screen-reader route. Ctrl+Enter is the double-click action; the menu key opens the menu.
- **The 3D view gets no editing control:** no input, no form, no button that changes information. A test counts them (section 9.3).

### 6.1 From the view into VS Code

| Class of object | Click | Double-click | Menu |
|---|---|---|---|
| **Any node** | Select. The tree view shows it: `treeView.reveal(item, {select: true, focus: false})`. | see below | "Reveal in the list" |
| **Agent (a session)** | select | **Focus the session** (6.2). | "Focus the session" · "Show its calls" (Quick Pick) · "Open its folder in a new window" · "Copy session id" (`vscode.env.clipboard.writeText`) |
| **Subagent** | select | Focus its parent session. | "Show its calls" |
| **Tool** | select | **Show the calls:** a Quick Pick (`vscode.window.showQuickPick`) of that tool's last calls in that session: time, duration, result, resource. Choosing one selects its resource. | "Focus the session" |
| **A call (a line)** | select | Reveal the call under its session in the tree view. | "Focus the session" |
| **Resource: one file** | select | **Open the file:** `vscode.window.showTextDocument(uri, {preview: true})`. | "Open to the side" (`viewColumn: vscode.ViewColumn.Beside`) · **"Show changes"**: `git.openChange` with the file's address, the working copy against git, as Source Control shows it · "Reveal in Explorer" (`revealInExplorer`) · "Copy relative path" |
| **Resource: a folder group of files** | select | A Quick Pick of its files, then open as above. | The same, after the Quick Pick. |
| **Resource: a searched folder** | select | `revealInExplorer`. | "Find in folder": `workbench.action.findInFiles` with `{filesToInclude}`. No query is filled in, because none is kept. |
| **Resource: URLs on a host** | select | A Quick Pick of the addresses (scheme, host and path only), then a modal confirmation that shows the address, then `vscode.env.openExternal`. | "Copy address" |
| **Resource: context** (a web search, an MCP resource) | select | Show the calls. No target is kept, so there is nothing to open. | none |
| **MCP server** | select | **Open the MCP configuration:** the file that defines the server, with the cursor on its entry (`showTextDocument` with a `selection`). Which file depends on the agent and on `serverSource`. Where it cannot be found, the item is disabled and says why. | "Show its calls" · "Copy server name" |
| **MCP tool (a port)** | select | Show the calls of that tool on that server. | none |
| **"+N" stack** | select | A Quick Pick of the folded items. Choosing one selects it. | none |
| **Clash arc** (two agents wrote one file) | select | **Compare the two copies:** `vscode.commands.executeCommand("vscode.diff", left, right, title)`, where the two agents work in two worktrees. In one folder: `git.openChange`. | "Focus the first session" · "Focus the second session" |
| **A column's workspace label** | select | **Go to that workspace's window:** `vscode.commands.executeCommand("vscode.openFolder", uri, {forceNewWindow: true})`. | "Open its folder in a new window" |
| **Empty space** | clear the selection | Frame all. | "Frame all" · "Separate floors" · "Tidy" |

**Not in any menu at the start:** stop, resume, approve, send a message. Those change things, and the board's cards already carry them. If the owner wants one later, it is a menu entry that runs a board command. It never becomes a control in the scene.

### 6.2 "Focus the session" and "another window", exactly

The host tries these in order and stops at the first that fits:

1. **A board card owns the session:** the board's own "open", the one the card uses today.
2. **A terminal of this window runs it:** `terminal.show()`. The terminal is found by walking from the session's process up to a terminal's process, as `openFound` already does (`src/extension.ts`).
3. **A Claude Code panel of this window runs it:** `vscode.commands.executeCommand("claude-vscode.editor.open", sessionId)`. Only when the session's process is a child of this window's host; from any other window it would start a second copy (`src/extension.ts`, in `openFound`).
4. **Another window owns it:** the action goes through the hub to that window, which does step 2 or 3. Then this window calls `vscode.openFolder` for that window's workspace with `forceNewWindow: true`, which should bring the existing window forward and can never replace this one. To be checked natively on both systems (phase 4).
5. **No window owns it** (a bare terminal): a message says where it runs, and offers "Open its folder in a new window".

- **The session's process id** is derived, not reported: from Claude Code's session files (`src/sessions.ts:442`), from the Codex process list (`src/codex.ts:916`), and from the hook's parent process for a spool collector. For Grok Build and Antigravity outside the board there is none, and the fallback is step 5.
- **"Show changes" against the session's start** is a later refinement: `vscode.diff` between the file at the commit that was checked out when the session started (the built-in Git extension's `toGitUri`) and the file now. Version 1 uses `git.openChange` and says what it compares.

### 6.3 From VS Code back into the view

| VS Code event | What the view shows |
|---|---|
| `vscode.window.onDidChangeActiveTextEditor` | Every node that stands for that file gets the "in the editor" ring: each agent's own copy, and the folder group that holds it. |
| `vscode.window.onDidChangeActiveTerminal` | The session running in that terminal gets the ring. |
| The tree view's `onDidChangeSelection` | The node is selected in the scene. |
| `vscode.window.onDidChangeActiveColorTheme` | The look follows the theme kind. |

- **A highlight is not the selection.** It is a second, quieter mark, so the editor never steals what the owner selected.
- **One message and one frame**, sent only while the tab is visible, at most one per 100 ms.
- **Focus rule (03, risk 3).** A click keeps focus in the view. A double-click that opens an editor or shows a terminal moves focus there. The page sends keys nowhere. The native check: double-click a file, type at once; every key lands in the editor and none reaches a terminal.

---

## 7. Any workspace

### 7.1 What stops it today

- `repoRoot()` (`src/extension.ts:358-365`) calls `checkWorkspace` (`src/workspace.ts:23`). That demands a saved workspace file, a folder, and that folder the top of a git repository.
- Without all three there is no `Board` (`src/extension.ts:154-155`), and the board view shows only a set-up message (`:652`).
- That gate is right for the board: it creates worktrees inside the folder. The monitor creates nothing in a workspace, so it must not sit behind it.

### 7.2 What must change

| Where | Change |
|---|---|
| `src/extension.ts`, `activate` | Create the monitor (hub client, view, commands) **before** `repoRoot()` and without a `Board`. It stays after the old-data-folder check (`:105`), because it also writes under `~/.entomatical`. |
| `src/workspace.ts` | `checkWorkspace` is **not loosened**. Two pure functions are added beside it: `sessionRoot(cwd)` and `wsKey(root)` (section 2.3), plain Node, so the hub, the tests and `tools/` share one rule. |
| The monitor's commands and views | Registered in every window: no folder, a plain folder, a folder that is not git, several folders. Their `when` clauses do not mention the board. |
| Several folders | Every folder of the window is a root the window owns. The board uses only the first (`folders[0]`, `src/workspace.ts:26`). |
| `Board` | Unchanged. When there is a board it hands the hub its card list, so a column can carry its card's title. |

- **Scope of the view** (the setting `entomatical.monitor3d.scope`): this window's folders, or every workspace on the machine. Decision 5.

### 7.3 Untrusted workspaces

- **Today** `package.json` has `capabilities.untrustedWorkspaces.supported: false`: in a restricted window the whole extension is off.
- **Recommended for version 1: leave it** (decision 6). A restricted window has no monitor tab. Agents running in that folder still appear in every trusted window, because collectors are per user and the hub is per machine.
- **What "limited" support would take, if the owner wants the tab there too:**
  - `supported: "limited"` with a description;
  - a guard in `activate` so the board, ledger, speech and Codex set-up do not start while `vscode.workspace.isTrusted` is false;
  - `onDidGrantWorkspaceTrust` offers a reload;
  - the set-up command refuses to run from a restricted window.
- **Why the monitor itself is safe either way.** It runs nothing from a workspace, reads no workspace setting, and writes nothing into one.

### 7.4 Before any collector is installed

- **The tree view** shows VS Code's own welcome content (`viewsWelcome`): one sentence, and the button "Set up collectors…".
- **The scene is not empty.** It shows what is known with no install (sections 3.2 to 3.6):
  - Claude Code and Codex sessions, from their own session lists: an agent with busy, idle or waiting, marked derived;
  - sessions the board started: also their tool names, and for ACP and app-server cards calls with start and end.
- **Each such column carries the caption "no collector":** tools, files and MCP calls are not seen.
- **One line under the scene** says how many agents have a collector. It is text, not a control: set-up starts from the tree view or the command palette.
- **After set-up**, a new session is covered from its first event. A session that was already running may need a restart before it reports: whether each agent reads its hooks again while it runs is not verified (section 13). Until it reports, its column keeps the caption "no collector".

---

## 8. The resource budget, and how to measure it

Every figure is a ceiling to test against. "Known" is what has been measured so far, and where.

| What | Budget | Known |
|---|---|---|
| **Agent: added time per event, HTTP hook** | 5 ms at the 90th percentile | Hub side 0.13 ms median (02 §6). Agent side not measured. |
| **Agent: added time per event, post command** | 25 ms median; 0 on the agent's path where the hook is asynchronous | Not measured. |
| **Agent: added time per event, spool** | 55 ms, accepted as a fallback only, and shown as `slow` | 55.1 ms median (02 §6). |
| **Agent: with no hub listening** | 5 ms, and nothing shown in the session | Not measured. |
| **Hub: memory** | +20 MB private in the host that runs it | Not measured. |
| **Hub: CPU per event** | 0.3 ms: receive, normalise, model, send | Receive 0.13 ms (02 §6); model 0.003 ms (step 4). |
| **Hub: CPU at rest** | No session live: 0 wake-ups. Sessions live but silent: one timer tick per 30 s. | By design. |
| **A window without the view** | One port try per 10 s; under 0.01 s of CPU per 10 s | Not measured. |
| **View: memory** | +1 process; +40 MB private at 200 nodes; GPU process +30 MB | +28.4 MB private, panel drawn once (03, measured). |
| **View: frames drawn at rest** | **0** in 10 s, and 0 animation frames asked for | 0 in 3 s (step 4, headless). |
| **View: page main thread at rest** | 2 ms per 10 s | 1.6 ms (03, headless). |
| **VS Code tree: CPU at rest, tab open** | No more than 0.05 s per 10 s above the same window with the tab closed | 0.188 s against 0.094 s, one sample each (03). |
| **View: one event** | At most 2 frames, plus the 600 ms trace of an ended call | 2 (step 4). |
| **View: one frame** | 8 ms at 200 nodes, 16 ms at 500 | three.js 2.1 ms at 200, 8.95 ms at 1,000 (03, VS Code webview). The step 4 Canvas engine: 1.3 ms median, 5.5 ms worst at 190 nodes (headless). |
| **View: twelve busy agents** | 10 frames a second at most; 30 ms of script a second | 7.2 frames a second, 14 ms (step 4, headless). |
| **Delay from event to pixel** | Median 50 ms, 95th percentile 150 ms, in the hub's window; +10 ms in another window | Not measured: no live feed exists yet. |
| **Package** | +450 KB compressed | three.js 420,122 bytes (03). |
| **Disk** | 512 KB checkpoint; spool files under 1 MB each | By design. |

### How to measure

**Before** (the first work of phase 1, on `main`, Windows and Linux):
- VS Code's process tree with the board open and no monitor: process count, private memory, CPU seconds per 10 s. Five samples each, with the method of [bench/README.md](bench/README.md) (`vscode-probe`). 03 took one sample.
- What a tool call costs today with the board's own hook: 55 ms per event (02 §6); run again on the Linux machine.
- Saved as `docs/monitor-3d/bench/baseline-<date>.json`.

**After** (at the end of each phase, same machines, same script):
- **The same process-tree figures** with the tab open at rest, with the tab hidden, and with the monitor off.
- **Frames at rest:** over CDP, count frames, `requestAnimationFrame` calls and draw calls for 10 s with no input and no event. Must be 0. This is `shoot.js`'s method, made a test.
- **Event to pixel:** the hub stamps `t` when the POST arrives. After the frame that shows the event, the page reads one pixel (so the GPU's work is counted) and reports the time. Hub and page are on one machine in the local case, so the two clocks agree. Under Remote they do not, so there the host times a round trip instead: it sends a marked event and waits for the page's answer.
- **Agent side:** a stand-in client posts recorded payloads the way the agent would (HTTP, `curl`, Node), 200 times each. Whether the agent's own debug output gives its hook time is not known (section 13). If it does, that figure is used.
- **Hub:** `performance.eventLoopUtilization()` and `process.memoryUsage()` inside the worker.
- **Soak:** eight hours of a recorded busy stream. Memory at the end within 5% of memory after the first hour.

**For the owner, at any time:** the command "Entomatical: 3D Monitor Cost" prints the live figures to an Output channel: events per second, dropped and rejected counts, the hub's memory and loop use, frames drawn, the last frame's milliseconds, nodes, labels, event to pixel. This is the critique's improvement 10.

---

## 9. Tests

All are plain `node --test` files under `test/`, run through `test/run.js` as the rest are. No new test framework and no network.

### 9.1 Recorded event files, replayed

- **`test/fixtures/monitor3d/*.events.jsonl`:** contract events. They are made by the step 4 simulator (`feed.js`, seeded, so they can be made again) and by hand for the edge cases: an end before its start, a duplicate, a gap, a thirteenth session, 500 files.
- **`test/fixtures/monitor3d/raw/<agent>/*.json`:** hook payloads as each agent sends them, written from the documentation with invented values. No payload from a real session goes into this public repository.
- **Normaliser:** each raw payload gives exactly the expected events.
- **Model:** each recorded file is replayed, and its final slot list and counts are compared with a stored expectation.
- **Two renderers:** the same file is replayed into the Canvas renderer and the three.js renderer. Both must give the same slot list, and a pick at each node's projected centre must return that node in both. This is 03 section 6's test.
- **Snapshot:** cut a file at any point, take a snapshot, load it into a new model and replay the rest. The result equals the uncut replay.

### 9.2 The privacy test

- Every raw payload carries a marker string in each field 02 §13 says is never kept: a command line, file content, a tool result, a prompt, a reply, a URL's query, an absolute path, a home folder, a user name.
- After the payloads pass through the hub, **no marker may appear** in any event, snapshot, checkpoint, spool file, log line, error or message to the page.
- A second assertion: no stored record holds an absolute path of either system's form.
- **Added 28 November 2026.** In the working mock-up's 0.1.5 the page also gets the selected agent's thinking, which can repeat a prompt or a file. It does not pass through the hub, so the assertions above still hold for everything that does; its own tests are `test/thinking.test.js`, `test/thinking-watch.test.js`, `test/thinking-page.test.js` and `test/thinking-privacy.test.js`, under `ui-concepts/monitor-3d-live/` (05 section 8.6).

### 9.3 Hub and installer, without VS Code

- **Hub:** started on a free port in a temporary folder. Tested: `seq` order; duplicates; snapshot, then changes; resuming after a `seq`; an oversized body; a wrong token; a request with an `Origin` header; a wrong `Host`; the bound address is 127.0.0.1; and a hand-over (stop the first hub; the second binds, loads the checkpoint, sends a `gap` and carries the `seq` on).
- **Spool:** eight writers appending 1,000 lines each to one file give 8,000 whole lines. 03 lists this as not tried.
- **Installer**, against temporary folders: other hooks in a settings file are kept; a second install changes nothing; remove takes out exactly its own entries; a settings file that does not parse is refused, never rewritten.

### 9.4 Webview tests over CDP

- They use the helpers that exist: `test/compile-webview-cdp.js` (`edgePath`, `freePort`, `waitFor`) and a harness page like `test/compile-webview-harness.html`, which loads the real `media/monitor3d/` files with a stand-in for `acquireVsCodeApi`.
- **Draw on change:** 0 frames in 3 s at rest; at most 2 for one event; frames stop within 1 s of the last event.
- **Selection and actions:** a real click at a node's centre posts one `select` and nothing else; a double-click posts the right `act`; the list twin has one row per node.
- **No editing controls:** no `input`, `select`, `textarea` or `contenteditable` in the page.
- **Captions:** 0 overlapping pairs at 40, 80 and 200 nodes.
- **Policy:** 0 `securitypolicyviolation` events and 0 console errors.
- **Renderers:** the same tests with the GPU, with `--disable-gpu` (software WebGL, which 03 measured), and with WebGL off, where the Canvas renderer must take over. A lost context (`WEBGL_lose_context`) falls back and keeps the selection.
- **Budget:** a frame over 8 ms at 200 nodes fails.

### 9.5 In a real VS Code

- `node test/compile-webview-cdp.js --edh` already drives an isolated Extension Development Host. The monitor adds:
  - open the tab, post a recorded file to the real hub, double-click a file node, and see the editor open on that file;
  - move the tab to a new window: one reload, selection kept (03, risk 2);
  - double-click, then type at once: the keys land in the editor (03, risk 3).
- These need a desktop and cannot run in a headless check. Each phase's acceptance lists them as a native check, with the system they were run on.

### 9.6 Windows and Linux together

- **One test set.** Every test is Node plus a headless browser, which the helper picks per system (Edge on Windows, Chrome or Chromium on Linux).
- **Paths.** The raw payloads include both Windows and POSIX forms, and both sets run on both systems. The normaliser tells the form from the payload, not from the host: a Windows hub receives WSL paths through the spool.
- **`ws` keys:** the same folder gives the same key however its case is written on Windows; case counts on Linux.
- **`npm run parity`** on both sides, with F126 at `todo` until a native run on that side.
- **A phase is accepted** only when its checks pass on both machines and its native checks have been done on both. A package inspection alone proves nothing about running (`docs/parity/README.md`).
- **Not covered by this plan:** macOS. The repository has two sides, `windows` and `linux`.

---

## 10. Phases

- Each phase ends with something that can ship. The setting `entomatical.monitor3d.enabled` stays off by default until phase 7, so a release in between changes nothing for anyone who has not switched it on.
- Sizes are in sessions. They are judgement, not measurement.
- Every phase must also keep the existing checks green: `build`, `test`, `parity`, `package`, `package-linux`.

| # | Phase | Sessions |
|---|---|---|
| 1 | Thin slice: Claude Code to the view to an editor | 4 |
| 2 | Everything Claude Code reports, and the VS Code side | 3 |
| 3 | The three.js renderer | 3 |
| 4 | Several windows, hand-over and Remote | 3 |
| 5 | The Codex collector | 3 |
| 6 | The Grok Build and Antigravity collectors | 2 |
| 7 | Hardening, and on by default | 2 |
| | **Total** | **20** |

**Before phase 1** (half a session, ships nothing):
- Run `bench/vscode-probe/` on the Linux machine and in VSCodium (03, risk 1: about two minutes each).
- Take the "before" measurements of section 8.
- Confirm the three "to check first" points of section 3.2 with one real Claude Code session.

### Phase 1. Thin slice: Claude Code to the view to an editor (4 sessions)

**What it is:** one agent, one window, the fallback renderer, one action. It proves every joint of section 1 once.

- **Built:**
  - the contract, with `serialize` and `load`;
  - the normaliser for Claude Code's SessionStart, SessionEnd, PreToolUse, PostToolUse and PostToolUseFailure, with resources and MCP;
  - the hub in a worker, with ingest and the stream to its own window;
  - set-up and removal for Claude Code;
  - the monitor tab with the Canvas renderer and the host feed;
  - click selects; double-click on a file opens it;
  - the monitor running without a board.
- **Not yet:** three.js, the tree view, other windows, other agents, turns and waits.

**Acceptance:**
1. With the collector installed, a Claude Code session started in a plain terminal, in a folder the board has never seen, appears as a column within 1 s of its first tool call.
2. A `Read` shows a tool node and a file node; an MCP call lights a port on its server; a failed call shows the failed mark.
3. A double-click on the file node opens that file in an editor. Typing at once goes into that editor.
4. A board card's calls arrive too, with `Board.writeHooks` unchanged.
5. At rest for 10 s: 0 frames. Event to pixel, median, under 50 ms.
6. The privacy test passes. `hub.json` and the checkpoint hold no absolute path.
7. With every VS Code window closed, a Claude Code session shows no error and loses no more than 5 ms per event.
8. "Remove collectors" leaves each settings file as it was before set-up, key for key.
9. All of the above on Windows and on Linux.

**Files:**
- New: `src/monitor-contract.ts`, `src/monitor-hub.ts`, `src/monitor-hub-worker.ts`, `src/monitor-install.ts`, `src/monitor-view.ts`, `src/monitor-actions.ts`, `hook/monitor-normalise.js`, `media/monitor3d/` (`layout.js`, `model.js`, `engine-canvas.js`, the two looks, `nav.js`, `page.js`, `host-feed.js`, `style.css`), `test/monitor-*.test.js`, `test/fixtures/monitor3d/`, `test/monitor3d-webview-harness.html`.
- Changed: `src/extension.ts` (`activate`), `src/workspace.ts` (two functions added), `package.json` (commands, settings, activation event), `tools/vsix-check.js` (`REQUIRED`), `tools/parity.js` (`OTHER_UI`), `docs/parity/FEATURES.md` (F126), `THIRD_PARTY_NOTICES.md` (the Entridir note), `CHANGELOG.md`, `workflows/checks.json`.

**Checks to add to `workflows/checks.json`:**

| Name | `run` | `what` | Minutes |
|---|---|---|---|
| `monitor-contract` | `node test/run.js --test-reporter=tap test/monitor-contract.test.js test/monitor-normalise.test.js test/monitor-privacy.test.js test/monitor-model.test.js` | After build: the contract, each agent's payloads to events, the privacy markers, and recorded files replayed into the model. | 1 |
| `monitor-hub` | `node test/run.js --test-reporter=tap test/monitor-hub.test.js test/monitor-install.test.js` | After build: the hub on a free loopback port in a temporary folder (order, duplicates, snapshot, tokens, refused origins) and the collector installer against temporary settings folders. | 2 |
| `monitor-webview` | `node test/run.js --test-reporter=tap test/monitor-webview.test.js` | After build: the real page in headless Edge or Chrome. No frames at rest, a click selects, a double-click asks for the action, no editing control, no policy violation, the frame budget. | 3 |

### Phase 2. Everything Claude Code reports, and the VS Code side (3 sessions)

- **Built:**
  - the remaining Claude Code events: turns, waits, permissions, notifications, subagents;
  - the hub's timer (`call.stale`, closing calls after a gap);
  - the tree view, with agents that wait for the owner first;
  - selection both ways;
  - highlighting the active editor and terminal;
  - the full action table for Claude Code;
  - the native context menu;
  - the cost command.

**Acceptance:**
1. A session that waits for a permission shows the "needs you" mark within 1 s and is first in the tree view.
2. A subagent's calls come from the subagent's node.
3. Every row of section 6.1 that applies to Claude Code works. Each double-click leaves focus where section 6.3 says.
4. Making a file the active editor rings its node within 150 ms and does not change the selection.
5. A call open for 120 s shows "unclear" with no other event, and the view draws exactly one frame for it.
6. The cost command prints every figure of section 8.
7. The page still has no editing control.

**Files:**
- Changed: `src/monitor-view.ts`, `src/monitor-actions.ts`, `src/monitor-hub-worker.ts`, `hook/monitor-normalise.js`, `media/monitor3d/page.js` and `nav.js`, `package.json` (the view, menus, commands), `docs/parity/FEATURES.md`, `docs/user-guide.md`.
- New: `test/monitor-actions.test.js`, `test/monitor-tree.test.js`.

**Check to add:** `monitor-actions`: `node test/run.js --test-reporter=tap test/monitor-actions.test.js test/monitor-tree.test.js`. "After build: each class's click, double-click and menu choice resolves to the expected VS Code command against a stand-in for `vscode`; a target outside a known folder is refused." 1 minute.

### Phase 3. The three.js renderer (3 sessions)

- **Built:** `engine-three.js` behind the scene interface, DOM labels, the choice of renderer at start, the fall back on a lost context, the look from the theme kind, and three.js packaged with its licence.

**Acceptance:**
1. One recorded file gives the same slot list and the same picks in both renderers.
2. One frame: 8 ms at 200 nodes and 16 ms at 500 in a real VS Code webview. Under 40 ms at 1,000 on software WebGL.
3. With WebGL off the Canvas renderer runs, and the cost command says so.
4. Losing the context falls back within one frame and keeps selection and camera.
5. 0 overlapping labels at 40, 80 and 200 nodes. Labels use the theme's font and colours.
6. 0 frames at rest in both renderers.
7. `npm run package` and `npm run package:linux` pass, with exactly two files from `node_modules/three`.
8. WebGL2 confirmed on the Linux machine and in VSCodium, or its absence recorded together with the fallback's figures.

**Files:**
- New: `media/monitor3d/engine-three.js`, `test/monitor-webgl-webview.test.js`.
- Changed: `media/monitor3d/page.js`, `src/monitor-view.ts` (policy, `localResourceRoots`), `package.json`, `package-lock.json`, `.vscodeignore`, `tools/vsix-check.js`, `THIRD_PARTY_NOTICES.md`.

**Check to add:** `monitor-webgl`: `node test/run.js --test-reporter=tap test/monitor-webgl-webview.test.js`. "After build: both renderers on one recorded file, with the GPU, with software WebGL and with WebGL off; the same slots and picks, the frame budget, the fall back on a lost context." 4 minutes.

### Phase 4. Several windows, hand-over and Remote (3 sessions)

- **Built:**
  - the stream to other windows;
  - the port retry and the take-over;
  - the checkpoint and `gap`;
  - the window register;
  - actions routed between windows;
  - the scope setting;
  - the checks under WSL and SSH.

**Acceptance:**
1. Two windows show the same slot list for the same sessions.
2. Closing the hub's window: the other takes over within 10 s, shows a gap and loses no node.
3. A double-click in window A on a file of window B's workspace opens it in window B and brings B forward, on Windows and on Linux.
4. In a WSL or SSH window the view shows that machine's agents, with no forwarded port.
5. A window without the view costs under 0.01 s of CPU per 10 s.
6. The spool's eight-writer test passes on both systems.

**Files:**
- Changed: `src/monitor-hub.ts`, `src/monitor-hub-worker.ts`, `src/monitor-actions.ts`, `src/monitor-view.ts`, `package.json` (the setting).
- New: `test/monitor-handover.test.js`, `hook/monitor-spool.js`, `test/monitor-spool.test.js`.

**Check to add:** `monitor-handover`: `node test/run.js --test-reporter=tap test/monitor-handover.test.js test/monitor-spool.test.js`. "After build: two hubs in one temporary folder. The second takes the port when the first stops, loads the checkpoint and carries the sequence on; a consumer resumes with no repeat and one gap. Eight spool writers give whole lines." 2 minutes.

### Phase 5. The Codex collector (3 sessions)

- **Built:**
  - Codex set-up: `hooks.json`, the fixed command path, the approval record;
  - the post command, with the spool as fallback;
  - the Codex normaliser: `apply_patch` headers, the MCP name split, failure from the exit code;
  - Codex in WSL;
  - the app-server signals for cards when no collector is installed (section 3.6).

**Acceptance:**
1. A Codex session started in a plain terminal appears with its calls, MCP calls and written files.
2. What Codex cannot report is drawn as such: `by: "?"` during a subagent, no file reads, the "derived" grade where section 3.3 says so.
3. Until the hook is approved the view says "awaiting approval". After approval nothing more is needed.
4. An update of the extension does not ask for approval again.
5. Measured and written into this folder: what a Codex event costs with `curl` and with the spool.
6. A Codex card's existing behaviour is unchanged: `test/` passes, and `CODEX_HOOKS` is untouched.

**Files:**
- Changed: `src/codex.ts` (`MONITOR_CODEX_HOOKS` and the fixed path added; `CODEX_HOOKS` not changed), `src/monitor-install.ts`, `hook/monitor-normalise.js`, `src/board.ts` (a second listener at `:6286`, adding only), `src/extension.ts` (placing the monitor's hook file beside `placeCodexHook`, `:168`).
- New: `test/monitor-codex.test.js`, more raw fixtures.

**Check to add:** `monitor-codex`: `node test/run.js --test-reporter=tap test/monitor-codex.test.js`. "After build: Codex payloads to events, the patch headers, the install into a temporary Codex home and its approval record, and the app-server items as events. No Codex is run." 1 minute.

### Phase 6. The Grok Build and Antigravity collectors (2 sessions)

- **Built:**
  - the argument-name recorder, and Grok Build's mapping completed from it;
  - both set-ups and both normalisers;
  - the ACP signals for cards when no collector is installed;
  - the derived session end for Antigravity.

**Acceptance:**
1. A session of each agent started in a plain terminal appears with its calls and resources.
2. Each derived item carries the "derived" grade in the tree view.
3. An Antigravity session that goes silent ends after 30 minutes with the reason "silent".
4. A project with a Claude Code hook in `.claude/settings.json` does not make a Grok session appear twice.
5. An ACP card with no collector shows its calls with start, end and files.
6. `docs/monitor-3d/02-live-signals.md` section 9 is updated with what the recorder found.

**Files:**
- Changed: `src/monitor-install.ts`, `hook/monitor-normalise.js`, `src/board.ts` (a second listener at `:6093`, adding only), `docs/monitor-3d/02-live-signals.md`.
- New: `test/monitor-acp.test.js`, more raw fixtures.

**Check to add:** `monitor-acp`: `node test/run.js --test-reporter=tap test/monitor-acp.test.js`. "After build: Grok Build and Antigravity payloads and ACP updates to events, the two installs into temporary homes, and the duplicate from a shared settings file dropped. No agent is run." 1 minute.

### Phase 7. Hardening, and on by default (2 sessions)

- **Built:**
  - the decision on untrusted workspaces, carried out;
  - a pass with a real screen reader on the list twin and the tree view;
  - the eight-hour soak;
  - the user guide;
  - F126 accepted on each side with its evidence;
  - the setting on by default. Set-up stays a deliberate command.

**Acceptance:**
1. Every budget of section 8 is measured on both machines, and the results are saved in this folder.
2. After eight hours of a busy recorded stream, memory is within 5% of its value after the first hour.
3. A screen-reader user can find the agent that waits, reach its file and open it without the scene.
4. With the monitor on and the tab closed, the VS Code tree's CPU is within the noise of the "before" figures.
5. F126 is `done` on both sides in `docs/parity/FEATURES.md`.

**Files:** `package.json` (the default; `capabilities` if decision 6 says so), `docs/user-guide.md`, `docs/parity/FEATURES.md`, `CHANGELOG.md`, `README.md`, `test/monitor-soak.js`.

**Check to add:** `monitor-budget`: `node test/run.js --test-reporter=tap test/monitor-budget.test.js`. "After build: a ten-minute recorded busy stream through the hub and the page in a headless browser. Fails on any frame at rest, a frame over budget, growing memory, or event to pixel over the ceiling." 12 minutes.

---

## 11. Open decisions for the owner

| # | Decision | Recommended | Why |
|---|---|---|---|
| 1 | **Where the hub runs:** a worker thread in one VS Code window, files only (03's wording), or a separate background program? | **The worker thread.** | An HTTP hook is the cheapest signal and needs a listener. A thread adds no process and cannot be stalled by a busy host. Files alone cost 55 ms per event. A background program is a second thing to install and stop. |
| 2 | **How Claude Code's collector is installed:** entries in each account folder's `settings.json`, or a Claude Code plugin? | **`settings.json`,** shown as a diff first, with one confirmation. | The hook's address holds this machine's port and token, so it must be written here either way. A plugin adds the plugin tooling, and each account folder must still enable it. |
| 3 | **Record calls while no VS Code window is open?** | **No.** The view says "not recorded" for that time. | It would need the spool for every agent, at 55 ms per event all the time, or a background program. Sessions still appear when a window opens; only their earlier calls are missing. |
| 4 | **three.js now or on evidence?** Phase 3 as planned, or only if the Canvas renderer misses its budget in a real webview? And: a locked dependency, or a vendored file? | **Measure at the end of phase 1; build phase 3 if Canvas is over 8 ms at 200 nodes or 16 ms at 500. A locked dependency.** | See the Dissent. The phase is planned in full either way. |
| 5 | **Which sessions the view shows at first:** this window's folders, or every workspace on the machine? | **This window's folders,** with "All workspaces" one click away and remembered. | Twelve columns fill fast, and the owner asked about this workspace when he opened this window. |
| 6 | **Untrusted workspaces:** leave the extension off there, or support the monitor in restricted windows? | **Leave it off** for version 1. | Their agents still show in every trusted window. Limited support touches the start-up of the whole extension. |
| 7 | **Should the board later take its tool lines from the hub** and drop its own PostToolUse hook, which costs each card 55 ms per call? | **Not in this plan.** Decide after phase 5, with the measured figures. | It would make every card faster, but it puts the board's status logic on a new source. That deserves its own plan. |

---

## 12. Dissent

Two points. The plan above follows 03 on both where it must.

**1. three.js may not be needed yet.**
- 03 chose three.js because the old Canvas renderer (`scene.js`) took 18.45 ms at 200 nodes.
- Step 4 then wrote a new Canvas engine that draws only on change and has no glow. It measured 1.3 ms median and 5.5 ms worst at 190 nodes with twelve busy agents (`ui-concepts/monitor-3d/measured.json`, headless Edge).
- That is under the 8 ms budget without WebGL, without 420 KB and without a licence entry.
- The two figures are not comparable as they stand: different machines' browsers, headless against a real webview, and 03's figure counts GPU work with a pixel read. So this is a reason to measure, not a finding.
- **What I would do:** ship phase 1 on the Canvas engine (the plan does), measure it in the real webview at 200 and 500 nodes, and build phase 3 only if it misses. Decision 4.
- **What three.js still gives if built:** room past 500 nodes, sharp DOM labels at any zoom, and real depth.

**2. "The hub is files" does not hold up.**
- 03 section 5 says "No daemon: the hub is files."
- 02 measured a file-writing hook at 55 ms per event and a loopback POST at 0.13 ms, and says to use HTTP hooks wherever an agent offers them.
- A click that must act in another window also needs a path faster than a polled file, and `fs.watch` has already failed on the Linux machine (`src/board.ts:806`).
- So this plan keeps "no daemon" and drops "files": one listener in a worker thread, with files only for the checkpoint and the fallback spool. Decision 1.

---

## 13. Not verified

Each of these is a first job of the phase named.

| Phase | Not verified |
|---|---|
| Before 1 | **WebGL2 in a webview on Linux and in VSCodium** (03 section 8). |
| 1 | **That `worker_threads` runs in the extension host**, locally and under Remote. It is ordinary Node, but was not tried. |
| 1 | **That Claude Code fires hooks from the account folder and from `--settings` together**, and that an HTTP hook's `timeout` is in seconds. |
| 1 | **What a refused connection costs the agent, and whether the session shows it.** 02 says "non-blocking error"; the time and the visible effect were not measured. |
| 1 | **Whether a running session picks up a hook added to its settings**, or only a new session does (section 7.4). |
| 1 | **The agent's own time for an HTTP hook** (02 §6). |
| 1 | **Whether an agent's debug output reports its hook time**, for the measurements of section 8. |
| 1 | **The snapshot's size and the parse time of a large payload** in the worker. |
| 2 | **That `webview/context` works on a canvas** with `data-vscode-context` set just before the menu opens. |
| 2 | **The `git.openChange` command and the Git extension's `toGitUri`:** both exist, but neither is used in this repository today. |
| 2 | **Where each agent keeps an MCP server's definition**, for "Open the MCP configuration". 02 gives only the server's name and source. |
| 4 | **That `vscode.openFolder` with `forceNewWindow: true` brings forward a window that already has the folder open**, on Windows and Linux. If it opens a second window instead, the fallback is a message naming the window. |
| 5 | **Codex:** that a per-user hook runs beside a per-session one; asynchronous PreToolUse; what `curl` costs; that the approval record survives an update. |
| 6 | **Grok Build and Antigravity:** everything 02 §9 lists for them. |
| 7 | **A real screen reader.** Nobody has listened to the list twin. |

**Also not checked:** the session sizes (judgement), and every budget of section 8 marked "not measured".
