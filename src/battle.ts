// Battle Royale (the user, 14 November 2026): one prompt starts four cards at once, one per provider, each on that provider's top model at
// its top effort. Pure and OS-independent: the host (extension.ts) passes the accounts and the Codex models; node tests call it directly.
import { tryResolve } from "./models";

export type BattleProvider = "claude" | "codex" | "grok" | "antigravity";
export interface BattleEntry { provider: BattleProvider; label: string; account: string; model?: string; effort?: string }
export interface BattleLineup { lineup: BattleEntry[]; skipped: { provider: BattleProvider; label: string; reason: string }[] }

/** The order the cards are made in, and each provider's name on its card. */
export const BATTLE_PROVIDERS: { provider: BattleProvider; label: string }[] = [
  { provider: "claude", label: "Claude" }, { provider: "codex", label: "Codex" }, { provider: "grok", label: "Grok" }, { provider: "antigravity", label: "Antigravity" }];

/** Every card's prompt starts with this line and a blank line; `others` is how many other contestants have the task. */
const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven"];
export const battlePreamble = (others: number) =>
  `Battle Royale: ${COUNT_WORDS[others] ?? others} other ${others === 1 ? "model has" : "models have"} this same task. Nobody will answer a question or approve a plan. Decide for yourself and finish the task.`;
export const battlePrompt = (prepared: string, others: number) => `${battlePreamble(others)}\n\n${prepared}`;
/**
 * A card that runs in its card terminal because it is part of a battle (Task.battle), opener or not (the user, 14 November 2026: "we run
 * each of these in the card terminal mode ... And the same goes for each of its subagents that it spawns"): a contestant, an orchestrator
 * contestant, and every card they open. One a transfer made headless (board.ts moveCards) runs headless, as before.
 */
export const inCardTerminal = (t: { battle?: string; headless?: boolean }) => !!t.battle && !t.headless;
/** The battle's title when nobody named it: the first line of the user's prompt with words, as an untitled card's. */
export const battleFallbackTitle = (prompt: string) => prompt.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 60) || "Untitled";

/** Codex efforts, lowest first; an effort not named here ranks below them all. */
const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** A Codex model's top effort (Sol's by default): ultra, else the highest it lists; undefined when the Codex CLI lists no such model. */
export function solEffort(codexModels: readonly { model: string; efforts: readonly string[] }[], model = "sol"): string | undefined {
  const id = tryResolve("codex", model, codexModels.map((m) => m.model));
  const efforts = codexModels.find((m) => m.model === id)?.efforts ?? [];
  if (!id || !efforts.length) return undefined;
  if (efforts.includes("ultra")) return "ultra";
  return [...efforts].sort((a, b) => CODEX_EFFORTS.indexOf(a) - CODEX_EFFORTS.indexOf(b)).at(-1);
}

/** One contestant of the entomatical.battleRoyale.contestants setting. An empty model or effort is the provider's default. */
export interface BattleContestant { provider: BattleProvider; model?: string; effort?: string; account?: string }
/** The setting's default: Claude on Fable at max, Codex on Sol at its top effort, Grok on its defaults, Antigravity on Carbon at high. */
export const DEFAULT_CONTESTANTS: BattleContestant[] = [
  { provider: "claude", model: "fable", effort: "max" }, { provider: "codex", model: "sol" }, { provider: "grok" }, { provider: "antigravity", model: "carbon", effort: "high" }];
/** The most contestants one battle starts. */
export const MAX_CONTESTANTS = 8;

/** The setting as typed: entries with an unknown provider are dropped, text fields trimmed, at most 8 kept; nothing usable gives the default. */
export function contestantsFrom(raw: unknown): BattleContestant[] {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const list = (Array.isArray(raw) ? raw : []).flatMap((c): BattleContestant[] => {
    const provider = c && typeof c === "object" ? (c as Record<string, unknown>).provider : undefined;
    if (!BATTLE_PROVIDERS.some((p) => p.provider === provider)) return [];
    const o = c as Record<string, unknown>;
    return [{ provider: provider as BattleProvider, model: str(o.model), effort: str(o.effort), account: str(o.account) }];
  }).slice(0, MAX_CONTESTANTS);
  return list.length ? list : DEFAULT_CONTESTANTS;
}

/**
 * The line-up from the contestants setting (DEFAULT_CONTESTANTS when none is passed), in its order. Each runs on its own named account,
 * else on the form's account when it is that provider's, else on that provider's first account. A Codex contestant runs on Sol when it names
 * no model, and at its model's top effort when it names no effort; Grok's model and effort are never passed (the board refuses either in Grok's own terminal). A provider named
 * more than once is labelled "Claude 1", "Claude 2" and so on. A contestant whose account is missing (or a Codex model the CLI does not
 * list) is skipped. Throws, naming what is missing, when fewer than two contestants are left.
 */
export function battleLineup(accounts: readonly { name: string; provider?: string }[], picked: string,
  codexModels: readonly { model: string; efforts: readonly string[] }[], contestants: readonly BattleContestant[] = DEFAULT_CONTESTANTS): BattleLineup {
  const lineup: BattleEntry[] = [], skipped: BattleLineup["skipped"] = [];
  const seen = new Map<BattleProvider, number>();
  for (const c of contestants) {
    const { provider } = c, base = BATTLE_PROVIDERS.find((p) => p.provider === provider)!.label;
    const k = (seen.get(provider) ?? 0) + 1; seen.set(provider, k);
    const label = contestants.filter((x) => x.provider === provider).length > 1 ? `${base} ${k}` : base;
    const own = accounts.filter((a) => (a.provider ?? "claude") === provider);
    const account = c.account ? own.find((a) => a.name === c.account) : own.find((a) => a.name === picked) ?? own[0];
    if (!account) { skipped.push({ provider, label, reason: c.account ? `the ${base} account "${c.account}" is not signed in` : `no ${base} account is signed in` }); continue; }
    if (provider === "grok") { lineup.push({ provider, label, account: account.name }); continue; }
    const model = c.model || (provider === "codex" ? "sol" : undefined);
    let effort = c.effort || undefined;
    if (provider === "codex" && !effort) {
      effort = solEffort(codexModels, model);
      if (!effort) { skipped.push({ provider, label, reason: `the Codex CLI lists no ${model} model` }); continue; }
    }
    lineup.push({ provider, label, account: account.name, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  }
  if (lineup.length < 2) {
    const why = skipped.map((s) => `${s.label}: ${s.reason}`).join("; ");
    throw new Error(`Battle Royale needs at least two contestants, and ${lineup.length ? `only ${lineup[0].label} can run` : "none can run"}. ${why}.`);
  }
  return { lineup, skipped };
}
