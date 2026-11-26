// The helper tab (src/helper-tab.ts) for Refine draft, Improve prompt and Review prompt. DOM calls only, no innerHTML, so draft and
// model text are never parsed as HTML. It shows one run: its status and clock, each model's thinking and answer as they stream in,
// the activity lines, what was sent, and the result. Nothing is applied from here; the board keeps Apply and the answer boxes.
const vscode = acquireVsCodeApi();
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
let run;
const act = (action) => { if (run) vscode.postMessage({ ...action, requestId: run.requestId }); };
const head = el("h2");
const status = el("p", { role: "status" });
const cancel = el("button", { textContent: "Cancel", onclick: () => act({ type: "cancel" }) });
cancel.classList.add("danger");
const live = el("section", { className: "helper-live", ariaLabel: "Live output" });
const result = el("section", { className: "helper-result" });
const log = el("pre", { className: "helper-log", ariaLabel: "Activity" });
const sentText = el("pre", { className: "helper-log" });
// The full text in an editor tab: the boxes here scroll, the editor shows it whole for reading, copying or printing.
const opener = (what, label) => el("button", { textContent: "Open in editor", ariaLabel: label, onclick: () => act({ type: "open", what }) });
const openResult = opener("result", "Open the whole result in an editor tab");
document.body.append(head, status, el("div", { className: "row" }, cancel),
  el("h3", { textContent: "Live output" }), live,
  // the user, 11 November 2026: the options sit above the returned text.
  el("h3", { textContent: "Result" }), el("div", { className: "row" }, openResult), result,
  el("h3", { textContent: "Activity" }), log,
  el("details", {}, el("summary", { textContent: "What was sent" }), sentText, el("div", { className: "row" }, opener("sent", "Open everything that was sent in an editor tab"))));

const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
// The machine's zone from the extension host (local-time.ts): the webview's own can differ, as on the board (board.js `stamp`).
let logClock = {};
const time = (at) => formatHostDate(at, logClock, "toLocaleTimeString", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
// The running clock is its own element outside the status live region, so a screen reader is not read the time every second (F19-5).
const ticking = el("span", { className: "muted" });
status.after(ticking);
function paintStatus() {
  if (!run) return;
  const took = clock((run.finishedAt || Date.now()) - run.startedAt);
  const text = run.status === "running" ? `Running · ${run.stage ? `${run.stage} · ` : ""}${run.detail}. The board stays usable meanwhile.`
    : run.status === "done" ? `Finished in ${took} · ${run.model ? `${run.model} · ` : ""}${run.detail}`
    : run.status === "cancelled" ? `Cancelled after ${took}.` : `Failed after ${took}.`;
  if (status.textContent !== text) status.textContent = text;
  ticking.textContent = run.status === "running" ? took : "";
  cancel.hidden = run.status !== "running";
  openResult.hidden = run.status !== "done";
}
// Each model's output in its own block; keep a block scrolled to the end while it was at the end, so new text stays in view.
function paintLive() {
  const sources = [...new Set(run.segments.map((s) => s.source))];
  if (!sources.length) {
    live.replaceChildren(el("p", { className: "muted", textContent: run.status === "running"
      ? "Nothing streamed yet. Thinking and the answer appear here as the model writes them." : "Nothing was streamed for this run." }));
    return;
  }
  const kept = new Map([...live.querySelectorAll("pre[data-key]")].map((p) => [p.dataset.key, { end: p.scrollTop + p.clientHeight >= p.scrollHeight - 4, top: p.scrollTop }]));
  live.replaceChildren(...sources.map((source) => el("div", { className: "helper-source" },
    source ? el("h4", { textContent: source }) : null,
    ...run.segments.filter((s) => s.source === source).map((s, i) => {
      const pre = el("pre", { className: `helper-stream ${s.stream}`, textContent: s.text });
      pre.dataset.key = `${source}:${i}`;
      return el("div", {}, el("div", { className: "muted", textContent: s.stream === "thinking" ? "Thinking" : "Answer, as it is written" }), pre);
    }))));
  for (const pre of live.querySelectorAll("pre[data-key]")) { const k = kept.get(pre.dataset.key); pre.scrollTop = !k || k.end ? pre.scrollHeight : k.top; }
}
function paintResult() {
  if (run.status === "running") return result.replaceChildren(el("p", { className: "muted", textContent: "Waiting for the result…" }));
  if (run.status !== "done") return result.replaceChildren(el("p", { role: "alert", textContent: run.error || "No result." }));
  result.replaceChildren(el("pre", { className: "helper-text", textContent: run.result.text }),
    ...run.result.notes.map((n) => el("p", { className: "muted", textContent: n })));
}
function paint() {
  if (!run) return;
  head.textContent = run.title;
  document.title = run.title;
  paintStatus();
  paintLive();
  paintResult();
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  // Unchanged text is not rewritten: a batch arrives every 150 ms and the sent packet can be 30 KB.
  const logText = run.log.length ? run.log.map((l) => `${time(l.at)}  ${l.text}`).join("\n") : "Starting…";
  if (log.textContent !== logText) log.textContent = logText;
  if (atBottom) log.scrollTop = log.scrollHeight;
  if (sentText.textContent !== run.sent) sentText.textContent = run.sent;
}
setInterval(paintStatus, 1000);
// A batched post carries only what streams (status, stage, log, segments): merged into the run the last full post gave.
window.addEventListener("message", (e) => {
  if (!e.data?.run) return;
  if (!e.data.partial) logClock = { hostTimezone: e.data.hostTimezone, hostTimeOffsets: e.data.hostTimeOffsets };
  if (e.data.partial) {
    if (!run || run.requestId !== e.data.run.requestId) return;
    run = { ...run, ...e.data.run };
    // Only the text appended since the last post: added to its segment, or a new segment.
    if (e.data.append) { run.segments = run.segments.slice(); for (const a of e.data.append) run.segments[a.i] = { source: a.source, stream: a.stream, text: (run.segments[a.i]?.text ?? "") + a.text }; }
  } else run = e.data.run;
  paint();
});
vscode.postMessage({ type: "ready" });
