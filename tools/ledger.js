#!/usr/bin/env node
// Query tool for Entomatical's call ledger (docs/ledger.md, also README.md beside this file in ~/.entomatical/ledger).
// Reads the index only; the prompt command reads the one transcript line the index points at. Never calls a model.
//   node ledger.js sessions [--since 2026-10-31] [--cwd text]   one line per session, newest last
//   node ledger.js prompts <session>                            per prompt: when, calls, tokens (subagents included), tools
//   node ledger.js prompt <session> <n>                         the text of prompt n, read from the transcript
//   node ledger.js calls <session> [n]                          the call lines, all or prompt n's, as JSON lines
//   node ledger.js summary <session>                            the efficiency summary (F77) and a per-prompt table
//   node ledger.js compare --since 2026-11-01 [--cwd text]      sessions grouped by model: median calls/prompt, mean context, tail
//   node ledger.js compare --board <repo>/.entomatical           Done cards grouped by model: passed/attempts, tokens per passed task
// <session> may be a unique prefix of the session id.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = process.env.ENTOMATICAL_LEDGER_DIR || (fs.existsSync(path.join(__dirname, "sessions.json")) ? __dirname : path.join(os.homedir(), ".entomatical", "ledger"));
// The efficiency summary is the board's own code (src/efficiency.ts): placed beside this file in the ledger folder, or built in the repo.
const efficiencyModule = () => {
  for (const p of [path.join(__dirname, "efficiency.js"), path.join(__dirname, "..", "out", "efficiency.js")]) if (fs.existsSync(p)) return require(p);
  fail("efficiency.js is missing beside ledger.js (Entomatical places it there; in the repo, run npm run build)");
};
const catalog = () => JSON.parse(fs.readFileSync(path.join(DIR, "sessions.json"), "utf8"));
const fail = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };

function session(prefix) {
  if (!prefix) fail("name a session id (or a unique prefix)");
  const ids = Object.keys(catalog()).filter((id) => id.startsWith(prefix));
  if (ids.length !== 1) fail(ids.length ? `ambiguous: ${ids.slice(0, 5).join(" ")}` : `no session ${prefix}`);
  let raw = "";
  try { raw = fs.readFileSync(path.join(DIR, "sessions", `${ids[0]}.jsonl`), "utf8"); } catch { /* no lines yet */ }
  const lines = raw.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); // a half-written line is skipped
  const files = {}, calls = new Map();
  for (const l of lines) if (l.k === "f") files[l.f] = l;
  // An index written before 4 November 2026 can hold a call twice: its last line counts, as in the catalog.
  for (const l of lines) if (l.k === "c") { calls.delete(l.messageId); calls.set(l.messageId, l); }
  return { id: ids[0], files, prompts: lines.filter((l) => l.k === "p"), calls: [...calls.values()] };
}
const sum = (calls, k) => calls.reduce((t, c) => t + (c[k] || 0), 0);
const count = (list) => Object.entries(list.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(" ");

/** The JSON line starting at `offset` in a transcript, and its length in bytes. */
function lineAt(file, offset) {
  const fd = fs.openSync(file, "r");
  try {
    const parts = [];
    for (let pos = offset, n; ; pos += n) {
      const buf = Buffer.alloc(1 << 20);
      n = fs.readSync(fd, buf, 0, buf.length, pos);
      const nl = buf.indexOf(10);
      if (!n || (nl >= 0 && nl < n)) { if (n) parts.push(buf.subarray(0, nl)); break; }
      parts.push(buf.subarray(0, n));
    }
    const raw = Buffer.concat(parts);
    return [JSON.parse(raw.toString("utf8")), raw.length];
  } finally {
    fs.closeSync(fd);
  }
}
const text = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n") : "");

const [cmd, a, b] = process.argv.slice(2);
const flag = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (cmd === "sessions") {
  const since = flag("--since"), cwd = flag("--cwd");
  const rows = Object.entries(catalog()).filter(([, s]) => (!since || (s.last || "") >= since) && (!cwd || (s.cwd || "").includes(cwd)));
  rows.sort((x, y) => (x[1].last || "").localeCompare(y[1].last || ""));
  for (const [id, s] of rows) {
    const t = s.tokens;
    console.log([id, s.first, s.last, s.account, s.entrypoint, s.cwd, `prompts ${s.prompts}`, `calls ${s.calls}`, `in ${t.input} cw ${t.cacheWrite} cr ${t.cacheRead} out ${t.output}`].join("\t"));
  }
} else if (cmd === "prompts") {
  const s = session(a);
  for (const p of s.prompts) {
    const calls = s.calls.filter((c) => c.promptId === p.promptId);
    const sub = calls.filter((c) => s.files[c.f] && s.files[c.f].agentId);
    console.log([`#${p.n}`, p.at, `calls ${calls.length} (subagents ${sub.length})`, `in ${sum(calls, "input")} cw ${sum(calls, "cacheWrite")} cr ${sum(calls, "cacheRead")} out ${sum(calls, "output")}`,
      count(calls.map((c) => c.model)), count(calls.flatMap((c) => c.tools || []))].join("\t"));
  }
} else if (cmd === "prompt") {
  const s = session(a);
  const p = s.prompts.find((x) => x.n === Number(b)) || fail(`no prompt ${b}`);
  // The prompt's first line can be a command caveat or an attachment; the typed text is the first user line with text.
  const file = s.files[p.f].file;
  if (!fs.existsSync(file)) fail(`the transcript is gone (the CLI deletes old ones): ${file}`);
  let offset = p.offset;
  for (let i = 0; i < 50; i++) {
    let e, bytes;
    try { [e, bytes] = lineAt(file, offset); } catch (err) { fail(`cannot read ${file} at byte ${offset}: ${err.message}`); }
    const t = e.type === "user" && e.promptId === p.promptId ? text(e.message && e.message.content) : "";
    if (t) { console.log(t); break; }
    offset += bytes + 1;
  }
} else if (cmd === "calls") {
  const s = session(a);
  const p = b === undefined ? undefined : s.prompts.find((x) => x.n === Number(b)) || fail(`no prompt ${b}`);
  for (const c of s.calls) if (!p || c.promptId === p.promptId) console.log(JSON.stringify(c));
} else if (cmd === "summary") {
  const { kilo } = efficiencyModule();
  const id = sessionId(a), entry = catalog()[id], e = summaryOf(id, entry);
  if (!e) { console.log(`${id}: no ledger data yet`); process.exit(0); }
  const checks = checkResult(entry && entry.cwd);
  console.log(`${id}\t${e.prompts} prompts · ${e.calls} calls · ${e.perPrompt}/prompt · ctx ${kilo(e.meanContext)} mean, ${kilo(e.endContext)} end · out ${kilo(e.output)} · tail ${Math.round(e.tail * 100)}%`
    + ` (after the first ${e.tailFrom === "stop" ? "Stop" : "prompt; no Stop event found"})${checks ? ` · checks ${checks}` : ""}`);
  console.log(["prompt", "calls", "mean ctx", "output", "tail", "tools"].join("\t"));
  for (const r of e.rows) console.log([`#${r.n}`, r.calls, kilo(r.meanContext), kilo(r.output), r.tail ? "yes" : "", Object.entries(r.tools).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join(" ")].join("\t"));
} else if (cmd === "compare" && process.argv.includes("--board")) {
  const { kilo, modelEfficiency } = efficiencyModule();
  const dir = flag("--board");
  if (!dir) fail("--board needs a folder, for example --board <repo>/.entomatical");
  const rows = modelEfficiency(boardCards(dir));
  if (!rows.length) { console.log("no Done cards on this board"); process.exit(0); }
  const k = (x) => (x === undefined ? "-" : kilo(x));
  console.log(["provider", "model", "passed", "tokens/passed", "without cache reads", "median follow-ups", "note"].join("\t"));
  for (const r of rows) console.log([r.provider, r.model, `${r.passed}/${r.attempts} passed`, k(r.perPassed), k(r.freshPerPassed),
    r.medianFollowUps ?? "-", r.fewCards ? "too few to compare" : ""].join("\t").trimEnd());
} else if (cmd === "compare") {
  const { kilo, median, mainModel } = efficiencyModule();
  const since = flag("--since"), cwd = flag("--cwd");
  if (!since) fail("compare needs --since <date>, for example --since 2026-11-01");
  const groups = new Map();
  for (const [id, entry] of Object.entries(catalog())) {
    if ((entry.last || "") < since || (cwd && !(entry.cwd || "").includes(cwd))) continue;
    const e = summaryOf(id, entry);
    if (!e) continue;
    const m = mainModel(e);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(e);
  }
  console.log(["model", "sessions", "median calls/prompt", "mean ctx", "median tail"].join("\t"));
  for (const [m, list] of [...groups].sort((x, y) => y[1].length - x[1].length)) {
    const calls = list.reduce((s, e) => s + e.calls, 0), ctx = list.reduce((s, e) => s + e.meanContext * e.calls, 0);
    console.log([m, list.length, median(list.map((e) => e.perPrompt)), kilo(calls ? ctx / calls : 0), `${Math.round(median(list.map((e) => e.tail)) * 100)}%`].join("\t"));
  }
} else {
  process.stdout.write(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
}

/** A board folder's cards (tasks.json: an array, or an older { tasks } object), each with its measurement from
 *  measurements/<id>.json attached; a missing or unreadable file leaves the card unmeasured. */
function boardCards(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "tasks.json"), "utf8"); } catch { fail(`no tasks.json in ${dir}`); }
  let tasks;
  try { tasks = JSON.parse(raw); } catch (err) { fail(`cannot read ${path.join(dir, "tasks.json")}: ${err.message}`); }
  tasks = Array.isArray(tasks) ? tasks : (tasks && tasks.tasks) || [];
  return tasks.filter((t) => t && typeof t === "object").map((t) => {
    let measurement;
    try { measurement = JSON.parse(fs.readFileSync(path.join(dir, "measurements", `${t.id}.json`), "utf8")); } catch { /* unmeasured */ }
    const ok = measurement && measurement.tokens && measurement.models && typeof measurement.models === "object";
    return { ...t, measurement: ok ? measurement : undefined };
  });
}
/** A session's id from a unique prefix. */
function sessionId(prefix) {
  if (!prefix) fail("name a session id (or a unique prefix)");
  const ids = Object.keys(catalog()).filter((id) => id.startsWith(prefix));
  if (ids.length !== 1) fail(ids.length ? `ambiguous: ${ids.slice(0, 5).join(" ")}` : `no session ${prefix}`);
  return ids[0];
}
/** A board task's folder from the session's cwd, `<repo>/.entomatical/wt/<id>`: its repo's .entomatical and the card id. */
function boardOf(cwd) {
  const m = typeof cwd === "string" && cwd.replace(/\\/g, "/").match(/^(.*)\/\.entomatical\/wt\/([0-9a-zA-Z-]+)\/?$/);
  return m ? { dir: path.join(m[1], ".entomatical"), id: m[2] } : undefined;
}
/** The efficiency summary of a session; the tail's boundary is the card's first Stop when its events file is found. */
function summaryOf(id, entry) {
  const { parseIndex, efficiency, firstStopAt } = efficiencyModule();
  let raw = "";
  try { raw = fs.readFileSync(path.join(DIR, "sessions", `${id}.jsonl`), "utf8"); } catch { return undefined; }
  let stop;
  const card = boardOf(entry && entry.cwd);
  if (card) {
    try {
      const events = fs.readFileSync(path.join(card.dir, "events", `${card.id}.jsonl`), "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
      stop = firstStopAt(events, id);
    } catch { /* no events file: the second prompt starts the tail */ }
  }
  return efficiency(parseIndex(raw), stop);
}
/** The latest acceptance-check result of the card the session ran for: passed, failed, running, or undefined when it has none. */
function checkResult(cwd) {
  const card = boardOf(cwd);
  if (!card) return undefined;
  const dir = path.join(card.dir, "checks", card.id);
  let runs = [];
  try { runs = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort((x, y) => Number(y) - Number(x)); } catch { return undefined; }
  for (const run of runs) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, run, "receipt.json"), "utf8"));
      return r.status === "running" ? "running" : r.status === "complete" && r.checksPassed === true ? "passed" : "failed";
    } catch { /* no receipt yet: an older run */ }
  }
  return undefined;
}
