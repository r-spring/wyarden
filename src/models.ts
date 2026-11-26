// Model names (plan fix 11, the user, 6 November 2026): a short name means the newest version of that model on its provider, today and
// after every release, and a full id of any version of a family runs the newest version too. Shared and OS-independent: the lists
// come from each provider (Codex model/list, `agy models`, an ACP account's advertised catalog), never from a fixed list here.
// Claude is the exception since 17 November 2026: its short names map to the fixed full ids in CLAUDE_MODEL_IDS below, and a Claude full id passes as it is (the user).
// Since 17 November 2026 only exact ids reach a CLI or an ACP session (isExactModel and exactModel at the end of this file).
export type ModelProvider = "claude" | "codex" | "grok" | "antigravity";

/** Claude's short names, the ones the board's lists show and a card stores (`task.model`). */
export const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"];
/**
 * The full id each short name is handed to Claude Code as (the user, 17 November 2026: "We can use shortcuts in our list, but we don't
 * want to use aliases at the coding level, or at the CLI level if we can help it. We want to be specific."). Every Claude launch path
 * maps through claudeModelId at the point of use: a card's settings file `model` (terminal, panel and headless sessions all pass it
 * with --settings), the helper calls' --model (worker.ts) and Finish's resolver (finish.ts headlessClaude). Stored cards keep the short
 * name. It also keeps plan mode on Haiku: Claude Code 2.1.326 plans on Sonnet for the alias `haiku`, not for the full id (F99,
 * docs/evidence/parity-win-2026-11-16/F99-plan-model.md, runs a, b and f).
 * To move to a newer model, change its one line here.
 */
export const CLAUDE_MODEL_IDS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
};
/** Claude's full ids from a model sync (src/model-sync.ts): the newest listed id of each family replaces its line above; unlisted families keep theirs. */
export function setClaudeModelIds(listed: readonly string[]) {
  for (const family of CLAUDE_FAMILIES) {
    const newest = newestOf("claude", family, listed.map((id) => id.replace(/-\d{8}$/, ""))); // the API's dated ids (…-20251001) name the same model
    if (newest) CLAUDE_MODEL_IDS[family] = newest.startsWith("claude-") ? newest : `claude-${newest}`;
  }
  return { ...CLAUDE_MODEL_IDS };
}
/** The id Claude Code is handed for a Claude model name: the full id for a short name, any other name (a full id already) as it is. */
export function claudeModelId(model: string): string;
export function claudeModelId(model: string | undefined): string | undefined;
export function claudeModelId(model: string | undefined) { return model && Object.prototype.hasOwnProperty.call(CLAUDE_MODEL_IDS, model) ? CLAUDE_MODEL_IDS[model] : model; }
/** Antigravity's effort is its own choice (--effort); `agy models` lists one id per effort, e.g. claude-opus-5-5-high. */
const EFFORT_SUFFIX = /-(low|medium|high)$/;
const nums = (text: string | undefined, sep: string | RegExp = ".") => (text ? text.split(sep).map(Number) : []);

/**
 * The family (its short name) and version of a model id or short name on a provider, or undefined for a name of no known shape
 * (Codex's hidden gpt-reserve and codex-auto-review, for one). A short name has an empty version.
 */
export function parseModel(provider: string, name: string): { family: string; version: number[] } | undefined {
  const s = name.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if (provider === "claude") return (m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+(?:-\d+)*))?$/.exec(s)) ? { family: m[1], version: nums(m[2], "-") } : undefined;
  if (provider === "codex") {
    if ((m = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(s))) return { family: m[2], version: nums(m[1]) };
    return /^[a-z]+$/.test(s) && s !== "gpt" ? { family: s, version: [] } : undefined;
  }
  if (provider === "grok") {
    if ((m = /^grok-(\d+(?:\.\d+)*)(?:-([a-z]+)(?:-[a-z0-9.-]+)?)?$/.exec(s))) return { family: m[2] ?? "grok", version: nums(m[1]) };
    return /^[a-z]+$/.test(s) ? { family: s, version: [] } : undefined;
  }
  if (provider === "antigravity") {
    const base = s.replace(EFFORT_SUFFIX, "");
    if ((m = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)$/.exec(base))) return { family: m[1], version: nums(m[2], "-") };
    if ((m = /^gemini-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(base))) return { family: m[2], version: nums(m[1]) };
    if ((m = /^gpt-oss-(\d+)b$/.exec(base))) return { family: "gpt-oss", version: [Number(m[1])] };
    return /^(?:[a-z]+|gpt-oss)$/.test(base) ? { family: base, version: [] } : undefined;
  }
  return undefined;
}

/** Versions compare as numbers, part by part (6.1 > 6 > 5.6), never as text: localeCompare orders "." against "-" by locale. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** The newest offered id of a family, or undefined. Among ids of one version (Antigravity's per-effort ids) the plain id wins, then high. */
export function newestOf(provider: string, family: string, offered: readonly string[]): string | undefined {
  const rank = (id: string) => (EFFORT_SUFFIX.test(id) ? ["low", "medium", "high"].indexOf(EFFORT_SUFFIX.exec(id)![1]) : 3);
  let best: { id: string; version: number[] } | undefined;
  for (const id of offered) {
    const p = parseModel(provider, id);
    if (!p || p.family !== family || !p.version.length || !isExactModel(provider, id)) continue; // a *-latest or *-preview id is never picked
    const d = best ? compareVersions(p.version, best.version) : 1;
    if (d > 0 || (d === 0 && rank(id) > rank(best!.id))) best = { id, version: p.version };
  }
  return best?.id;
}

/** The short names a provider offers now, each with the id it runs, in the order the provider lists them. */
export function shortNames(provider: string, offered: readonly string[]): { name: string; id: string }[] {
  if (provider === "claude") return CLAUDE_FAMILIES.map((name) => ({ name, id: name }));
  const out: { name: string; id: string }[] = [];
  for (const id of offered) {
    const family = parseModel(provider, id)?.family;
    const newest = family && !out.some((n) => n.name === family) ? newestOf(provider, family, offered) : undefined;
    if (family && newest) out.push({ name: family, id: newest });
  }
  return out;
}

/**
 * What a card stores: a full id of a known family becomes its short name (gpt-5.6-sol is "sol"); anything else stays as given. An
 * Antigravity id that carries its effort (gemini-3.8-flash-low) stays as it is: that effort is part of the choice.
 */
export function modelName(provider: string, name: string): string {
  const p = parseModel(provider, name);
  return p?.version.length && !(provider === "antigravity" && EFFORT_SUFFIX.test(name.trim().toLowerCase())) ? p.family : name;
}

/** "Fable 5.2", "Astra 6.2": a versioned id's name and version, for a menu (the user, 23 November 2026: no bare short names); any other name as it is. */
export function modelLabel(provider: string, id: string): string {
  const p = parseModel(provider, id);
  return p?.version.length ? `${familyLabel(p.family)} ${p.version.join(".")}` : id;
}

/** "Sol", "Opus", "GPT-OSS": a short name for a menu. */
export const familyLabel = (family: string) => (family === "gpt-oss" ? "GPT-OSS" : family.charAt(0).toUpperCase() + family.slice(1));

/**
 * The id to launch for a name. Claude returns the full id of the name's family (CLAUDE_MODEL_IDS, as a card's add() keeps any Claude id
 * as its family). The others return the newest offered id of the name's family; an id the provider offers that has no known shape is
 * returned as it is. Throws on a name nothing offered matches. A caller that launches checks the result with exactModel.
 */
export function resolveModel(provider: string, name: string, offered: readonly string[]): string {
  const p = parseModel(provider, name);
  if (provider === "claude") {
    if (p) return claudeModelId(p.family);
    throw new Error(`Unknown model ${name}. Valid: ${CLAUDE_FAMILIES.join(", ")}, or a full id of one of them.`);
  }
  // An Antigravity id that carries its effort runs the newest version with that same effort (gemini-3.7-flash-low → gemini-3.8-flash-low).
  // An exact id the provider lists runs as it is (the user, 23 November 2026: the menus list every model, so a pick is that model).
  if (offered.includes(name) && isExactModel(provider, name)) return name;
  const effort = provider === "antigravity" ? EFFORT_SUFFIX.exec(name.trim().toLowerCase())?.[1] : undefined;
  const id = p && newestOf(provider, p.family, effort ? offered.filter((o) => EFFORT_SUFFIX.exec(o)?.[1] === effort) : offered);
  if (id) return id;
  if (offered.includes(name)) return name;
  const valid = shortNames(provider, offered).map((n) => n.name);
  throw new Error(`Unknown model ${name}. Valid: ${valid.length ? `${valid.join(", ")}, or a full id of one of them` : "none listed yet"}.`);
}

/** resolveModel without the throw, for display. */
export function tryResolve(provider: string, name: string | undefined, offered: readonly string[]): string | undefined {
  if (!name) return undefined;
  try { return resolveModel(provider, name, offered); } catch { return undefined; }
}

/** Names a provider resolves itself: never sent as a model (the user, 17 November 2026), including moving ids such as grok-4-latest or gemini-flash-preview. */
const ALIASES = /^(default|auto|latest|best|recommended)$|(^|-)(latest|preview)$/i;
/**
 * Whether a model id is exact (the user, 17 November 2026: "All models from all providers must be called by their exact model names so
 * there is never a mixup for any reason."): a versioned id of a known family (claude-opus-5-5, gpt-6.2-sol, grok-4.7,
 * gemini-4-argon), or a provider's own id of no known shape (gpt-reserve, gemini-pro-orchestrator). Not exact: no name, a short name
 * (opus, sol, grok, argon), an alias such as default or auto, or an id that moves (one ending in latest or preview). Claude needs the claude-<family>-<version> form.
 */
export function isExactModel(provider: string, id: string | undefined): boolean {
  const s = id?.trim();
  if (!s || ALIASES.test(s)) return false;
  const p = parseModel(provider, s);
  if (provider === "claude") return !!p?.version.length && /^claude-/i.test(s);
  return p ? p.version.length > 0 : /[-\d]/.test(s);
}
const PROVIDER_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok", antigravity: "Antigravity" };
/** The id as it is when it is exact (isExactModel); otherwise a plain refusal that names the model that would have been sent. */
export function exactModel(provider: string, id: string | undefined): string {
  if (isExactModel(provider, id)) return id!.trim();
  throw new Error(`${PROVIDER_LABELS[provider] ?? provider} would be handed ${id?.trim() ? `"${id.trim()}"` : "no model"}, not an exact model id, so nothing was started. Entomatical names every model by its exact id.`);
}
