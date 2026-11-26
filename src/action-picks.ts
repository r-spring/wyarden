// Right-click picks for the buttons that call a helper model (F102, the user, 13 November 2026): "Any button that does an action that uses
// an agent should be right-clickable into a menu where you can pick a different default provider/model/effort/permissions." Each pick is
// the new default for that action, kept per profile in VS Code's globalState (src/extension.ts) and shown on the board. A pick with nothing
// in it is today's behaviour exactly. Shared and OS-independent.
import { CLAUDE_FAMILIES, tryResolve, type ModelProvider } from "./models";
import type { CodexModel } from "./codex";

/** The actions a pick belongs to: Refine draft, Improve prompt (and Improve with these answers), a card's Review, a card's Finish. */
export const PICK_ACTIONS = ["refine", "improve", "review", "finish"] as const;
export type ActionKey = (typeof PICK_ACTIONS)[number];
/**
 * account: run on this signed-in account instead of the action's own (the form's account, or the card's). provider: the provider the
 * model and effort were picked for; they apply only while the account that runs the action is on that provider, else its defaults do.
 * permission: Finish's conflict resolver only (FINISH_PERMISSIONS); the other helpers run without tools.
 */
export interface ActionPick { account?: string; provider?: ModelProvider; model?: string; effort?: string; permission?: string }
export type ActionPicks = Partial<Record<ActionKey, ActionPick>>;
/** The globalState key the picks are kept under. */
export const PICKS_KEY = "entomatical.actionPicks";
/** Ordered low to high, for "the highest effort a Codex model lists". */
export const HELPER_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PROVIDERS: ModelProvider[] = ["claude", "codex", "grok", "antigravity"];
/** Finish's conflict resolver (finish.ts headlessClaude) runs `claude -p`, where nobody can answer an ask: so no Ask here. Default: acceptEdits. */
export const FINISH_PERMISSIONS: Record<string, string> = { edits: "acceptEdits", auto: "auto", bypass: "bypassPermissions" };

const word = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().length <= 200 && !/[\x00-\x1f\x7f]/.test(v) ? v.trim() : undefined);

/** A pick as the webview sent it, checked field by field; undefined when nothing is left (Reset to default). Throws on an unknown action. */
export function cleanPick(action: unknown, raw: unknown): { action: ActionKey; pick?: ActionPick } {
  if (!PICK_ACTIONS.includes(action as ActionKey)) throw new Error(`Unknown action ${String(action)}.`);
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick: ActionPick = {};
  // Finish runs on the card's own Claude account, which holds its conversation, so it takes no account.
  if (action !== "finish" && word(r.account)) pick.account = word(r.account);
  const provider = PROVIDERS.includes(r.provider as ModelProvider) ? r.provider as ModelProvider : undefined;
  if (provider && (word(r.model) || word(r.effort)) && (action !== "finish" || provider === "claude")) {
    pick.provider = provider;
    if (word(r.model)) pick.model = word(r.model);
    if (word(r.effort)) pick.effort = word(r.effort);
  }
  if (action === "finish" && typeof r.permission === "string" && FINISH_PERMISSIONS[r.permission]) pick.permission = r.permission;
  return { action: action as ActionKey, pick: Object.keys(pick).length ? pick : undefined };
}

/** The picks kept in globalState, each one checked again; anything unreadable is dropped. */
export function readPicks(stored: unknown): ActionPicks {
  const out: ActionPicks = {};
  if (!stored || typeof stored !== "object") return out;
  for (const [action, raw] of Object.entries(stored)) {
    try { const c = cleanPick(action, raw); if (c.pick) out[c.action] = c.pick; } catch { /* an action this build does not know */ }
  }
  return out;
}

/**
 * The model and effort an action runs on: the pick's where it was made for this provider and names something the provider takes, else
 * base's. base is a thunk because a Codex default can throw (no Astra listed); a pick that names a listed model does not need it.
 * Claude: any Claude family and low to max. Codex: a short name or id the CLI lists, and an effort that model lists (else the default's
 * effort when listed, else its highest). Grok, Antigravity: what the account advertised; the board has no fixed list of them.
 */
export function applyPick(provider: ModelProvider, pick: ActionPick | undefined, base: () => { model: string; effort: string }, codex: CodexModel[] = []):
  { model: string; effort: string; picked: boolean } {
  const fallback = () => ({ ...base(), picked: false });
  if (!pick || pick.provider !== provider || (!pick.model && !pick.effort)) return fallback();
  if (provider === "claude") {
    const b = base();
    const model = pick.model && CLAUDE_FAMILIES.includes(pick.model) ? pick.model : b.model;
    const effort = pick.effort && CLAUDE_EFFORTS.includes(pick.effort) ? pick.effort : b.effort;
    return { model, effort, picked: model !== b.model || effort !== b.effort };
  }
  if (provider === "codex") {
    let b: { model: string; effort: string } | undefined;
    try { b = base(); } catch { /* no default: the pick must name a model */ }
    const model = (pick.model && tryResolve("codex", pick.model, codex.filter((m) => !(m as { hidden?: boolean }).hidden).map((m) => m.model))) || b?.model;
    if (!model) return fallback(); // throws base's own error
    const efforts = codex.find((m) => m.model === model)?.efforts ?? [];
    const effort = pick.effort && efforts.includes(pick.effort) ? pick.effort : b && efforts.includes(b.effort) ? b.effort
      : [...efforts].sort((x, y) => HELPER_EFFORT_ORDER.indexOf(x) - HELPER_EFFORT_ORDER.indexOf(y)).at(-1);
    if (!effort) return fallback();
    return { model, effort, picked: model !== b?.model || effort !== b?.effort };
  }
  const b = base();
  const model = pick.model || b.model, effort = pick.effort || b.effort;
  return { model, effort, picked: model !== b.model || effort !== b.effort };
}

/** Finish's two helper calls with a pick: the commit message (Haiku at the CLI's default effort unless picked) and the conflict resolver
 *  (the task's session model and effort unless picked, acceptEdits unless picked). Only a Claude pick applies. */
export function finishRun(pick: ActionPick | undefined): { messageModel: string; messageEffort?: string; model?: string; effort?: string; permission: string } {
  const claude = pick?.provider === "claude";
  const model = claude && pick?.model && CLAUDE_FAMILIES.includes(pick.model) ? pick.model : undefined;
  const effort = claude && pick?.effort && CLAUDE_EFFORTS.includes(pick.effort) ? pick.effort : undefined;
  return { messageModel: model ?? "haiku", messageEffort: effort, model, effort, permission: FINISH_PERMISSIONS[pick?.permission ?? ""] ?? "acceptEdits" };
}
