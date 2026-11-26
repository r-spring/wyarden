// Sync models (the user, 22 November 2026): the board's "Sync models" button asks one provider which models it lists now and updates
// Entomatical's list for it. Codex, Grok and Antigravity ask their own CLI (as the account scan does); Claude Code has no list command,
// so Claude asks the Anthropic API's /v1/models with ANTHROPIC_API_KEY and keeps the result across restarts.
import * as vscode from "vscode";
import { discoverAntigravityModels, antigravityListed, discoverGrokModels } from "./acp";
import { externalProviderAccounts } from "./accounts";
import { codexModels, discoverCodex } from "./codex";
import { setClaudeModelIds, type ModelProvider } from "./models";

const CLAUDE_KEY = "claudeModelIds";

/** Applies the Claude ids a past sync kept. */
export function restoreClaudeModels(state: vscode.Memento) {
  const kept = state.get<Record<string, string>>(CLAUDE_KEY);
  if (kept) setClaudeModelIds(Object.values(kept));
}

async function claudeListed(): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Claude Code has no command that lists models. Set ANTHROPIC_API_KEY in the environment VS Code starts with, then sync again.");
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`The Anthropic API answered ${res.status} ${res.statusText}.`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

/** Syncs one provider's list and returns what it now lists, for the message the user sees. */
export async function syncModels(provider: ModelProvider, state: vscode.Memento): Promise<string[]> {
  if (provider === "claude") {
    const ids = setClaudeModelIds(await claudeListed());
    await state.update(CLAUDE_KEY, ids);
    return Object.entries(ids).map(([f, id]) => `${f} → ${id}`);
  }
  if (provider === "codex") { await discoverCodex(); return codexModels().map((m) => m.model); }
  if (provider === "antigravity") { await discoverAntigravityModels(); return antigravityListed(); }
  // Grok reads `grok models` at every start already; syncing shows what each profile lists now.
  const profiles = externalProviderAccounts().filter((a) => a.provider === "grok");
  const lists = await Promise.all(profiles.map(async (a) => `${a.name}: ${(await discoverGrokModels(a.configDir)).ids.join(", ") || "none"}`));
  return lists;
}
