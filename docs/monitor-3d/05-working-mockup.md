# 05. The working mock-up

**What this is:** the first wired slice of [04-wiring-plan.md](04-wiring-plan.md): real Claude Code sessions, drawn live in a VS Code tab, with a choice of workspace.
**Where it lives:** [ui-concepts/monitor-3d-live/](../../ui-concepts/monitor-3d-live/), as a small extension of its own.
**Why its own extension:** it installs beside the Entomatical build that is already running, in VS Code and in VSCodium, with no change to that build. Folding it into the main extension later is a move of files (04, section 5.2).

This document is the contract the parts were built against. Sections 1 to 8 say what each part does and how the parts talk. Section 9 says what was verified and what was not.

## 1. What the owner asked for, and the rule each request became

| Asked for | Rule |
|---|---|
| "Select the workspace." | The view has one chip for each open editor window, named as the window is titled, and one for "All open". A chip is a filter on what is shown; it edits nothing. |
| "Anything that is currently open in VS Code." | A workspace is what one editor window has open: its folder, or all the folders of its workspace file. Each window tells the hub its name and folders and keeps one connection open. A window with no folder has no workspace and no chip. |
| "Only the windows of VS Code that are open." (27 November, after the first look) | Version 0.1.0 listed each folder: eight chips for six windows, because two windows held two folders each. Since 0.1.1 the list is the windows. |
| "No dead workspaces." | A workspace is listed only while a window holds its connection. When the window closes, the connection drops and the workspace leaves the list at once. |
| "Only what is alive." | A session is drawn only when its folder is inside an open workspace. An ended session leaves the scene 20 seconds after its end. A session whose process is gone is ended. |
| "VS Code and the open-source builds, Windows and Linux." | Plain JavaScript, no package, no native code, no build step. Only stable `vscode` API. One VSIX for every system and editor. Paths are handled by their own form (Windows or POSIX), so both forms are tested on both systems. |

## 2. The parts

```
 Claude Code sessions (any folder)             editor windows (VS Code, VSCodium, Code - OSS)
   |  http hook: one POST per event              |  each window: POST /v1/attach, kept open
   |  (only after "Set Up Collectors")           |  body: its folders and the scope it shows
   v                                             v
 +----------------------------------------------------------------------------------------+
 | HUB: one per machine, a worker thread in whichever window bound the port first.         |
 |   lib/hub-server.js   the listener, the timers, the worker entry                        |
 |   lib/hub-core.js     sessions, windows, one model for each scope, duplicates, seq      |
 |   lib/normalise.js    a hook payload -> contract events; the privacy rule               |
 |   lib/discover.js     live Claude Code sessions, from the CLI's own session files       |
 |   lib/transcript.js   tool calls of a session with no collector, from its transcript    |
 +----------------------------------------------------------------------------------------+
   |  one line of JSON per message, on each window's open connection
   v
 extension host of a window          lib/hub-client.js   bind or connect, reconnect, take over
   extension.js, lib/view.js         the tab, its HTML and policy, the messages
   lib/actions.js                    a double-click becomes a VS Code command
   lib/procs.js                      a process and its ancestors: where a session runs
   lib/install.js                    collectors: plan, show, write, remove
   |  postMessage
   v
 the page (a webview tab)            media/page.js, host-feed.js, model.js, layout.js,
                                     engine.js, look-*.js, nav.js, style.css, page.html
```

- **Three sources, in order of trust.** A hook (`exact`, src `hook:<Event>`). The transcript (`derived`, src `transcript:<Event>`): only for a session no hook has reported for. The CLI's session file (`derived`, src `sessions-file`): that a session is alive, and busy, idle or waiting.
- **So the view works before any set-up.** Opening the tab shows every live Claude Code session in an open workspace, with its tool calls read from the transcript. "Set Up Collectors" makes the calls exact and adds what a transcript cannot give.
- **This slice is Claude Code only.** Codex, Grok Build and Antigravity are phases 5 and 6 of 04.

## 3. Shared rules: `lib/contract.js`

Written. Every part loads it. Read the file; the main exports:

| Export | What |
|---|---|
| `monitorHome(env)`, `ensureHubFile(home)`, `readHubFile(home)` | The hub's folder (`~/.wyarden-monitor`, or `WYARDEN_MONITOR_HOME` for tests) and its one file `hub.json`: `{v, port, ingest, control, created}`. Made once, never replaced. |
| `hookUrl(hub, agent)`, `hookPath`, `isHookUrl(value)`, `MARK` | A collector's address: `http://127.0.0.1:<port>/wyarden-monitor/h/<ingest token>/<agent>`. `isHookUrl` is how set-up and removal know their own entries. |
| `rootInfo(cwd)` | `{root, real, ws, name}` for a session's folder: the nearest folder at or above `cwd` with a `.git` entry, else `cwd`. Cached. |
| `keptPath(info, cwd, file)` | A path as it may be kept: relative to the root with `/`, or `{outside: true, name}`. |
| `wsKey(folder)`, `normPath`, `relativeIn`, `isInside` | The key of a folder (12 hex of SHA-256 of its real path, case-folded where case is ignored), and containment. |
| `windowKey(folderPaths)`, `windowKeyOf(folderKeys)`, `windowName(name)` | The key of a workspace: everything one window has open. One folder keeps that folder's key; several folders give one key of their own, whatever their order or spelling. And the window's name as its title shows it (an editor adds " (Workspace)" for a workspace file; the title does not). |
| `cleanText`, `cleanName`, `cleanUrl`, `inputHash` | The only ways text from a payload may be kept. |
| `LIMITS`, `ALL`, `AGENTS`, `VERSION` | Limits and constants. |

## 4. Events and records

The vocabulary is [02-live-signals.md](02-live-signals.md) section 11, and `media/model.js` checks every event (`validate`). Additions in this slice:

- **`session.start` carries `root: {name}`**: the base name of the session root. It is in the inspector as "Folder"; the scene no longer shows it, because for a card's worktree it is a code and not a word.
- **Since 0.1.1 a session also has two short texts**, each at most 120 characters, on its `session.start` when known then, and in the event **`session.info`** when either changes:
  - `title`: the title of the session's tab, from the CLI's session file (`name`, unless it is the CLI's placeholder). The scene shows it under the agent only while the pointer is on the agent; the inspector and the list always have it.
  - `space`: the name of the workspace the session works in, which is its window's title. The tile the agent stands on is labelled with it.
- **The title is an addition to what may be kept** (02 section 13 lists no session title). The owner asked for it on 27 November. It is the text the editor already shows on the tab; it is cleaned and cut like every other text, held in memory, sent only to the windows of this machine's editors, and written nowhere.
- **`src` values:** `hook:<Event>`, `args:<tool>` (a file or address read from a hook's tool arguments), `transcript:<Event>`, `sessions-file`, `hub:known` (a session the hub already knew, shown because its workspace opened), `hub:gone` (its process ended), `hub:silent` (no end signal and no event for 30 minutes).
- **Ids and names are kept only when they look like ids and names** (`contract.safeId`, `safeName`): a call, turn or subagent id made of id characters; a tool, server, model or agent-type name made of name characters and at most four words. Any other value becomes a stand-in made from its hash (`id-…`, `unnamed-…`), so a path or a command line cannot ride in a name field. A session id that is not letters, digits, `-` and `_` is not a session, and its payload is refused.
- **The hub adds `seq`** to every event: a whole number rising by one. Order is `seq`.
- **Two control records** (they have `ctl`, not `ev`):
  - `{ctl: "snapshot", epoch, seq, scope, state}`: `state` is `model.serialize()` text. Always the first record a page gets, and the first after a change of scope.
  - `{ctl: "drop", key, why}`: the session `key` (`<agent>:<session>`) leaves now; apply `model.drop(key)`. `why` is `ended` or `workspace-closed`.
- **`media/model.js`** (written) adds `serialize()`, `load(text)`, `drop(key)`, the agent's `root`, `card`, `collector`, `title` and `space` fields, and a subagent's `kind` (its provider). The hub and the page load this same file. A page of 0.1.0 does not know `session.info`: it refuses the event and counts it, and nothing else happens.

## 5. `lib/normalise.js`

```js
const { createNormaliser } = require('./normalise.js');
const n = createNormaliser({ rootInfo });          // default: contract.rootInfo
const out = n.feed(payload, { t, hint });           // t: arrival, ms. hint: the agent named in the address, or undefined
n.forget(key);                                      // drop what is remembered for one session
n.size();                                           // sessions remembered (at most 200; the least recent goes first)
```

- **`out` is `null`** when the payload is not an object, names no session, or is not a shape this slice knows. The caller counts it as rejected.
- **Else** `{agent, session, key, cwd, root, source, events}`:
  - `agent`: read from the payload's shape, never trusted from `hint`. This slice returns only `claude`.
  - `key`: `<agent>:<session>`. `cwd`: the absolute folder, for the hub's memory only. `root`: `rootInfo(cwd)`.
  - `source`: `hook` or `transcript`.
  - `events`: zero or more events of section 4, complete but for `seq`. An event never holds `cwd`, an absolute path, or any text section 13 of 02 forbids.
- **A transcript payload** is hook-shaped and carries `_wy: {src: "transcript", at}`. Every event from it has `grade: "derived"`, `src: "transcript:<Event>"` and `at`.
- **State it may keep**, bounded, per session: the arrival time of each open call (to derive `ms` when `duration_ms` is absent), the open Agent call (for `parentCall`), and whether a wait is open (to derive `wait.end`).
- **What each Claude Code hook gives** is 04 section 3.2 and 02 sections 10 to 13. In short:

| Hook | Events |
|---|---|
| SessionStart | `session.start` with `source`, `model`, `root` |
| SessionEnd | `session.end` with `reason` |
| UserPromptSubmit | `turn.start` with `turn`, `chars` |
| Stop, StopFailure | `turn.end` with `outcome` (`done`, `failed`) and `asks` |
| PreToolUse | `tool.start` or `mcp.start`; then one `resource.touch` for each path or URL that 02 section 12 names; `wait.start` (`question`) for AskUserQuestion |
| PostToolUse | `tool.end` or `mcp.end` with `ok: true`, `ms`, `msGrade`; `wait.end` when a wait was open |
| PostToolUseFailure | the same with `ok: false`, `error` (`tool_error` or `interrupted`), `interrupted` |
| PermissionRequest | `wait.start` (`permission`) with `tool`, `hash` |
| PermissionDenied | `tool.end` or `mcp.end` with `ok: false`, `error: "denied"` |
| Notification | `wait.start`: `permission_prompt` is `permission`, `idle_prompt` is `idle`, `elicitation_dialog` and `agent_needs_input` are `question`; any other type gives nothing |
| SubagentStart, SubagentStop | `subagent.start` (with `parentCall` when an Agent call is open), `subagent.stop` |
| any other event | no events (`events: []`), the session is still named |

- **SessionStart and SessionEnd are understood but not expected.** Measured (section 9): Claude Code skips an `http` hook for SessionStart, and set-up does not register SessionEnd. The hub makes a session from its first event, and learns its end from the session file.
- **A start and its end are paired by `tool_use_id` only.** Parallel calls arrive interleaved.
- **The same payload twice gives the same events twice**, so the hub can drop the repeat: a second hook for one event (in a project's settings) fires in the same millisecond.

## 6. `lib/discover.js` and `lib/transcript.js`

```js
const { claudeConfigDirs, liveClaudeSessions, pidAlive } = require('./discover.js');
claudeConfigDirs({ home, env })          // existing folders: ~/.claude, each folder in ~/.claude-accounts (not *.lock), $CLAUDE_CONFIG_DIR; no folder twice
liveClaudeSessions(dirs, { alive })       // [{agent: 'claude', session, key, cwd, pid, status, waitingFor, updatedAt, statusUpdatedAt, procStart, entry, title, configDir, transcript}]
```

- `entry` (since 0.1.3) is the file's `entrypoint` when it is one this slice knows: `claude-vscode` (a session in Claude Code's chat panel), `cli` (one started in a terminal) or `sdk-cli` (one that runs with no terminal). Any other value is not given.
- `procStart` is a string of digits. On Windows it is the process's creation time as a FILETIME (measured, 9.7): that is what tells the session's own process from another program that was later given its process id.
- `title` is the session's `name` in that file, at most 80 characters: what its tab is titled. It is absent while the CLI has only its placeholder name (`nameSource: "derived"`).
- A session is listed when `<dir>/sessions/<file>.json` parses, has a `pid` that is a positive whole number, a `sessionId` of letters, digits, `-` and `_` (at most 128), and a string `cwd`, and the process is alive. `status` is `busy`, `idle`, `waiting` or undefined, as the file gives it. A session listed in two folders is given once, the more recently written.
- `transcript` is `<dir>/projects/<cwd with every character outside [a-zA-Z0-9] replaced by "-">/<sessionId>.jsonl`, whether or not it exists yet.
- The session files and the transcript are the CLI's own and undocumented. Every read tolerates a missing folder, a half-written file and an unknown shape, and gives nothing rather than throwing.

```js
const { createTail } = require('./transcript.js');
const tail = createTail(file, { session, cwd, lookback, replay });   // lookback: bytes read on the first poll, default 256 KB (the hub asks for 2 MB); replay: calls, default 150
tail.poll();        // -> hook-shaped payloads, oldest first; [] when nothing new
tail.close();       // also: tail.skipped, tail.jumps, tail.left, tail.open
```

- **First poll: a replay.** It reads the last `lookback` bytes and gives the calls it finds there, oldest first, starts and ends, at most the last `replay` of them, each payload marked `_wy.replay: true`. A call still open at the end of the file is always given. So a session shows at once what it has lately been doing. The hub does this before it makes the first snapshot, so the replay is inside the snapshot and does not draw as motion.
- **Later polls:** for each complete new line: an assistant `tool_use` block gives a `PreToolUse` payload; a user `tool_result` block gives `PostToolUse`, or `PostToolUseFailure` when `is_error` is true, with the tool's name and input remembered from its `tool_use`. The result's content is dropped here.
- **Records of a subagent** (`isSidechain: true`) are skipped in this slice. A subagent's own records are in a file of their own, which is not read.
- A payload: `{hook_event_name, session_id, cwd, tool_name, tool_input, tool_use_id, _wy: {src: "transcript", at}}`. `at` is the record's own time in ms when it has one.
- A file that shrank, or grew by more than 4 MB at once, is read again from its end, as a first poll. A line that does not parse is skipped and counted (`tail.skipped`).

## 7. The hub

### 7.1 `lib/hub-core.js`: no I/O, no timers of its own

```js
const core = createHubCore({ normaliser, Model, now, schedule, log });
// Model: require('../media/model.js'). now(): ms. schedule(fn, ms) -> cancel(): default setTimeout, unref'd.
core.ingest(payload, { hint, t });                    // a hook payload, or a transcript payload
core.setLiveSessions(list, t);                        // the whole current answer of discover.liveClaudeSessions
core.attach({ id, app, name, pid, folders: [{ path, name }], scope }) // -> the window's id
core.update(id, { folders, scope });                  // either may be absent
core.detach(id);
core.onSend = (windowId, message) => {};              // every message for a window's connection
core.resolve({ id, member });                         // section 7.4
core.status();                                        // counters, section 7.4
core.tailTargets();                                   // sessions that need a transcript tail now: [{key, session, cwd, transcript}]
core.needsDiscovery();                                // true while at least one window shows a scope
```

- **Sessions.** One record per session key: agent, session, cwd, root, pid, status, the best source seen (`hook` over `transcript` over `sessions-file`), the time of its last event, and its owner.
- **Workspaces.** One for each attached window that has a folder: everything that window has open. Its key is `contract.windowKeyOf` of its folders' keys (one folder keeps that folder's `wsKey`). Its name is the window's (`contract.windowName`), else its first folder's. Two windows with the same folders, in two editors say, are one workspace.
- **A session's owners.** The folder that holds the session is the longest folder, over all windows, that contains its `cwd`. Every workspace that has that folder owns the session: mostly one, two when the same folder is open in two windows of different make-up. A deeper folder in another window takes the session from an outer one. No owner: the session is kept in the hub's memory, drawn nowhere, and counted as hidden.
- **Scopes and models.** One model for `all` and one for each workspace key. An event of an owned session is given a `seq` and applied to `all` and to each owner's model. It is sent to each window whose scope is one of those.
- **A scope given as a folder's key** (what a 0.1.0 window and a choice saved by it send) is taken as the window that holds that folder.
- **When the workspaces change** (attach, update, detach):
  - a workspace that is new gets a model; each known live session it now owns is put into it, and into `all` if it was not there, with a `session.start` of `grade: "derived"`, `src: "hub:known"` and its `root`;
  - a session is dropped (`{ctl: "drop", why: "workspace-closed"}`) from each workspace that no longer owns it, and from `all` when none owns it; a workspace that is gone loses its model;
  - a session that stays in a model while its owners, or a workspace's name, change gets one `session.info` with its new `space`;
  - a window whose folders changed follows its own workspace to the new key; any other window whose scope is gone is moved to `all`;
  - every window gets a new `workspaces` message.
- **Duplicates** are dropped by the keys of 04 section 2.5, remembered per session (the last 500).
- **Unknown session.** The first event of a session the hub has not seen makes the session; if that event is not a `session.start`, the hub first makes one itself (`derived`, `src: "hub:known"`, with `root`).
- **One source per session.** Once a hook payload has arrived for a session, transcript payloads for it are ignored and it leaves `tailTargets()`.
- **`setLiveSessions(list)`**, for sessions the list names:
  - not known: the session is made (`session.start`, `derived`, `src: "sessions-file"`); `busy` also gives `turn.start`, `waiting` gives `wait.start` (`permission` when `waitingFor` mentions a permission, else `question`);
  - known, no hook seen, status changed: `busy` gives `turn.start`; `idle` gives `turn.end` (`outcome: "done"`); `waiting` gives `wait.start`; leaving `waiting` gives `wait.end`;
  - known with a `pid`, and missing from two lists in a row (a session file can be missed for one pass while the CLI rewrites it): `session.end`, `derived`, `src: "hub:gone"`, `reason: "gone"`. This holds for every session, also one a hook reports for: the collector registers no SessionEnd.
  - known, and named by the list: it takes its `pid` and status from the list, also when a hook saw it first.
- **After a `session.end`** the hub schedules `{ctl: "drop", why: "ended"}` for 20 seconds later (`LIMITS.lingerMs`) and forgets the session. An event for it before then cancels the drop.
- **A model refuses an event** (it throws): the event is counted as rejected. It goes only to a scope whose model took it.
- **Snapshots.** A window that attaches with a scope, or changes scope, gets `{type: "records", scope, records: [snapshot]}` first, and events after it. A window with `scope: null` gets no records.

### 7.2 `lib/hub-server.js`: the listener and the timers

```js
const hub = await startHub({ home, hub: hubFileContents, log, deps });   // rejects with error.code 'EADDRINUSE' when the port is taken
hub.port; hub.core; await hub.close();
```

- **Also the worker entry.** When loaded in a worker thread with `workerData.wyardenHub`, it starts with `workerData` and posts `{type: "listening", port}` or `{type: "error", code, message}` to its parent.
- **`deps`** (for tests): `{createNormaliser, claudeConfigDirs, liveClaudeSessions, createTail}`. By default the real modules are loaded; one that is missing or throws at load switches that source off, and `status()` says so.
- **Binds `127.0.0.1` by number**, on the port of `hub.json`.
- **Every request:** a request with an `Origin` or `Sec-Fetch-Site` header gets 404. A `Host` header other than `127.0.0.1:<port>` gets 404. An unknown path or a wrong token gets a plain 404, the same for both.

| Request | Token | Does |
|---|---|---|
| `POST /wyarden-monitor/h/<ingest>/<agent>` | ingest, in the path | Reads the body (at most `LIMITS.body`), answers `200 {}` as soon as the body has arrived, then `core.ingest`. A body that is too large or not JSON is counted and still answered 200. |
| `POST /v1/attach` | control, signed (below) | Body `{v: 1, window: {id, app, name, pid, folders: [{path, name}]}, scope}`. Answers `200`, `Content-Type: application/x-ndjson`, and keeps the response open: one JSON message per line. `core.attach`; when the connection closes, `core.detach`. |
| `POST /v1/update` | control | Body `{window: id, folders?, scope?, snapshot?}`. `core.update`. `snapshot: true` sends that window a fresh snapshot of its scope even when nothing changed: a page that was reloaded asks this way. Answers `{}`. |
| `POST /v1/resolve` | control | Body `{window: id, target: {id, member?}}`. Answers `core.resolve`. |
| `GET /v1/status` | control | Answers `core.status()`. |

- **The control token is never sent.** The port is fixed, so while no hub runs any program on the machine can listen on it; a window must not hand the token to whatever answers. Each control request carries `Authorization: Wyarden <nonce>.<keyed hash of the method, the path and the nonce>` (`contract.signRequest`, `checkRequest`). The hub proves itself the same way: `hello.proof`, and the header `X-Wyarden-Proof` on every other control answer, is a keyed hash of that request's nonce (`contract.hubProof`). A window that does not get a good proof treats the port as held by another program (`blocked`) and delivers nothing from it; an answer to `resolve` without one is thrown away, so a stranger on the port cannot name a file for the editor to open.
- **A sender that stalls** is dropped: 5 seconds for the headers, 10 for the request. At most 256 connections.
- **Messages on a window's connection:**
  - `{type: "hello", v: 1, epoch, pid, proof}`: first. `epoch` is 8 random hex characters made when the hub starts.
  - `{type: "workspaces", list: [{key, name, apps: [..], windows, sessions, needs, folders: [..]}], hidden, scope, total, totalNeeds, watching, own}`: after attach, and when the list, a count or this window's scope changes. At most four a second. `sessions` is the live sessions that workspace owns; `needs` how many of them wait for the owner; `folders` the names of its folders; `hidden` the live sessions no workspace owns; `scope` what this window is shown; `total` and `totalNeeds` the same counts over every window, each session once; `own` this window's own workspace; `watching` whether the hub is looking for sessions at all (false while no window shows a scope: then the counts are not counts). The last five fields are new in 0.1.1, and a window of either version works with a hub of the other.
  - `{type: "records", scope, records: [...]}`: section 7.1. Events are batched: one message per turn of the event loop, never one per event.
- **Timers**, only while `core.needsDiscovery()`: discovery every 3 s (`liveClaudeSessions` into `core.setLiveSessions`), and once at the moment the first window asks for a scope, before its snapshot is made; each transcript tail of `core.tailTargets()` polled every 700 ms. With no window showing a scope, no timer runs.
- **The 30-minute silence rule** (`session.end`, `src: "hub:silent"`) runs from the discovery timer, for sessions with no `pid`.

### 7.3 `lib/hub-client.js`: one per extension host

```js
const client = createHubClient({ home, window: { id, app, name, pid, folders }, log });
client.onState = state => {};      // 'connecting', 'up', 'blocked', 'stopped'. 'blocked': another program holds the port
client.onMessage = message => {};  // hello, workspaces, records
client.start(); client.stop();
client.update({ folders, scope });         // remembered, and sent again after a reconnect
await client.resolve(target); await client.status();
client.role;                               // 'hub' while this host runs the worker, else 'client'
```

- **Start:** `ensureHubFile`, then attach. A refused connection: start the hub in a worker thread (`new Worker(hub-server.js, {workerData})`), and attach when it listens. `EADDRINUSE` from the worker: another window won; attach. If a worker cannot be made, the hub runs in the host's own thread.
- **The connection ends** (the hub's window closed): try again after a random 50 to 400 ms, the same way. Whichever window binds first is the new hub. It starts empty and fills from discovery, the transcripts and the next hooks; open calls from before are lost.
- **An attach answered with anything but 200** from a port that accepts connections: `blocked`. Try again every 10 s.
- **`stop()`** closes the connection, and the worker when this host runs it.

### 7.4 `resolve` and `status`

- `resolve({id})` for a resource node `r:<key>:file:<group>`: `{kind: "file", root, folder, members: [{name, path}]}` with absolute paths made from the session's root, the group and each member the hub's model holds (the `all` model, else the owner's); a `member` in the request narrows it to that one. A dir group (no member): `{kind: "dir", path}`. A group outside the root: `{kind: "outside"}`.
- For `r:<key>:url:<host>`: `{kind: "url", urls: [...]}`, each `https://<host><member>`.
- For an agent `a:<key>`: `{kind: "session", agent, session, cwd, root, pid}`.
- Anything else, or an id the hub does not hold: `{kind: "none"}`.
- `resolve` answers are the only place an absolute path leaves the hub, and only to a holder of the control token.
- `status()`: `{epoch, upMs, role, windows, workspaces, sessions: {known, shown, hidden}, events: {received, applied, duplicates, rejected, tooLarge, ignored, replayed}, sources: {hook, transcript, sessionsFile}, tails, lastHookAt, off: [...], seq}`. `role` is `worker` or `thread`; `ignored` counts transcript payloads dropped because a hook already reports for that session.

## 8. The extension host and the page

### 8.1 Host to page, page to host

Every message has `v: 1` and a `type`.

| Direction | Message | Purpose |
|---|---|---|
| page to host | `{type: "ready"}` | The page has loaded and wants the feed. |
| host to page | `{type: "records", scope, records: [...]}` | Passed through from the hub. |
| host to page | `{type: "workspaces", list, hidden, scope, here: [keys], total?, totalNeeds?, watching?, own?}` | The chips. `own` is this window's workspace; `here` is the same and its folders' keys, for a hub of 0.1.0. The last four are passed on only when the hub sent them. |
| host to page | `{type: "hub", state, role, collectors: {claude: {state, folders, installed}}}` | The status line. `state`: `connecting`, `up`, `blocked`, `stopped`. Collector `state`: `installed`, `partly`, `missing`. |
| host to page | `{type: "look", look}` | `nexus` for a dark theme, `glasshouse` for a light one. |
| page to host | `{type: "scope", scope}` | A chip was chosen: `all` or a workspace key. |
| page to host | `{type: "select", target: {class, id}}` | A click. Nothing else happens. |
| page to host | `{type: "act", action, target: {class, id}, member}` | A double-click, or Ctrl+Enter on the selection. `action`: `open` for a file group or a URL group; `focus` for a session (since 0.1.3), with the session's agent node as the target, also when a subagent was double-clicked. |

- **The page never names a path, a command, a process or a window.** The host asks the hub to resolve the node.
- **The host checks** every message's shape, and refuses an id that does not resolve.

### 8.2 The page

| File | What |
|---|---|
| `media/page.html` | The page's markup, with three placeholders the host fills: `{{csp}}`, `{{nonce}}`, `{{base}}`. No inline script or style; every script and the stylesheet carry the nonce. |
| `media/host-feed.js` | The seam of 04 section 5.1: `create(api)` (the page hands it what `acquireVsCodeApi()` returned), then `subscribe(onEvent)` with `(event, scope)`, and the handlers `onSnapshot(state, scope, record)`, `onDrop(key, why, scope)`, `onWorkspaces(message)`, `onHub(message)`, `onLook(look)`; `post(message)`; `start()`. |
| `media/page.js` | Joins the feed, the model and the view. Replaces the mock-up's `app.js`: the simulated-feed buttons are gone, the workspace chips are new. |
| `media/nav.js`, `style.css`, `engine.js`, `look-*.js`, `layout.js`, `model.js` | From the mock-up. `nav.js` describes an agent with its folder and its source. |

- **Chips:** "All open", then one for each open editor window, this window's first. Each shows the window's name and its live sessions, and marks one that waits for the owner; its hover text names its folders and the editors that have it open. They are buttons in a toolbar; the chosen one has `aria-pressed="true"`.
- **The scene, as the owner asked for it on 27 November:**
  - an agent is an icosahedron and a subagent a dodecahedron, in both looks;
  - an agent and its subagents have their provider's colour, as the owner named them: Claude orange, Codex blue, Antigravity purple, Grok green (since 0.1.2; in each look a shade of that hue). A tool, a resource and an MCP server keep their class's colour, and three of those share a hue with a provider (mint, violet, amber), so each provider's shade is set well away from it. The agent's caption names the provider in words, and the legend lists the four with their colours;
  - a caption has no plate behind it, so it hides nothing; a thin outline in the background's colour, round the letters only, keeps it readable where a line runs through it;
  - an agent's caption is what it is ("CLAUDE") and its state. The title of its tab shows under its name only while the pointer is on it;
  - the tile an agent stands on is labelled with the name of its workspace (the window's title), cut to fit the tile.
- **Nothing live:** the scene shows one sentence that says so, and names the workspace.
- **The status line** under the scene says: hub state; how many sessions are shown and how many are hidden because their folder is open in no window; and whether Claude Code's collector is installed, with the name of the command that installs it.
- **No editing control:** no `input`, `select`, `textarea` or `contenteditable`.
- **Kept from the mock-up:** draw only on change, 0 frames at rest, the list twin, the legend, Frame all, Separate floors, Isolate, Tidy, the two looks, the keys.

### 8.3 The host

| File | What |
|---|---|
| `extension.js` | `activate`: the hub client for this window, the commands, the tab and its serializer, folder changes. |
| `lib/view.js` | The tab: `createWebviewPanel`, the HTML from `page.html`, the messages of 8.1, and the policy: `default-src 'none'`, scripts and the stylesheet by this page's nonce only, `img-src data:`, `connect-src 'none'`. No host is named, not even the editor's own. |
| `lib/actions.js` | `open`: resolve, then `showTextDocument` beside the monitor (a covered tab has no page); a Quick Pick first when the group holds more than one file; for a searched folder `revealInExplorer` when it is in this window, else `revealFileInOS`; for a URL a modal confirmation that shows it, then `openExternal`. `focus`: section 8.5. |
| `lib/procs.js` | `ancestors(pid)`: the process and its ancestors, nearest first. Section 8.5. |
| `lib/install.js` | Section 8.4. |
| `package.json` | Commands: "Wyarden 3D Monitor: Open", "…: Choose Workspace", "…: Set Up Collectors…", "…: Remove Collectors", "…: Status". |

### 8.4 `lib/install.js`: Claude Code's collector

```js
const install = require('./install.js');
install.plan(dirs, hub)        // -> [{dir, file, exists, before, after, changed, state, error, reformatted, added, replaced, collapsed, removed}]   nothing is written
install.planRemoval(dirs, hub) // the same shape; `after` has no entry of ours. `hub` is optional: with it, `state` tells a current entry from a stale one
install.apply(changes)         // writes each `after` where changed and no error; atomic (temporary file, then rename); refuses a file that changed since the plan
install.status(dirs, hub)      // -> {state: 'installed' | 'partly' | 'missing', folders: n, installed: n, stale: n, unreadable: n}
install.EVENTS                 // the hook events registered: [{name, matcher}]
```

- **`dirs`** is `discover.claudeConfigDirs()`: every Claude account folder. The file is `<dir>/settings.json`.
- **An entry of ours** is a hook object `{type: "http", url, timeout: 1}` whose `url` passes `contract.isHookUrl`. Set-up adds one for each event of `EVENTS`, with matcher `*` where the event takes a matcher. Removal deletes exactly those, and any group, event list or `hooks` object it thereby empties.
- **`EVENTS`, eleven:** UserPromptSubmit, Stop, StopFailure, PreToolUse (`*`), PostToolUse (`*`), PostToolUseFailure (`*`), PermissionRequest (`*`), PermissionDenied, Notification, SubagentStart, SubagentStop.
- **Not SessionStart:** Claude Code silently skips an `http` hook for it. **Not SessionEnd:** with no hub listening, a refused SessionEnd hook is the only one that prints a line on the session's stderr, and that line shows the collector's address with its token. Every other event fails silently, in 8 to 28 ms.
- **`timeout: 1` is one second**, measured. A hub that answers late would hold each tool call for that second, which is why the hub answers before it parses and runs in its own thread.
- **An entry of ours under any other event** (a hand edit, an older set-up) is found too: set-up and removal look at every event in the file.
- **Kept:** every other key and hook, their order, the file's indentation and its final newline.
- **A second set-up changes nothing.** An entry of ours with another port or token (`stale`) is replaced, not added to.
- **A file that does not parse** is never rewritten: `error` says so and `changed` is false. A missing file is created with our entries alone.
- **No backup copy is made:** a settings file can hold secrets.
- **The command** shows the first change in a diff editor and asks, naming every file. "Show every change" opens the others and asks again. Only then does it write. Nothing is installed on activation.
- **One case does not come back exactly:** a `hooks` object, or a registered event's list, that was already empty before set-up is gone after removal, because nothing tells it from one that set-up made.

### 8.5 A double-click on a session (since 0.1.3)

The owner's card of 27 November: the inspector said "Nothing is wired for a session yet", and he asked for it to be wired. This is steps 2 and 3 of 04 section 6.2, for the window the monitor is in.

- **The rule:** it shows something that already runs. It never starts, stops, resumes or changes a session.
- **The page** posts `act` with `action: "focus"` and the session's agent node. A subagent sends its session's agent.
- **The host** (`actions.focus`) asks three things, in this order:
  1. **The hub:** which session is this node? (`resolve`, 7.4.)
  2. **Claude Code's own session file:** its process id, how it was started (`entry`, section 6) and when its process started.
  3. **The system's process list:** that process and its ancestors (`procs.ancestors`).

```js
const { ancestors, walk, MAX_DEPTH } = require('./procs.js');
await ancestors(pid)     // -> { chain: [pid, parent, grandparent, ...], known, start }      never throws
```

- `chain` is at most 16 long. `known` is false when the list could not be read; then nothing is shown. `start` is the process's own start time, on Windows only.
- **Windows:** one run of Windows PowerShell by its full path in the system folder (`Get-CimInstance Win32_Process`), with a constant command: nothing from a session, a page or a file goes into it. **Linux:** `/proc/<pid>/stat`, step by step. Any other system: not known.
- **A parent is taken only when it did not start after its child.** A process id is used again after its process ends; the start time tells a real parent from a stranger that was given the number.

**What happens, the first that fits:**

| The session | A double-click |
|---|---|
| The hub does not answer | A warning. |
| It is no longer live, or no running process is known for it, or the process list could not be read | A message that says which. |
| Its file names a start time that is not its process's (Windows; 1 ms or more apart) | "This session has ended. Another program now runs under its process id." |
| A terminal of this window is among its ancestors | That terminal is shown (`terminal.show()`), and the focus goes to it. |
| Its file says chat panel (`claude-vscode`), and this window's extension host is among its ancestors | Claude Code's own command shows its tab: `claude-vscode.editor.open` with the session id. When that command is not in this window, a message says so. |
| Its file says chat panel, in another window | "This session's chat panel is in another window." |
| Its file says it runs with no terminal (`sdk-cli`) | "It has no terminal or chat panel to show." |
| It runs under this window, in neither (a board card's own terminal, for one) | A message that says so. |
| Anything else | "Its terminal is not in this window. It runs in another window, or outside the editor." |

- **Why three conditions stand before the one command.** Claude Code only brings forward the tab of a session it already runs in this window. Given any other session id, the same command would start a second copy of that session. So the command runs only when the session's own file says chat panel, its process descends from this window's extension host, and its start time is the file's. A session of an older CLI whose file names no `entrypoint` is not shown in a panel at all.
- **No hub change.** How a session was started is read by the window that was asked, so a window of 0.1.3 works with a hub of 0.1.2.

## 9. Verified, and not

All of it on 26 November 2026, on one Windows 11 machine. "Isolated" means an editor started with its own user-data folder, its own extensions folder and its own monitor home, so nothing of the owner's editor profile or Claude settings was read or changed.

### 9.1 What ran

| What | Where | Result |
|---|---|---|
| The tests, `node --test "test/*.test.js"` | Windows 11, Node 26.7.0, headless Edge | 259 tests: 255 pass, 0 fail, 4 skipped (file modes and links, which Windows cannot make; and two on a window that stops reading, which Windows cannot show, section 9.4) |
| The same | Linux (WSL 2, Ubuntu), Node 24.21.0 | 259 tests: 241 pass, 0 fail, 18 skipped (the page tests: no browser there). The four that Windows skips ran and passed. |
| The page tests alone | headless Edge (all 18, on the finished build), and headless Chrome (the 16 there were before the last two were added) | all pass. Measured there: 0 frames in 3 seconds at rest; one frame for a call that starts, two for one that ends; a frame of 4.4 ms (median) at 265 nodes. |
| The VSIX | `code --install-extension` into an isolated extensions folder | "successfully installed", listed as `r-spring.wyarden-monitor-3d@0.1.0` |
| The extension in a real editor | VS Code 1.148.0, isolated, as a development extension, on this repository's folder | Hub up in a worker thread; the workspace listed with its one live session; a snapshot of that session's recent calls, read from its transcript (14 to 21 nodes, by the run); then live calls. [Screenshot](img/live/vscode-live-session.png). |
| Two editors, one hub | VS Code 1.148.0 and VSCodium 1.143.17232 (the portable build, its published SHA-256 checked), isolated, side by side. Run four times; the last two on the finished build, with the signed handshake. | The second attached as a client. Both listed both workspaces, each with its editor's name. |
| A real session with the collector | Claude Code 2.1.332, one `-p` run each time in a throwaway repository, the collector's eleven entries passed with `--settings` | The VSCodium window, showing that workspace, received every event as `exact`: the turn's start, each call's start, its file and folder touches, each call's end (one failed), the turn's end. The VS Code window, showing the outer workspace, received none of them: the deeper folder owns the session. [Screenshot](img/live/vscodium-hooks.png). |
| The session's end | the same runs | Ended from its session file, then dropped from the scene after the 20 seconds. |
| The hub's window closes | the VS Code instance was stopped | VSCodium became the hub and was up again 2.6 to 6.7 seconds after the stop was asked for (the figure includes stopping nine processes). Its list then held its own workspace only. |
| A double-click, to an editor | VS Code 1.148.0, isolated, the finished build; the action was sent as the page sends it, for a file a live session had just read | The hub named the file, and an editor opened on it beside the monitor, which stayed in view. That showed the scene squeezed to a sliver in the narrow tab; the page now puts the inspector under the scene below 640 px. |
| Set-up and removal | the whole extension against a stand-in for `vscode`, a temporary home | The change shown as a diff, one question, the file written; removal left it byte for byte as it was. |

### 9.2 What Claude Code really does (measured, CLI 2.1.332)

- The documented settings structure is accepted as it is. `timeout` is in seconds.
- **An `http` hook never fires for SessionStart.** The CLI skips it without a word.
- Hooks from the user's settings, from `--settings` and from a project's settings all run together. Two hooks for one event fire in the same millisecond.
- `prompt_id` is on every event. A failed call arrives as PostToolUseFailure with `error`, `is_interrupt` and `duration_ms`.
- The tool that starts a subagent is named `Agent`. Calls inside the subagent carry `agent_id` and the parent's `session_id`.
- An MCP call carries `mcp_server: {name, source}`; the server's name keeps its underscores inside `tool_name`.
- With no hub listening, each hook fails in 8 to 28 ms and is silent, except SessionEnd, which prints one line on stderr.
- A session's file, `sessions/<pid>.json`, appears 1 to 4 seconds after launch and is deleted on exit. A subagent's transcript is a file of its own.

### 9.3 Not verified

- **No editor was run on Linux.** The Node side passed there; the page, the tab and the worker thread inside a Linux editor did not run. Code - OSS was not run on either system.
- **Node 18**, the oldest runtime an editor of the declared engine (1.85) carries: the code uses nothing newer by design, but only Node 24 and 26 ran it.
- **A remote window** (WSL, SSH, a container).
- **Whether a session that is already running picks up a collector** added to its settings, or only a new session does.
- **StopFailure, PermissionRequest, PermissionDenied and Notification over HTTP:** none was triggered in the probe, so their payloads are from documentation. The same holds for the argument names of Edit, MultiEdit, NotebookEdit, Bash, PowerShell, Grep, WebFetch, WebSearch and AskUserQuestion.
- **The budgets of 04 section 8** beyond what the tests measure (0 frames at rest; a frame of 4.4 ms median at 265 nodes in headless Edge). Event to pixel, the hub's memory, an eight-hour run: not measured.
- **A real screen reader.**
- **A click and a double-click with a real mouse inside a real editor's tab.** They ran in the headless browser against the page, and the action ran in a real editor, but the two were not joined by hand.

### 9.4 What the independent reviews found

Three reviewers, each given claims to refute and no reasoning, attacked the privacy rule, the hub and the installer, and the page and the host; a fourth then attacked the rewritten installer. What they broke was fixed and is now under test:

| Found | Fixed by |
|---|---|
| A path or a command line under 80 characters could ride in an id or a name field (a tool name, a session id, a call id), since those were only cut to length. | Ids and names are kept only when they look like ids and names; anything else becomes a stand-in made from its hash (section 4). |
| A session working at the top of a file system (`/`, `C:\`) was named by that path, and a path "relative" to it was the whole path. | It is named `(root)`, and files there are kept by base name alone. |
| A `cwd` on a network share (`\\server\share`) made the hub look that share up, which on Windows signs in to the server named. | A path on another machine is never looked up on disk. |
| One request could stall the hub for over a minute: an input nested millions deep (its hash was built from the whole input), or a `cwd` thousands of levels deep. | The hash walks the input with a budget; the climb to the session root stops after 64 folders; a "path" over 4096 characters is not one. |
| Calls that start and never end piled up without limit, until the snapshot was too large to send. | A session keeps at most 64 calls open; the oldest is closed as "end not seen". |
| `resolve` found its session by the longest matching prefix, so a made-up session id could answer for another session's files. | A session id cannot hold `:`; the node id is parsed exactly. |
| A window sent the control token to whatever answered on the port. | The token is never sent: requests are signed, and the hub proves itself (section 7.2). |
| The installer rewrote the whole settings file, so number-like keys changed order, a few odd numbers changed value, and a duplicate key was lost. | It changes only the text of the `hooks` member; every other byte stays. |
| The rewritten installer, checked again by a fourth reviewer with 8,000 generated files: set-up deleted a `null` that a user's hook list held, because it marked its own duplicates with `null`. | Its mark is a value no file can hold. The reviewer's own generator, run again on 12,000 files, finds only the documented case (white space inside an empty top-level object). |
| The same check: a record made by hand could be handed to `apply`, and an 8 MB file of dense text cost 2 GB of memory to scan. | `apply` writes only the very records `plan` returned; a settings file over 1 MB is refused. |
| The hub closed a window that was sent two large messages at once (found by the Linux run, not by a reviewer). | A window is closed for being stuck only when nothing has moved for 5 seconds, or 32 MB waits. |
| A tab restored from the last session, beside a newly opened one, sat there with no feed (seen in a screenshot). | The restored one is closed when the editor brings it back, and the live one is shown. |
| A look named `__proto__` or `toString` was taken for a real one and, once saved, kept the page from ever starting again. | A look is a look only by its own name. |
| A snapshot with a part of the wrong kind passed loading and then failed in the drawing code on every frame. | `model.load` refuses it, so the page keeps the picture it had. |
| The page's policy allowed the editor's whole resource host family (`cspSource` holds a wildcard). | Scripts and the stylesheet are allowed by the page's nonce alone; no host is named. |
| Fifteen sentences in this document and the README did not match the code. | Corrected. |

**Left as it is, and why:**
- **Another user of the same machine can listen on the hub's port while no editor is open.** Claude Code's hooks then post to that program: prompts, commands and file contents. A hook cannot check who answers. So: do not set up collectors on a machine that other people log in to. The view works there without them, from the transcripts.
- **A name of up to four plain words is kept as a name.** A holder of the ingest token can therefore still put a few words of its own into a tool's name. It learns nothing by doing so.
- **A link inside a session's folder that points outside it** opens what it points to, as it does in the editor's own Explorer.
- **A process running as the owner** with the ingest token can still waste the hub's time within the limits above, and one with the control token can take all 64 window places. Such a process can already read every transcript.
- **On Windows the hub cannot tell that a window has stopped reading.** A loopback write is taken whole by the system there, so nothing is left waiting for the hub to measure; the rule that closes a stuck window (more than 4 MB waiting and no progress for 5 seconds, or 32 MB waiting) works on Linux only. What such a window holds up is the system's memory for that connection, at the rate events arrive.

### 9.5 Version 0.1.1: the owner's first look, 27 November

The owner installed 0.1.0 in his own VS Code, ran "Set Up Collectors" there, and asked for changes while he watched it.

**What his machine showed** (read from the running hub, as counts and names only):
- The extension came up in all six open windows with no reload, and listed **eight** workspaces: two windows held a workspace file with two folders, and 0.1.0 listed folders.
- A view of all of them drew eight live sessions (84 shapes) from the transcripts, with calls arriving live.
- His own "Set Up Collectors" wrote the eleven entries into all three Claude account folders, and one running session was reporting through them soon after. Whether the other seven, which were running before set-up, pick the hooks up without a restart was not established.
- Before any tab was open the status bar said "0 live sessions". It had not looked: the hub looks only while a tab is open.

**What changed, and how each was checked:**

| Asked for | Built | Checked |
|---|---|---|
| Only the windows that are open | A workspace is a window (sections 1 and 7.1). | Hub tests on Windows and Linux. In real editors: a window opened on a workspace file with two folders gave one chip, named after the file; a real Claude Code session in its second folder was counted under it. |
| (found, not asked) the status bar's "0" | A count is shown only while the hub is looking (`watching`). | The same run: "1 open workspace. Click to open." before the tab, a count after. |
| Labels to be transparent | No plate behind a caption; a thin outline round the letters. | Node and browser tests: the only filled rectangle in a frame, apart from the 5 px marks of written files, is the background. Screenshots of both looks. |
| The tab's title under the agent, only on mouse-over | `title` from the CLI's session file; drawn while the pointer is on the agent. | Browser test with a real pointer: absent at rest, drawn directly under the name when pointed at, gone again after; one frame for it. |
| Agents as icosahedrons, subagents as dodecahedrons | Both looks. | Node tests of the two solids (12 corners and 30 edges; 20 and 30). Screenshots. |
| Agents and subagents coloured by provider; then, by name: Claude orange, Codex blue, Antigravity purple, Grok green (0.1.2) | Those four hues in each look; the floor agents stand on became a neutral colour, so no provider's runs into it. | Tests: each provider's colour is of the hue named, at least 40 apart (in red, green and blue) from the other classes, the floor, and the "needs you" and "failed" colours, and 60 from each other. Screenshots of both looks. |
| The tile an agent stands on labelled with its workspace's title, not the code | `space` on the session; the agent's own caption is now its provider's name, and the folder's code is only in the inspector. | Browser test: each tile's label equals its agent's workspace, clear of every caption. In a real editor: "WYARDEN" under this session's agent. |
| (found by the page's builder) a state mark hid half of a small subagent | The mark stands out from the shape's corner. | Node test on the mark's place. |

**Tests:** 300 on Windows (296 pass, the same 4 skipped) and on Linux (275 pass; the 25 page tests need a browser). The finished build in a real VS Code, showing the session that built it: [screenshot](img/live/vscode-0.1.1.png).

**Old and new together, in real editors:** a hub of 0.1.0 with a window of 0.1.1, and a hub of 0.1.1 with a window of 0.1.0, both ran a whole session through. With the old hub the list stays by folder; with the new hub the old window sees the list by window and is shown its own. So after an update the list is by window only once the window that runs the hub runs 0.1.1, which is certain only when every window has been reloaded.

**What it cost:** a frame at 265 nodes took about 7 ms (median, on a machine at full load) where it took 4.4 to 5.7 ms before: an icosahedron has 30 edges where the octahedron had 12. The plan's budget is 8 ms at 200 nodes and 16 at 500, which is 9.7 ms at 265; the test holds the frame to that line.

**Not verified for 0.1.1:** the owner's own six windows after the update (it takes effect when they are reloaded); a title on a session of a provider other than Claude Code (none exists yet); how the real editor shows a chip's hover text of several lines.

### 9.6 Where the slice differs from 04

| 04 says | This slice |
|---|---|
| Built inside the main extension (`src/monitor-*.ts`). | Its own extension, in plain JavaScript, so it installs beside a running Entomatical build. |
| A window without the view holds no connection. | Every window holds one, with no traffic on it: that is what makes "only open workspaces" true. |
| The hub's own window is fed over a `MessagePort`. | Every window, the hub's too, uses the same loopback connection: one path, tested without an editor. |
| Scope: this window's folders, or every workspace. | A chip for each open workspace, and "All open". This window's folder is shown first. |
| An ended session stays up to 60 minutes. | 20 seconds. The owner asked to see only what is alive. |
| Collectors are the only source of calls. | A session with no collector is read from its transcript (`derived`), so the view works before any set-up. |
| SessionStart and SessionEnd hooks. | Neither (9.2). |
| A checkpoint file carries the picture across a hand-over. | None. The new hub rebuilds from session files and transcripts; open calls of collector sessions are lost. |
| "Focus the session" in five steps: the board's card, a terminal, the chat panel, another window through the hub, no window (6.2). | Since 0.1.3: the terminal and the chat panel, for the window the monitor is in (8.5). A session anywhere else gets a message. How a session was started is read from its session file, which 04 did not know of. |
| three.js, the tree view, the native menu, actions routed between windows, the cost command, Codex, Grok Build, Antigravity. | Not built. |
