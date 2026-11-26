import * as vscode from "vscode";
import * as crypto from "crypto";
import type { HelperOutput } from "./worker";
import { hostClock } from "./local-time";

/**
 * Refine draft, Improve prompt and Review prompt each run in their own editor tab beside the board (the user, 4 November 2026).
 * They used to run as hidden processes with one status line on the board. The tab shows what was sent, the activity of each provider
 * call, each model's thinking and answer as they stream in, how long it has run, and the result. The board keeps the result and its
 * Apply, answers, Restore and Keep buttons exactly as before; the tab only shows. Everything here lives in memory: nothing is written to disk.
 */
export type HelperKind = "refine" | "improve" | "review" | "work";
/** A model's live output: its thinking and its answer, in the order they arrived. */
interface Segment { source: string; stream: "thinking" | "answer"; text: string }
/** What the tab shows as the result; the host formats it (refineView, improveView, reviewView below). */
export interface ResultView { text: string; notes: string[] }
interface Run {
  requestId: string; kind: HelperKind; title: string; target: string; detail: string; draft: string; answers: string; prompt?: string;
  startedAt: number; finishedAt?: number; status: "running" | "done" | "failed" | "cancelled"; stage?: string;
  log: { at: number; text: string }[]; segments: Segment[]; result?: ResultView; model?: string; error?: string; cancel: () => void;
}
const LOG_LIMIT = 300, LOG_LINE_LIMIT = 400, STREAM_LIMIT = 120_000, STREAM_POST_MS = 150;
// A short substring from a provider can still reference its entire input packet. Own only the retained code units.
const copyText = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");
const diagnostic = (text: string, limit = LOG_LINE_LIMIT) =>
  copyText(text.length > limit ? text.slice(0, limit - 1) + "…" : text);
const finishedCancel = () => {};

// Keep arrival order for eviction. The panel groups consecutive thinking or answer chunks for each model.
function displaySegments(chunks: Segment[]) {
  const segments: Segment[] = [], latest = new Map<string, Segment>();
  for (const chunk of chunks) {
    const previous = latest.get(chunk.source);
    if (previous?.stream === chunk.stream) previous.text += chunk.text;
    else {
      const segment = { ...chunk };
      segments.push(segment);
      latest.set(chunk.source, segment);
    }
  }
  return segments;
}
const LABEL: Record<HelperKind, [string, string]> = { refine: ["Refine draft", "Refine"], improve: ["Improve prompt", "Improve"], review: ["Review prompt", "Review"], work: ["Review work", "Review"] };
/** The tab title: the button's name for the new-task box, or the short form and the task title for a card's box. */
export function helperTitle(kind: HelperKind, taskTitle?: string) {
  if (!taskTitle) return LABEL[kind][0];
  return `${LABEL[kind][1]}: ${taskTitle.length > 40 ? `${taskTitle.slice(0, 40)}…` : taskTitle}`;
}

export class HelperTabs {
  static readonly viewType = "entomatical.helperTab";
  private panels = new Map<string, vscode.WebviewPanel>(); // one tab per draft box and button
  // A draft belongs to its board attachment until disposal (null). Work reviews belong to the card (undefined).
  private runs = new Map<string, Run & { boardKey?: number | null }>();
  private byRequest = new Map<string, string>(); // requestId -> key
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private shown = new Map<string, number[]>(); // lengths at the last post; invalidated whenever the window slides
  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Opens (or reuses) the tab beside the board without taking focus, so typing on the board carries on. */
  start(key: string, run: Omit<Run, "startedAt" | "status" | "log" | "segments">, boardKey?: number) {
    const previous = this.runs.get(key);
    // A new run on the same box and button replaces the old one, so the old call is stopped too (F19-3 in session 3482f4's review).
    if (previous) {
      this.retire(key, previous);
      if (previous.status === "running") previous.cancel();
    }
    const entry = { ...run, boardKey, startedAt: Date.now(), status: "running" as const, log: [], segments: [] };
    this.runs.set(key, entry); this.byRequest.set(run.requestId, key);
    this.open(key, false);
    return this.progress(key, new WeakRef<Run>(entry));
  }

  // A delayed provider callback must neither retain the retired run nor write into its replacement.
  private progress(key: string, ref: WeakRef<Run>) {
    let streamChars = 0;
    const live = () => {
      const entry = this.runs.get(key);
      return entry?.status === "running" && entry === ref.deref() ? entry : undefined;
    };
    const log = (entry: Run, text: string) => {
      const line = diagnostic(text);
      entry.log.push({ at: Date.now(), text: line });
      if (entry.log.length > LOG_LIMIT) entry.log.shift();
      return line;
    };
    const append = (source: string, text: string, stream?: Segment["stream"]) => {
      const entry = live();
      if (!entry) return;
      // Activity lines (stderr can be many a second) are batched like streamed text (F19-6).
      if (!stream) {
        log(entry, source ? `${source}: ${text.slice(0, LOG_LINE_LIMIT)}` : text);
        this.post(key, true);
        return;
      }
      if (!text) return;
      text = copyText(text.slice(-STREAM_LIMIT));
      const chunks = entry.segments, last = chunks.at(-1);
      if (last?.source === source && last.stream === stream) last.text += text;
      else chunks.push({ source, stream, text });
      streamChars += text.length;
      if (streamChars > STREAM_LIMIT) {
        let excess = streamChars - STREAM_LIMIT, count = 0;
        while (excess >= chunks[count].text.length) {
          excess -= chunks[count].text.length;
          count++;
        }
        if (count) chunks.splice(0, count);
        if (excess) chunks[0].text = chunks[0].text.slice(excess);
        streamChars = STREAM_LIMIT;
        this.shown.delete(key);
      }
      this.post(key, true);
    };
    /** Live output of one model call; source names the model when several run (Review prompt). */
    const output = (label = ""): HelperOutput => {
      const source = diagnostic(label);
      return (text, stream) => append(source, text, stream);
    };
    const end = (fields: Partial<Run>) => {
      const entry = live();
      if (!entry) return;
      Object.assign(entry, fields, { finishedAt: Date.now(), cancel: finishedCancel });
      this.post(key);
      this.retireIfUnowned(key, entry);
    };
    return {
      output,
      /** generateText's and compileDraft's progress: the packet sent, and the call's output. */
      prompt: (text: string) => {
        const entry = live();
        if (entry) { entry.prompt = text; this.post(key); }
      },
      line: output(),
      stage: (text: string) => {
        const entry = live();
        if (entry) { entry.stage = log(entry, text); this.post(key); }
      },
      finish: (result: ResultView, model?: string) => end({ status: "done", result, model: model && diagnostic(model) }),
      fail: (error: string, cancelled: boolean) => end({ status: cancelled ? "cancelled" : "failed", error: diagnostic(error, 4_000) }),
    };
  }

  /** The board's "Show progress": bring the run's tab back, reopening it if it was closed. */
  show(requestId: string) {
    const key = this.byRequest.get(requestId);
    if (key) this.open(key, true);
  }

  releaseBoard(boardKey: number) {
    for (const [key, run] of this.runs) {
      if (run.boardKey !== boardKey) continue;
      run.boardKey = null;
      this.retireIfUnowned(key, run);
    }
  }

  private clearPost(key: string) {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  private retireIfUnowned(key: string, run: Run & { boardKey?: number | null }) {
    // A card offers Show progress for a work review only while it is running.
    if (!this.panels.has(key) && (run.boardKey === null || (run.kind === "work" && run.status !== "running"))) this.retire(key, run);
  }

  private retire(key: string, run: Run) {
    this.runs.delete(key);
    if (this.byRequest.get(run.requestId) === key) this.byRequest.delete(run.requestId);
    this.clearPost(key);
    this.shown.delete(key);
  }

  private open(key: string, reveal: boolean) {
    const run = this.runs.get(key)!;
    let panel = this.panels.get(key);
    if (panel) { panel.title = run.title; if (reveal || !panel.visible) panel.reveal(undefined, !reveal); this.post(key); return; }
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    panel = vscode.window.createWebviewPanel(HelperTabs.viewType, run.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Not kept alive while hidden (F19-6): shown again, the page reloads and asks for the run ("ready"), which is all kept here.
      { enableScripts: true, localResourceRoots: [media] });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    const nonce = crypto.randomBytes(16).toString("hex");
    const uri = (f: string) => panel!.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("board.css")}"></head>
<body class="helper-tab"><script nonce="${nonce}" src="${uri("usage.js")}"></script><script nonce="${nonce}" src="${uri("helper-tab.js")}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((m) => {
      if (this.panels.get(key) !== panel) return;
      const current = this.runs.get(key);
      if (m?.type === "ready") { this.post(key); return; }
      if (!current || m?.requestId !== current.requestId) return;
      if (m.type === "cancel" && current.status === "running") current.cancel();
      // The whole text in an editor tab, for reading, copying or printing at any length (the user, 4 November 2026).
      if (m.type === "open" && (m.what === "sent" || m.what === "result")) {
        const content = m.what === "sent" ? sentText(current) : current.result ? [current.result.text, ...current.result.notes].join("\n\n") : undefined;
        // Loaded when used, so this module still loads where vscode is a stand-in (the tests).
        if (content) void (require("./readonly-docs") as typeof import("./readonly-docs")).showReadOnly(`${current.title} · ${m.what === "sent" ? "what was sent" : "result"}.md`, content);
      }
    });
    // Closing the tab does not stop the run: the board's Show progress brings it back, its Cancel stops it.
    panel.onDidDispose(() => {
      if (this.panels.get(key) !== panel) return;
      this.panels.delete(key);
      this.clearPost(key);
      this.shown.delete(key);
      const current = this.runs.get(key);
      if (current) this.retireIfUnowned(key, current);
    });
    this.panels.set(key, panel);
  }

  /**
   * Streamed text arrives many times a second: those posts are batched, and a batch sends only what changes (status, stage, log,
   * segments). Re-sending the whole run, prompt twice, every 150 ms structured-cloned about 400 MB over a 4-minute Fable run (item 4 of
   * session 3482f4's second review). Anything else posts the whole run at once, with what was batched.
   */
  private post(key: string, batched = false) {
    if (!this.panels.has(key)) return;
    if (batched) {
      if (!this.timers.has(key)) this.timers.set(key, setTimeout(() => { this.timers.delete(key); this.send(key, true); }, STREAM_POST_MS));
      return;
    }
    this.clearPost(key);
    this.send(key, false);
  }
  private send(key: string, partial: boolean) {
    const run = this.runs.get(key), panel = this.panels.get(key);
    if (!run || !panel) return;
    // Append deltas until eviction changes segment offsets, then replace the panel's stream window.
    const had = this.shown.get(key), segments = displaySegments(run.segments);
    this.shown.set(key, segments.map((s) => s.text.length));
    if (partial) {
      const head = { requestId: run.requestId, status: run.status, stage: run.stage, log: run.log };
      if (had) {
        const append = segments.flatMap((s, i) => (s.text.length === had[i] ? [] : [{ i, source: s.source, stream: s.stream, text: s.text.slice(had[i] ?? 0) }]));
        void panel.webview.postMessage({ partial: true, run: head, append });
      } else void panel.webview.postMessage({ partial: true, run: { ...head, segments } });
      return;
    }
    const { cancel, boardKey, ...shown } = run;
    // The webview's own zone can differ from the machine's (an hour behind on Windows, 5 November 2026), as the board's does.
    void panel.webview.postMessage({ run: { ...shown, segments, sent: sentText(run) }, ...hostClock() });
  }
}

/** What was sent: the exact packet when the call reported it, else the draft and its answers. */
const sentText = (run: Run) => run.prompt || [run.draft, run.answers ? `\nCLARIFICATION ANSWERS:\n${run.answers}` : ""].join("");
/** What a call used, from its usage report, for the result notes (item 8: the maximum-model policy's cost should be visible). */
export function usageNote(usage: any): string | undefined {
  const u = usage?.usage ?? usage;
  if (!u || typeof u !== "object") return undefined;
  const n = (k: string) => (typeof u[k] === "number" ? u[k] : 0);
  const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
  if (!total) return undefined;
  const cost = typeof usage?.totalCostUsd === "number" ? ", CLI estimate " + "$" + usage.totalCostUsd.toFixed(2) : "";
  return "Used " + total.toLocaleString("en") + " tokens (" + n("output_tokens").toLocaleString("en") + " written" + cost + ").";
}
/** At most n items in one line, then how many more (the receipt keeps the whole list). */
const firstOf = (list: string[], n = 20) => list.slice(0, n).join(", ") + (list.length > n ? `, and ${list.length - n} more` : "");
const where = (target: string) => target === "new" ? "under the new-task box" : "under this task's follow-up box";

/** Refine draft's result, as the board shows it. */
export function refineView(value: any, target: string): ResultView {
  const apply = `The result is also on the board ${where(target)}: apply it, or answer the questions, there.`;
  if (value.kind === "unchanged") return { text: "Your draft is already clear.", notes: [apply] };
  if (value.kind === "questions") return { text: value.questions.map((q: any) => [q.question, `Why: ${q.reason}`, q.suggested ? `Suggested answer: ${q.suggested}` : ""].filter(Boolean).join("\n")).join("\n\n"), notes: [apply] };
  return { text: value.revision, notes: [...(value.assumptions || []).map((a: string) => `Assumption: ${a}`), apply] };
}
/** Improve prompt's result: the execution prompt, or the contradictions that left it unfinished. */
export function improveView(result: any, target: string): ResultView {
  if (!result.rendered) return { text: (result.record?.conflicts || []).map((k: any) => `Earlier: ${k.earlier}\nLater: ${k.later}\nWhy: ${k.why}`).join("\n\n"),
    notes: ["Clarification is unfinished: a consequential contradiction remains. Edit the draft to resolve it, then improve it again."] };
  const t = result.tally;
  return { text: result.rendered.text, notes: [
    ...(t ? [`${t.requirements} requirements · ${t.criteria} checks · ${t.quarantined ?? 0} held back because the model assumed them · ${t.assumed} assumed facts sent as unconfirmed · ${t.mustAsk} questions to ask first`] : []),
    ...(result.quarantined || []).map((q: any) => `The model assumed this; not sent (${q.kind}): ${q.text}`),
    // One line per list: a pasted log gave hundreds of anchors, one paragraph each (Linux machine, 4 November 2026).
    ...(result.dropped?.length ? [`Possibly not carried into the prompt: ${firstOf(result.dropped)}`] : []),
    ...(result.sourceOnly?.length ? [`Only in pasted material, not as an instruction: ${firstOf(result.sourceOnly)}`] : []),
    ...(result.oversize ? [`This prompt is ${result.oversize.chars} characters, over the ${result.oversize.limit}-character limit: the board will not apply it.`] : []),
    ...(result.lint || []).map((f: any) => `Check: ${f.message} (${f.text})`),
    `The improved prompt is also on the board ${where(target)}: ${result.oversize ? "copy what you need from it there" : "apply it there"}.`] };
}
/** Review prompt's result: Astra's review, then each attempt's outcome. */
export function reviewView(result: any): ResultView {
  const v = result.review;
  const parts = v ? [v.overview, ...v.attempts.map((a: any) => [`${a.model}: ${a.approach}`, ...a.worked.map((w: string) => `Worked: ${w}`), ...a.didNotWork.map((w: string) => `Did not work: ${w}`)].join("\n")),
    v.comparison ? `Comparison: ${v.comparison}` : "", v.takeaways.length ? ["Takeaways:", ...v.takeaways.map((t: string) => `- ${t}`)].join("\n") : ""].filter(Boolean)
    : [`Astra could not review the attempts: ${result.reviewError}`];
  return { text: parts.join("\n\n"), notes: (result.attempts || []).map((a: any) => `${a.label} (${a.model || "no model"} · ${a.effort} effort): ${a.error ? `failed: ${a.error}` : a.status === "unfinished" ? "unfinished" : "finished"}`) };
}
