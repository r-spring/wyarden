// Shared helpers for the compile-format comparison harness (eval/compile-format/README.md).
// Plain CommonJS; reuses the compiled extension modules in ../../out. No new dependencies.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const REPO = path.resolve(ROOT, "..", "..");
const OUT = path.join(ROOT, "out");
const CASES_DIR = path.join(ROOT, "cases");
const PROPERTIES = ["uncertain-permissions", "explicit-exclusions", "conditional-requirements", "awkward-identifiers", "quoted-instructions", "user-corrections"];
const CHECK_KINDS = ["file-contains", "file-not-contains", "file-exists", "file-absent", "file-unchanged", "manual"];

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const saveJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };

/** Compiled extension module; a clear message when `npx tsc -p .` has not run yet. */
function requireOut(name) {
  const file = path.join(REPO, "out", `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: run \`npx tsc -p .\` in ${REPO} first.`);
  return require(file);
}
function optionalOut(name) {
  try { return requireOut(name); } catch { return undefined; }
}

function loadManifest() { return readJson(path.join(ROOT, "manifest.json")); }

/** Cases in id order. Validation is validate.js's job; this only parses. */
function loadCases(dir = CASES_DIR) {
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => ({ file: path.join(dir, f), ...readJson(path.join(dir, f)) }));
}

/** sha256 over "<file name>\n<content>\n" for every case file in name order: any edit to any case changes it. */
function casesHash(dir = CASES_DIR) {
  const names = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  return sha256(names.map(n => `${n}\n${fs.readFileSync(path.join(dir, n), "utf8")}\n`).join(""));
}
const fileHash = (file) => sha256(fs.readFileSync(file));

/** The shortening condition "xml-short": information removal, not serialization. Rationale strings blanked, context facts removed. */
function shortRecord(record) {
  const copy = JSON.parse(JSON.stringify(record));
  for (const r of copy.requirements) r.rationale = "";
  copy.context.facts = [];
  return copy;
}

/** Every rendering for one record, keyed by condition name as in manifest.json. */
function renderAll(record) {
  const compile = requireOut("compile");
  return {
    xml: compile.renderXml(record),
    markdown: compile.renderMarkdown(record),
    json: compile.renderJson(record),
    "xml-short": compile.renderXml(shortRecord(record)),
  };
}

/** Same stripping as src/worker.ts environment(): providers own their authentication. */
function environment(configDir) {
  const env = { ...process.env };
  for (const key of ["CLAUDECODE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EFFORT_LEVEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) delete env[key];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/** Same binary choice as src/worker.ts call(). */
function claudeBinary() {
  const native = path.join(os.homedir(), ".local", "bin", "claude.exe");
  return process.platform === "win32" && fs.existsSync(native) ? native : "claude";
}

/** Argument list for one executor run, from the manifest's invocation template. The prompt goes on stdin. */
function claudeArgs(manifest, caseId, format, repeat) {
  const e = manifest.executor;
  return ["--print", "--model", e.model, "--effort", e.effort, "--output-format", "json", "--verbose", "--no-session-persistence",
    "--permission-mode", e.permissionMode, "--allowedTools", e.tools.join(","), "--tools", e.tools.join(","),
    "--strict-mcp-config", "--settings", JSON.stringify(e.settings),
    "--name", `Entomatical eval ${caseId} ${format} ${repeat}`];
}

const safeRelative = (p) => typeof p === "string" && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !/^[A-Za-z]:/.test(p);

/** Fresh starting state: the fixture files, then `git init` and one commit, so the executor sees a clean repo. */
function makeWorkdir(caseObj, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(caseObj.fixture.files)) {
    if (!safeRelative(rel)) throw new Error(`fixture path "${rel}" is not a safe relative path`);
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=entomatical-eval", "-c", "user.email=eval@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `fixture ${caseObj.id}`);
  return git("rev-parse", "HEAD").trim();
}

/** `git status --porcelain` of a working dir (empty string = nothing changed), or null if git fails. */
function gitStatus(dir) {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

/** Recursive file list (relative, forward slashes), skipping .git. */
function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel)); else out.push(rel);
  }
  return out.sort();
}

/** Copy a working dir (without .git) to the snapshot folder used for grading. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const rel of listFiles(from)) {
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, rel), target);
  }
}

const sum = (t) => t.input + t.cacheRead + t.cacheWrite + t.output;
/** The repo's token unit (src/metrics.ts): input + cacheRead + cacheWrite + output, from the CLI's own result record. */
function tokensFromUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const t = { input: n(usage.input_tokens), cacheRead: n(usage.cache_read_input_tokens), cacheWrite: n(usage.cache_creation_input_tokens), output: n(usage.output_tokens) };
  if (Object.values(t).some(v => v === undefined)) return undefined;
  return t;
}
function tokensFromModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const out = {};
  for (const [model, m] of Object.entries(modelUsage)) {
    const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const t = { input: n(m?.inputTokens), cacheRead: n(m?.cacheReadInputTokens), cacheWrite: n(m?.cacheCreationInputTokens), output: n(m?.outputTokens) };
    out[model] = Object.values(t).some(v => v === undefined) ? undefined : { ...t, total: sum(t) };
  }
  return out;
}

/**
 * Model identity, the same rule as parseClaudeResponse in src/worker.ts (which cannot be reused directly:
 * it requires a structured answer). Assistant events of the result's session must name exactly one model of the
 * requested family and it must appear in modelUsage; otherwise a sole modelUsage key of that family; otherwise unknown.
 * Delegation (subagents) is reported, not accepted. Never throws: the receipt records the outcome and the grader excludes.
 */
function observeModel(events, requestedFamily) {
  const raw = events.findLast(e => e?.type === "result");
  if (!raw) return { observedModel: null, method: "no-result", accepted: false, reason: "no result record" };
  const family = (model, name) => new RegExp(`^claude-(?:[0-9]+(?:-[0-9]+)*-)?${name}(?:-|$)`).test(String(model).toLowerCase());
  const models = Object.keys(raw.modelUsage || {});
  const assistants = events.filter(e => e?.type === "assistant" && !e.error);
  if (raw.subagent_stats?.spawned > 0 || assistants.some(e => e.parent_tool_use_id != null)) {
    return { observedModel: null, method: "delegated", accepted: false, reason: "the executor delegated work to a subagent" };
  }
  const main = assistants.filter(e => !raw.session_id || !e.session_id || e.session_id === raw.session_id);
  if (assistants.length && (main.length !== assistants.length || main.some(e => typeof e.message?.model !== "string" || !e.message.model))) {
    return { observedModel: null, method: "identity-missing", accepted: false, reason: "assistant identity missing or from another session" };
  }
  const observed = [...new Set(main.map(e => e.message?.model).filter(m => typeof m === "string"))];
  if (observed.length) {
    if (observed.length !== 1 || !family(observed[0], requestedFamily)) return { observedModel: observed.join(","), method: "assistant-model", accepted: false, reason: `answered with ${observed.join(", ")}, not ${requestedFamily}` };
    if (!models.includes(observed[0])) return { observedModel: observed[0], method: "assistant-model", accepted: false, reason: "answer model missing from modelUsage" };
    return { observedModel: observed[0], method: "assistant-model", accepted: true };
  }
  if (models.length === 1 && family(models[0], requestedFamily)) return { observedModel: models[0], method: "sole-usage-model", accepted: true };
  return { observedModel: null, method: "unknown", accepted: false, reason: "no assistant model and no sole usage model of the requested family" };
}

/** Facts the grader derives from the CLI's verbatim stream (see rubric.md "measures"). */
function streamFacts(events) {
  const raw = events.findLast(e => e?.type === "result");
  const toolErrors = [];
  const writes = {};
  for (const e of events) {
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    if (e?.type === "user") for (const c of content) if (c?.type === "tool_result" && c.is_error === true) toolErrors.push(c.tool_use_id ?? null);
    if (e?.type === "assistant") for (const c of content) if (c?.type === "tool_use" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name)) {
      const file = typeof c.input?.file_path === "string" ? c.input.file_path.replace(/\\/g, "/") : typeof c.input?.notebook_path === "string" ? c.input.notebook_path.replace(/\\/g, "/") : "(unknown)";
      writes[file] = (writes[file] || 0) + 1;
    }
  }
  const rewrites = Object.values(writes).reduce((n, c) => n + Math.max(0, c - 1), 0);
  const resultText = typeof raw?.result === "string" ? raw.result : "";
  // Repaired 4 November 2026 (review item 4.1, consensus item 38): only lines ENDING in "?" were counted, so a question asked mid-line
  // ("should I delete old-a.txt and old-b.txt? I did no...") was missed in 37 of 38 must-ask runs. questions now counts question
  // candidates: sentences ending in "?" anywhere, outside code and quotes. A candidate is not proof the required question was asked.
  const questions = questionCandidates(resultText).length;
  // repairs (tool errors plus extra writes) is no longer reported: the two are different things, and extra writes are activity.
  return { resultText, questions, questionsAtLineEnd: resultText.split(/\r?\n/).map(l => l.trim()).filter(l => l.endsWith("?")).length,
    toolErrors: toolErrors.length, rewrites, writes,
    usage: tokensFromUsage(raw?.usage), modelUsage: tokensFromModelUsage(raw?.modelUsage),
    totalTokens: tokensFromUsage(raw?.usage) ? sum(tokensFromUsage(raw.usage)) : null,
    elapsedMs: typeof raw?.duration_ms === "number" ? raw.duration_ms : null,
    numTurns: typeof raw?.num_turns === "number" ? raw.num_turns : null,
    resultSubtype: raw?.subtype ?? null, resultIsError: raw?.is_error === true };
}

/**
 * The Codex executor for the downstream comparison (4 November 2026, item 4.3): codex exec in the fixture repository, workspace-write
 * sandbox, no user config, rules, MCP apps or web search, the prompt on stdin, JSON events on stdout.
 */
function codexExecArgs(model, effort) {
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "workspace-write", "--model", model, "--json", "--color", "never",
    "--disable", "apps", "--disable", "plugins", "--disable", "multi_agent", "-c", 'web_search="disabled"', "-c", 'approval_policy="never"',
    "-c", "project_doc_max_bytes=0", "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-"];
}
/** The same facts streamFacts gives for Claude, from Codex exec's JSON lines: final answer, question candidates, failed commands,
 *  extra edits to one file, and usage. Lines that are not JSON are skipped. */
function codexFacts(stdout) {
  let resultText = "", usage = null, failed = false;
  const toolErrors = [], writes = {};
  for (const line of String(stdout).split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const item = e && e.item;
    if (e.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") resultText = item.text;
    if (e.type === "item.completed" && item?.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0) toolErrors.push(item.id ?? null);
    if (e.type === "item.completed" && item?.type === "file_change") for (const c of item.changes || []) { const f = String(c.path || "(unknown)").replace(/\\/g, "/"); writes[f] = (writes[f] || 0) + 1; }
    if (e.type === "turn.completed") usage = e.usage ?? null;
    if (e.type === "turn.failed") failed = true;
  }
  const n = (k) => (usage && typeof usage[k] === "number" ? usage[k] : 0);
  return { resultText, questions: questionCandidates(resultText).length, questionsAtLineEnd: resultText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.endsWith("?")).length,
    toolErrors: toolErrors.length, rewrites: Object.values(writes).reduce((a, c) => a + Math.max(0, c - 1), 0), writes, usage,
    totalTokens: usage ? n("input_tokens") + n("output_tokens") : null, elapsedMs: null, numTurns: null, resultSubtype: failed ? "turn.failed" : null, resultIsError: failed };
}

/** Sentences ending in "?" outside fenced or inline code and outside quotation marks: candidates for a question to the user. */
function questionCandidates(text) {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, " ");
  // A sentence may end in markup after its mark ("…exists?** I have not…"), so the split allows closing * _ ) ] ' after it.
  return prose.split(/(?<=[.!?][*_)\]']*)\s+|\r?\n/).map(s => s.trim().replace(/^[-*>#\s]+/, "").replace(/[*_)\]']+$/, "")).filter(s => s.endsWith("?") && /[A-Za-z]/.test(s));
}

module.exports = { ROOT, REPO, OUT, CASES_DIR, PROPERTIES, CHECK_KINDS, sha256, readJson, saveJson, requireOut, optionalOut, loadManifest, loadCases, questionCandidates, codexExecArgs, codexFacts,
  casesHash, fileHash, shortRecord, renderAll, environment, claudeBinary, claudeArgs, safeRelative, makeWorkdir, gitStatus, listFiles, copyTree,
  tokensFromUsage, tokensFromModelUsage, observeModel, streamFacts, sum };
