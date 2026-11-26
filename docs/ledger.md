# Call ledger

An index of every Claude Code API call on this machine: which prompt in which session it served, when, on which account, its token counts and the tools it called. It is for studying, after the fact, which prompts used their tokens well. Entomatical writes it (`src/ledger.ts`); this file is copied into the ledger folder as `README.md`, and the query tool beside it as `ledger.js`.

The ledger holds counts, ids and byte offsets only. The text stays in the CLI's own transcripts, where they already live; the offsets point into them. Nothing calls a model, so keeping the ledger costs no tokens.

## Where

`~/.entomatical/ledger/` (`ENTOMATICAL_LEDGER_DIR` overrides it), one per machine:

| File | What |
|---|---|
| `sessions.json` | Catalog: `{ <sessionId>: { account, file, cwd, entrypoint, version, first, last, prompts, calls, tokens: { input, cacheWrite, cacheRead, output } } }`. `file` is the session's transcript; `first`/`last` are its first and last call times. |
| `sessions/<sessionId>.jsonl` | The session's lines, below. |
| `state.json`, `owner.json` | How far each transcript has been read, and which VS Code window does the reading. Not for analysis. If `state.json` or `sessions.json` is missing the index is rebuilt from the transcripts on disk, and the old `sessions/` is kept as `sessions.before-<time>` (it may be the only record of calls whose transcripts the CLI has deleted; the newest two are kept). If `state.json` is damaged it is kept as `state.json.bad-<time>` and the index rebuilt the same way. If it is another version (a newer Entomatical), nothing is written until that Entomatical runs here. Either case shows one warning in the VS Code window that owns the ledger (a notification at the bottom right), once per window. |
| `README.md`, `ledger.js`, `efficiency.js` | This file, the query tool, and the efficiency summary it loads (the board's own `src/efficiency.ts`, so the card and the tool give the same numbers). |

Usage limits are logged separately, per account: `~/.entomatical/usage/<account>.readings.jsonl`, a line per reading with `at` (ms), `fiveHour`, `week` (whole percent), `fiveHourExact`, `weekExact` (unrounded, from panel sessions' stream), the reset times, `source` and the `sessionId` that saw it. The window running the ledger also asks each Claude account's CLI every 15 minutes, and Refresh does the same (`source: "query"`, no `sessionId`, no tokens used): the stream names the 5-hour limit only now and then. In a `query` reading, `fiveHour: null` means the reply lacked an unambiguous account-wide five-hour percentage. The timestamp records when Entomatical received the reply. Claude Code can return cached values without their original observation time. A `stream` reading names only what its event reported in `fiveHourExact` and `weekExact`; its `fiveHour`, `week` and reset times can be carried over from the account's last reading (`<account>.json`) when the event did not name that window, and `null` there means no earlier reading or one whose reset has passed. Put a change in a limit beside the calls made on that account at that time.

## Lines in `sessions/<sessionId>.jsonl`

Each line has `k`, its kind. `f` numbers the transcript files of the session; `offset` is the byte offset of the line in that file.

- **`k: "f"`, a transcript file:** `f`, `file` (absolute path), `agentId` (set for a subagent's file), `account`. A file that moved to another account folder gets a new `f` line with the same number.
- **`k: "p"`, a prompt:** `f`, `offset` (first transcript line of the turn), `n` (1, 2, … in the session), `promptId` (the CLI's id for the turn), `at` (ISO time).
- **`k: "c"`, an API call:** `f`, `offset` (the reply's first line), `at`, `promptId` (the turn it served; a subagent's calls carry the parent's prompt), `messageId`, `requestId`, `querySource` (`sdk` for the main loop; others name helpers and agents, when the CLI recorded one), `model`, `effort`, `stop` (`tool_use`, `end_turn`, …), `tools` (names of the tools the reply called), and the counters `input`, `cacheWrite` (`cacheWrite1h`, `cacheWrite5m` split it by cache lifetime), `cacheRead`, `output`, `thinking` (part of `output`), `webSearch`, `webFetch`.

Total tokens of a call, counting cache reads and writes once each: `input + cacheWrite + cacheRead + output`.

## Query tool

```
node ~/.entomatical/ledger/ledger.js sessions [--since 2026-10-31] [--cwd entomatical]
node ~/.entomatical/ledger/ledger.js prompts <session>      # per prompt: time, calls (subagents too), tokens, models, tools
node ~/.entomatical/ledger/ledger.js prompt <session> <n>   # prompt n's text, read from the transcript
node ~/.entomatical/ledger/ledger.js calls <session> [n]    # call lines as JSON
node ~/.entomatical/ledger/ledger.js summary <session>      # the efficiency summary and a per-prompt table
node ~/.entomatical/ledger/ledger.js compare --since 2026-11-01 [--cwd entomatical]   # sessions grouped by model
node ~/.entomatical/ledger/ledger.js compare --board <repo>/.entomatical              # Done cards by model: passed, tokens per passed task
```

`<session>` can be a unique prefix of the id.

### Efficiency summary

`summary` prints the numbers a card's Session details shows (F77), then one row per prompt (calls, mean context, output, whether it is in the tail, tools used):

- **prompts**, **calls** (a subagent's calls carry the parent's prompt and count with it), **calls per prompt**;
- **mean context per call**: `input + cacheRead + cacheWrite`, averaged over all calls; **context at end**: the same sum for the session's own last call;
- **output** tokens in total;
- **tail**, the correction tail: the share of all tokens (`input + cacheWrite + cacheRead + output`) spent on prompts that began after the task's first Stop, 0 with one prompt. The first Stop is read from the board's events file when the session ran in a task worktree (`<repo>/.entomatical/wt/<id>`, so `<repo>/.entomatical/events/<id>.jsonl`); otherwise the tail starts at the second prompt, and the line says so;
- **checks**: the latest acceptance-check run of that card (`<repo>/.entomatical/checks/<id>`), when it has one.

`compare --since <date>` groups the sessions whose last call is on or after the date by the model that made most of their calls, and prints per model: sessions, median calls per prompt, mean context per call (over all their calls) and median tail. Five sessions of one task class per model is the least to compare (see `docs/research/2026-11-02-paperclip-ideas-analysis.md`).

`compare --board <folder>` reads that board's `tasks.json` and each card's token measurement (`measurements/<id>.json`; a card without one, or with source `unknown`, is unmeasured) and prints the board's model comparison (F93, `modelEfficiency` in `src/efficiency.ts`), one line per provider and model: `passed/attempts passed`, tokens per passed task, the same without cache reads, median follow-ups, and "too few to compare" under five measured attempts. An attempt is a Done card (a found session that only closed is not one): **failed** when it was discarded or its checks errored, even if they passed; **passed** when its acceptance checks completed or its done review said done; **unverified** otherwise. Tokens per passed task are all the tokens of every measured attempt, failed and unverified ones included, divided by the passed cards, so a model that often fails costs more per result; "-" with no pass. `tools/prompt-outcomes.js` adds the same outcome counts and tokens per passed task to each prompt-source group.

Create and Battle write a provenance row for each allocated card. The row stores its card ID and the hash and length of the exact submitted prompt, including whitespace. Planning templates, completion rules and orchestrator briefs can change the prompt stored on the card. The report uses the recorded ID to look up checks, follow-ups and token measurements.

After a draft reloads, the host can recover an applied Improve run from its saved candidate and a new Refine run from its completed receipt. If the Improve receipt file has gone, the candidate still identifies the source and the receipt field is null. A reported helper without supporting evidence, including an older Refine run whose folder cannot be tied to the request, appears as `unknown`. The last helper determines the prompt's source. A submission with no reported helpers has source `raw`.

For older create rows without a card ID, the report compares the recorded hash against stored prompt prefixes of the recorded length. It reserves every recorded card ID first. An older receipt can claim a remaining card only when it matches exactly one card and no other historical receipt matches that card. Missing matches, competing receipts and duplicate explicit IDs leave the affected receipts without an outcome. The `--json` rows give the attribution method and preserve the recorded ID if the card has since left the board.

## Coverage and limits

- Every Claude Code session whose transcript is in `~/.claude/projects` or `~/.claude-accounts/*/projects`, whoever started it: the board, the VS Code panel, a terminal, another workspace, and their subagents. A transcript hard-linked or copied into several account folders (Switch account) is indexed once. Of hard links (one file under several names), the one in the folder of the account whose CLI ran the session (`<folder>/session-env/<session>`, CLI 2.1.310 and later) is used, then the one in the session's own project folder; of real copies, the longest. A session that really ran on two accounts (resumed after Switch account) has both marks; the folder whose `session-env/<session>` changed last wins, which is usually the account that ran it most recently.
- Not covered: Codex sessions; claude.ai and the desktop or phone apps; the other machine (Windows and Linux each keep their own ledger); transcripts the CLI has already deleted (by default after 30 days, `cleanupPeriodDays`).
- The transcript fields used (`promptId` on user lines, `requestRef` and `api-request` lines) are undocumented; seen in CLI 2.1.312. Older transcripts without them still give calls and counts, with no prompt id or `querySource`.
- A window reads new transcript bytes every 30 seconds. A call is written once it has its stop reason and eight more calls follow, or once the file has been quiet for 30 seconds, because a reply's final counts can come lines (sometimes many calls) after its first.
- A message id or prompt id is written once per session, even when the CLI writes its line again later or a shorter copy of the transcript is read from the start. A fork subagent's file starts with a copy of its parent's call (after a `fork-context-ref` line); that copy is not counted again. The CLI's own `<synthetic>` lines (such as "You've hit your session limit") are not API calls and are left out. Index files written before 4 November 2026 can still hold a call twice; `ledger.js` and the catalog count its last line only.
