#!/usr/bin/env node
// Entomatical's board command for sessions (spec docs/agents/README.md, 4.1 to 4.3; F69 to F71).
// The extension places this file at ~/.entomatical/board.js, so briefs can name it on both machines; the source is tools/board.js.
// It reads the board's own files under <repo>/.entomatical and never a transcript. Node built-ins only: the placed copy has no
// node_modules. The repo is ENTOMATICAL_REPO (every task session has it), else the outermost folder above cwd with .entomatical/tasks.json.
//
//   node ~/.entomatical/board.js list [--mine] [--all] [--live]  status lines; --mine includes descendants, --live requires a current owner snapshot
//   node ~/.entomatical/board.js show <id|self> [--last 20]    status, identity, permissions, checks and recent events
//   node ~/.entomatical/board.js models|accounts|capabilities [--json]   valid labels and implemented runtime features
//   node ~/.entomatical/board.js wait [--mine | --ids a,b] [--timeout 600]   prints unseen settled states or changes since this card last waited; exit 2 on timeout
//   node ~/.entomatical/board.js watch [--mine]               streams one status line per change, never exits (for Claude Code's Monitor tool)
//   node ~/.entomatical/board.js events <id|self> [--from n]  raw event lines
//   node ~/.entomatical/board.js add --title T --prompt-file F [--parent <id>] [--account A] [--model M] [--effort E]
//                               [--runtime claude|codex|grok|antigravity] [--permission bypass] [--rule-file F.json | --autoRule] [--after a,b] [--start auto|manual] [--json] [--may-open|--orchestrator] [--role judge|scribe|research] [--judge] [--watch id,id]
//                               governed run: [--profile REF] --assignment-file F.json {key, outcome, owns?, acceptance?, evidence?, returns?} [--delegate-file F.json {allowed?, defaultChild?, depth?}]
//   node ~/.entomatical/board.js submit --head <commit> --summary-file F [--base <commit>] [--files a,b] [--check "<claimed check>"] [--covers A-01,A-02] [--limitations T] [--decision T]
//                               governed child: hand off a clean committed revision to the card that opened you
//   node ~/.entomatical/board.js integrate <child>            accept the clean revision of a child you opened into your own card branch; governed runs require the validated submission
//   node ~/.entomatical/board.js readiness [<id>|self]        governed run: what the board's readiness check says now (a child: integrate; the root: Finish), with reasons
//   node ~/.entomatical/board.js overview [<root>|self] [--since <seq>]   governed run: compact brief, project state and events after seq (expired: true = rebuild from the snapshot)
//   node ~/.entomatical/board.js council convene plan|milestone|final   governed root: the user's saved council reviews one fixed package read-only (members on exactly the saved accounts)
//   node ~/.entomatical/board.js council reconcile <checkpoint> --file F.json   governed root: [{finding: "<member>/<id>", disposition: confirmed|disproved|outside-scope|unresolved, evidence?, rationale?}]
//   node ~/.entomatical/board.js council retry <checkpoint> <member>  |  council show [<checkpoint>]   governed root: one more attempt for an invalid or late member; the full record
//   node ~/.entomatical/board.js capabilities --profile REF   governed run: the full pinned manifest of one profile you may delegate
//   Models: Claude opus, sonnet, haiku, fable each run the fixed full id in src/models.ts CLAUDE_MODEL_IDS, and a Claude full id runs as it is. For Codex sol, terra, luna, astra; Grok grok, build; and Antigravity's from models, a short name always runs the newest version of that model, and a full id of any version runs the newest too. `models` lists each name with the id it runs now (--effort: Codex efforts, or the agent's thought levels).
//   node ~/.entomatical/board.js send <id> --text-file F | --text T
//   node ~/.entomatical/board.js stop|resume|done|cancel|adopt <id>
//   node ~/.entomatical/board.js claim <id> --reason "<text>"   take control of a card whose holders have finished (owner done, cancelled or idle 30 min, the card not live)
//   node ~/.entomatical/board.js claim-tree <root> --reason "<text>"   claim every open card a finished or idle run left behind; live cards stay and are listed
//   node ~/.entomatical/board.js request-takeover <id> --reason "<text>"   ask the user (Approve or Deny) when claim is refused; a live owner may hand it over first
//   node ~/.entomatical/board.js handoff <id|self> --to <card> [--reason "<text>"]   give a card you control (self: every open card you opened) to another orchestrator
//   node ~/.entomatical/board.js rebind --session <current-session-id>   explicitly bind a detached controller (a session that is not the card's own waits for the user to Allow it on the board)
//   node ~/.entomatical/board.js receive                       consume messages for this card (also works in detached sessions)
//   node ~/.entomatical/board.js ready                         declare this orchestrator's delivery ready for final checks
//   node ~/.entomatical/board.js discard <id>                  unavailable to agents; ask the user to review and discard manually
//   node ~/.entomatical/board.js switch <id> --account A       move a stopped card to another signed-in account (Switch account), then resume it
//   node ~/.entomatical/board.js finish self                   when the whole run is delivered: the board reviews it after this turn; on Done it merges, pushes and cleans up
//   node ~/.entomatical/board.js finish <id>                   root of an approved run: close a card of your run or of the user's whose work is in the target already (worktree removed, Done; never merges or pushes)
//   node ~/.entomatical/board.js turn-done                     Grok or Antigravity card terminal: your turn ended; your card moves to Review (run it last, every turn)
//   node ~/.entomatical/board.js note "<text>"                 a notification for the user, with Open
//   node ~/.entomatical/board.js plan [--caps-file F.json] [--policy-file F.json]  root proposes one approval for the whole tree
//   node ~/.entomatical/board.js screen <id> [--lines 60]       what a descendant card's terminal shows (Card terminal, Grok, Antigravity)
//   node ~/.entomatical/board.js type <id> [--text T | --text-file F] [--key escape] [--key ctrl-c] [--enter] [--override]
//                               type into a descendant card's terminal: keys first, then text, then Enter. Refused if the user typed
//                               there since your last screen; read it, then decide (--override types over him anyway)
//   node ~/.entomatical/board.js reload-windows                reload every VS Code window running Entomatical (ends their sessions)
// Write verbs carry the current runtime session id; a different controller must explicitly rebind, and the user must allow a rebind from a session that is not the card's own.
// the user's own terminal (no ENTOMATICAL_TASK; F95, src/operator.ts): with ENTOMATICAL_OPERATOR_TOKEN, or --operator to read
// ~/.entomatical/operator-token, stop|resume|done|cancel|send|handoff|approve|deny act as the card's buttons do. The request carries an
// HMAC of the token, never the token. Kept out of the help text on purpose: it is not for agents.
// Write verbs drop a request in <repo>/.entomatical/inbox/<nonce>.json and wait up to 20 s for inbox/done/<nonce>.json (spec 4.1).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WAIT_POLL_MS = 2000;
const ID = /^[0-9a-f]{6}$/;
const PROTOCOL_VERSION = 3;
function capabilities(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, ".entomatical", "capabilities.json"), "utf8")); }
  catch { throw new Error("No capability snapshot. Open this repo with the updated Entomatical extension."); }
}
const freshCapabilities = (repo) => {
  const c = capabilities(repo);
  if (Date.now() - Date.parse(c.at) > 30000 || !Number.isFinite(Date.parse(c.at))) throw new Error("Board snapshot is stale; open the owning window to refresh live state.");
  return c;
};

function findRepo(cwd, env = process.env) {
  const has = (d) => fs.existsSync(path.join(d, ".entomatical", "tasks.json"));
  if (env.ENTOMATICAL_REPO && has(env.ENTOMATICAL_REPO)) return path.resolve(env.ENTOMATICAL_REPO);
  let found;
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (has(d)) found = d; // keep going: a worktree under <repo>/.entomatical/wt/<id> may carry a board of its own; the outermost is the repo's
    // The workspace's .entomatical/tmp (src/workspace.ts): a test board made there is never mistaken for the real one above it.
    if (path.dirname(d) === d || fs.existsSync(path.join(d, "ENTOMATICAL-TEMP-ROOT"))) return found;
  }
}
const readTasks = (repo) => { try { return JSON.parse(fs.readFileSync(path.join(repo, ".entomatical", "tasks.json"), "utf8")); } catch { return []; } };
// Opening a conversation URI carries the Codex thread across to the editor, but not the first app-server's task env.
// The owner rechecks an inferred card against the caller's thread before consuming its mail.
function receiveCardId(repo, env) {
  if (env.ENTOMATICAL_TASK !== undefined || !env.CODEX_THREAD_ID) return env.ENTOMATICAL_TASK ?? null;
  if (env.ENTOMATICAL_RUNTIME ? env.ENTOMATICAL_RUNTIME !== "codex" : env.CLAUDE_CODE_SESSION_ID) return null;
  const tasks = readTasks(repo);
  const matches = Array.isArray(tasks) ? tasks.filter((t) => t?.sessionId === env.CODEX_THREAD_ID) : [];
  if (matches.length > 1) throw new Error("Ambiguous editor thread on this board.");
  const [card] = matches;
  if (card?.provider !== "codex" || card.codexEditor !== true || typeof card.id !== "string" || !ID.test(card.id)) return null;
  if (tasks.some((t) => t !== card && t?.id === card.id)) throw new Error("Ambiguous card id on this board.");
  return card.status === "done" || card.cancelled ? null : card.id;
}
const statusFile = (repo) => path.join(repo, ".entomatical", "status.jsonl");
const eventsFile = (repo, id) => path.join(repo, ".entomatical", "events", `${id}.jsonl`);
const readEvents = (repo, id) => { try { return fs.readFileSync(eventsFile(repo, id), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };
/**
 * Every complete record of status.jsonl from byte `from`, with the byte offset after the last complete line (an append in progress
 * is read next time). Bytes, not characters: the lines hold "·" and "…", so a character slice drifted off the file (seen live on
 * 4 November 2026: a master's `wait` missed its child's settle). The file is truncated when a window takes the board over.
 */
function readStatus(repo, from = 0) {
  let fd;
  try { fd = fs.openSync(statusFile(repo), "r"); } catch { return { records: [], offset: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < from) from = 0;
    if (size === from) return { records: [], offset: from };
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString("utf8"), end = text.lastIndexOf("\n");
    const complete = end < 0 ? "" : text.slice(0, end + 1);
    const records = complete.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    return { records, offset: from + Buffer.byteLength(complete, "utf8") };
  } finally { fs.closeSync(fd); }
}
/** The latest record per card. */
const latest = (records) => { const m = new Map(); for (const r of records) if (r && typeof r.id === "string") m.set(r.id, r); return m; };
const ago = (ms, now = Date.now()) => { const m = Math.max(0, Math.round((now - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const label = (e) => { if (typeof e.desc === "string") return e.desc; const first = (s) => (typeof s === "string" ? s.trim().split("\n")[0].slice(0, 70) : "");
  switch (e.hook_event_name) { case "UserPromptSubmit": return `Prompt: ${first(e.prompt)}`; case "Stop": return `Stop: ${first(e.last_assistant_message)}`; case "StopFailure": return `StopFailure: ${e.error ?? "API error"}`;
    case "PermissionRequest": return `Permission: ${e.tool_name ?? ""}`; case "SessionStart": return `SessionStart${e.source ? ` (${e.source})` : ""}`; default: return String(e.hook_event_name ?? "event"); } };

function resolveId(arg, env) {
  const id = arg === "self" || arg === undefined ? env.ENTOMATICAL_TASK : arg;
  if (!id || !ID.test(id)) throw new Error(arg === "self" || arg === undefined ? "No ENTOMATICAL_TASK in this session's environment; give the card id." : `Not a card id: ${arg}`);
  return id;
}
const flag = (argv, name) => argv.includes(name);
const opt = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** Which cards a list, wait or watch covers: --mine (opened by this task), --ids a,b, or every card but this one (--all includes it). */
function filterFor(argv, env, tasks = []) {
  const ids = opt(argv, "--ids");
  if (ids) { const set = new Set(ids.split(",").map((s) => s.trim()).filter(Boolean)); return (r) => set.has(r.id); }
  if (flag(argv, "--mine")) {
    const me = env.ENTOMATICAL_TASK, descendants = new Set([me]);
    for (let grew = true; grew;) { grew = false; for (const t of tasks) if (descendants.has(t.openedBy) && !descendants.has(t.id)) { descendants.add(t.id); grew = true; } }
    return (r) => {
      if (descendants.has(r.openedBy)) descendants.add(r.id);
      return r.id !== me && (descendants.has(r.id) || r.watchedBy === me);
    };
  }
  const me = env.ENTOMATICAL_TASK;
  return (r) => flag(argv, "--all") || r.id !== me;
}

function showText(repo, id, now = Date.now(), lastCount = 5) {
  const tasks = readTasks(repo), task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No card ${id} on this board.`);
  let root = task;
  for (let depth = 0; root.openedBy && depth < 10; depth++) {
    const parent = tasks.find((t) => t.id === root.openedBy);
    if (!parent) break;
    root = parent;
  }
  const events = readEvents(repo, id);
  const record = latest(readStatus(repo).records).get(id);
  const stop = events.findLast((e) => e.hook_event_name === "Stop" && typeof e.last_assistant_message === "string");
  const reply = stop ? stop.last_assistant_message.trim().slice(0, 600) : undefined;
  const since = Date.parse(task.statusAt ?? task.updatedAt);
  const out = [];
  let snapshot = {}; try { snapshot = capabilities(repo); } catch { /* older owner: preserve ISO below */ }
  const zone = snapshot.hostTimezone;
  // This CLI is also placed as a standalone file. Interpret the same offset pairs as the webview.
  const time = (at) => {
    const date = new Date(at);
    const offset = snapshot.hostTimeOffsets?.findLast(([from]) => from <= date.getTime())?.[1];
    const timeZone = typeof offset === "number" ? "UTC" : zone;
    if (typeof offset === "number") date.setTime(date.getTime() + offset * 1000);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone });
  };
  out.push(`${task.id}  ${task.cancelled ? "cancelled" : task.status}  since ${time(since)} (${ago(since, now)})  "${task.title}"`);
  out.push(`time: ${new Date(since).toISOString()}${zone ? ` (${zone})` : " (owner timezone unavailable)"}`);
  out.push(`runtime: ${task.provider || "claude"}  session: ${task.sessionId || "not started"}  parent: ${task.openedBy || "none"}  root: ${task.orchestrator?.root || root.id}  permission: ${task.permission === "bypass" ? "Bypass permissions" : task.permission || "account default"}`);
  const assigned = task.takenOver ? (task.controller ? "external session" : "operator") : task.watchedBy || task.openedBy || "operator";
  out.push(`assigned controller: ${assigned}  grouping parent: ${task.parentId || "none"}`);
  out.push(`launch state: ${record?.launchState ?? "not recorded"}`);
  if (task.controller) out.push(`controller: ${task.controller.mode} ${task.controller.sessionId}, last request ${task.controller.at}`);
  // F95: who controls it now and how it got there; the full record is in .entomatical/transfers.jsonl (`events <id>` prints it).
  for (const r of (task.transfers ?? []).slice(-3)) out.push(`${r.op === "handoff" ? "handed" : "taken over"}: ${r.from ?? "none"} -> ${r.to} by ${r.by} (${r.via}${r.approvedBy ? `, approved by ${r.approvedBy}` : ""}) at ${r.at}${r.reason ? `: ${r.reason}` : ""}`);
  if (task.takeoverAsk) out.push(`takeover asked: by ${task.takeoverAsk.by} at ${task.takeoverAsk.at}: ${task.takeoverAsk.reason} (the user decides)`);
  if (task.runPolicy) out.push(`run policy: ${JSON.stringify(task.runPolicy)}`);
  if (task.stepHold) out.push(`hold: ${task.stepHold}`);
  if (task.startRetryAt) out.push(`start retry eligible: ${new Date(task.startRetryAt).toISOString()}`);
  if (task.launchError) out.push(`launch failed: ${task.launchError}`);
  if (record?.doing) out.push(`doing: ${record.doing}`);
  if (reply) out.push(`last reply: ${reply.split("\n").slice(0, 8).join("\n            ")}`);
  const commands = task.completion?.commands ?? [];
  if (commands.length) {
    const c = task.checks;
    let line = `checks: ${c?.status === "complete" ? "passed" : c?.status === "error" ? "failed" : c?.status === "running" ? "running" : "pending (not run yet)"} (${commands.join(" · ")})`;
    if (c?.status === "error" && c.run) {
      // The failing command's last lines, from the run folder the board keeps.
      try {
        const n = fs.readdirSync(c.run).filter((f) => /^check-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(c.run, f), "utf8"))).find((j) => j.exitCode !== 0);
        const i = n ? commands.indexOf(n.command) : -1;
        if (i >= 0) { const tail = fs.readFileSync(path.join(c.run, `check-${i}.log`), "utf8").trim().split("\n").slice(-6); line += `\n  ${n.command} (exit ${n.exitCode}):\n  ` + tail.join("\n  "); }
      } catch { /* no log */ }
      if (c.error) line += `\n  ${c.error}`;
    }
    out.push(line);
  } else out.push("checks: none");
  const chips = [];
  if (task.status === "needs-input") chips.push("needs input");
  if (task.interrupted && task.status === "review" && !task.cancelled) chips.push("interrupted");
  if (task.headless) chips.push("headless");
  if (task.takenOver) chips.push("taken over");
  const moved = task.transfers?.at(-1);
  if (moved && moved.to === task.openedBy) chips.push(`${moved.op === "handoff" ? "handed to" : "taken over by"} ${moved.to}`);
  if (task.takeoverAsk) chips.push(`takeover asked by ${task.takeoverAsk.by}`);
  if (task.deliveryReady) chips.push("delivery ready");
  if (task.cancelled) chips.push("cancelled");
  if (task.paused) chips.push(task.paused === "budget" ? "paused (budget reached)" : "paused");
  if (task.finishAsked && task.status !== "done") chips.push("asked to finish (the board reviews the run)");
  if (task.waitsForReset) chips.push(`waits for reset ${time(task.waitsForReset.at)}`);
  if (task.openedBy) chips.push(`opened by ${task.openedBy}`);
  if (task.orchestrator) chips.push(`orchestrator (${task.orchestrator.opened ?? 0} of ${task.orchestrator.caps?.total ?? "?"} opened)`);
  if (task.plan && !task.approved) chips.push("plan ready");
  if (task.approved) chips.push("plan approved");
  const bound = task.controller?.sessionId ?? task.orchestrator?.session;
  if (bound) chips.push(`rebound to ${bound.slice(0, 8)}`);
  const waiting = record?.chips?.find((x) => x.startsWith("notices waiting"));
  if (waiting) chips.push(waiting);
  out.push(`chips: ${chips.join(", ") || "none"}`);
  // Cost: prompts from the events, points the account moved during its runs, the context window's last reading.
  const prompts = events.filter((e) => e.hook_event_name === "UserPromptSubmit" && e.agent_id === undefined).length;
  const calls = events.filter((e) => e.hook_event_name === "PostToolUse" && e.agent_id === undefined).length;
  const isAcp = task.provider === "grok" || task.provider === "antigravity";
  const finished = (task.usageRuns ?? []).filter(r => r.endedAt);
  const movement = (key, minutes, label) => {
    const meter = u => u?.windows ? u.windows.find(w => w.minutes === minutes) : { pct: u?.[key], resets: u?.[key + "Resets"] };
    let points = 0;
    for (const run of finished) {
      const a = meter(run.start), b = meter(run.end);
      if (!Number.isFinite(a?.pct) || !Number.isFinite(b?.pct) || b.pct < a.pct ||
        (typeof a.resets === "number" && a.resets * 1000 <= run.end.at)) return `${label} unknown`;
      points += b.pct - a.pct;
    }
    return `+${Math.round(points * 10) / 10} pp ${label}`;
  };
  let context;
  if (!isAcp) try { context = JSON.parse(fs.readFileSync(path.join(repo, ".entomatical", "metrics", `${id}.context.json`), "utf8")); } catch { /* none */ }
  out.push(`cost: ${prompts} prompt${prompts === 1 ? "" : "s"} · ${calls} tool call${calls === 1 ? "" : "s"}` + (isAcp ? " · Provider usage unavailable" : finished.length ? ` · account moved ${movement("week", 10080, "weekly")}, ${movement("fiveHour", 300, "5-hour")}` : " · No ledger data yet")
    + (context && typeof context.usedPercent === "number" ? ` · context ${context.usedPercent}% at last reading` : ""));
  out.push(`branch: ${task.branch ?? "none"}  worktree: ${task.worktree ?? "none"}${task.account ? `  account: ${task.account}` : ""}${task.model ? `  model: ${task.model}` : ""}`);
  const last = events.filter((e) => e.agent_id === undefined).slice(-lastCount);
  if (last.length) out.push("events:", ...last.map((e) => `  ${time(e.t)} ${label(e)}`));
  return out.join("\n");
}

/** Lines for `list`: the latest status line per card from status.jsonl, else a plain line built from tasks.json (no owner yet). */
function listLines(repo, keep, all) {
  const tasks = readTasks(repo);
  const records = latest(readStatus(repo).records);
  const lines = [];
  for (const t of tasks) {
    if (!all && t.status === "done") continue;
    const r = records.get(t.id);
    const fake = { id: t.id, openedBy: t.openedBy ?? null, watchedBy: t.watchedBy ?? t.openedBy ?? null };
    if (!keep(r ?? fake)) continue;
    lines.push(r?.line ?? `${t.id}  ${t.status.padEnd(11)} ${ago(Date.parse(t.updatedAt)).padStart(8)}  "${t.title}"  (no status line yet: the board writes one once a window owns this repo)`);
  }
  return lines;
}

/** A card's waits share observed states, so completion between separate CLI calls cannot disappear into the next baseline. */
async function waitFor(repo, keep, timeoutMs, once, write, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), observationFile) {
  const initial = readStatus(repo);
  let { offset } = initial;
  const settled = (r) => ["review", "needs-input", "done"].includes(r.status);
  const stateKey = (r) => JSON.stringify([r.status, r.checks, r.chips?.filter((c) => /interrupted|input|cancelled|ready|taken over|handed to|takeover/.test(c)), settled(r) ? [r.last, r.since] : null, r.status === "needs-input" ? r.asks : null]);
  let observed = {};
  if (observationFile) try { observed = JSON.parse(fs.readFileSync(observationFile, "utf8")); } catch { /* first wait or damaged cursor: report settled cards again */ }
  const states = new Map(observationFile ? Object.entries(observed && typeof observed === "object" ? observed : {}) : [...latest(initial.records)].map(([id, r]) => [id, stateKey(r)]));
  let dirty = false;
  const changedSinceSeen = (records, first = false) => records.filter((r) => {
    if (!keep(r)) return false;
    const previous = states.get(r.id), key = stateKey(r);
    states.set(r.id, key);
    if (previous !== key) dirty = true;
    return !once || (previous !== key && (!first || previous !== undefined || settled(r)));
  });
  const saveObserved = () => {
    if (!observationFile || !dirty) return;
    fs.mkdirSync(path.dirname(observationFile), { recursive: true });
    const tmp = `${observationFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(states)));
    fs.renameSync(tmp, observationFile);
    dirty = false;
  };
  if (observationFile) {
    const unseen = changedSinceSeen([...latest(initial.records).values()], true);
    for (const r of unseen) write(`${r.line ?? JSON.stringify(r)}\n`);
    saveObserved();
    if (unseen.length && once) return 0;
  }
  let seenAt = offset;
  const dir = path.join(repo, ".entomatical");
  let poke = false;
  let watcher;
  try { watcher = fs.watch(dir, (_e, f) => { if (f === "status.jsonl") poke = true; }); watcher.on("error", () => {}); } catch { /* the poll still runs */ }
  const end = Date.now() + timeoutMs;
  try {
    for (;;) {
      const { records, offset: next } = readStatus(repo, offset);
      if (next < seenAt) { offset = 0; } // truncated by a new owner: its first lines are the whole board, not changes
      const changed = changedSinceSeen(records);
      offset = next; seenAt = next;
      if (changed.length) { for (const r of changed) write(`${r.line ?? JSON.stringify(r)}\n`); saveObserved(); if (once) return 0; }
      saveObserved();
      if (once && Date.now() >= end) return 2;
      poke = false;
      for (let waited = 0; waited < WAIT_POLL_MS && !poke; waited += 100) await sleep(100);
    }
  } finally { watcher?.close(); }
}

// ---- write verbs: the inbox (spec 4.1, 5.3) ----
function readArgText(argv, fileFlag, textFlag) {
  const file = opt(argv, fileFlag);
  if (file) return fs.readFileSync(file, "utf8");
  const text = textFlag && opt(argv, textFlag);
  return typeof text === "string" ? text : undefined;
}
/** The operator's signature (src/operator.ts operatorMac): HMAC-SHA256 of the nonce and the request without `mac`. */
const operatorMac = (token, nonce, req) => crypto.createHmac("sha256", token).update(`${nonce}\n${JSON.stringify(req)}`).digest("hex");
const OPERATOR_VERBS = ["stop", "resume", "done", "cancel", "send", "handoff", "approve", "deny"];
/** the user's own terminal (F95 item 5): the token, or undefined for a card's session. A card's session never signs as the operator. */
function operatorToken(argv, env, home) {
  if (env.ENTOMATICAL_TASK !== undefined || env.ENTOMATICAL_RUNTIME || env.ENTOMATICAL_SESSION || env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID) {
    if (flag(argv, "--operator")) throw new Error("--operator is for the user's own terminal.");
    return undefined;
  }
  if (env.ENTOMATICAL_OPERATOR_TOKEN) return env.ENTOMATICAL_OPERATOR_TOKEN.trim();
  if (!flag(argv, "--operator")) return undefined;
  try { return fs.readFileSync(path.join(home ?? require("os").homedir(), ".entomatical", "operator-token"), "utf8").trim(); }
  catch { throw new Error("No operator token at ~/.entomatical/operator-token. A window running this Entomatical version makes it."); }
}
/** Writes the request and waits for the owner window's answer. */
async function request(repo, body, env, timeoutMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), token) {
  const inbox = path.join(repo, ".entomatical", "inbox");
  fs.mkdirSync(path.join(inbox, "done"), { recursive: true });
  const nonce = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const session = env.ENTOMATICAL_RUNTIME === "claude" ? env.CLAUDE_CODE_SESSION_ID || env.ENTOMATICAL_SESSION
    : env.ENTOMATICAL_RUNTIME === "codex" ? env.CODEX_THREAD_ID || env.ENTOMATICAL_SESSION
    : ["grok", "antigravity"].includes(env.ENTOMATICAL_RUNTIME) ? env.ENTOMATICAL_SESSION
    : env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.ENTOMATICAL_SESSION;
  // Phase 3: a host that speaks protocol 3 gets it named, so a governed run can refuse older clients; an older host never sees the field.
  let hostProtocol = 0; try { hostProtocol = Number(JSON.parse(fs.readFileSync(path.join(repo, ".entomatical", "capabilities.json"), "utf8")).protocolVersion) || 0; } catch { /* none yet */ }
  let req = { v: 1, by: env.ENTOMATICAL_TASK ?? null, session: session || null, at: new Date().toISOString(), ...(hostProtocol >= 3 && !token ? { protocol: PROTOCOL_VERSION } : {}), ...body };
  if (token) { req = { v: 1, by: "operator", session: null, at: new Date().toISOString(), ...body }; req = { ...req, mac: operatorMac(token, nonce, req) }; }
  const file = path.join(inbox, `${nonce}.json`), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(req, null, 2)); fs.renameSync(tmp, file);
  const done = path.join(inbox, "done", `${nonce}.json`);
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(200)) {
    if (fs.existsSync(done)) { try { return JSON.parse(fs.readFileSync(done, "utf8")); } catch { /* mid-write */ } }
  }
  return { error: "No answer from the board in 20 s. Is a VS Code window open on this repo and owning the board?" };
}
async function writeVerb(argv, repo, env, timeoutMs, home) {
  const verb = argv[0];
  const token = operatorToken(argv, env, home);
  if (token && !OPERATOR_VERBS.includes(verb)) throw new Error(`From the user's terminal: ${OPERATOR_VERBS.join(", ")}. ${verb} needs a card's session (ENTOMATICAL_TASK).`);
  if (!token && (verb === "approve" || verb === "deny")) throw new Error(`${verb} answers a takeover request and is the user's: use Approve or Deny on the notification.`);
  const id = ["send", "stop", "resume", "done", "cancel", "adopt", "discard", "switch", "claim", "claim-tree", "request-takeover", "approve", "deny", "integrate", "readiness"].includes(verb) ? resolveId(argv[1], env) : undefined;
  let body;
  switch (verb) {
    case "claim": case "claim-tree": case "request-takeover": {
      const reason = opt(argv, "--reason");
      if (!reason || !reason.trim()) throw new Error(`${verb} needs --reason "<why>"; it goes in the audit record${verb === "request-takeover" ? " and to the user" : ""}.`);
      body = { op: verb, id, reason }; break;
    }
    case "handoff": {
      const to = opt(argv, "--to"), reason = opt(argv, "--reason");
      if (!to || !ID.test(to)) throw new Error("handoff needs --to <card id>.");
      if (token && argv[1] === "self") throw new Error("handoff self is a card's own; from the user's terminal name the card.");
      body = { op: "handoff", ...(argv[1] === "self" ? { self: true } : { id: resolveId(argv[1], env) }), to, ...(reason ? { reason } : {}) };
      break;
    }
    case "approve": case "deny": body = { op: verb, id }; break;
    case "add": {
      const prompt = readArgText(argv, "--prompt-file", "--prompt");
      const title = opt(argv, "--title");
      if (!title || !prompt) throw new Error("add needs --title and --prompt-file (or --prompt).");
      const rule = opt(argv, "--rule-file");
      body = { op: "add", title, prompt, parent: opt(argv, "--parent") ?? env.ENTOMATICAL_TASK ?? null, account: opt(argv, "--account") ?? null, model: opt(argv, "--model") ?? null, effort: opt(argv, "--effort") ?? null,
        completion: rule ? JSON.parse(fs.readFileSync(rule, "utf8")) : null, autoRule: flag(argv, "--autoRule") || flag(argv, "--auto-rule"), after: (opt(argv, "--after") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        start: opt(argv, "--start") ?? "auto", mayOpen: flag(argv, "--may-open") || flag(argv, "--orchestrator"),
        ...(opt(argv, "--role") ? { role: opt(argv, "--role") } : {}), ...(flag(argv, "--judge") ? { judge: true } : {}), ...(opt(argv, "--watch") ? { watch: opt(argv, "--watch").split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(opt(argv, "--runtime") ? { runtime: opt(argv, "--runtime") } : {}), ...(opt(argv, "--permission") ? { permission: opt(argv, "--permission") } : {}),
        ...(opt(argv, "--profile") ? { profile: opt(argv, "--profile") } : {}),
        ...(opt(argv, "--assignment-file") ? { assignment: JSON.parse(fs.readFileSync(opt(argv, "--assignment-file"), "utf8")) } : {}),
        ...(opt(argv, "--delegate-file") ? { delegate: JSON.parse(fs.readFileSync(opt(argv, "--delegate-file"), "utf8")) } : {}) };
      break;
    }
    case "submit": {
      const head = opt(argv, "--head"), summary = readArgText(argv, "--summary-file", "--summary");
      if (!head || !summary) throw new Error("submit needs --head <commit> and --summary-file F (or --summary T).");
      const csv = (k) => (opt(argv, k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const all = (k) => argv.flatMap((a, i) => a === k && argv[i + 1] ? [argv[i + 1]] : []);
      body = { op: "submit", head, summary, ...(opt(argv, "--base") ? { base: opt(argv, "--base") } : {}), ...(csv("--files").length ? { files: csv("--files") } : {}),
        ...(all("--check").length ? { claimedChecks: all("--check") } : {}), ...(csv("--covers").length ? { covers: csv("--covers") } : {}),
        ...(opt(argv, "--limitations") ? { limitations: opt(argv, "--limitations") } : {}), ...(all("--decision").length ? { decisions: all("--decision") } : {}) };
      break;
    }
    case "send": { const text = readArgText(argv.slice(2), "--text-file", "--text"); if (!text) throw new Error("send needs --text-file (or --text)."); body = { op: "send", id, text }; break; }
    case "stop": case "resume": case "done": case "cancel": case "adopt": case "discard": case "integrate": case "readiness": body = { op: verb, id }; break;
    case "screen": { const lines = opt(argv, "--lines"); body = { op: "screen", id: resolveId(argv[1], env), ...(lines ? { lines: Number(lines) } : {}) }; break; }
    case "type": {
      const text = readArgText(argv.slice(2), "--text-file", "--text");
      const keys = argv.flatMap((a, i) => a === "--key" && argv[i + 1] ? [argv[i + 1]] : []);
      body = { op: "type", id: resolveId(argv[1], env), ...(text ? { text } : {}), ...(keys.length ? { keys } : {}), ...(flag(argv, "--enter") ? { enter: true } : {}), ...(flag(argv, "--override") ? { override: true } : {}) };
      break;
    }
    case "switch": { const account = opt(argv, "--account"); if (!account) throw new Error("switch needs --account."); body = { op: "switch", id, account }; break; }
    case "finish":
      if (!argv[1] || argv[1].startsWith("--")) throw new Error("finish needs `self` (the board reviews and finishes your own card's run) or the id of a card whose work has landed.");
      body = argv[1] === "self" ? { op: "finish", self: true } : { op: "finish", id: resolveId(argv[1], env) };
      break;
    case "ready": body = { op: verb }; break;
    case "receive":
      body = { op: verb, by: receiveCardId(repo, env) };
      if (body.by && env.ENTOMATICAL_TASK === undefined) body.inferredEditor = true;
      break;
    case "council": {
      const action = argv[1], cp = argv[2];
      if (!["convene", "reconcile", "retry", "show"].includes(action)) throw new Error("council needs convene, reconcile, retry or show.");
      if (action !== "show" && !cp) throw new Error(`council ${action} needs a checkpoint (plan, milestone or final).`);
      if (action === "retry" && !argv[3]) throw new Error("council retry needs the member's key.");
      if (action === "reconcile" && !opt(argv, "--file")) throw new Error("council reconcile needs --file F.json (a list of dispositions).");
      body = { op: "council", action, ...(cp ? { checkpoint: cp } : {}), ...(action === "retry" ? { member: argv[3] } : {}), ...(action === "reconcile" ? { dispositions: JSON.parse(fs.readFileSync(opt(argv, "--file"), "utf8")) } : {}) };
      break;
    }
    case "turn-done": if (argv[1] !== undefined && argv[1] !== "self") throw new Error("turn-done takes no card: it reports your own card's turn."); body = { op: verb }; break;
    case "rebind": body = { op: verb, ...(opt(argv, "--session") ? { session: opt(argv, "--session") } : {}) }; break;
    case "note": { const text = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim(); if (!text) throw new Error("note needs a text."); body = { op: "note", text }; break; }
    case "plan": body = { op: "plan", ...(opt(argv, "--caps-file") ? { caps: JSON.parse(fs.readFileSync(opt(argv, "--caps-file"), "utf8")) } : {}), ...(opt(argv, "--policy-file") ? { policy: JSON.parse(fs.readFileSync(opt(argv, "--policy-file"), "utf8")) } : {}) }; break;
    default: throw new Error(`Unknown verb ${verb}.`);
  }
  // The host explicitly rejected a rate-limited request before acting, so it is safe to retry (up to 3 times, 1 to 1.5 s apart with
  // jitter, so parallel callers do not collide again). Never retry a timeout or a launch error, which may already have allocated a card.
  let result = await request(repo, body, env, timeoutMs, undefined, token);
  for (let n = 0; n < 3 && result.error === "Rate: at most one request per second"; n++) {
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 500));
    result = await request(repo, body, env, timeoutMs, undefined, token);
  }
  return result;
}

// ---- Phase 3: governed runs (src/orchestrator.ts governedRootOf, allowanceOf; the host writes .entomatical/governed/<root>.json) ----
/** The governed root of a card in tasks.json, as the host finds it: its own config, its marker, or up its opener and parent chain. */
function governedRoot(tasks, id) {
  const seen = new Set();
  for (let t = tasks.find((x) => x.id === id), i = 0; t && i < 25 && !seen.has(t.id); i++) {
    seen.add(t.id);
    if (t.governed) return t;
    if (t.governedBy) return tasks.find((x) => x.id === t.governedBy && x.governed);
    const up = t.openedBy ?? t.parentId;
    t = up ? tasks.find((x) => x.id === up) : undefined;
  }
  return undefined;
}
/** The caller's compact profile catalog: only what this card may delegate (the root's or its own narrowed allowance), with a summary each. */
function profileCatalog(repo, env) {
  const tasks = readTasks(repo), me = tasks.find((t) => t.id === env.ENTOMATICAL_TASK), root = me && governedRoot(tasks, me.id);
  if (!root) return {};
  const allowance = me.governed ? me.governed.delegation : me.delegation;
  const summary = (ref) => { const s = root.governed.profiles[ref]; return !s ? { ref, missing: true } : s.mode === "provider-defaults" ? { ref, name: "Provider defaults", providers: "all", items: "inherited" }
    : { ref, name: s.snapshot.name, description: s.snapshot.description, providers: Object.keys(s.snapshot.variants), items: Object.fromEntries(Object.entries(s.snapshot.variants).map(([p, v]) => [p, v.items.length])) }; };
  return { governed: { root: root.id, limits: root.governed.limits, ...(allowance ? { delegate: allowance.allowed.map(summary), defaultChild: allowance.defaultChild ?? null, depth: allowance.depth } : { delegate: [], note: "a worker opens no cards" }) } };
}
/** One pinned profile's full manifest, only when the caller may delegate it. */
function profileManifest(repo, env, ref) {
  const tasks = readTasks(repo), me = tasks.find((t) => t.id === env.ENTOMATICAL_TASK), root = me && governedRoot(tasks, me.id);
  if (!root) throw new Error("capabilities --profile: this card is not in a governed run.");
  const allowance = me.governed ? me.governed.delegation : me.delegation;
  const hit = allowance && allowance.allowed.find((a) => a === ref || a.split("@")[0] === ref);
  if (!hit) throw new Error(`capabilities --profile: ${ref} is not one you may delegate.`);
  return { ref: hit, profile: root.governed.profiles[hit] };
}
/** The governed run's brief and overview (host snapshot) and the material events after `--since`; a compacted cursor reads expired. */
function overview(repo, argv, io) {
  const tasks = readTasks(repo), arg = argv[1] && !argv[1].startsWith("--") ? argv[1] : "self";
  const id = arg === "self" ? io.env.ENTOMATICAL_TASK : arg;
  const root = id && governedRoot(tasks, id);
  if (!root) throw new Error(`overview: ${id || "this session"} is not in a governed run.`);
  let snap; try { snap = JSON.parse(fs.readFileSync(path.join(repo, ".entomatical", "governed", `${root.id}.json`), "utf8")); } catch { throw new Error("overview: no snapshot yet; open the owning window."); }
  let events = []; try { events = fs.readFileSync(path.join(repo, ".entomatical", "governed", `${root.id}.events.jsonl`), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { /* none yet */ }
  const sinceArg = opt(argv, "--since");
  if (sinceArg === undefined) { io.write(JSON.stringify({ ...snap, cursor: snap.overview.seq }, null, 2) + "\n"); return 0; }
  const since = Number(sinceArg);
  if (!Number.isInteger(since) || since < 0) throw new Error("--since must be a whole number (the cursor of your last overview)");
  const first = events.length ? events[0].seq : snap.overview.seq + 1;
  if (since < first - 1) { io.write(JSON.stringify({ expired: true, note: "events before your cursor were compacted; rebuild from this snapshot", ...snap, cursor: snap.overview.seq }, null, 2) + "\n"); return 0; }
  const delta = events.filter((e) => e.seq > since);
  io.write(JSON.stringify({ cursor: delta.length ? delta.at(-1).seq : since, events: delta, ...(delta.length ? { overview: snap.overview } : {}) }, null, 2) + "\n");
  return 0;
}

/** F84: every installed Entomatical window polls this file and reloads when the request is newer than its own start (src/reload-request.ts). */
function reloadWindows(io) {
  const file = path.join(io.home ?? require("os").homedir(), ".entomatical", "reload-request.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), by: io.env.ENTOMATICAL_TASK || "terminal" }) + "\n");
  io.write("Asked every Entomatical window to reload (each one does within about 2 s). Sessions in those windows end; resume them afterwards.\n");
  return 0;
}

async function main(argv, io = { cwd: process.cwd(), env: process.env, write: (s) => process.stdout.write(s) }) {
  const verb = argv[0];
  if (verb === "reload-windows") return reloadWindows(io);
  const read = ["list", "show", "wait", "watch", "events", "models", "accounts", "capabilities", "overview"], write = ["add", "send", "receive", "stop", "resume", "done", "cancel", "adopt", "rebind", "ready", "note", "plan", "discard", "switch", "finish", "screen", "type",
    "claim", "claim-tree", "request-takeover", "handoff", "turn-done", "submit", "integrate", "readiness", "council"];
  if (!verb || flag(argv, "--help") || !(read.includes(verb) || write.includes(verb) || OPERATOR_VERBS.includes(verb))) {
    io.write(fs.readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//   ")).map((l) => l.slice(5)).join("\n") + "\n");
    return !verb || flag(argv, "--help") ? 0 : 1;
  }
  const repo = findRepo(io.cwd, io.env);
  if (!repo) throw new Error("No Entomatical here: set ENTOMATICAL_REPO or run inside a repo with .entomatical/tasks.json.");
  const now = Date.now();
  switch (verb) {
    case "overview": return overview(repo, argv, io);
    case "models": case "accounts": case "capabilities": {
      const c = capabilities(repo), rows = c[verb];
      if (verb === "capabilities" && opt(argv, "--profile")) { io.write(JSON.stringify(profileManifest(repo, io.env, opt(argv, "--profile")), null, 2) + "\n"); return 0; }
      if (verb === "capabilities") { io.write(JSON.stringify({ ...c, cliProtocolVersion: PROTOCOL_VERSION, ...profileCatalog(repo, io.env) }, null, 2) + "\n"); return 0; }
      if (flag(argv, "--json")) io.write(JSON.stringify({ ...c, cliProtocolVersion: PROTOCOL_VERSION }, null, 2) + "\n");
      else io.write((rows || []).map((r) => `${r.runtime}  ${r.id || r.name}${r.newest ? ` → ${r.newest}` : ""}${r.aliases?.length ? `  aliases: ${r.aliases.join(", ")}` : ""}${r.lastSeen ? `  ${r.account}, last seen ${r.lastSeen}` : ""}`).join("\n") + "\n");
      return 0;
    }
    case "list": {
      const keep = filterFor(argv, io.env, readTasks(repo)), live = flag(argv, "--live") ? new Set(freshCapabilities(repo).live) : null;
      const lines = listLines(repo, (r) => keep(r) && (!live || live.has(r.id)), flag(argv, "--all")); io.write(lines.length ? lines.join("\n") + "\n" : "No cards.\n"); return 0;
    }
    case "show": {
      const n = Number(opt(argv, "--last") ?? 5); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("--last must be between 1 and 1000");
      io.write(showText(repo, resolveId(argv[1], io.env), now, n) + "\n"); return 0;
    }
    case "events": {
      const id = resolveId(argv[1], io.env), from = Number(opt(argv, "--from") ?? 0) || 0;
      let text = ""; try { text = fs.readFileSync(eventsFile(repo, id), "utf8"); } catch { /* none */ }
      // F95: the card's transfer records follow its hook events (their own file; status.jsonl is rewritten by a new owner window).
      let moves = ""; try { moves = fs.readFileSync(path.join(repo, ".entomatical", "transfers.jsonl"), "utf8"); } catch { /* none */ }
      const transfers = moves.split("\n").filter((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
      const lines = [...text.split("\n").filter(Boolean), ...transfers].slice(from);
      io.write(lines.length ? lines.join("\n") + "\n" : "No events.\n"); return 0;
    }
    case "wait": return waitFor(repo, filterFor(argv, io.env, readTasks(repo)), (Number(opt(argv, "--timeout") ?? 600) || 600) * 1000, true, io.write, undefined,
      ID.test(io.env.ENTOMATICAL_TASK || "") ? path.join(repo, ".entomatical", "wait", `${io.env.ENTOMATICAL_TASK}.json`) : undefined);
    case "watch": return waitFor(repo, filterFor(argv, io.env, readTasks(repo)), Infinity, false, io.write);
    default: {
      const result = await writeVerb(argv, repo, io.env, io.timeoutMs, io.home);
      if (verb === "add" && flag(argv, "--json")) { io.write(JSON.stringify(result) + "\n"); return result.error || result.launchError ? 1 : 0; }
      if (result.error) { io.write(`refused: ${result.error}\n`); return 1; }
      if (verb === "screen") { io.write(`${result.text ?? ""}\n-- ${result.live ? "live" : "ended"}, ${result.cols}x${result.rows}; the user last typed here: ${result.userInputAt ?? "never"}\n`); return 0; }
      if (verb === "receive") { io.write(JSON.stringify(result.messages || [], null, 2) + "\n"); return 0; }
      io.write(`${result.id ? result.id : "ok"}${result.note ? `  ${result.note}` : ""}\n`); return result.launchError ? 1 : 0;
    }
  }
}

module.exports = { findRepo, readStatus, latest, listLines, showText, waitFor, request, main };
if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
