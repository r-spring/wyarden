// Drives the real media/board.js in a browser over the Chrome DevTools Protocol using only Node built-ins
// (global fetch and WebSocket, Node 22+). Used by test/compile-webview.test.js (headless Microsoft Edge on the
// harness page) and, as `node test/compile-webview-cdp.js --edh`, against an isolated VS Code Extension
// Development Host. Compilation results are always injected; no model is ever called.
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
// Edge on Windows; on Linux (linux) Chrome or Chromium, which speak the same DevTools protocol.
function edgePath() {
  const candidates = process.platform !== "win32" ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : [
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
function codePath() {
  const exe = path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe");
  return fs.existsSync(exe) ? exe : undefined;
}
/** Environment for a child that must not inherit this session's Claude context (HANDOFF.md section 6), nor the
 * extension host's own Electron/VS Code variables (ELECTRON_RUN_AS_NODE=1 would turn Code.exe into a bare node). */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|ELECTRON_|VSCODE_)/i.test(k)) env[k] = v;
  return env;
}
/** Environment for a test browser. Off Windows, Chrome makes its SingletonSocket in a new folder under TMPDIR and aborts
 * ("Socket path too long") when that path passes 107 characters; a card's run folder reached 108 on 18 November 2026, after the
 * rename to Entomatical. So the browser gets the run's temp root (GIT_CEILING_DIRECTORIES from test/run.js), one folder shorter.
 * shortcut: a workspace path about 8 characters longer fails again; upgrade: a short symlink to the run folder as TMPDIR. */
function browserEnv() {
  const env = cleanEnv();
  if (process.platform !== "win32" && process.env.GIT_CEILING_DIRECTORIES) env.TMPDIR = process.env.GIT_CEILING_DIRECTORIES;
  return env;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 30_000, interval = 250) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  return r.json();
}

// Every call here ends. A page whose renderer has died never answers a command, and a test waiting on one never reached its
// `finally`: node's test timeout failed the test but the open socket and the browser kept the file's process alive, so a whole
// `npm test` stood still (13 November 2026: one stood for 12 hours on test/card-terminal-webview.test.js). So a command is
// refused when the page crashes or the socket closes, and after `timeout` ms without an answer.
class Cdp {
  static async connect(url, timeout = 10_000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch { /* never opened */ } reject(new Error(`no connection to ${url} in ${timeout} ms`)); }, timeout);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot connect to ${url}`)); };
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.next = 1; this.pending = new Map(); this.events = []; this.dead = undefined;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer);
        if (m.error) reject(new Error(`${m.error.message}${m.error.data ? `: ${m.error.data}` : ""}`)); else resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
        if (m.method === "Inspector.targetCrashed") this.fail("the page crashed");
      }
    };
    ws.onclose = () => this.fail("the connection to the browser closed");
    ws.onerror = () => this.fail("the connection to the browser failed");
  }
  /** Refuses every waiting command, and every later one, with `why`. */
  fail(why) {
    this.dead ||= why;
    for (const { reject, timer, method } of this.pending.values()) { clearTimeout(timer); reject(new Error(`${method}: ${this.dead}`)); }
    this.pending.clear();
  }
  send(method, params = {}, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error(`${method}: ${this.dead}`));
      const id = this.next++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no answer in ${timeout} ms`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  /** Evaluates in the page's main context, or in `contextId` (an execution context of one of its frames). */
  async evaluate(expression, contextId) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { this.ws.close(); }
}

/** Starts headless Edge on `url`; returns { port, kill }. */
async function launchEdge(url, scratch) {
  const exe = edgePath();
  if (!exe) throw new Error("Microsoft Edge (msedge.exe), Chrome or Chromium was not found.");
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(scratch, "edge-profile-"));
  const args = [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--window-size=900,1400", url];
  const child = spawn(exe, args, { env: browserEnv(), stdio: "ignore", windowsHide: true });
  // The processes that hold the profile: on Windows the msedge.exe started here often exits at once and leaves its browser and helper
  // processes outside its tree (probe of 5 November 2026: exit code 0 within 12 ms, 15 processes still naming the profile), so waiting
  // for it, or a fixed 500 ms, let a full npm test hit EPERM (30 Oct, 4 and 5 Nov 2026). Wait until no process names the profile.
  const holders = () => {
    if (process.platform !== "win32") return child.exitCode === null ? [child.pid] : [];
    try {
      const all = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true }));
      return all.filter((p) => String(p.CommandLine || "").includes(profile)).map((p) => p.ProcessId);
    } catch { return []; }
  };
  const gone = async (ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (!holders().length) return true; return false; };
  const kill = async () => {
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json(); const b = await Cdp.connect(v.webSocketDebuggerUrl); await b.send("Browser.close"); b.close(); } catch { /* already gone */ }
    if (!(await gone(10_000))) {
      for (const pid of process.platform === "win32" ? holders() : [child.pid]) try { process.platform === "win32" ? execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }) : process.kill(pid, "SIGKILL"); } catch { /* exited */ }
      await gone(5000);
    }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* still locked; the caller's removal reports it */ }
  };
  await waitFor(() => listTargets(port), "the Edge DevTools endpoint", 20_000);
  return { port, child, kill, exe, args };
}

// Page-side helpers. Everything the scenarios read or click goes through window.__h so the Edge harness and the
// Extension Development Host are driven identically. `vscode` is board.js's top-level binding for the webview API.
const HELPERS = `window.__h = {
  btn: (t) => [...document.querySelectorAll(".refinement button")].find((b) => b.textContent === t),
  click(t) { const b = this.btn(t); if (!b) throw new Error("No button: " + t); if (b.disabled) throw new Error("Disabled button: " + t); b.click(); return true; },
  box: () => document.querySelector('textarea[data-draft-target="new"]'),
  setBox(v) { const b = this.box(); b.value = v; b.dispatchEvent(new Event("input", { bubbles: true })); return b.value; },
  value() { return this.box().value; },
  select(label, value) { const s = document.querySelector('select[aria-label="' + label + '"]'); s.value = value; s.dispatchEvent(new Event("change")); return s.value; },
  account: () => document.querySelector('select[aria-label="Account for new task"]').value,
  buttons: () => [...document.querySelectorAll(".refinement button")].map((b) => b.textContent + (b.disabled ? " (disabled)" : "")),
  alerts: () => [...document.querySelectorAll('.refinement [role="alert"]')].map((e) => e.textContent),
  statuses: () => [...document.querySelectorAll('.refinement [role="status"]')].map((e) => e.textContent),
  area: (label) => { const a = document.querySelector('textarea[aria-label="' + label + '"]'); return a ? { value: a.value, readOnly: a.readOnly } : null; },
  muted: () => [...document.querySelectorAll(".compilation .muted")].map((e) => e.textContent),
  conflicts: () => [...document.querySelectorAll(".compilation .conflicts li")].map((e) => e.textContent),
  posted: () => window.__posted,
  lastCompile: () => window.__posted.filter((m) => m.type === "compile").at(-1),
  inject(compilation) { window.dispatchEvent(new MessageEvent("message", { data: { compilation } })); return true; },
  state: () => vscode.getState(),
  snapshot() { const s = vscode.getState() || {}; return { value: this.value(), keys: Object.keys(s).length, hasCompilations: "compilations" in s, compilations: s.compilations || [],
    buttons: this.buttons(), alerts: this.alerts(), statuses: this.statuses(), compiled: this.area("Improved prompt"), original: this.area("Original draft"), muted: this.muted(), conflicts: this.conflicts() }; }
}; true`;

const D = "Add CSV export for the filtered table.";
const D2 = `${D} Only rows matching the active filters.`;
const X = "<task>\n  <goal>Add CSV export for the filtered table.</goal>\n\n  <requirements>\n    R1: Export only rows matching the active filters.\n  </requirements>\n</task>";
const PROMPT_VERSION = "compile-2026-11-03-c1";
const baseRecord = { version: 1, outcome: { goal: D, deliverable: "", beneficiary: "" }, context: { facts: [], identifiers: [], sources: [], dependencies: [] },
  success: { criteria: [] }, requirements: [{ id: "R1", text: "Export only rows matching the active filters.", provenance: "user", strength: "mandatory", rationale: "" }],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [] };
const CONFLICT = { earlier: "Keep the existing CSV column order.", later: "Reorder the columns alphabetically.", why: "Both govern column order and neither was withdrawn." };
const readyResult = (requestId, original) => ({ requestId, target: "new", original, status: "ready", record: { ...baseRecord, status: "ready", conflicts: [] },
  rendered: { format: "xml", text: X }, conflicts: [], dropped: ["Nice-to-have: a progress toast"], model: "claude-opus-5-5", effort: "high", promptVersion: PROMPT_VERSION });
const unfinishedResult = (requestId, original) => ({ requestId, target: "new", original, status: "unfinished", record: { ...baseRecord, status: "unfinished", conflicts: [CONFLICT] },
  conflicts: [CONFLICT], dropped: [], model: "claude-opus-5-5", effort: "high", promptVersion: PROMPT_VERSION });

async function runDraftContextScenarios({ evaluate, reload, parent, accounts, profile }) {
  const host = (data) => evaluate(`window.__host(${JSON.stringify(data)}); true`);
  const snapshot = { tasks: [parent], live: [], own: [], accounts, activeAccount: accounts[0], profiles: { entries: [profile], errors: [] } };
  const accountLabel = "Account for new task", profileLabel = "Capability profile for new task";
  const select = (label, value) => evaluate(`window.__h.select(${JSON.stringify(label)}, ${JSON.stringify(value)})`);
  const shortcut = () => evaluate(`window.__h.box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))`);
  const add = () => evaluate("taskButton.click(); true");
  const messages = () => evaluate("window.__posted.filter((m) => m.type !== 'ready')");
  const shown = () => evaluate(`({ prompt: window.__h.value(), parent: subtaskOf.textContent, account: accountBox.value,
    profile: profileBox.value, profileNote: profileNote.textContent, addDisabled: taskButton.disabled,
    alert: [...taskForm.querySelectorAll('[role=alert]')].filter((e) => e.getClientRects().length).map((e) => e.textContent).join(' ') })`);
  const restore = async (saved) => { await evaluate(`vscode.setState(${JSON.stringify(saved)}); true`); await reload(); };

  await reload();
  await host(snapshot);
  await evaluate(`window.__h.setBox(${JSON.stringify(D)})`);
  assert.equal(await select(accountLabel, accounts[1]), accounts[1]);
  assert.equal(await select(profileLabel, profile.ref), profile.ref);
  await host({ cardAction: { type: "subtask", id: parent.id } });
  const saved = await evaluate("vscode.getState()");
  assert.equal(saved.parentId, parent.id, "choosing the parent persists it even without a text edit");
  await reload();
  assert.equal((await shown()).prompt, D);
  await add(); await shortcut();
  assert.deepEqual(await messages(), [], "no Create can be sent before the host snapshot arrives");
  await host(snapshot);
  const view = await shown();
  assert.deepEqual([view.prompt, view.account, view.profile, view.addDisabled], [D, accounts[1], profile.ref, false]);
  assert.ok(view.parent.includes(parent.title), `restored parent: ${view.parent}`);
  assert.match(view.profileNote, /Blocked: .* r1/);
  await host({ ...snapshot, activeAccount: accounts[1] });
  await host(snapshot);
  assert.equal((await shown()).account, accounts[1], "a default-account change must preserve the saved selection");
  assert.deepEqual(await messages(), [], "snapshot restoration has no side effects");
  await add();
  const positive = await messages();
  assert.equal(positive.length, 1);
  const create = positive[0];
  assert.deepEqual([create.type, create.prompt, create.parentId, create.account, create.profile], ["create", D, parent.id, accounts[1], profile.ref]);
  assert.equal(create.profileRevision, profile.revision);
  assert.equal(typeof create.createId, "string");

  const setBox = (value) => evaluate(`window.__h.setBox(${JSON.stringify(value)})`);
  const pendingIds = () => evaluate("(vscode.getState().pendingCreates || []).map(([id]) => id)");
  const refusal = { failed: create, createContextIssue: "profile" };
  await setBox(D2);
  await reload();
  await host(snapshot);
  assert.equal((await shown()).prompt, D2);
  assert.deepEqual(await pendingIds(), [create.createId], "the pending Create survives recreation alongside the new draft");
  assert.deepEqual(await evaluate("vscode.getState().pendingCreates[0][1].message"), create, "stored submission keeps the original text and selections");
  await evaluate("promptBox.focus(); promptBox.setSelectionRange(3, 9); true");
  await host(refusal);
  assert.deepEqual(await pendingIds(), [], "a matching refusal consumes the pending entry");
  assert.deepEqual(await evaluate("[promptBox.value, document.activeElement === promptBox, promptBox.selectionStart, promptBox.selectionEnd]"), [D2, true, 3, 9]);
  assert.equal(await evaluate("refusedCreateBox.querySelector('button').disabled"), true);
  await reload();
  await host(snapshot);
  assert.equal((await shown()).prompt, D2, "the newer draft survives a reload while the refused submission is held separately");
  await setBox("");
  await evaluate("refusedCreateBox.querySelector('button').click(); true");
  const recovered = await shown();
  assert.deepEqual([recovered.prompt, recovered.account, recovered.addDisabled], [D, accounts[1], true]);
  assert.ok(recovered.parent.includes(parent.title));
  assert.match(recovered.alert, /choose a capability profile/i);
  await shortcut();
  assert.deepEqual(await messages(), []);
  await select(profileLabel, profile.ref);
  await add();
  const [retry] = await messages();
  assert.notEqual(retry.createId, create.createId);
  assert.equal(retry.profileRevision, profile.revision);
  await reload();
  assert.equal((await shown()).prompt, "", "a pending Create must not refill the prompt or send again on reload");
  assert.deepEqual(await messages(), []);
  // An acknowledgement can arrive before the first snapshot in the recreated view.
  await host({ failed: retry, createContextIssue: "parent" });
  await host(snapshot);
  assert.equal((await shown()).prompt, D, "a refusal restores in place if the form still belongs to that submission");
  assert.match((await shown()).alert, /choose a parent/i);

  for (const [change, prompt, reselect, expected] of [
    [{ profiles: undefined }, /choose a capability profile/i, () => select(profileLabel, "provider-defaults"), [parent.id, accounts[1], "provider-defaults"]],
    [{ profiles: { entries: [{ ...profile, revision: 2 }], errors: [] } }, /choose a capability profile/i, () => select(profileLabel, profile.ref), [parent.id, accounts[1], profile.ref]],
    [{ accounts: [accounts[0]] }, /choose an account/i, () => select(accountLabel, accounts[0]), [parent.id, accounts[0], profile.ref]],
    [{ tasks: [] }, /choose a parent/i, () => evaluate("[...subtaskOf.querySelectorAll('button')].find((b) => b.textContent === 'Use no parent').click(); true"), ["", accounts[1], profile.ref]],
  ]) {
    await restore(saved);
    await host({ ...snapshot, ...change });
    const blocked = await shown();
    assert.equal(blocked.prompt, D);
    assert.equal(blocked.addDisabled, true);
    assert.match(blocked.alert, prompt);
    await add(); await shortcut();
    assert.deepEqual(await messages(), [], "unresolved draft choices never send Create");
    if ("tasks" in change) {
      await reload();
      await host(snapshot);
      assert.equal((await shown()).addDisabled, true, "an unresolved choice still requires confirmation after reload");
    }
    await reselect();
    assert.equal((await shown()).addDisabled, false);
    await shortcut();
    const [sent, ...extra] = await messages();
    assert.equal(extra.length, 0);
    assert.deepEqual([sent.type, sent.prompt, sent.parentId, sent.account, sent.profile], ["create", D, ...expected]);
  }

  await restore({ prompt: D, model: "opus", effort: "high" });
  await host(snapshot);
  assert.equal((await shown()).addDisabled, false);
  assert.deepEqual(await messages(), []);
  await add();
  const [legacy, ...extra] = await messages();
  assert.equal(extra.length, 0);
  assert.deepEqual([legacy.type, legacy.prompt, legacy.parentId, legacy.account, legacy.profile, legacy.model, legacy.effort],
    ["create", D, "", accounts[0], "provider-defaults", "opus", "high"]);
  assert.equal(legacy.profileRevision, undefined);
  await setBox(D2);
  await add();
  const [, later] = await messages();
  await reload();
  await host({ created: later.createId });
  assert.deepEqual(await pendingIds(), [legacy.createId], "success removes only its matching pending Create");
  await reload();
  await host(snapshot);
  await host({ failed: later });
  assert.equal((await shown()).prompt, "", "a late duplicate refusal cannot reopen an acknowledged Create");
  await host({ failed: legacy });
  assert.equal((await shown()).prompt, "", "the older refusal must not take over the latest submission's composer");
  assert.deepEqual(await pendingIds(), []);
  await evaluate("refusedCreateBox.querySelector('button').click(); true");
  assert.equal((await shown()).prompt, D, "the older refusal remains recoverable after the later success");
  await add();
  const [final] = await messages();
  await reload();
  await host({ created: final.createId });
  assert.deepEqual(await pendingIds(), []);
  assert.equal(await evaluate("vscode.getState().latestCreate === undefined"), true, "the final success removes the saved submission marker");
  await reload();
  await host(snapshot);
  await host({ failed: final });
  assert.equal((await shown()).prompt, "", "the final success still owns the acknowledgement after recreation");
  assert.equal(await evaluate("refusedCreateBox.hidden"), true);
  return { create, legacy };
}

/**
 * The eight step-6 scenarios. `evaluate(expression)` runs in the webview context; `log(entry)` receives one
 * observation per action; `screenshot(name)` is optional; `reload()` (optional) reloads the page and re-installs
 * the helpers, used to show a pending compile becomes "interrupted".
 */
async function runScenarios({ evaluate, log = () => {}, screenshot, reload, requestCompile }) {
  await evaluate(HELPERS);
  const h = (expr) => evaluate(`window.__h.${expr}`);
  const observe = async (step, action) => { const s = await h("snapshot()"); log({ step, action, ...s }); return s; };
  const entry = (s) => { const e = s.compilations.find(([t]) => t === "new"); return e && e[1]; };
  const inject = (c) => evaluate(`window.__h.inject(${JSON.stringify(c)})`);
  // `requestCompile` (EDH) creates the pending state through board.js's own globals without posting to the host;
  // otherwise the real button is clicked and the posted request is read back from the harness recorder.
  const compile = async () => { const req = requestCompile ? await requestCompile() : (await h("click('Improve prompt')"), await h("lastCompile()")); assert.ok(req, "a compile request was posted"); return req; };
  const compiled = requestCompile ? "created the pending compile through board.js globals (no click, nothing sent)" : "clicked Improve prompt (request posted)";
  await h("select('Model for new task', 'opus')"); await h("select('Effort for new task', 'high')");
  const account = await h("account()");
  assert.ok(account, "an account is selected");
  await h(`setBox(${JSON.stringify(D)})`);
  const before = await observe(0, `selected ${account} · opus · high; box set to D`);
  assert.ok(before.buttons.includes("Refine draft") && before.buttons.includes("Improve prompt"), `both buttons enabled: ${before.buttons}`);

  // (1) Compile with D -> X shown read-only, box still D.
  const r1 = await compile();
  assert.deepEqual({ type: r1.type, id: r1.id, account: r1.account, model: r1.model, effort: r1.effort, deep: r1.deep, draft: r1.draft, answers: r1.answers },
    { type: "compile", id: undefined, account, model: "opus", effort: "high", deep: undefined, draft: D, answers: "" });
  let s = await observe(1, `${compiled}; result pending`);
  assert.ok(s.statuses.includes("Improving your prompt in its own tab. The board stays usable meanwhile."), `pending status: ${s.statuses}`);
  assert.ok(s.buttons.includes("Cancel improvement") && s.buttons.includes("Improve prompt (disabled)"), `pending buttons: ${s.buttons}`);
  assert.equal(entry(s).pending, true); assert.equal(entry(s).original, D);
  await inject(readyResult(r1.requestId, D));
  s = await observe(1, "injected ready compilation");
  assert.deepEqual(s.compiled, { value: X, readOnly: true });
  assert.ok(s.statuses.includes("Improved with claude-opus-5-5 · high effort · xml format"), `ready status: ${s.statuses}`);
  assert.ok(s.muted.includes("Possibly not carried into the prompt: Nice-to-have: a progress toast"), `dropped line: ${s.muted}`);
  assert.equal(s.value, D);
  assert.ok(s.buttons.includes("Apply improved prompt") && s.buttons.includes("Keep original") && !s.buttons.some((b) => b.startsWith("Restore")), `ready buttons: ${s.buttons}`);
  assert.equal(entry(s).status, "ready"); assert.equal(entry(s).pending, false); assert.equal(entry(s).rendered.text, X);

  // (2) Apply -> box = X, Restore original visible.
  await h("click('Apply improved prompt')");
  s = await observe(2, "clicked Apply improved prompt");
  assert.equal(s.value, X);
  assert.ok(s.buttons.includes("Restore original") && s.buttons.includes("Apply improved prompt (disabled)") && s.buttons.includes("Keep improved draft"), `applied buttons: ${s.buttons}`);
  assert.equal(entry(s).applied, true);
  if (screenshot) await screenshot("apply");

  // (3) Restore -> box = D.
  await h("click('Restore original')");
  s = await observe(3, "clicked Restore original");
  assert.equal(s.value, D);
  assert.ok(s.buttons.includes("Keep original") && !s.buttons.includes("Restore original"), `restored buttons: ${s.buttons}`);
  assert.equal(entry(s).applied, false);

  // (4) Apply, edit box to X+"edit", Restore -> refused, alert, original D shown read-only, box unchanged.
  await h("click('Apply improved prompt')");
  await h(`setBox(${JSON.stringify(X + "edit")})`);
  await h("click('Restore original')");
  s = await observe(4, "applied, edited box to X+edit, clicked Restore original");
  assert.ok(s.alerts.includes("Your draft changed after applying. Your edits were preserved. Copy from the original below if needed."), `restore alert: ${s.alerts}`);
  assert.deepEqual(s.original, { value: D, readOnly: true });
  assert.equal(s.value, X + "edit");
  assert.equal(entry(s).restoreConflict, true); assert.equal(entry(s).applied, true);
  await h("click('Keep improved draft')");
  s = await observe(4, "clicked Keep improved draft");
  assert.equal(s.compilations.length, 0); assert.equal(s.compiled, null); assert.equal(s.value, X + "edit");

  // (5) Compile with D, edit box to D2 before Apply, Apply -> refused with message, box = D2.
  await h(`setBox(${JSON.stringify(D)})`);
  const r5 = await compile();
  await inject(readyResult(r5.requestId, D));
  await h(`setBox(${JSON.stringify(D2)})`);
  await h("click('Apply improved prompt')");
  s = await observe(5, `${compiled} for D, injected ready, edited box to D2, clicked Apply improved prompt`);
  assert.ok(s.alerts.includes("Your draft changed. Improve it again to avoid overwriting your edits."), `apply alert: ${s.alerts}`);
  assert.equal(s.value, D2);
  assert.deepEqual(s.compiled, { value: X, readOnly: true }); // X stays visible read-only after the refusal
  assert.ok(s.buttons.includes("Apply improved prompt") && s.buttons.includes("Keep original") && !s.buttons.includes("Restore original"), `refused buttons: ${s.buttons}`);
  assert.equal(entry(s).applyConflict, true); assert.equal(entry(s).applied, undefined); assert.equal(entry(s).original, D);
  await h("click('Keep original')");
  s = await observe(5, "clicked Keep original");
  assert.equal(s.compilations.length, 0); assert.equal(s.value, D2);

  // (6) Apply, edit, Compile again -> the new request's draft is the edited box text; the old compilation is gone.
  await h(`setBox(${JSON.stringify(D)})`);
  const r6a = await compile();
  await inject(readyResult(r6a.requestId, D));
  await h("click('Apply improved prompt')");
  assert.equal(await h("value()"), X);
  await h(`setBox(${JSON.stringify(X + "edit")})`);
  const r6b = await compile();
  s = await observe(6, `${compiled} for D, injected ready, applied, edited box to X+edit, ${compiled} again`);
  assert.equal(r6b.draft, X + "edit"); assert.notEqual(r6b.requestId, r6a.requestId);
  assert.equal(s.compiled, null); assert.ok(s.statuses.includes("Improving your prompt in its own tab. The board stays usable meanwhile."));
  assert.equal(s.compilations.length, 1); assert.equal(entry(s).pending, true); assert.equal(entry(s).original, X + "edit"); assert.equal(entry(s).applied, undefined);
  await inject(readyResult(r6a.requestId, D)); // a late answer to the discarded request is ignored
  s = await observe(6, "injected a late result for the discarded request");
  assert.equal(entry(s).pending, true); assert.equal(s.compiled, null);
  if (reload) {
    await reload();
    s = await observe(6, "reloaded the page while the compile was pending");
    assert.ok(s.alerts.includes("Improvement interrupted. Your draft is preserved; try again."), `interrupted alert: ${s.alerts}`);
    assert.equal(s.value, X + "edit");
    await h("click('Dismiss')");
  } else {
    await h("click('Cancel improvement')"); // posts cancelHelper; with no helper of that id the host does nothing
    if (!requestCompile) assert.equal((await h("posted()")).filter((m) => m.type === "cancelHelper").at(-1)?.requestId, r6b.requestId);
  }
  s = await observe(6, reload ? "clicked Dismiss" : "clicked Cancel improvement");
  assert.equal(s.compilations.length, 0); assert.equal(s.value, X + "edit");

  // (7) Unfinished result -> alert, conflicts listed, no Apply button.
  await h(`setBox(${JSON.stringify(D)})`);
  const r7 = await compile();
  await inject(unfinishedResult(r7.requestId, D));
  s = await observe(7, `${compiled} for D, injected unfinished compilation`);
  assert.equal(s.alerts[0], "Clarification is unfinished: a consequential contradiction remains. Edit the draft to resolve it, then improve it again.");
  assert.equal(s.conflicts.length, 1);
  for (const part of [CONFLICT.earlier, CONFLICT.later, CONFLICT.why]) assert.ok(s.conflicts[0].includes(part), `conflict shows ${part}`);
  assert.ok(!s.buttons.some((b) => b.startsWith("Apply")) && s.buttons.includes("Dismiss"), `unfinished buttons: ${s.buttons}`);
  assert.equal(s.compiled, null); assert.equal(s.value, D);
  assert.equal(entry(s).status, "unfinished"); assert.equal(entry(s).rendered, undefined);
  if (screenshot) await screenshot("unfinished");
  await h("click('Dismiss')");
  s = await observe(7, "clicked Dismiss");
  assert.equal(s.compilations.length, 0);
  const failedRequest = await compile();
  const error = "The helper could not finish the compilation.";
  await inject({ requestId: failedRequest.requestId, target: "new", error });
  s = await observe("error", "injected failed compilation");
  assert.ok(s.alerts.includes(error));
  assert.equal(s.value, D);
  assert.ok(!s.buttons.some((b) => b.startsWith("Apply")));
  await h("click('Dismiss')");
  s = await observe("error", "dismissed failed compilation");
  assert.equal(s.compilations.length, 0);
  assert.ok(!s.alerts.includes(error));
  assert.equal(s.value, D);

  const largeRequest = await compile();
  await inject({ ...readyResult(largeRequest.requestId, D), oversize: { chars: X.length, limit: X.length - 1 } });
  s = await observe("oversize", "injected compilation over the length limit");
  assert.ok(s.alerts.some((text) => text.includes("character limit")));
  assert.ok(s.buttons.includes("Apply improved prompt (disabled)"));
  assert.deepEqual(s.compiled, { value: X, readOnly: true });
  assert.equal(s.value, D);
  await h("click('Keep original')");
  s = await observe("oversize", "dismissed oversized compilation");
  assert.equal(s.compilations.length, 0);
  assert.ok(!s.alerts.some((text) => text.includes("character limit")));
  assert.equal(s.value, D);
  // Refinement controls are untouched by all of the above.
  assert.ok(s.buttons.includes("Refine draft") && s.buttons.includes("Improve prompt"), `final buttons: ${s.buttons}`);
  return { account };
}

/** Browser harness only: real control clicks with recorded messages and injected helper results. */
async function runPromptControlScenarios({ evaluate, reload }) {
  await evaluate(HELPERS);
  const h = (expr) => evaluate(`window.__h.${expr}`);
  const host = (data) => evaluate(`window.__host(${JSON.stringify(data)}); true`);
  const last = (type) => evaluate(`window.__posted.filter((m) => m.type === ${JSON.stringify(type)}).at(-1)`);
  const selection = (m) => ({ account: m.account, model: m.model, effort: m.effort });
  const account = await h("account()");
  const selected = { account, model: "opus", effort: "high" };
  const oldSelection = { account, model: "fable", effort: "max" };
  const questions = [{ question: "Which rows?", reason: "Define the export scope.", suggested: "Only filtered rows." }];
  const old = { kind: "questions", requestId: "legacy", original: D, deep: true, selection: oldSelection, questions };
  // An old checked preference must not affect fresh requests; a saved clarification keeps its original selection.
  await evaluate(`vscode.setState({ ...vscode.getState(), prompt: ${JSON.stringify(D)}, refinementDeep: [["new", true]], refinements: [["new", ${JSON.stringify(old)}]] }); true`);
  await reload();
  const checkControls = async (target) => {
    const controls = await evaluate(`(() => { const e = document.querySelector('[data-refine-target="${target}"]'); return { checkboxes: e.querySelectorAll('input[type="checkbox"]:not([data-review-mode])').length, text: e.textContent,
      titles: [...e.querySelectorAll('[data-refine-start], [data-compile-start]')].map(b => b.title) }; })()`);
    assert.equal(controls.checkboxes, 0, `${target}: obsolete checkbox removed`);
    assert.doesNotMatch(controls.text, /\bDeep\b/);
    // Since 4 November 2026 (the user, Q2) helpers use the most capable model at its highest effort, whatever the task's menus say.
    assert.match(controls.titles[0], /project context.*only where it needs it.*most capable model at its highest effort/);
    assert.match(controls.titles[0], /up to three questions.*unchanged.*Review before applying/);
    assert.match(controls.titles[1], /long draft or one with pasted material.*structured execution prompt.*most capable model at its highest effort/);
    assert.match(controls.titles[1], /held back and listed.*unresolved contradictions.*Review before applying/);
    assert.match(await evaluate(`document.querySelector('[data-refine-target="${target}"] [data-refine-selection]').textContent`), /^Uses fable · max effort · /);
  };
  await checkControls("new");
  assert.equal(await evaluate(`"refinementDeep" in vscode.getState()`), false);
  assert.equal(await evaluate(`"deep" in vscode.getState().refinements[0][1]`), false);
  await h("click('Use answers')");
  let r = await last("refine");
  assert.deepEqual(selection(r), oldSelection, "saved clarification retains its original Fable/max selection");
  assert.equal(r.deep, undefined);
  await host({ refinement: { requestId: r.requestId, target: "new", kind: "unchanged" } });
  await h("click('Keep original')");

  await h("click('Refine draft')");
  r = await last("refine");
  assert.deepEqual(selection(r), selected, "a fresh refinement ignores the old checked preference");
  assert.equal(r.deep, undefined);
  assert.equal(r.draft, D);
  await host({ refinement: { requestId: r.requestId, target: "new", kind: "questions", questions } });
  await h("select('Model for new task', 'sonnet')");
  await h("select('Effort for new task', 'low')");
  await h(`setBox(${JSON.stringify(D2)})`);
  await h("click('Use answers')");
  r = await last("refine");
  assert.deepEqual(selection(r), selected, "answers retain the initial selection after dropdowns change");
  assert.equal(r.draft, D, "answers retain the original draft");
  assert.equal(r.answers, "Which rows?\nOnly filtered rows.");
  await host({ refinement: { requestId: r.requestId, target: "new", kind: "revision", revision: "Proposed clearer draft.", model: "claude-opus-5-5", effort: "high" } });
  assert.equal(await h("value()"), D2, "a refinement proposal never applies itself");
  // the user, 11 November 2026: the options sit above the returned text. Which of these buttons come before the result's textarea, in its own block.
  const above = (label) => evaluate(`(() => { const t = [...document.querySelectorAll("textarea")].find((x) => x.ariaLabel === ${JSON.stringify(label)});
    return t ? [...t.parentElement.querySelectorAll("button:not([data-refine-start], [data-compile-start], .split-arrow)")].filter((b) => b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).map((b) => b.textContent) : null; })()`);
  assert.deepEqual(await above("Proposed draft"), ["Apply proposal", "Show changes", "Keep original"], "Refine draft: Apply, Show changes and Keep sit above the proposal");
  await h("click('Improve prompt')");
  let c = await last("compile");
  const changed = { account, model: "sonnet", effort: "low" };
  assert.deepEqual(selection(c), changed);
  assert.equal(c.deep, undefined);
  assert.equal(c.draft, D2, "Improve uses current textbox contents");
  // Answers go only with the draft they answered (4 November 2026, item 2.1): the box changed to D2 after they were given for D.
  assert.equal(c.answers, "", "answers to another version of the draft are not sent");
  await host({ compilation: readyResult(c.requestId, D2) });
  assert.match(await evaluate("document.body.textContent"), /Your clarification answers were not sent: the draft changed after you answered\./);
  assert.equal(await h("value()"), D2, "an improved prompt never applies itself");
  assert.deepEqual(await above("Improved prompt"), ["Apply improved prompt", "Show changes", "Keep original"], "Improve prompt: Apply, Show changes and Keep sit above the improved prompt");
  await h("click('Keep original')"); // refinement first, then compilation
  await h("click('Keep original')");
  // Improve with these answers: straight to Improve with the answers shown, no second Refine call; the draft must be the one asked about.
  await h(`setBox(${JSON.stringify(D)})`);
  await h("click('Refine draft')");
  r = await last("refine");
  await host({ refinement: { requestId: r.requestId, target: "new", kind: "questions", questions } });
  const refines = (await evaluate("window.__posted.filter((m) => m.type === 'refine').length"));
  await h("click('Improve with these answers')");
  c = await last("compile");
  assert.deepEqual([c.draft, c.answers], [D, "Which rows?\nOnly filtered rows."], "the draft asked about and the answers shown, suggestion included");
  assert.equal(await evaluate("window.__posted.filter((m) => m.type === 'refine').length"), refines, "no second Refine call");
  await host({ compilation: readyResult(c.requestId, D) });
  await h("click('Keep original')");
  await h("click('Dismiss')");
  // A spaces-only answer is unanswered (F59-7); cancelling the Use answers round gives the questions and typed answers back (F59-6).
  await h("click('Refine draft')");
  r = await last("refine");
  await host({ refinement: { requestId: r.requestId, target: "new", kind: "questions", questions } });
  await evaluate(`(() => { const b = document.querySelector('[data-refine-focus="new:0"]'); b.value = "   "; b.dispatchEvent(new Event("input")); })(); true`);
  await h("click('Use answers')");
  r = await last("refine");
  assert.equal(r.answers, "Which rows?\nUnanswered; preserve ambiguity.");
  await h("click('Cancel refinement')");
  assert.equal(await evaluate(`document.querySelector('[data-refine-focus="new:0"]')?.value`), "   ", "the questions come back with what was typed");
  await h("click('Dismiss')");
  await h(`setBox(${JSON.stringify(D2)})`);

  const task = { id: "followup", title: "Follow-up controls", prompt: D, status: "running", account, model: "opus", effort: "high", updatedAt: new Date().toISOString(),
    completion: { goal: D, doneWhen: "Filtered rows are exported.", commands: [], writer: "claude-fable-5-5", effort: "high" } };
  await host({ tasks: [task], own: [task.id], live: [task.id], accounts: [account] });
  await host({ cardAction: { type: "followUp", id: task.id } });
  await checkControls(task.id);
  const clickFollowUp = (attribute) => evaluate(`document.querySelector('[data-refine-target="followup"] [${attribute}]').click(); true`);
  const followUpValue = () => evaluate(`document.querySelector('textarea[data-draft-target="followup"]').value`);
  await evaluate(`(() => { const b = document.querySelector('textarea[data-draft-target="followup"]'); b.value = ${JSON.stringify(D)}; b.dispatchEvent(new Event("input")); })(); true`);
  await clickFollowUp("data-refine-start");
  r = await last("refine");
  assert.deepEqual(selection(r), changed);
  assert.equal(r.id, task.id);
  assert.equal(r.deep, undefined);
  await host({ refinement: { requestId: r.requestId, target: task.id, kind: "unchanged" } });
  await clickFollowUp("data-compile-start");
  c = await last("compile");
  assert.deepEqual(selection(c), changed);
  assert.equal(c.id, task.id);
  assert.equal(c.deep, undefined);
  await host({ compilation: { ...readyResult(c.requestId, D), target: task.id } });
  assert.equal(await followUpValue(), D, "follow-up improvements never apply themselves");
  assert.match(await evaluate(`document.querySelector('.completion').textContent`), /Done when written by claude-fable-5-5 · high effort\./);
  assert.doesNotMatch(await evaluate(`document.querySelector('.completion').textContent`), /prompt stated none/);
  const ruleLabel = await evaluate(`document.querySelector('label[for="autoRule"]').textContent`);
  assert.equal(ruleLabel, "Done When: Fable");
  assert.match(await evaluate(`document.querySelector('label[for="autoRule"]').title`), /Fable at high effort.*goal and when it is done/);
  assert.ok(!(await evaluate(`window.__posted.map(m => m.type)`)).some(t => ["create", "send"].includes(t)), "helper controls never create or send a task");
  // Reset only the simulated task state before the existing compile scenarios.
  await host({ tasks: [], own: [], live: [], accounts: [account] });
  await h("select('Model for new task', 'opus')");
  await h("select('Effort for new task', 'high')");
}

/** The helper tab page (media/helper-tab.js) in test/helper-tab-harness.html: full and batched posts, the quiet live region, Cancel. */
async function runHelperTabScenarios({ evaluate }) {
  const host = (data) => evaluate(`window.__host(${JSON.stringify(data)}); true`);
  const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  assert.deepEqual(await evaluate("window.__posted"), [{ type: "ready" }], "the page asks for the run when it loads");
  const now = Date.now();
  const run = { requestId: "r1", kind: "improve", title: "Improve prompt", target: "new", detail: "fable · max effort · acct", draft: "Fix it.", answers: "",
    startedAt: now - 5000, status: "running", log: [{ at: now - 4000, text: "Model: maximum policy: Claude Fable at max effort." }], segments: [], sent: "THE WHOLE PACKET" };
  await host({ run });
  assert.equal(await text("h2"), "Improve prompt");
  assert.match(await text("[role=status]"), /^Running · fable · max effort · acct\. The board stays usable meanwhile\.$/, "no clock inside the live region (F19-5)");
  const statusBefore = await text("[role=status]");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await text("[role=status]"), statusBefore, "the live region is not rewritten every second");
  // A batched post carries only what streams; it is merged into the run, keeping what was sent.
  await host({ partial: true, run: { requestId: "r1", status: "running", stage: undefined, log: run.log, segments: [{ source: "", stream: "thinking", text: "Thinking it over." }] } });
  assert.match(await text(".helper-live"), /Thinking it over\./);
  assert.equal(await evaluate("document.querySelector('details pre')?.textContent"), "THE WHOLE PACKET", "a partial post keeps what was sent");
  // A later batch carries only the appended text: added to its segment, or a new segment.
  await host({ partial: true, run: { requestId: "r1", status: "running", stage: undefined, log: run.log },
    append: [{ i: 0, source: "", stream: "thinking", text: " Still thinking." }, { i: 1, source: "", stream: "answer", text: "The answer." }] });
  assert.match(await text(".helper-live"), /Thinking it over\. Still thinking\./);
  assert.match(await text(".helper-live"), /The answer\./);
  await host({ partial: true, run: { requestId: "other", status: "running", log: [], segments: [{ source: "", stream: "answer", text: "WRONG RUN" }] } });
  assert.doesNotMatch(await text(".helper-live"), /WRONG RUN/, "a batch for another run is ignored");
  await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(); true");
  assert.deepEqual(await evaluate("window.__posted.at(-1)"), { type: "cancel", requestId: "r1" });
  await host({ run: { ...run, status: "done", finishedAt: now, model: "claude-fable-5-1", result: { text: "<task>Fix it.</task>", notes: ["Used 1,200 tokens (300 written, CLI estimate $0.10)."] } } });
  assert.match(await text("[role=status]"), /^Finished in 0:05 · claude-fable-5-1 · /);
  assert.match(await text(".helper-result"), /Used 1,200 tokens/);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').hidden"), true);
  await evaluate("document.querySelector('.helper-result').previousElementSibling.querySelector('button').click(); true");
  assert.deepEqual(await evaluate("window.__posted.at(-1)"), { type: "open", what: "result", requestId: "r1" });
  await host({ run: { ...run, requestId: "r2", sent: "replacement packet" } });
  await evaluate("document.querySelector('details button').click(); true");
  assert.deepEqual(await evaluate("window.__posted.at(-1)"), { type: "open", what: "sent", requestId: "r2" });
}

// ---- Extension Development Host driver (`node test/compile-webview-cdp.js --edh`) ----
async function edh() {
  const worktree = path.resolve(__dirname, "..");
  const outDir = path.join(worktree, "docs", "evidence", "compile-stage-2026-10-26", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-edh-"));
  const lines = [];
  const say = (l) => { lines.push(l); console.log(l); };
  const finish = (status) => { say(status); fs.writeFileSync(path.join(outDir, "m5-step6-edh-log.txt"), lines.join("\n") + "\n"); };
  let code, browser, workbench, web;
  try {
    const version = execFileSync("code --version", { shell: true, encoding: "utf8", env: cleanEnv() }).trim().split(/\r?\n/).join(" ");
    say(`Entomatical compile stage · M5 step 6 · Extension Development Host run`);
    say(`Date/time: ${new Date().toString()}`);
    say(`VS Code version: ${version}`);
    const repo = path.join(scratch, "repo");
    fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, "README.md"), "Throwaway repository for the Entomatical EDH run.\n");
    const g = (...a) => execFileSync("git", ["-c", "user.name=EDH", "-c", "user.email=edh@example.invalid", ...a], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    g("init", "-q"); g("add", "README.md"); g("commit", "-q", "-m", "init");
    const userData = path.join(scratch, "user-data"), extensions = path.join(scratch, "extensions");
    const port = await freePort();
    const exe = codePath();
    if (!exe) throw new Error("Code.exe not found under LOCALAPPDATA.");
    const args = [`--extensionDevelopmentPath=${worktree}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--remote-debugging-port=${port}`, "--disable-workspace-trust", "--skip-release-notes", "--skip-welcome", repo];
    say(`Launch command: "${exe}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
    say(`Environment: inherited minus every CLAUDE*, ANTHROPIC*, ELECTRON_* and VSCODE_* variable.`);
    code = spawn(exe, args, { env: cleanEnv(), stdio: "ignore", windowsHide: false, detached: false });
    const targets = await waitFor(async () => { const t = await listTargets(port); return t.find((x) => x.type === "page" && /workbench/.test(x.url)) ? t : null; }, "the VS Code workbench page", 60_000);
    workbench = await Cdp.connect(targets.find((x) => x.type === "page" && /workbench/.test(x.url)).webSocketDebuggerUrl);
    // Open the Entomatical view container from the activity bar (the view is not opened automatically).
    await waitFor(() => workbench.evaluate(`!!document.querySelector('.activitybar [aria-label^="Entomatical"]')`), "the Entomatical activity bar item", 60_000, 500);
    await workbench.evaluate(`document.querySelector('.activitybar [aria-label^="Entomatical"]').click(); true`);
    say(`Opened the Entomatical view from the activity bar.`);
    // Find the execution context (in any target) where board.js's globals live.
    let contextId;
    await waitFor(async () => {
      for (const t of await listTargets(port)) {
        if (!(t.type === "page" || t.type === "iframe" || t.type === "webview")) continue;
        let c;
        try {
          c = await Cdp.connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable"); await sleep(400);
          const ids = [...new Set(c.events.filter((e) => e.method === "Runtime.executionContextCreated").map((e) => e.params.context.id))];
          for (const id of ids) {
            try { if (await c.evaluate(`typeof promptBox === "object" && !!document.querySelector('textarea[data-draft-target="new"]')`, id)) { web = c; contextId = id; say(`Webview found: target ${t.type} ${t.url.slice(0, 80)} context ${id}`); return true; } } catch { /* not this frame */ }
          }
        } catch { /* target vanished */ }
        if (c && c !== web) c.close();
      }
      return false;
    }, "the board webview's script context", 60_000, 1000);
    const evaluate = (expr) => web.evaluate(expr, contextId);
    // The webview API object is frozen and `send` is a const, so neither can be replaced with a recorder. The Compile
    // button is therefore never clicked here: the pending state is created through board.js's own globals (everything
    // requestCompilation does except send), so the host never receives a compile message and never spawns the CLI.
    assert.equal(await evaluate(`Object.isFrozen(vscode)`), true, "the VS Code webview API object is frozen");
    await evaluate(`window.__posted = []; true`);
    const requestCompile = () => evaluate(`(() => {
      const draft = draftValue("new"), selection = refinementSelection();
      const requestId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"), answers = refinements.get("new")?.answers || "";
      clearCompilation("new"); compilations.set("new", { requestId, original: draft, pending: true, selection }); saveDrafts(); refreshRefinement("new");
      return { type: "compile", requestId, ...selection, draft, answers }; })()`);
    say(`The Compile button is never clicked in the EDH (the webview API object is frozen, so no recorder can replace it); pending state is created through board.js globals without send.`);
    await waitFor(() => evaluate(`document.querySelector('select[aria-label="Account for new task"]').value !== ""`), "an account in the new-task form", 30_000, 500);
    const truncate = (t) => (t.length > 200 ? `${t.slice(0, 200)}…` : t).replace(/\r?\n/g, "\\n");
    const screenshot = async (name) => {
      // Collapse the accounts list and bring the compile section into view so the window capture shows it.
      await evaluate(`accountsBox.open = false; (document.querySelector(".compilation") || promptBox).scrollIntoView({ block: "center" }); true`);
      await sleep(300);
      const shot = await workbench.send("Page.captureScreenshot", { format: "png" });
      const file = path.join(outDir, `m5-step6-edh-${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      say(`Screenshot: ${file}`);
    };
    const { account } = await runScenarios({ evaluate, screenshot, requestCompile,
      log: (e) => say(`[${e.step}] ${e.action}\n    box: "${truncate(e.value)}"\n    persisted keys: ${e.keys} (compilations entries: ${e.compilations.length}${e.hasCompilations ? "" : "; compilations key missing"})\n    buttons: ${e.buttons.join(" | ")}${e.alerts.length ? `\n    alerts: ${e.alerts.join(" | ")}` : ""}`) });
    say(`Account shown in the selection: ${account} (no request was sent to the host for it).`);
    say(`Helper folders created by the host under the throwaway repo: ${fs.existsSync(path.join(repo, ".entomatical", "helpers")) ? fs.readdirSync(path.join(repo, ".entomatical", "helpers")).length : 0} (0 = no compile reached the host).`);
    say(`No model call was made; compilation results were injected.`);
    finish(`EDH run: done.`);
  } catch (e) {
    say(`FAILED: ${e.stack || e}`);
    say(`No model call was made; compilation results were injected.`);
    finish(`EDH run: not done.`);
    process.exitCode = 1;
  } finally {
    try { web?.close(); } catch { /* closed */ }
    try { workbench?.close(); } catch { /* closed */ }
    if (code && code.exitCode === null) { try { execFileSync("taskkill", ["/PID", String(code.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* exited */ } }
    await sleep(1500);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* temp folder */ }
  }
}

module.exports = { freePort, edgePath, codePath, cleanEnv, browserEnv, waitFor, listTargets, Cdp, launchEdge, runScenarios, runPromptControlScenarios, runHelperTabScenarios, runDraftContextScenarios, HELPERS, fixtures: { D, D2, X, readyResult, unfinishedResult, CONFLICT } };
if (require.main === module && process.argv.includes("--edh")) edh();
