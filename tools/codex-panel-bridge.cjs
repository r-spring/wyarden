// Entomatical's private bridge for the installed Codex IDE extension. The bridge is loaded by a version-checked patch inside
// that extension, so both the panel and these requests use the extension's own app-server connection.
"use strict";

module.exports = function installCodexPanelBridge(vscode, connection, subscriptions, webviews) {
  const provider = "entomatical-panel";
  const pending = new Map();
  const turns = new Map();
  const starts = new Map();
  let sequence = 0;
  let initialized = !!connection.initialized;
  let initializationError;
  const waiting = new Set();
  class UnknownOutcome extends Error {}

  // Only the source module lives beside our hook. A bare entomatical-panel-bridge.cjs from an older installer has no classifier.
  const asks = installCodexPanelBridge.asks ?? (require("node:path").basename(__filename) === "codex-panel-bridge.cjs"
    ? require("../hook/hook.js").asks : undefined);
  // Before acknowledgement any same-thread terminal may belong to another turn. Bound full answers per launch.
  const maxEarlyReplies = 4;
  const maxEarlyReplyBytes = 128 * 1024; // UTF-8 text and item ID together; at most 512 KiB across four replies
  function terminalEvidence({ params, error }, byteLimit = Infinity) {
    const { threadId, turn } = params;
    if (turn.status !== "completed" || turn.error !== null || error != null || params.error != null
      || (params.turnId !== undefined && params.turnId !== turn.id)
      || (turn.threadId !== undefined && turn.threadId !== threadId)) return;
    const success = { outcome: "completed" };
    if (!byteLimit) return success;
    const finals = Array.isArray(turn.items) ? turn.items.filter(item => item?.type === "agentMessage" && item.phase === "final_answer") : [];
    if (finals.length !== 1) return success;
    const [item] = finals;
    if (typeof item.id !== "string" || typeof item.text !== "string"
      || (byteLimit !== Infinity && Buffer.byteLength(item.id) + Buffer.byteLength(item.text) > byteLimit)
      || !item.id.trim() || !item.text.trim()
      || (item.turnId !== undefined && item.turnId !== turn.id)
      || (item.threadId !== undefined && item.threadId !== threadId)
      || turn.items.some(other => other !== item && other?.id === item.id)) return success;
    return { ...success, finalAnswer: { itemId: item.id, text: item.text, ...(asks && { asks: asks(item.text) }) } };
  }

  const report = (active, method, status, turnId, evidence) => {
    void vscode.commands.executeCommand("entomatical.codexPanelEvent", {
      taskId: active.taskId, launchToken: active.launchToken, threadId: active.threadId, turnId, method, status,
      ...(evidence && { terminalEvidence: evidence }),
    }).then(undefined, () => {});
  };
  const complete = (active, { status, evidence }, buffered = false) => {
    active.completed = true;
    active.status = status;
    turns.delete(active.threadId);
    pending.delete(active.expiredInterruptId);
    // CancelStart already placed the card in interrupted Review. Settle B locally without replaying its earlier success.
    if (buffered && active.cancelled && status === "completed") return;
    report(active, "turn/completed", status, active.turnId, evidence);
  };

  const fail = (error) => {
    initializationError = error instanceof Error ? error : new Error(String(error));
    for (const item of waiting) item.reject(initializationError);
    waiting.clear();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new UnknownOutcome(initializationError.message)); }
    pending.clear();
  };
  subscriptions.push(connection.registerProvider(provider, {
    onInitialized() {
      initialized = true;
      initializationError = undefined;
      for (const item of waiting) item.resolve();
      waiting.clear();
    },
    onFatalError(error) { initialized = false; fail(error); },
    onResult(message) {
      const id = String(message.id);
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      item.onReply?.(message.error, id);
      if (message.error) item.reject(new Error(message.error.message || "Codex rejected the request"));
      else item.resolve(message.result);
    },
    onNotification(message) {
      const threadId = message.params?.threadId;
      const active = turns.get(threadId);
      if (!active) return;
      const { method } = message;
      if (method === "thread/status/changed") {
        active.threadStatus = message.params.status;
        if (!active.cancelled || active.interruptRefused || active.threadStatus?.type !== "active") report(active, method, active.threadStatus);
        return;
      }
      if (method !== "turn/started" && method !== "turn/completed") return;
      const { id, status } = message.params.turn ?? {};
      if (typeof id !== "string" || !id.trim()) return;
      if (!active.early && id !== active.turnId) return;
      if (active.early) {
        const { eventsByTurn, replies } = active.early;
        const events = eventsByTurn.get(id) ?? new Map();
        const first = events.get(method);
        const keepReply = first ? !!first.evidence?.finalAnswer : replies.size < maxEarlyReplies;
        const evidence = method === "turn/completed" && !active.cancelled
          ? terminalEvidence(message, keepReply ? maxEarlyReplyBytes : 0) : undefined;
        if (!first) {
          events.set(method, { status, evidence });
          if (evidence?.finalAnswer) replies.add(evidence);
        } else if (first.evidence) {
          // Preserve the legacy first status. Only carry evidence that the buffered terminal notices agree on.
          if (!evidence || first.evidence.finalAnswer?.itemId !== evidence.finalAnswer?.itemId
            || first.evidence.finalAnswer?.text !== evidence.finalAnswer?.text) {
            replies.delete(first.evidence);
            delete first.evidence.finalAnswer;
            if (!evidence) first.evidence = undefined;
          }
        }
        eventsByTurn.set(id, events);
      } else if (method === "turn/completed") complete(active, { status, evidence: terminalEvidence(message) });
      else report(active, method, status, id);
    },
  }));

  const ready = async () => {
    if (initialized) return;
    if (initializationError) throw initializationError;
    await new Promise((resolve, reject) => {
      const item = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => { waiting.delete(item); reject(new Error("Codex's panel process did not start in time")); }, 15_000);
      waiting.add(item);
    });
  };
  const send = (method, params, { onTimeout, interruptTarget, onReply } = {}) => {
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => {
        if (onTimeout) return onTimeout(); // keep the original request ID for a late answer
        // The caller gets its timeout now. Only the latest interrupt on a live turn retains a route for its late reply.
        if (interruptTarget && !interruptTarget.completed) interruptTarget.expiredInterruptId = id;
        else pending.delete(id);
        reject(new UnknownOutcome(`Codex did not answer ${method}; its outcome is unknown`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer, onReply });
      try { connection.sendRequest(provider, id, method, params); }
      catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(method === "turn/start" ? new UnknownOutcome(String(e?.message ?? e)) : e);
      }
    });
  };
  const request = async (method, params, onTimeout) => {
    await ready();
    return send(method, params, { onTimeout });
  };

  const interrupt = (active) => {
    // CancelStart and the board's Stop after a late launch result can race.
    if (active.stopping) return active.stopping;
    const stopping = ready().then(() => {
      // An exact completion or late acceptance can settle Stop while the transport is becoming ready.
      if (turns.get(active.threadId) !== active || active.stopping !== stopping) return;
      if (initializationError) throw initializationError; // disconnected after ready() resolved
      pending.delete(active.expiredInterruptId);
      active.expiredInterruptId = undefined;
      active.interruptRefused = false;
      return send("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, {
        interruptTarget: active,
        onReply(error, id) {
          if (error) {
            active.interruptRefused = true;
            if (active.stopping === stopping) active.stopping = undefined;
          } else if (active.expiredInterruptId === id) {
            // The caller already saw the timeout; subsequent Stops share the confirmed acceptance.
            active.stopping = Promise.resolve();
          }
          active.expiredInterruptId = undefined;
        },
      });
    }).catch(error => {
      if (active.stopping === stopping) active.stopping = undefined;
      if (!active.completed) throw error;
    });
    active.stopping = stopping;
    return stopping;
  };

  const openPanel = async (threadId, title) => {
    const uri = vscode.Uri.from({ scheme: "openai-codex", authority: "route", path: `/local/${threadId}` });
    await vscode.commands.executeCommand("vscode.openWith", uri, "chatgpt.conversationEditor", { preview: false, preserveFocus: true });
    // Wait for Codex's own renderer-ready signal, so a failed webview never starts an unseen task.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const entry = [...(webviews?.editorPanels?.entries() ?? [])].find(([, state]) => state.initialRoute === `/local/${threadId}` && state.ready);
      if (entry) {
        if (title) { entry[0].__entomaticalTitle = true; entry[0].title = title; }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Codex's panel did not become ready; the task was not started");
  };

  const startPanel = async (options) => {
    if (!options || typeof options.taskId !== "string" || !options.taskId || typeof options.cwd !== "string" || !options.cwd
      || typeof options.prompt !== "string" || !options.prompt.trim()) throw new Error("A task id, worktree and prompt are required");
    const { sandbox, approvalPolicy } = options;
    if (approvalPolicy !== "never" || !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
      throw new Error("This Codex panel requires an explicit sandbox and cannot answer approvals. Start the card in a Codex terminal.");
    }
    const active = { taskId: options.taskId, launchToken: options.launchToken, cancelled: false, completed: false };
    if (options.launchToken) starts.set(options.launchToken, active);
    try {
    const started = await request("thread/start", {
      cwd: options.cwd, ...(options.model ? { model: options.model } : {}),
      sandbox, approvalPolicy,
      ...(options.hooks || options.env ? { config: { ...(options.hooks || {}), ...(options.env ? { "shell_environment_policy.set": options.env } : {}) } } : {}),
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new Error("Codex did not return a thread id");
    if (active.cancelled) throw new Error("The task was cancelled before its panel opened");
    if (options.named && options.title?.trim()) {
      await request("thread/name/set", { threadId, name: options.title.trim() });
    } else {
      // A brand-new unnamed thread is not resumable until it is materialized. Record the worktree's existing commit without
      // inventing a title or a model turn; this leaves Codex free to name the conversation itself.
      if (typeof options.gitSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(options.gitSha)) throw new Error("The worktree's commit is required for an unnamed panel task");
      await request("thread/metadata/update", { threadId, gitInfo: { sha: options.gitSha } });
    }
    if (options.launchToken) {
      const accepted = await vscode.commands.executeCommand("entomatical.codexPanelPrepared", {
        taskId: options.taskId, launchToken: options.launchToken, threadId, transcript: started.thread.path,
      });
      if (!accepted) throw new Error("The task was cancelled before its panel opened");
    }
    await openPanel(threadId, options.named ? options.title?.trim() : undefined);
    if (options.launchToken && !(await vscode.commands.executeCommand("entomatical.codexPanelCanStart", {
      taskId: options.taskId, launchToken: options.launchToken, threadId,
    }))) throw new Error("The task was cancelled before its prompt was sent");
    if (active.cancelled) throw new Error("The task was cancelled before its prompt was sent");
    if (turns.has(threadId)) throw new Error("Codex returned a thread with a pending panel dispatch");
    active.threadId = threadId;
    active.early = { eventsByTurn: new Map(), replies: new Set() };
    turns.set(threadId, active);
    const identity = { threadId, transcript: started.thread.path, ...(options.launchToken ? { launchToken: options.launchToken } : {}) };
    const unknown = () => ({ ...identity, completed: false, threadStatus: active.threadStatus, uncertain: true });
    const unidentified = () => {
      active.early = undefined;
      if (active.cancelled) void vscode.window.showWarningMessage("Entomatical: Codex did not identify the panel turn to stop.");
      return unknown();
    };
    let timedOut = false;
    const timeout = Promise.withResolvers();
    active.dispatch = request("turn/start", {
      threadId, input: [{ type: "text", text: options.prompt }], ...(options.effort ? { effort: options.effort } : {}),
    }, () => { timedOut = true; timeout.resolve(unknown()); }).then(async result => {
      const id = result?.turn?.id;
      if (typeof id !== "string" || !id.trim()) return unidentified();
      active.turnId = id;
      if (timedOut) report(active, "dispatch/accepted", undefined, id);
      const events = active.early.eventsByTurn.get(id);
      active.early = undefined;
      if (events?.has("turn/started")) report(active, "turn/started", events.get("turn/started").status, id);
      if (events?.has("turn/completed")) complete(active, events.get("turn/completed"), true);
      if (active.cancelled && !active.completed) {
        // CancelStart returned before the RPC identified the turn. Deliver any eventual refusal to the user.
        try { await interrupt(active); }
        catch (error) { void vscode.window.showWarningMessage(`Entomatical: could not stop Codex's panel turn: ${error.message}`); }
      }
      return { ...identity, turnId: id, completed: active.completed, status: active.status, threadStatus: active.threadStatus };
    }, error => {
      if (error instanceof UnknownOutcome) return unidentified();
      active.early = undefined;
      turns.delete(threadId);
      if (timedOut) report(active, "dispatch/rejected", error.message);
      throw error;
    });
    return await Promise.race([active.dispatch, timeout.promise]);
    } finally {
      const release = () => { if (starts.get(active.launchToken) === active) starts.delete(active.launchToken); };
      // A timeout result can still be in transit when the Board cancels by token. Keep it until the original RPC settles.
      if (active.early && active.dispatch) void active.dispatch.then(release, release);
      else release();
    }
  };
  subscriptions.push(vscode.commands.registerCommand("entomatical.codexPanelStartWithPermissions", startPanel));

  subscriptions.push(vscode.commands.registerCommand("entomatical.codexPanelCancelStart", async (launchToken) => {
    if (!launchToken) return;
    // The original RPC can settle before the Board receives its result. Its acknowledged turn still owns the token.
    const active = starts.get(launchToken) ?? [...turns.values()].find(turn => turn.launchToken === launchToken && turn.turnId);
    if (!active) return;
    active.cancelled = true;
    if (active.early) {
      for (const evidence of active.early.replies) delete evidence.finalAnswer;
      active.early.replies.clear();
    }
    if (active.turnId && !active.completed) await interrupt(active);
  }));

  subscriptions.push(vscode.commands.registerCommand("entomatical.codexPanelStop", async (threadId) => {
    const active = turns.get(threadId);
    if (active?.early) {
      // Keep this exact launch across the wait, even if the thread route changes before the reply.
      try { await active.dispatch; } catch { return; } // explicit turn/start rejection: nothing to stop
      if (active.completed) return;
    }
    if (!active?.turnId) throw new Error("Codex has not reported an active turn to stop");
    await interrupt(active);
  }));
  subscriptions.push(vscode.commands.registerCommand("entomatical.codexPanelStartWithTokenStopV1", startPanel));
};
