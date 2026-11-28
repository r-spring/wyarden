# Monitor 3D, step 2: the live signals

Plan "3D agent monitor: critique, approach, wiring plan", step 2 of 5. Documents only: nothing here is wired.

## 1. The answer

- All four agents now have documented, per-user hooks that push a JSON event on every tool call, start and end. That is the one source that covers any workspace, including sessions Wyarden did not start. Build the monitor on hooks; use ACP, `codex exec --json` and the app-server stream only for sessions the board starts itself, and transcripts never as the source of an "exact" mark.
- Claude Code gives the most: start (PreToolUse), end (PostToolUse), failure (PostToolUseFailure), `tool_use_id` to pair them, an optional `duration_ms`, the subagent (`agent_id`) on every tool event, and an `mcp_server` object on MCP calls.
- Codex hooks give start and end with `tool_use_id`, and MCP tools as `mcp__<server>__<tool>`, but no failure event, no duration, no subagent on tool events, and nothing for hosted tools such as web search.
- Grok Build hooks match Claude's shape in camelCase (`toolName`, `toolInput`, `toolUseId`), have PostToolUseFailure and an `http` hook type, and name MCP tools `<server>__<tool>`.
- Antigravity has six hook events only (no session end, no notification, no subagent events). An MCP call is, by default, the generic tool `call_mcp_tool` with `ServerName` and `ToolName` in its arguments.
- What this repository records today is not enough: PostToolUse only, no start, failure, duration, pairing id, MCP parse or resource; and installed per card, so sessions the board did not start are invisible (section 7).
- A Node command hook costs about 55 ms per event on this machine (measured, section 6); an HTTP hook avoids the process start. The monitor should use HTTP or async hooks wherever the agent offers them.

## 2. How this was checked

- Official documentation was fetched on 2026-11-26 by four research agents, each told to answer from the pages only and to write "NOT IN DOCS" otherwise. They read the pages through a summarising fetcher, so field names are exact but long JSON examples were summarised, not quoted.
- `developers.openai.com/codex/*` now answers with a 308 redirect to `learn.chatgpt.com/docs/*`; the Codex URLs below are the redirect targets.
- The repository and the Entridir repository were read directly (sections 7 and 8). The cost figures were measured here (section 6).
- What could not be verified is listed in section 9.

## 3. Claude Code

Docs: [hooks](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide), [plugins reference](https://code.claude.com/docs/en/plugins-reference), [plugin install scopes](https://code.claude.com/docs/en/plugins/install), [settings](https://code.claude.com/docs/en/settings), [monitoring](https://code.claude.com/docs/en/monitoring-usage), [the .claude directory](https://code.claude.com/docs/en/claude-directory).

Common hook fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name`; inside a subagent also `agent_id` and `agent_type`.

| Signal | Reveals | Push/poll | Delay | Fields | Install | Stability |
|---|---|---|---|---|---|---|
| PreToolUse hook | tool call requested (before permission and before it runs) | push | at the event; a sync hook delays the call by its run time | `tool_name, tool_input, tool_use_id`; MCP: `mcp_server {name, source}` (source: plugin, sdk, user, project) | user, project, local, managed settings, `--settings`, or a plugin | documented; `mcp_server` needs v2.1.274+ |
| PostToolUse hook | call ended ok | push | at the event | `tool_input, tool_response, tool_use_id, mcp_server`, optional `duration_ms` (excludes permission prompts and PreToolUse hooks) | as above | documented |
| PostToolUseFailure hook | call failed after it started | push | at the event | `tool_name, tool_input, tool_use_id, error` (display text, not a stable format), optional `is_interrupt`, `duration_ms`. Not fired when a running tool is cancelled | as above | documented |
| PostToolBatch hook | a batch of parallel calls finished, before the next model request | push | at the event | `tool_calls[] {tool_name, tool_input, tool_use_id, tool_response}` | as above | documented |
| PermissionRequest hook | waiting for the user to approve a call | push | at the event | `tool_name, tool_input, permission_suggestions`; no `tool_use_id` | as above | documented |
| PermissionDenied hook | the auto-mode classifier refused a call (not a refused dialog, not a deny rule) | push | at the event | `tool_name, tool_input, tool_use_id, reason, mcp_server` | as above | documented |
| Notification hook | waiting for the user | push | at the event | `message, title, notification_type`: `permission_prompt, idle_prompt, elicitation_dialog, elicitation_url_dialog, elicitation_complete, elicitation_response, agent_needs_input, agent_completed`, auth, quota and plugin types | as above | documented; cannot block |
| Elicitation, ElicitationResult hooks | an MCP server asks the user for input, and the answer | push | at the event | `mcp_server_name, message, mode, url, elicitation_id, requested_schema`; result: `action, content` | as above | documented |
| SubagentStart, SubagentStop hooks | subagent start and stop | push | at the event | `agent_id, agent_type`; stop adds `agent_transcript_path, last_assistant_message, stop_hook_active` | as above | documented |
| SessionStart, SessionEnd hooks | session start and end | push | at the event | start: `source` (startup, resume, clear, compact, fork), `model, agent_type, session_title`; end: `reason` (clear, resume, logout, prompt_input_exit, other). All SessionEnd hooks share a 1.5 s budget | as above | documented |
| UserPromptSubmit hook | turn start | push | at the event | `prompt, session_title`; also fires for scheduled tasks and background-subagent reports | as above | documented |
| Stop, StopFailure hooks | turn end; StopFailure when an API error ended it | push | at the event | `last_assistant_message, stop_hook_active, background_tasks, session_crons`; failure: `error, error_details`. Stop does not fire on a user interrupt | as above | documented |
| OpenTelemetry logs: `claude_code.tool_result`, `tool_decision`, `user_prompt`, `subagent_completed`, `mcp_server_connection` | call end with success and duration; permission decision | push, batched | `OTEL_LOGS_EXPORT_INTERVAL`, default 5000 ms (metrics 60000 ms) | `tool_name, tool_use_id, success, duration_ms, error_type, decision_type, decision_source, tool_input_size_bytes, tool_result_size_bytes, mcp_server_scope`; standard `session.id, prompt.id, event.sequence`. With `OTEL_LOG_TOOL_DETAILS` off (default) an MCP tool's name is the literal `mcp_tool`; on, `tool_parameters` holds `mcp_server_name, mcp_tool_name` but also the input | environment variables, per process or in user settings `env` | documented |
| Transcript `projects/<project>/<session>.jsonl` | every `tool_use` and `tool_result`, `is_error`, `isSidechain` for subagents | poll or file watch | when the CLI writes the record | undocumented record shape | per user (config folder) | not documented as an interface; "the transcript file isn't guaranteed to include the final message" at Stop; deleted after `cleanupPeriodDays` (30) |
| Session file `sessions/<pid>.json` (read by `src/sessions.ts`) | live sessions, `busy, idle, waiting` | poll | the board polls every 3 s | `pid, sessionId, cwd, status, waitingFor, name, statusUpdatedAt, procStart` | per user | undocumented |

Hook types: `command` (exec form with `args`; `async: true` runs in the background and cannot block, its `timeout` not enforced; `asyncRewake`), `http` (POST of the event JSON; a non-2xx answer, a refused connection or a non-JSON body is a non-blocking error), `mcp_tool`, `prompt`, `agent` (experimental). Default timeout 600 s for command and http.

Install: a plugin carries hooks in `hooks/hooks.json` that run "when plugin is enabled", without editing settings. User scope (`enabledPlugins` in the user's settings) is the default for `claude plugin install`, so one install covers every workspace. Catch: each account folder (`CLAUDE_CONFIG_DIR`) has its own settings, and board cards run with their account's folder (`src/board.ts:4296`), so the plugin must be enabled in each account folder. `disableAllHooks` turns every hook off.

MCP names: `mcp__<server>__<tool>`; plugin servers `mcp__plugin_<plugin>_<server>__<tool>`. Use the `mcp_server` object, not the name, for the server: a server or plugin name can itself contain underscores.

## 4. Codex CLI

Docs: [hooks](https://learn.chatgpt.com/docs/hooks), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [app-server](https://learn.chatgpt.com/docs/app-server), [advanced config, OTel and notify](https://learn.chatgpt.com/docs/config-file/config-advanced), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [changelog](https://learn.chatgpt.com/docs/changelog). Field-level source for `exec --json`: [exec_events.rs](https://raw.githubusercontent.com/openai/codex/main/codex-rs/exec/src/exec_events.rs); OTel: [session_telemetry.rs](https://raw.githubusercontent.com/openai/codex/main/codex-rs/otel/src/events/session_telemetry.rs); config: [docs/config.md](https://raw.githubusercontent.com/openai/codex/main/docs/config.md).

Common hook fields: `session_id, transcript_path, cwd, hook_event_name, model`; `turn_id` on every event but SessionStart and SessionEnd (the least certain point of the fetch); `permission_mode` on most.

| Signal | Reveals | Push/poll | Delay | Fields | Install | Stability |
|---|---|---|---|---|---|---|
| PreToolUse hook | call start, local tools only | push | at the event | `tool_name, tool_use_id, tool_input`. Shell and `exec_command` arrive as `Bash`; `apply_patch` as `apply_patch` (matchers `Edit`, `Write`); MCP as `mcp__<server>__<tool>`; `spawn_agent` matches `Agent`; hosted tools such as web search are not covered | user `~/.codex/hooks.json` (`$CODEX_HOME`), project `.codex/hooks.json` (trusted projects only), system, plugin, managed, inline `[hooks]` in config.toml, per-session `-c hooks.<Event>=…` | documented; on by default (`[features] hooks = false` turns off). Every non-managed hook must be reviewed in `/hooks` before it runs; `allow_managed_hooks_only` can lock out user hooks |
| PostToolUse hook | call end, also on a non-zero exit | push | at the event | the above plus `tool_response`. No failure event: failure is read from the response | as above | documented |
| PermissionRequest hook | waiting for approval | push | at the event | `tool_name, tool_input`; no `tool_use_id` | as above | documented |
| SubagentStart, SubagentStop hooks | subagent start and stop | push | at the event | `agent_id, agent_type`; stop adds `agent_transcript_path, last_assistant_message, stop_hook_active`. Tool events do not carry `agent_id` | as above | documented |
| SessionStart, SessionEnd hooks | session start and end | push | at the event | `source` (startup, resume, clear, compact, fork); `reason` (always `other` today). SessionEnd not fired for subagents; 1 s default timeout | as above | documented |
| UserPromptSubmit, Stop, Interrupt hooks | turn start, end, interrupted (main thread only) | push | at the event | `prompt`; `last_assistant_message, stop_hook_active` | as above | documented |
| Pre/PostModelRequest hooks | each model request | push | at the event | `agent_id, agent_type` when available; post: `status, error, token_usage` | as above | documented, diagnostic only |
| `notify` program | turn end only (`agent-turn-complete`) | push | at the event | `type, thread-id, turn-id, cwd, input-messages, last-assistant-message` | user config.toml | documented, legacy |
| `codex exec --json` stdout | thread, turn, item start, update and end | push | as it happens | `thread.started{thread_id}`, `turn.started`, `turn.completed{usage}`, `turn.failed{error}`, `item.started/updated/completed{item}`. Items: `command_execution{command, aggregated_output, exit_code, status: in_progress, completed, failed, declined}`, `file_change{changes[{path, kind: add, delete, update}], status}`, `mcp_tool_call{server, tool, arguments, result, error, status}`, `collab_tool_call{tool: spawn_agent, send_input, wait, close_agent; sender_thread_id, receiver_thread_ids, agents_states, status}`, `web_search{query, action}`, `todo_list`, `reasoning`, `agent_message` | only the run that was started with it | documented by example; fields from source |
| app-server JSON-RPC (used by the board, `src/board.ts:6270-6299`) | the same, camelCase, with durations | push | as it happens | `turn/started`, `turn/completed`, `item/started`, `item/completed`; `commandExecution{command, cwd, status, commandActions, exitCode, durationMs}`, `fileChange{changes[{path, kind, diff}]}`, `mcpToolCall{server, tool, arguments, result, error, durationMs}`, `collabToolCall{senderThreadId, receiverThreadId, newThreadId}` | only threads on that app-server | stdio documented; some methods behind `experimentalApi`; schema per version from `codex app-server generate-json-schema` |
| OTel (`[otel]` in config.toml) | `codex.tool_decision`, `codex.tool_result` (duration, success, output snippet) | push, batched | exporter batch, flushed on shutdown; interval not documented | `tool_name, tool_namespace, call_id, decision, source` | user config.toml | documented; off by default; `log_user_prompt` false by default |
| Rollout `~/.codex/sessions/…/rollout-*.jsonl` (read by `src/codex.ts` and Entridir) | function calls, outputs, exec begin and end | poll | when written | undocumented | per user | not documented; storage changed in 0.171.0 (2026-11-20, compressed shards) |

Subagents: no tool-hook field names the subagent. `transcript_path` might differ per subagent; that is not documented. Only `collab_tool_call` (exec) and `collabToolCall` (app-server) carry thread ids.

## 5. Grok Build and Antigravity

### Grok Build

Docs: [hooks (docs.x.ai)](https://docs.x.ai/build/features/hooks.md); fuller, in xAI's official repository: [10-hooks.md](https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md), [14-headless-mode.md](https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [24-monitoring-usage.md](https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/24-monitoring-usage.md); [MCP servers](https://docs.x.ai/build/features/mcp-servers.md), [subagents](https://docs.x.ai/build/features/subagents.md), [headless](https://docs.x.ai/build/cli/headless-scripting.md), [permissions](https://docs.x.ai/build/features/permissions.md), [settings](https://docs.x.ai/build/settings/reference.md). Where the two disagree the repository's is more complete (docs.x.ai omits StopCancelled and the 600 s timeouts).

Common fields: `hookEventName` (also `hook_event_name`), `sessionId, cwd, workspaceRoot, timestamp, permissionMode, promptId`.

| Signal | Reveals | Push/poll | Delay | Fields | Install | Stability |
|---|---|---|---|---|---|---|
| PreToolUse hook | call start | push | at the event | `toolName, toolInput, toolUseId, toolInputTruncated` | user `~/.grok/hooks/*.json`; project `.grok/hooks/*.json` after `/hooks-trust`. Also reads `.claude/settings.json` and `.cursor/hooks.json` | documented |
| PostToolUse, PostToolUseFailure hooks | end ok, failed | push | at the event | add `toolResult` (alias `tool_response`), `toolResultTruncated`; failure fields not detailed | as above | documented |
| PermissionDenied hook | a call was refused | push | at the event | the tool fields | as above | documented |
| Notification hook | waiting for the user (probably) | push | at the event | `notificationType` (values NOT IN DOCS), `message` ("may change between releases") | as above | documented |
| SubagentStart, SubagentStop (`SubagentEnd`) hooks | subagent start and stop | push | at the event | stop: the Stop fields plus `phase: "gate"`; `subagentType` (general-purpose, explore, plan) in subagent sessions; id format NOT IN DOCS | as above | documented |
| SessionStart, SessionEnd hooks | session start and end | push | at the event | matcher `startup, resume`; payload NOT IN DOCS. Session end 1.5 s budget | as above | documented |
| UserPromptSubmit, Stop, StopFailure, StopCancelled hooks | turn start and end | push | at the event | Stop: `stopHookActive, lastAssistantMessage, reason (end_turn, channel_closed, shutdown), backgroundTasks, sessionCrons`; failure `error, errorDetails`; cancelled `cancelledBy, cancelTrigger` | as above | documented |
| `--output-format streaming-json` | text, `tool_call{toolCallId, toolName, kind, status, rawInput, locations}`, `tool_call_update{status, rawOutput, locations}`, `end` | push | as it happens | derived from ACP updates; "non-exhaustive" | only that run | documented |
| ACP (`grok agent stdio`; the board runs `grok acp`, `src/acp.ts:159`) | see section 5.3 | push | as it happens | ACP | only sessions the client starts | ACP v1 |
| OTel (`GROK_EXTERNAL_OTEL=1`) | content-free events | push, batched | not documented | `event.sequence, session.id, turn_number, prompt.id` | environment | documented |
| `~/.grok/sessions/` (SQLite) | transcripts | poll | | undocumented | per user | not an interface |

Hook types: `command` and `http` (POSTs the whole envelope). Default timeout 5 s; PostToolUse, Stop and SubagentStop 600 s. Exit 2 denies; any other non-zero fails open. MCP tools: `<server>__<tool>` (e.g. `linear__save_issue`). Built-in tools: `run_terminal_command, read_file, search_replace, grep, list_dir, web_search, spawn_subagent`, `web_fetch` (off by default); their argument names are NOT IN DOCS.

Risk: Grok reads `.claude/settings.json`, so a Claude hook installed in a project's settings would also fire for Grok. The monitor's hook must read the agent from the payload's shape (`hookEventName` vs `hook_event_name` alone, `toolName` vs `tool_name`), not assume it.

### Antigravity

Docs: [hooks](https://antigravity.google/docs/hooks.md), [MCP](https://antigravity.google/docs/mcp.md), [headless](https://antigravity.google/docs/cli/headless.md), [ACP](https://antigravity.google/docs/cli/acp.md).

Common fields: `conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName, lastUserInput`.

| Signal | Reveals | Push/poll | Delay | Fields | Install | Stability |
|---|---|---|---|---|---|---|
| PreToolUse hook | call start | push | at the event | `toolCall.name, toolCall.args, stepIdx` | global `~/.gemini/config/hooks.json`; workspace `.agents/hooks.json`; plugin `hooks.json` | documented; no stability label |
| PostToolUse hook | call end; failed when `error` is set | push | at the event | the above plus optional `error` | as above | documented |
| PreInvocation, PostInvocation hooks | each agent run (taken as a turn) | push | at the event | `invocationNum, initialNumSteps` | as above | documented |
| SessionStart hook | session start | push | at the event | common fields | as above | documented |
| Stop hook | the agent stopped | push | at the event | `executionNum, terminationReason, error, fullyIdle` | as above | documented |
| `agy -p … --output-format stream-json` | `init`, `step_update{conversation_id, step_index, state: ACTIVE, DONE; step_type: user_input, agent_response, tool, checkpoint; tool_name, tool_info, subagent_info}`, `result{status: SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING}` | push | as it happens | `tool_info` and `subagent_info` contents NOT IN DOCS | only that run | documented |
| ACP (`agy acp`, used by the board) | section 5.3 | push | as it happens | ACP; Antigravity's methods NOT IN DOCS | only sessions the client starts | ACP v1 |

Hook type: `command` only, 30 s default timeout; matcher a regex on tool events. No SessionEnd, Notification, UserPromptSubmit or Subagent event. No OTel (NOT IN DOCS; a third-party page says none). Transcript location and format NOT IN DOCS.

Tools and their documented arguments: `view_file{AbsolutePath, StartLine, EndLine}`, `write_to_file{TargetFile, CodeContent, Overwrite}`, `replace_file_content{TargetFile, …}`, `multi_replace_file_content{TargetFile, ReplacementChunks}`, `list_dir{DirectoryPath}`, `find_by_name{SearchDirectory, Pattern}`, `grep_search{SearchPath, Query, IsRegex}`, `run_command{CommandLine, Cwd, WaitMsBeforeAsync}`, `read_url_content{Url}`, `search_web{query, domain}`, `ask_question{questions}`, `ask_permission{Action, Target, Reason}`, `invoke_subagent{Subagents[{Prompt, Role, TypeName}]}`.

MCP: by default (lazy) the agent calls `call_mcp_tool{ServerName, ToolName, Arguments}`. A tool marked `"eager": true` in `mcp_config.json` is registered as `mcp_<serverName>_<toolName>`; split it against the server names in that file, since both parts may hold underscores. How MCP calls look inside hooks is NOT IN DOCS; in lazy mode `toolCall.name` should be `call_mcp_tool`.

### 5.3 Agent Client Protocol

Docs: [prompt turn](https://agentclientprotocol.com/protocol/prompt-turn), [tool calls](https://agentclientprotocol.com/protocol/tool-calls), [session setup](https://agentclientprotocol.com/protocol/session-setup), [initialization](https://agentclientprotocol.com/protocol/initialization), [extensibility](https://agentclientprotocol.com/protocol/extensibility), [agents list](https://agentclientprotocol.com/overview/agents), [v1 schema](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json).

- Push, as it happens, and only for sessions the client starts (the board's Grok and Antigravity cards).
- `session/update` with `tool_call{toolCallId, title, name?, kind, status, content, locations[{path, line}], rawInput, rawOutput}` and `tool_call_update` (only `toolCallId` required). `kind`: read, edit, delete, move, search, execute, think, fetch, switch_mode, other. `status`: pending, in_progress, completed, failed. Content: `content`, `diff{path, oldText, newText}`, `terminal`, `session` (a subagent's session, if the client advertises `subagents`).
- No MCP server identity: no field names the server; `name` is opaque. The client knows the server names it sent in `session/new{mcpServers}`, not which one served a call.
- Subagents: `subagent_update{sessionId, title, state, …}` behind the `subagents` capability; no parent tool call id.
- Waiting for the user: the `session/request_permission{sessionId, toolCall, options[{optionId, name, kind: allow_once, allow_always, reject_once, reject_always}]}` request, until it is answered.
- Turn: `session/prompt` starts it; its response `stopReason` (end_turn, max_tokens, max_turn_requests, refusal, cancelled) ends it. No turn notification.
- Stable version 1; new capabilities are not breaking changes. A `schema/v2` folder exists and was not read.

## 6. Cost per tool call, measured

Measured on this Windows machine, 2026-11-26, Node v26.7.0, 20 runs after one warm-up (scripts outside the repository):

| What | Median | p90 |
|---|---|---|
| Start `node -e ""` with a small stdin | 45.8 ms | 51.8 ms |
| Run `hook/hook.js` on a PostToolUse with a 2 KB result, appending one line | 55.1 ms | 62.4 ms |
| Receive one JSON POST on a localhost Node server (200 runs) | 0.13 ms | 0.23 ms |

- A synchronous command hook adds about 55 ms to the agent per event, so about 110 ms per call with PreToolUse and PostToolUse. Almost all of it is starting Node. `async: true` (Claude Code; Codex runs up to 8 async hooks per session) moves it off the agent's path but still spends the CPU.
- An HTTP hook (Claude Code, Grok Build) spends no process. The receiving side costs about 0.1 ms; the agent's own HTTP client time was not measured. When the monitor is not listening, Claude Code treats the refused connection as a non-blocking error.
- OTel costs the agent nearly nothing per call but arrives up to 5 s late (Claude Code's default).
- Each recorded line is about 220 bytes today.
- Not measured: the agent-side cost of an HTTP hook, a non-Node hook binary, Codex's, Grok's and Antigravity's hook runners.

## 7. What this repository captures today

All line numbers are at commit b780c90.

### hook/hook.js

- One script for Claude Code and Codex. It reads the hook event from stdin and appends one JSON line to the file named in `argv[2]` (Claude) or `ENTOMATICAL_EVENTS` (Codex), or to a route in `panel-sessions/<session>.json` (`hook/hook.js:137-163`). A session with no destination is ignored (`hook/hook.js:150`): Codex sessions the board did not start are not recorded.
- The KEEP list (`hook/hook.js:19`): `hook_event_name, session_id, cwd, transcript_path, prompt, source, notification_type, tool_name, last_assistant_message, agent_id, agent_type, agent_transcript_path, model, effort, effort_level, error, stop_hook_active`. Plus `t` (the hook's own `Date.now()`, not the agent's time) and, for Codex turn hooks, `turn_id` (`hook/hook.js:154-155`).
- Not kept: `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`, `permission_mode`, and any MCP field. So a start cannot be paired with an end, and no duration is known.
- `describe()` (`hook/hook.js:22-30`): `desc` = tool name plus the first line of the first present of `file_path, notebook_path, command, pattern, url, query, description, skill, prompt`, a path under `cwd` made relative, cut to 80 characters. It is a label, not a resource: a `Grep` keeps its `pattern` and loses its `path`; a `Bash` keeps 80 characters of command; an MCP tool keeps whichever of those keys its schema happens to use.
- `hash` (`hook/hook.js:90`, set at `:159`): the first 8 hex of sha1(tool_name + tool_input) on every PostToolUse, so a repeated call is seen without storing its input.
- `agent` (`hook/hook.js:38-46`, `:59-69`, set at `:160-161`): an Agent result's id, type, model, tokens, tool calls, time, status and reply length, or the same from a `<task-notification>` prompt.
- `asks` (`hook/hook.js:75-89`, set at `:158`): whether the last reply ends with a question.
- `call` (`hook/hook.js:100-104`, set at `:162`): a hash of a PermissionRequest's input without `description` and `timeout`.
- Privacy gap: `prompt` and `last_assistant_message` are in KEEP, so every UserPromptSubmit and Stop line holds the full prompt or reply text. The monitor must not reuse that file as is (see section 13).

### Board.writeHooks (src/board.ts:4281-4334)

- Writes `.entomatical/hooks/<card>.json` (`src/board.ts:1374-1378`), passed to Claude Code with `--settings` at launch (`src/board.ts:4352`). Events go to `.entomatical/events/<card>.jsonl` (`src/board.ts:1369-1373`).
- hook.js is registered for: SessionStart, UserPromptSubmit, PostToolUse (matcher `*`), PermissionRequest (`*`), Notification (`permission_prompt` only), Stop, StopFailure, SubagentStart, SubagentStop (`src/board.ts:4313-4326`).
- Not registered: PreToolUse (only `agent-fence.js` for Bash/PowerShell and `plan-folder.js` for Write), PostToolUseFailure, PostToolBatch, SessionEnd, Elicitation, ElicitationResult, PermissionDenied, Notification types other than `permission_prompt`.
- Installed per card, through `--settings`: a Claude Code session the board did not start, in the same workspace or any other, is never seen by the hook.

### CODEX_HOOKS (src/codex.ts:338)

- `SessionStart, UserPromptSubmit, PermissionRequest, PostToolUse, Stop, Interrupt, SubagentStart, SubagentStop, SessionEnd`, passed per session as `-c hooks.<Event>=…` overrides (`src/codex.ts:357-360`) or as config for a thread in the editor's app-server (`src/codex.ts:363-366`). The command runs a copy of hook.js at a fixed per-user path (`src/codex.ts:341`) so Codex's approval hash stays the same. No PreToolUse.
- A headless Codex card runs `codex app-server` and turns every `item/completed` that is not an agent message into a PostToolUse line whose `tool_name` is the item type, e.g. `commandExecution` (`src/board.ts:6289-6294`); `turn/completed` gives Stop, Interrupt or StopFailure (`src/board.ts:6295-6299`). `item/started` is ignored, so no start or duration.
- A Codex card's first turn runs `codex app-server` with `hookArgs()` (`src/board.ts:6409`), so its hooks report as above, and every non-delta notification is written to `.entomatical/codex/<card>.log` (`src/board.ts:6415-6417`), not to the events file.

### ACP handling (src/board.ts:6075-6150, src/acp.ts)

- Grok Build and Antigravity cards run `<agent> acp` (`src/acp.ts:142-161`). Each `session/update` with `sessionUpdate: "tool_call"` becomes a PostToolUse line whose `tool_name` is the call's `title` (`src/board.ts:6106`). `tool_call_update` (status, completion, failure) is ignored, as are `kind`, `locations` and `rawInput`.
- `session/request_permission` becomes a PermissionRequest line with the call's title (`src/board.ts:6124-6130`); its `rawInput`, `content` and `locations` are shown in a modal (`src/board.ts:6131-6138`) but not recorded.
- `agent_message_chunk` text is appended as AcpMessageChunk lines (`src/board.ts:6095-6104`).

### liveSessions (src/sessions.ts:442-466)

- Lists `<config folder>/sessions/*.json` for every Claude account folder, keeps those whose `cwd` is in this repository and whose `pid` is alive, and reads `status` (`busy`, `idle`, `waiting` with `waitingFor`), `name` and `statusUpdatedAt`. These session files are the CLI's own and undocumented (`src/sessions.ts:428-431`, `:470-472`).
- This is how the board sees sessions it did not start, but only their status; no tool call. `liveCodexSessions` (`src/codex.ts:916-943`) does the same for Codex from running processes and their rollout files.
- Polled by `Board.scan` from the 3-second tick (`src/board.ts:893`, `:1095-1119`).

### How a change reaches a webview (src/extension.ts)

- `fs.watch` on `.entomatical/events/` calls `syncStatus` and fires `changed` on any `.jsonl` change (`src/board.ts:806-817`); without the watcher the 3 s tick reads the events (`src/board.ts:893`). ACP text redraws at most every 500 ms (`src/board.ts:1161-1167`).
- `BoardView` subscribes once to `board.onChange` (`src/extension.ts:551`) and calls `repost`, which goes through `coalesce` (`src/extension.ts:518-538`, `:546-548`): at most one rebuild per 500 ms, none while no board webview is visible, one when it shows again. A rebuild builds the whole board message, every card (`src/extension.ts:583`), and posts it to every board webview. A 15 s timer also reposts (`src/extension.ts:683`).
- So today a tool call reaches the webview 0 to 500 ms after hook.js appends it, as a whole-board message. The 3D view needs a delta message instead (one event), or it redraws the whole scene per tool call.

### What a real line looks like (shape only)

Six event files in the main checkout, 450 lines. Keys seen, by event: PostToolUse `t, hook_event_name, session_id, cwd, transcript_path, tool_name, desc, hash, effort, agent_id, agent_type, agent`; SubagentStart `agent_id, agent_type`; SubagentStop adds `agent_transcript_path, last_assistant_message, stop_hook_active`; SessionStart `model, source`; UserPromptSubmit `prompt, agent`; Stop `last_assistant_message, asks, stop_hook_active`; PermissionRequest `tool_name, desc, call`; Notification `notification_type`. Of 397 PostToolUse lines none was an `mcp__` tool, so the MCP path has no recorded example here.

## 8. What Entridir does (read only)

- `godot/scripts/claude_reader.gd` reads Claude Code transcripts (`<config>/projects/<encoded cwd>/<session>.jsonl`). It skips `isSidechain` records (subagents). An assistant `tool_use` block opens a call by its `id`; a user `tool_result` with the same `tool_use_id` closes it, `is_error` marking failure (`claude_reader.gd:108-126`, `:161-176`). Edit tools' `file_path` go into `files_touched`. A call still open at the end of the read is `pending`; AskUserQuestion and ExitPlanMode mark it as asking.
- `godot/scripts/session_traffic.gd` keeps a per-call row with `requestedAt`, `startedAt`, `finishedAt` and a state `pending, active, complete, failed, unknown` (`session_traffic.gd:266-296`). Claude: `progress` records (`bash_progress`, `mcp_progress`, `agent_progress`) mark a call active (`:175-177`). Codex rollouts: `function_call`, `custom_tool_call`, `local_shell_call` open a call; their `*_output` closes it; `exec_command_begin`/`_end` and `CommandExecution` items give start, end and exit code (`:196-233`). A shell result's state is read only from the process header ("Process exited with code N"), never from output (`:248-264`). MCP tools are labelled from the last `__` segment, and only when every word of it is on an allow-list (`:298-325`), so no server or argument text reaches the screen.
- Exact or inferred: `status.gd:56-64` takes the hook's PermissionRequest or Notification as exact ("needs_input", `exact: true`); without a hook, a tool call with no result for 60 s is `needs_input` with `soft: true`, shown as "(inferred)" (`status.gd:79`, `engine.gd:666`). A turn counts as hook-covered when the hook saw its UserPromptSubmit (`claude_hooks.gd:326`).
- Entridir installs its hook in the user's own `settings.json` (`claude_hooks.gd:52`), for PermissionRequest, Notification (`permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input`), UserPromptSubmit, Stop and SessionEnd (`claude_hooks.gd:25-31`): per user, so it covers every workspace. This is the model the monitor should follow, unlike the board's per-card `--settings`.
- Both readers depend on the transcript and rollout formats, which neither vendor documents as an interface. They are a fallback for "derived", never the source of "exact".

## 9. Not verified in official documentation

- Claude Code: the tool names for MCP resources (`ListMcpResourcesTool`, `ReadMcpResourceTool`, seen in a live session's tool list) and their argument names; the input fields of FileChanged, CwdChanged, ConfigChange and TeammateIdle; the full list of `mcp_server_scope` values; the last part of the hooks page went unread. No page says the transcript format is a supported interface, and none says it is not; it is treated as unsupported here.
- Claude Code tool argument names (`file_path`, `pattern`, `path`, `url`, `query`, `notebook_path`) come from hook/hook.js and live events, not from a docs page read today.
- Codex: the exact scope of `turn_id` on hook events (the fetch contradicted itself); whether `transcript_path` differs per subagent; `codex.tool_result` attributes; the OTel export interval; the full app-server schema, including what `commandActions` holds; whether Codex hooks have an `http` type (only `command` was seen); how MCP resources appear.
- Grok Build: built-in tool argument names; the payloads of SessionStart, SessionEnd, SubagentStart and UserPromptSubmit; `notificationType` values; the subagent id format; how a subagent's tool calls are attributed; MCP resources.
- Antigravity: exit codes; any session-end, notification or subagent event; the transcript's location and format; its ACP methods; MCP naming inside hooks; the contents of `tool_info` and `subagent_info`; MCP resources; OTel (only a third-party page, which says there is none).
- ACP: `schema/v2`; whether any agent's `_meta` carries an MCP server or a parent tool call; whether the subagent, compaction and notice updates are marked unstable.
- Every page was read through a summarising fetcher: field names are as the pages give them, but long JSON examples were summarised.

## 10. Need against agent

Grades: **exact**, the agent reports it as a field; **derived**, computed from fields the agent reports (argument parsing, a name split, two timestamps); **unavailable**, no documented per-user signal gives it. "Board only" marks a signal that exists only for sessions Wyarden starts itself.

| Need | Claude Code | Codex | Grok Build | Antigravity |
|---|---|---|---|---|
| Tool call starts | exact: PreToolUse (`tool_use_id`) | exact: PreToolUse, local tools only; hosted web search unavailable | exact: PreToolUse (`toolUseId`) | exact: PreToolUse (`stepIdx`) |
| Tool call ends ok | exact: PostToolUse | exact: PostToolUse | exact: PostToolUse | exact: PostToolUse without `error` |
| Tool call fails | exact: PostToolUseFailure (`error`, `is_interrupt`) | derived: PostToolUse `tool_response` (exit code); exact board only: exec `status: failed` | exact: PostToolUseFailure | exact: PostToolUse `error` |
| Duration | exact when present: `duration_ms`; else derived from Pre/Post times | derived: Pre/Post hook times; exact board only: app-server `durationMs` | derived: Pre/Post `timestamp` | derived: Pre/Post hook times |
| File read | derived: Read `tool_input` | derived: only `apply_patch` and MCP args; shell reads unavailable; app-server `commandActions` board only | derived: `read_file` args (names unverified); ACP `kind: read` + `locations` board only | derived: `view_file{AbsolutePath}` |
| File written | derived: Write/Edit/MultiEdit/NotebookEdit `tool_input` | derived: `apply_patch` input (paths in the patch); exact board only: `file_change.changes[].path, kind` | derived: `search_replace` args (unverified) | derived: `write_to_file`, `replace_file_content`, `multi_replace_file_content{TargetFile}` |
| File searched | derived: Grep/Glob `path`, `pattern` | unavailable (shell `rg`/`grep`); app-server `commandActions` board only | derived: `grep`, `list_dir` args (unverified) | derived: `grep_search{SearchPath}`, `find_by_name{SearchDirectory}`, `list_dir{DirectoryPath}` |
| URL fetched | derived: WebFetch `url`; WebSearch `query` (a search, no URL) | unavailable: web search is hosted, no hook; exec `web_search` board only | derived: `web_fetch` (off by default), `web_search` | derived: `read_url_content{Url}`, `search_web{query}` |
| MCP resource read | derived: ReadMcpResourceTool (name unverified) | unavailable | unavailable | unavailable |
| MCP server and tool | exact: `mcp_server.name` + tool from `mcp__<server>__<tool>` | derived: split `mcp__<server>__<tool>`; exact board only: `mcp_tool_call{server, tool}` | derived: split `<server>__<tool>` | derived: `call_mcp_tool{ServerName, ToolName}`; eager `mcp_<server>_<tool>` split against `mcp_config.json` |
| Which subagent made a call | exact: `agent_id`, `agent_type` on tool events | unavailable on tool events (start and stop only) | derived: `subagentType` in a subagent session (attribution undocumented) | unavailable |
| Subagent start and stop | exact: SubagentStart, SubagentStop | exact: SubagentStart, SubagentStop | exact: SubagentStart, SubagentStop | derived: PreToolUse/PostToolUse of `invoke_subagent` |
| Waiting for the user | exact: PermissionRequest, Notification (`permission_prompt`, `elicitation_dialog`, `agent_needs_input`, `idle_prompt`), Elicitation; derived: PreToolUse of AskUserQuestion | exact: PermissionRequest; derived: PreToolUse of `request_user_input` | derived: Notification (types undocumented); exact board only: ACP `session/request_permission` | derived: PreToolUse of `ask_question`, `ask_permission`; exact board only: ACP `session/request_permission` |
| Wait ends | derived: the next PreToolUse/PostToolUse of that call, ElicitationResult, or UserPromptSubmit | derived: the call's PostToolUse | derived: as Claude | derived: the call's PostToolUse; exact board only: the ACP answer |
| Session start | exact: SessionStart (`source`) | exact: SessionStart (`source`) | exact: SessionStart | exact: SessionStart |
| Session end | exact: SessionEnd (`reason`) | exact: SessionEnd (`reason` always `other`) | exact: SessionEnd | unavailable (process exit, board only) |
| Turn start | exact: UserPromptSubmit (`prompt_id`) | exact: UserPromptSubmit (`turn_id`) | exact: UserPromptSubmit (`promptId`) | derived: PreInvocation |
| Turn end | exact: Stop, StopFailure; a user interrupt fires neither: derived from the next UserPromptSubmit | exact: Stop, Interrupt | exact: Stop, StopFailure, StopCancelled | derived: PostInvocation, Stop (`fullyIdle`) |

## 11. Common event vocabulary

One JSON object per event, one line each. Every event has the envelope; the rest depends on `ev`.

Envelope:

- `v`: schema version, 1.
- `t`: when the monitor's hook received it, ms since the epoch; `at`: the agent's own time when it sends one (Grok `timestamp`), else absent.
- `agent`: `claude`, `codex`, `grok`, `antigravity`.
- `session`: the agent's session id (Antigravity `conversationId`). `turn`: the turn id when the agent gives one (`prompt_id`, `turn_id`, `promptId`), else one the monitor numbers.
- `by`: the subagent's id when known, else absent (main thread), or `"?"` when the agent cannot say.
- `ws`: the workspace folder the event belongs to, as a key the monitor maps from `cwd`; never the path itself in a stored line.
- `ev`: the event name below. `grade`: `exact` or `derived`. `src`: the signal it came from.

Events: `session.start`, `session.end`, `turn.start`, `turn.end`, `tool.start`, `tool.end`, `resource.touch`, `mcp.start`, `mcp.end`, `subagent.start`, `subagent.stop`, `wait.start`, `wait.end`.

An MCP call emits `mcp.start` and `mcp.end` instead of `tool.start` and `tool.end`, with the same `call` id, so one call is one object in the scene. A `resource.touch` names its `call`, so a file can be drawn on the line from the tool that touched it.

```json
{"v":1,"t":1795689600000,"agent":"claude","session":"s-41f2","ws":"w1","ev":"session.start","grade":"exact","src":"hook:SessionStart","source":"startup","model":"claude-opus-5-5"}
```

```json
{"v":1,"t":1795693200000,"agent":"claude","session":"s-41f2","ws":"w1","ev":"session.end","grade":"exact","src":"hook:SessionEnd","reason":"prompt_input_exit"}
```

```json
{"v":1,"t":1795689605000,"agent":"codex","session":"s-77a0","turn":"t-3","ws":"w1","ev":"turn.start","grade":"exact","src":"hook:UserPromptSubmit","chars":412}
```

```json
{"v":1,"t":1795689712000,"agent":"codex","session":"s-77a0","turn":"t-3","ws":"w1","ev":"turn.end","grade":"exact","src":"hook:Stop","outcome":"done","asks":false}
```

`outcome`: `done`, `failed` (StopFailure, `turn.failed`), `interrupted` (Interrupt, StopCancelled, or derived from a new turn starting).

```json
{"v":1,"t":1795689606100,"agent":"claude","session":"s-41f2","turn":"p-9","by":"a-1c","ws":"w1","ev":"tool.start","grade":"exact","src":"hook:PreToolUse","call":"toolu_01AB","tool":"Edit","class":"edit","hash":"3fa1c2d0"}
```

```json
{"v":1,"t":1795689606900,"agent":"claude","session":"s-41f2","turn":"p-9","by":"a-1c","ws":"w1","ev":"tool.end","grade":"exact","src":"hook:PostToolUseFailure","call":"toolu_01AB","tool":"Edit","ok":false,"ms":780,"msGrade":"exact","error":"tool_error","interrupted":false}
```

`tool.end` has `ok: true` or `false`; `ms` with `msGrade` (`exact` from `duration_ms` or `durationMs`, `derived` from the start's `t`); for a shell call, `exit` (a number) when the agent reports one. `error` is a class (`tool_error`, `denied`, `interrupted`, `timeout`), never the message. `class` on `tool.start` is one of `read`, `edit`, `search`, `execute`, `fetch`, `agent`, `ask`, `mcp`, `other` (ACP's `kind` where there is one).

```json
{"v":1,"t":1795689606100,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"resource.touch","grade":"derived","src":"args:Edit","call":"toolu_01AB","kind":"file","op":"write","path":"src/board.ts"}
```

```json
{"v":1,"t":1795689607200,"agent":"antigravity","session":"c-2b9e","ws":"w1","ev":"resource.touch","grade":"derived","src":"args:read_url_content","call":"step-14","kind":"url","op":"read","url":"https://code.claude.com/docs/en/hooks"}
```

`kind`: `file`, `dir`, `url`, `search` (a web search: no target kept), `mcp-resource`. `op`: `read`, `write`, `search`, `unknown` (an MCP argument names it; what the tool did to it is not known). `path` is relative to the workspace root; a path outside it is `{"outside":true,"name":"<basename>"}`. A Grep or Glob gives `op: "search"` on the folder it searched, never its pattern.

```json
{"v":1,"t":1795689608000,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"mcp.start","grade":"exact","src":"hook:PreToolUse","call":"toolu_01CD","server":"github","tool":"list_issues","serverSource":"user"}
```

```json
{"v":1,"t":1795689608650,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"mcp.end","grade":"exact","src":"hook:PostToolUse","call":"toolu_01CD","server":"github","tool":"list_issues","ok":true,"ms":650,"msGrade":"exact"}
```

`grade` is `derived` when the server comes from splitting a name or from `call_mcp_tool`'s arguments.

```json
{"v":1,"t":1795689609000,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"subagent.start","grade":"exact","src":"hook:SubagentStart","sub":"a-1c","type":"Explore","parentCall":"toolu_01EF"}
```

```json
{"v":1,"t":1795689650000,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"subagent.stop","grade":"exact","src":"hook:SubagentStop","sub":"a-1c","type":"Explore","calls":14,"ms":41000}
```

`parentCall` is the Agent call that started it when the two can be matched (derived: the latest open Agent/Task/`spawn_agent`/`invoke_subagent` call in that session); absent otherwise.

```json
{"v":1,"t":1795689610000,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"wait.start","grade":"exact","src":"hook:PermissionRequest","why":"permission","tool":"Bash","hash":"9b07e1aa"}
```

```json
{"v":1,"t":1795689622000,"agent":"claude","session":"s-41f2","turn":"p-9","ws":"w1","ev":"wait.end","grade":"derived","src":"hook:PostToolUse","why":"permission","answer":"allowed"}
```

`why`: `permission`, `question` (AskUserQuestion, `request_user_input`, `ask_question`, an elicitation), `idle` (the turn ended and the agent waits for a prompt). `answer`: `allowed`, `refused`, `answered`, `unknown`.

## 12. From tool arguments to resource touches

Each rule reads only the fields named; all other input is dropped (section 13). Paths are made relative to the workspace root, separators turned to `/`.

| Agent | Tool | Touch |
|---|---|---|
| Claude Code | `Read` (`file_path`) | file read |
| Claude Code | `Write`, `Edit`, `MultiEdit` (`file_path`); `NotebookEdit` (`notebook_path`) | file write |
| Claude Code | `Grep` (`path`, default the cwd), `Glob` (`path`, default the cwd) | dir search |
| Claude Code | `WebFetch` (`url`) | url read |
| Claude Code | `WebSearch` (`query`) | search, no target |
| Claude Code | `ReadMcpResourceTool` (`server`, `uri`; unverified) | mcp-resource read: server and URI scheme only |
| Claude Code | `mcp__<server>__<tool>` | an MCP call; an argument named `path`, `file_path`, `url` or `uri` also gives a derived touch with `op: "unknown"` |
| Codex | `apply_patch` (patch text) | file write for each `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:` header; the patch body is dropped |
| Codex | `Bash` / `exec_command` | none (see below); with the app-server, `commandActions` read, list and search entries (board only, unverified) |
| Codex | `mcp__<server>__<tool>` | as Claude Code |
| Codex | exec `file_change` (board only) | file write per `changes[].path`, `kind` |
| Grok Build | `read_file`, `search_replace`, `grep`, `list_dir`, `web_fetch`, `web_search` | as the Claude Code tool each maps to; argument names to be captured live before use |
| Grok Build | `<server>__<tool>` | an MCP call |
| Antigravity | `view_file` (`AbsolutePath`) | file read |
| Antigravity | `write_to_file`, `replace_file_content`, `multi_replace_file_content` (`TargetFile`) | file write |
| Antigravity | `grep_search` (`SearchPath`), `find_by_name` (`SearchDirectory`), `list_dir` (`DirectoryPath`) | dir search |
| Antigravity | `read_url_content` (`Url`) | url read |
| Antigravity | `search_web` (`query`) | search, no target |
| Antigravity | `call_mcp_tool` (`ServerName`, `ToolName`) | an MCP call |
| ACP (board only) | any `tool_call` with `kind` read, edit, delete, move, search, fetch and `locations[].path` | that kind on each location |

What cannot be known:

- Files a shell command reads or writes (`Bash`, `PowerShell`, `exec_command`, `run_terminal_command`, `run_command`), and anything a build, test, git or package tool does. Parsing the command line would guess, and a script it runs is invisible. The view shows the call as `execute` with no resource, and may show the executable's name from a fixed allow-list (git, npm, node, python, …), as Entridir does.
- A file changed while a shell call was running can be seen by a VS Code file watcher, but it cannot be attributed to the agent: another agent, the editor or the user may have changed it. If shown, it is `derived` and marked "changed during" the call, never "written by" it.
- What an MCP tool does on its side (files, URLs, databases). Only the server and tool are known.
- Which files a Grep or Glob matched: that is in `tool_response`, which is not kept. Only the searched folder is.
- Codex's reads: it reads through the shell, so in hooks they are unavailable.
- Files named in a prompt (`@file` mentions) and context loaded by the agent itself (CLAUDE.md, AGENTS.md, skills, memory): no tool call. Claude Code's InstructionsLoaded hook may cover part; its fields were not read.
- Whether a Read touched the whole file or a range: kept as a read either way.

## 13. Privacy rule

Tool input can hold secrets: a command line with a token, a URL with a key, an MCP argument, file content in a Write. The monitor's hook keeps a fixed list of fields and drops the rest before anything is written or sent, as hook/hook.js does today for `tool_input`.

Kept:

- Event name, the agent, its time, session, turn, prompt and call ids, subagent id and type, `source`, `reason`, `notification_type`, `permission_mode`, the model name.
- Tool name; MCP server name and tool name; `mcp_server.source`; ACP `kind` and `status`.
- Success or failure, an error class (not text), exit code, duration, `is_interrupt`.
- Resource kind and op; a path relative to the workspace root, or the basename alone for a path outside it; for a URL, scheme, host and path only.
- Sizes and counts: prompt length, input and result bytes, a subagent's tool calls and tokens.
- An 8-hex hash of the tool input, for repeated calls.
- A shell call's executable name, only when it is on a fixed allow-list.

Never kept:

- `tool_input` values other than the path and URL fields of section 12; `tool_response` and `toolResult`; ACP `rawInput`, `rawOutput`, `content`, diffs.
- Command lines, search patterns and queries, web search queries, MCP arguments and results, MCP resource URIs beyond their scheme, elicitation content.
- Prompt text, assistant text (`prompt`, `last_assistant_message`, `lastUserInput`, `lastAssistantMessage`), error and notification message text. One exception, since the working mock-up's 0.1.7, by the owner's decision of 27 November: the thinking of the one agent the owner has selected, which is the model's own text and can repeat a prompt, a file or a command line, is read from its transcript by the extension host of the editor window that opened the monitor and shown on that monitor's page only, never sent to the hub or another window and never written ([05 section 8.6](05-working-mockup.md#86-thinking-for-the-selected-agent-since-017)).
- URL query strings, fragments and user info; HTTP headers; environment variables.
- Absolute paths, `transcript_path`, `agent_transcript_path`, `cwd`, home folders, user and machine names: the monitor keeps them in memory only, to route and locate, and writes the workspace key `ws` instead.

The existing events file keeps `prompt` and `last_assistant_message` in full and an 80-character slice of a command in `desc` (section 7). The monitor must not read those fields from it or copy them into its own stream.
