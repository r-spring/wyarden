// Claude accounts: one config folder each (~/.claude, or a folder in ~/.claude-accounts). Plus the one Codex account (~/.codex).
// Logging in and out goes through each CLI's own login and logout commands; Entomatical never sees the login itself.
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { ACCOUNTS_ROOT, sameFolder, Usage, accountFolders, accountStatuses, authStatus, claudeAccountEnv, discoverAccounts, forgetAuthStatus, freshAuthStatus, meantFor, readUsage, USAGE_DIR, usageKey, writeFileAtomic } from "./sessions";
import { queryUsage } from "./usage";
import { recordUsage } from "./usage-history";
import { discoverAntigravityModels } from "./acp";
import { CODEX_DIR, codexCommand, codexStatus, codexUsage, discoverCodex } from "./codex";
import { Recent, antigravityRecent, antigravitySignIn, grokRecent, grokSignIn } from "./providerUsage";

/** The latest reading, kept in the account's history too (usage-history.ts) so a task's cost can be worked out later. */
const usageRow = (configDir: string) => {
  const usage = readUsage(configDir);
  recordUsage(usageKey(configDir), usage);
  return usage;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const changed = new vscode.EventEmitter<void>();
/** Fires after the account list was rescanned. */
export const onAccountsChanged = changed.event;

let state: vscode.Memento;
export function initAccounts(globalState: vscode.Memento) {
  state = globalState;
  void rescan();
}

/** `oneAtATime`: for the 15-minute poll, which nobody waits on; each account's check and usage query starts a CLI. */
export async function rescan(refreshUsage = false, oneAtATime = false) {
  // F88: what the shared Antigravity sign-in has, for the new-task form's model menu, only once Antigravity was connected here; a
  // short name runs the newest id it lists (F92).
  await Promise.all([discoverAccounts(oneAtATime, expected()), discoverCodex(), ...(state?.get<boolean>("antigravityAccount", false) ? [discoverAntigravityModels()] : [])]);
  // A signed-in folder that belongs to no email yet (logged in outside Entomatical) is bound to the email it holds now, so a later
  // login of another account into it is caught.
  const unbound = accountStatuses().filter((s) => s.loggedIn && s.email && !meantFor(s.configDir, expected()));
  if (state && unbound.length) await state.update("expectedEmails", { ...expected(), ...Object.fromEntries(unbound.map((s) => [s.configDir, s.email!])) });
  changed.fire();
  // No Codex session reports usage to Entomatical, so its reading is asked for when missing or older than 15 minutes.
  const codex = codexStatus()?.loggedIn && (refreshUsage || !((readUsage(CODEX_DIR)?.at ?? 0) > Date.now() - 15 * 60_000));
  const dirs = [...(refreshUsage ? accountStatuses().filter((s) => s.loggedIn).map((s) => s.configDir) : []), ...(codex ? [CODEX_DIR] : [])];
  if (oneAtATime) for (const dir of dirs) await refreshAccountUsage(dir);
  else await Promise.all(dirs.map(refreshAccountUsage));
}

const usageRequests = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const usageErrors = new Map<string, string>();

/** Coalesce repeated clicks, and discard requests invalidated by login/logout. */
export function refreshAccountUsage(dir: unknown): Promise<void> {
  const codex = dir === CODEX_DIR;
  const configDir = codex ? CODEX_DIR : known(dir);
  const pending = usageRequests.get(configDir);
  if (pending) return pending.promise;
  const controller = new AbortController();
  usageErrors.delete(configDir);
  const promise = (codex ? codexUsage(controller.signal) : queryUsage(configDir, controller.signal)).then((usage) => {
    if (controller.signal.aborted) return;
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    writeFileAtomic(path.join(USAGE_DIR, `${usageKey(configDir)}.json`), JSON.stringify(usage));
    // null records a missing or ambiguous five-hour reading. Codex has no readings log.
    if (!codex) fs.appendFileSync(path.join(USAGE_DIR, `${usageKey(configDir)}.readings.jsonl`), JSON.stringify({ ...usage, fiveHour: usage.fiveHour ?? null, fiveHourResets: usage.fiveHourResets ?? null }) + "\n");
  }).catch((error) => {
    if (!controller.signal.aborted) usageErrors.set(configDir, error instanceof Error ? error.message : "Usage refresh failed. Try Refresh again.");
  }).finally(() => {
    if (usageRequests.get(configDir)?.controller === controller) usageRequests.delete(configDir);
    changed.fire();
  });
  usageRequests.set(configDir, { controller, promise });
  changed.fire();
  return promise;
}

function cancelUsage(configDir: string) {
  usageRequests.get(configDir)?.controller.abort();
  usageRequests.delete(configDir);
  usageErrors.delete(configDir);
}

export function disposeAccounts() {
  for (const dir of usageRequests.keys()) cancelUsage(dir);
}

/** The email each folder is meant for, as typed when logging in through Entomatical. Lower case, like the CLI's. */
const expected = (): Record<string, string> =>
  Object.fromEntries(Object.entries(state?.get<Record<string, string>>("expectedEmails", {}) ?? {}).map(([dir, e]) => [dir, e.toLowerCase()]));
/** Match the normalized addresses returned by the CLI. */
const normal = (email: string | undefined) => email?.trim().toLowerCase();
const label = (configDir: string) => (configDir ? path.basename(configDir) : "main (~/.claude)");

export interface AccountRow {
  configDir: string;
  /** Unset for Claude. */
  provider?: "codex" | "grok" | "antigravity";
  active: boolean;
  folder: string;
  loggedIn: boolean;
  email?: string;
  plan?: string;
  /** Set when the folder is logged into a different email than it was meant for. */
  expected?: string;
  /** Other folders logged into the same email. */
  sameAs?: string;
  /** An extra Grok profile can be moved to the trash; its default home cannot. */
  removable?: boolean;
  /** Grok and Antigravity (F93): tokens their sessions used on this machine, from the CLIs' own files. */
  recent?: Recent;
  /** Antigravity: when agy's log last recorded the sign-in. */
  seenAt?: number;
  /** The CLI's latest 5-hour and weekly quota reading for this folder, if any session has reported one. */
  usage?: Usage;
  usageRefreshing: boolean;
  usageError?: string;
}

export function accountRows(): AccountRow[] {
  const all = accountStatuses();
  const codex = codexStatus(); // undefined: Codex is not installed, so it gets no row
  const codexRow: AccountRow[] = codex ? [{
    configDir: CODEX_DIR, provider: "codex", active: false, folder: "Codex (~/.codex)", loggedIn: codex.loggedIn, email: codex.email, plan: codex.plan,
    usage: usageRow(CODEX_DIR), usageRefreshing: usageRequests.has(CODEX_DIR), usageError: usageErrors.get(CODEX_DIR) ?? codex.error,
  }] : [];
  return [...all.map((s) => {
    const want = meantFor(s.configDir, expected());
    const twins = all.filter((o) => o !== s && o.loggedIn && s.loggedIn && o.email === s.email).map((o) => label(o.configDir));
    return {
      configDir: s.configDir,
      active: sameFolder(s.configDir, activeConfigDir()),
      folder: label(s.configDir),
      loggedIn: s.loggedIn,
      email: s.email,
      plan: s.plan,
      expected: want && s.loggedIn && want !== s.email ? want : undefined,
      sameAs: twins.length ? twins.join(", ") : undefined,
      usage: usageRow(s.configDir),
      usageRefreshing: usageRequests.has(s.configDir),
      usageError: usageErrors.get(s.configDir),
    };
  }), ...codexRow, ...grokFolders().map((dir): AccountRow => {
    const { signedIn, email, recent } = providerInfo(`grok:${dir}`, () => ({ ...grokSignIn(dir), recent: grokRecent(dir) }));
    return { configDir: dir, provider: "grok", active: false, folder: dir === GROK_DEFAULT ? "Default (~/.grok)" : path.basename(dir),
      removable: dir !== GROK_DEFAULT, loggedIn: !!signedIn, email, recent, usageRefreshing: false };
  }), ...(state.get<boolean>("antigravityAccount", false) ? [((): AccountRow => {
    const { email, at, recent } = providerInfo("antigravity", () => ({ ...antigravitySignIn(), recent: antigravityRecent() }));
    return { configDir: "", provider: "antigravity", active: false, folder: "Shared Google sign-in", loggedIn: !!email, email, seenAt: at, recent, usageRefreshing: false };
  })()] : [])];
}
// F93: the Grok and Antigravity rows read the CLIs' own files; accountRows() runs on every board update, so each read is reused for a minute.
const providerCache = new Map<string, { at: number; info: { signedIn?: boolean; email?: string; at?: number; recent?: Recent } }>();
function providerInfo(key: string, read: () => { signedIn?: boolean; email?: string; at?: number; recent?: Recent }) {
  const hit = providerCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.info;
  let info: { signedIn?: boolean; email?: string; at?: number; recent?: Recent } = {};
  try { info = read(); } catch (e) { console.error("Entomatical: provider account info", e); }
  providerCache.set(key, { at: Date.now(), info });
  return info;
}

/** The IDE setting is the source of truth, including changes made outside Entomatical. */
type EnvEntry = { name: string; value: string };
const ideEnv = (): EnvEntry[] => vscode.workspace.getConfiguration("claudeCode").get<EnvEntry[]>("environmentVariables", []);
export function activeConfigDir(): string {
  const configured = ideEnv().filter((e) => e.name.toUpperCase() === "CLAUDE_CONFIG_DIR" && path.isAbsolute(e.value)).pop()?.value;
  const dir = configured ?? process.env.CLAUDE_CONFIG_DIR ?? "";
  return sameFolder(dir, "") ? "" : dir;
}

/** Select a previously signed-in folder through Claude Code's native environment setting. */
export async function useAccount(dir: unknown): Promise<void> {
  const configDir = known(dir);
  const current = await authStatus(configDir);
  if (!current.loggedIn) throw new Error("This account is not signed in. Log in, then try again.");
  const want = meantFor(configDir, expected());
  if (want && current.email !== want) throw new Error("This folder is signed in as a different account. Log in again to fix it.");
  if (!configDir && process.env.CLAUDE_CONFIG_DIR && !sameFolder(process.env.CLAUDE_CONFIG_DIR, "")) {
    throw new Error("VS Code inherited another CLAUDE_CONFIG_DIR. Restart VS Code without that variable to select the main account.");
  }
  const config = vscode.workspace.getConfiguration("claudeCode");
  const env = ideEnv().filter((e) => e.name.toUpperCase() !== "CLAUDE_CONFIG_DIR");
  if (configDir) env.push({ name: "CLAUDE_CONFIG_DIR", value: configDir });
  await config.update("environmentVariables", env, vscode.ConfigurationTarget.Global);
  await rescan();
  void vscode.window.showInformationMessage(`Claude IDE default: ${current.email || label(configDir)}. New chats use this account; existing sessions keep theirs. Reload the window if Claude still shows the previous account.`);
}

export async function pickAccount(): Promise<void> {
  await rescan();
  const rows = accountRows().filter((r) => r.loggedIn && !r.expected && !r.provider);
  if (!rows.length) return addAccount();
  const pick = await vscode.window.showQuickPick(rows.map((r) => ({
    label: r.email || r.folder,
    description: [r.active && "IDE default", r.plan, r.sameAs && r.folder].filter(Boolean).join(" · "),
    detail: r.usage ? "Usage readings are shown in the Entomatical Accounts section." : "Usage not reported yet.",
    configDir: r.configDir,
  })), { title: "Switch Claude account", placeHolder: "Default for new IDE chats and new board tasks (all VS Code windows)" });
  if (pick) await useAccount(pick.configDir);
}

/** Only folders Entomatical lists may be acted on (the request comes from the webview). */
function known(configDir: unknown): string {
  if (typeof configDir !== "string" || !accountFolders().includes(configDir)) throw new Error("Unknown account folder.");
  return configDir;
}

/**
 * A folder Add account may create: directly inside ~/.claude-accounts, with a plain name, not there yet.
 * A sibling such as ~/.claude-accounts-x, or a path with ../, is refused.
 */
function newAccountFolder(dir: unknown): string | undefined {
  if (typeof dir !== "string" || !dir) return undefined;
  const full = path.resolve(dir);
  const name = path.basename(full);
  const plain = /^[\w.@-]+$/.test(name) && !/^\.+$/.test(name);
  return path.dirname(full) === path.resolve(ACCOUNTS_ROOT) && plain && !fs.existsSync(full) ? full : undefined;
}

/** Signs a folder in with `claude auth login --email`, waits for it to finish, then checks who got signed in. */
export async function logIn(dir: unknown, knownEmail?: string): Promise<void> {
  const newFolder = newAccountFolder(dir);
  const configDir = newFolder ?? known(dir);
  // Reauthentication goes straight to the browser; only Add account asks for an email.
  const intended = meantFor(configDir, expected());
  const requested = normal(knownEmail);
  if (!newFolder && intended && requested && intended !== requested) {
    throw new Error(`The folder for ${requested} already belongs to ${intended}.`);
  }
  const email = requested ?? intended ?? normal(accountStatuses().find((s) => s.configDir === configDir)?.email);
  if (newFolder) {
    fs.mkdirSync(ACCOUNTS_ROOT, { recursive: true });
    fs.mkdirSync(newFolder);
    // Keep the chosen address when its sanitized folder name differs, even if the first login is cancelled.
    if (requested && requested !== intended) await state.update("expectedEmails", { ...expected(), [newFolder]: requested });
  }
  const term = vscode.window.createTerminal({
    name: `Log in ${email || label(configDir)}`,
    shellPath: "claude",
    shellArgs: ["auth", "login", ...(email ? ["--email", email] : [])],
    cwd: os.homedir(),
    env: claudeAccountEnv(configDir),
    iconPath: new vscode.ThemeIcon("account"),
  });
  term.show();
  void vscode.window.showInformationMessage(`Finish signing in${email ? ` as ${email}` : ""} in your browser. Entomatical notices when you are done.`);
  let exit: vscode.TerminalExitStatus | undefined;
  for (const deadline = Date.now() + 10 * 60_000; Date.now() < deadline;) {
    exit = term.exitStatus;
    if (exit) break;
    await sleep(2000);
  }
  if (exit?.reason === vscode.TerminalExitReason.User) return void vscode.window.showWarningMessage(`Entomatical: Sign-in for ${label(configDir)} was cancelled.`);
  if (exit?.code === undefined || exit.reason !== vscode.TerminalExitReason.Process) {
    return void vscode.window.showWarningMessage(`Entomatical: Sign-in for ${label(configDir)} was not confirmed. Check the login terminal.`);
  }
  if (exit.code !== 0) return void vscode.window.showWarningMessage(`Entomatical: Sign-in for ${label(configDir)} failed (exit code ${exit.code}). Check the login terminal.`);
  term.dispose();
  const now = await freshAuthStatus(configDir);
  if (!now) return void vscode.window.showWarningMessage(`Entomatical: Could not verify the current sign-in for ${label(configDir)}.`);
  if (email && !meantFor(configDir, expected())) await state.update("expectedEmails", { ...expected(), [configDir]: email });
  cancelUsage(configDir);
  fs.rmSync(path.join(USAGE_DIR, `${usageKey(configDir)}.json`), { force: true }); // never show the previous login's quota
  await rescan();
  const listed = accountStatuses().find(s => s.configDir === configDir);
  const wanted = meantFor(configDir, expected()) ?? email;
  if (!listed || listed.loggedIn !== now.loggedIn || listed.email !== now.email || (email && wanted !== email)) {
    return void vscode.window.showWarningMessage(`Entomatical: The sign-in for ${label(configDir)} changed during verification. Check the account and try again.`);
  }
  if (!now.loggedIn) return void vscode.window.showWarningMessage(`Entomatical: ${label(configDir)} is not logged in.`);
  if (wanted && now.email !== wanted) {
    const retry = await vscode.window.showWarningMessage(
      `Entomatical: Could not verify ${wanted} in ${label(configDir)}. Claude reported ${now.email || "no email"}.`,
      {
        modal: true,
        detail: `This folder belongs to ${wanted}. Check the account in your browser or open the login link in a private window, then try again.`,
      },
      "Try again",
    );
    if (retry === "Try again") await logIn(configDir, wanted);
    return;
  }
  void vscode.window.showInformationMessage(`Entomatical: ${label(configDir)} is signed in${now.email ? ` as ${now.email}` : ""}.`);
  await refreshAccountUsage(configDir);
}

export async function logOut(dir: unknown): Promise<void> {
  const configDir = known(dir);
  const row = accountRows().find((r) => r.configDir === configDir);
  const ok = await vscode.window.showWarningMessage(`Log ${row?.email ?? label(configDir)} out of ${label(configDir)}?`, { modal: true }, "Log out");
  if (ok !== "Log out") return;
  cancelUsage(configDir);
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  await promisify(execFile)("claude", ["auth", "logout"], { env, timeout: 30_000, windowsHide: true });
  forgetAuthStatus(configDir);
  fs.rmSync(path.join(USAGE_DIR, `${usageKey(configDir)}.json`), { force: true });
  await rescan();
}

/** Moves an extra account folder to the trash, so it can be restored, and forgets it. */
export async function removeAccount(dir: unknown): Promise<void> {
  const configDir = known(dir);
  if (!configDir) throw new Error("The main account (~/.claude) cannot be removed.");
  if (sameFolder(configDir, activeConfigDir())) throw new Error("This account is the IDE default. Choose another account first.");
  const row = accountRows().find((r) => r.configDir === configDir);
  const ok = await vscode.window.showWarningMessage(`Remove ${row?.email ?? label(configDir)}?`, {
    modal: true,
    detail: `Moves ${configDir} to the trash, with its sign-in and chat history. Tasks that use this account can no longer resume.`,
  }, "Remove");
  if (ok !== "Remove") return;
  cancelUsage(configDir);
  await vscode.workspace.fs.delete(vscode.Uri.file(configDir), { recursive: true, useTrash: true });
  forgetAuthStatus(configDir);
  fs.rmSync(path.join(USAGE_DIR, `${usageKey(configDir)}.json`), { force: true });
  const { [configDir]: _, ...rest } = state.get<Record<string, string>>("expectedEmails", {});
  await state.update("expectedEmails", rest);
  await rescan();
}

/** A new folder in ~/.claude-accounts, named after the email, then logged in. */
export async function addAccount(): Promise<void> {
  const email = await vscode.window.showInputBox({
    title: "Add a Claude account",
    prompt: "Email of the Claude account",
    validateInput: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? undefined : "Enter an email address"),
  });
  if (!email) return;
  const existing = accountRows().find((r) => !r.provider && r.loggedIn && !r.expected && r.email === normal(email));
  if (existing) return void vscode.window.showInformationMessage(`Entomatical: ${email} is already signed in (${existing.folder}).`);
  await logIn(path.join(ACCOUNTS_ROOT, normal(email)!.replace(/[^\w.@-]/g, "_")), normal(email));
}

// Grok owns each profile's credentials. Folder names are user labels, not verified identities.
const GROK_ACCOUNTS = path.join(os.homedir(), ".grok-accounts");
const GROK_DEFAULT = path.join(os.homedir(), ".grok");
function grokFolders(): string[] {
  let profiles: string[] = [];
  try { profiles = fs.readdirSync(GROK_ACCOUNTS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(GROK_ACCOUNTS, e.name)); }
  catch { /* no managed profiles yet */ }
  try { if (fs.statSync(GROK_DEFAULT).isDirectory()) profiles.unshift(GROK_DEFAULT); } catch { /* no default profile */ }
  return profiles;
}
/** Configured task profiles. These labels do not assert that a provider is signed in. */
export function externalProviderAccounts(): { name: string; configDir: string; provider: "grok" | "antigravity" }[] {
  return [
    ...grokFolders().map((dir) => ({ name: `Grok · ${dir === GROK_DEFAULT ? "~/.grok" : path.basename(dir)}`, configDir: dir, provider: "grok" as const })),
    ...(state?.get<boolean>("antigravityAccount", false) ? [{ name: "Antigravity · Shared", configDir: "", provider: "antigravity" as const }] : []),
  ];
}
function knownGrok(dir: unknown): string {
  if (typeof dir !== "string" || !grokFolders().includes(dir)) throw new Error("Unknown Grok account folder.");
  return dir;
}
function providerBinary(provider: "grok" | "antigravity"): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const name = provider === "grok" ? "grok" : "agy";
  const candidates = provider === "grok"
    ? [path.join(os.homedir(), ".grok", "bin", name + exe)]
    : [path.join(os.homedir(), ".gemini", "bin", name + exe), ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "agy", "bin", name + exe)] : [])];
  return candidates.find((file) => fs.existsSync(file)) ?? name;
}
function providerTerminal(provider: "grok" | "antigravity", dir: string, login: boolean): vscode.Terminal {
  const keys = provider === "grok" ? ["XAI_API_KEY", "GROK_DEPLOYMENT_KEY"]
    : ["GEMINI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_ADC_AUTH"];
  const cleared = Object.fromEntries([...new Set([...keys, ...Object.keys(process.env).filter((key) => keys.includes(key.toUpperCase()))])].map((key) => [key, null]));
  return vscode.window.createTerminal({
    name: `${login ? "Sign in" : "Open"} ${provider === "grok" ? `Grok · ${path.basename(dir)}` : "Antigravity"}`,
    shellPath: providerBinary(provider),
    shellArgs: login ? (provider === "grok" ? ["login"] : ["acp", "--login"]) : [],
    cwd: os.homedir(),
    env: provider === "grok" ? { ...cleared, GROK_HOME: dir } : cleared,
    iconPath: new vscode.ThemeIcon("account"),
  });
}
const providerLogins = new Set<string>();
/** A successful shared sign-in can change whose ACP default is displayed, even when agy reports no email. */
export const antigravityLoginId = (): string => state?.get<string>("antigravityLoginId", "") ?? "";
async function providerLogin(provider: "grok" | "antigravity", dir: string): Promise<void> {
  const key = `${provider}:${dir}`;
  if (providerLogins.has(key)) throw new Error("Sign-in is already in progress for this account.");
  providerLogins.add(key);
  try {
    const term = providerTerminal(provider, dir, true);
    term.show();
    void vscode.window.showInformationMessage(provider === "grok"
      ? "Follow the Grok sign-in instructions in the terminal. The folder name is a label; Entomatical cannot verify the identity."
      // agy shows a code after the browser step and waits for it in the terminal: on 6 November 2026 a sign-in finished in the browser alone
      // sat there unfinished because this message did not say so (F86).
      : "Sign in with Google in the browser, then paste the code it shows into the \"Sign in Antigravity\" terminal and press Enter. Antigravity uses its shared local sign-in.");
    for (const end = Date.now() + 10 * 60_000; Date.now() < end && !term.exitStatus;) await sleep(2000);
    if (term.exitStatus?.code === 0) {
      term.dispose();
      if (provider === "antigravity") await state.update("antigravityLoginId", randomUUID());
      void vscode.window.showInformationMessage("Sign-in finished. Entomatical cannot verify the account identity or usage yet.");
    } else {
      void vscode.window.showWarningMessage("Sign-in did not finish successfully. Check the terminal.");
    }
  } finally { providerLogins.delete(key); providerCache.clear(); changed.fire(); } // the row shows the new sign-in at once
}
export async function addGrokAccount(): Promise<void> {
  const label = (await vscode.window.showInputBox({ title: "Add a Grok account", prompt: "A label for this Grok account (letters, numbers, @, dot, dash or underscore)" }))?.trim();
  if (!label) return;
  if (!/^[\w@-][\w.@-]{0,79}$/.test(label) || /\.$/.test(label) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(label)) throw new Error("Enter a valid account label.");
  fs.mkdirSync(GROK_ACCOUNTS, { recursive: true });
  const dir = path.join(GROK_ACCOUNTS, label);
  try { fs.mkdirSync(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A Grok account with that label already exists.");
    throw e;
  }
  changed.fire();
  await providerLogin("grok", dir);
}
export const grokLogIn = (dir: unknown) => providerLogin("grok", knownGrok(dir));
export function openGrok(dir: unknown): void { providerTerminal("grok", knownGrok(dir), false).show(); }
export async function removeGrokAccount(dir: unknown): Promise<void> {
  const folder = knownGrok(dir);
  if (folder === GROK_DEFAULT) throw new Error("The default Grok profile cannot be removed.");
  const ok = await vscode.window.showWarningMessage(`Remove Grok account ${path.basename(folder)}?`,
    { modal: true, detail: "Moves this profile and its Grok sign-in and history to the trash. Open sessions may still use it." }, "Remove");
  if (ok !== "Remove") return;
  await vscode.workspace.fs.delete(vscode.Uri.file(folder), { recursive: true, useTrash: true });
  changed.fire();
}
export async function addAntigravityAccount(): Promise<void> {
  await state.update("antigravityAccount", true);
  changed.fire();
  void discoverAntigravityModels().then(() => changed.fire()); // F88: the form's models, without waiting for the 15-minute scan
  // Antigravity has one shared Google sign-in per machine, often already working. A forced `agy acp --login` could replace it with
  // another Google account, so connecting only adds the row and offers sign-in (found in the 5 November 2026 Windows check, F86).
  const pick = await vscode.window.showInformationMessage(
    "Antigravity added. It uses the Google sign-in Antigravity already has on this machine. Sign in only if Antigravity is not signed in yet.", "Sign in");
  if (pick === "Sign in") await providerLogin("antigravity", "");
}
export const antigravityLogIn = () => providerLogin("antigravity", "");
export function openAntigravity(): void { providerTerminal("antigravity", "", false).show(); }
export async function hideAntigravityAccount(): Promise<void> { await state.update("antigravityAccount", false); changed.fire(); }

/** Signs Codex in with its own `codex login` (browser), waits for it, then reads who got signed in. */
export async function codexLogIn(): Promise<void> {
  cancelUsage(CODEX_DIR);
  fs.rmSync(path.join(USAGE_DIR, `${usageKey(CODEX_DIR)}.json`), { force: true }); // never show the previous login's quota
  const login = codexCommand(["login"], os.homedir()); // in WSL mode, the WSL Codex signs in to its own ~/.codex
  const term = vscode.window.createTerminal({ name: "Log in Codex", shellPath: login.file, shellArgs: login.args, cwd: os.homedir(), iconPath: new vscode.ThemeIcon("account") });
  term.show();
  void vscode.window.showInformationMessage("Finish signing in to Codex in your browser. Entomatical notices when you are done.");
  for (const end = Date.now() + 10 * 60_000; Date.now() < end && !term.exitStatus; ) await sleep(2000);
  const exit = term.exitStatus?.code;
  if (exit === 0) term.dispose(); // a failed login stays open so its message can be read
  await rescan();
  if (exit !== 0) {
    return void vscode.window.showWarningMessage(exit === undefined
      ? "Entomatical: Codex sign-in was not confirmed. Check the Log in Codex terminal."
      : `Entomatical: Codex sign-in failed (exit code ${exit}). Check the Log in Codex terminal for the error. An earlier sign-in does not mean this attempt succeeded.`);
  }
  const now = codexStatus();
  if (!now?.loggedIn) return void vscode.window.showWarningMessage("Entomatical: Codex is not logged in.");
  void vscode.window.showInformationMessage(`Entomatical: Codex is signed in as ${now.email ?? "an API key"}.`);
}

export async function codexLogOut(): Promise<void> {
  const ok = await vscode.window.showWarningMessage(`Log ${codexStatus()?.email ?? "Codex"} out of Codex?`, { modal: true }, "Log out");
  if (ok !== "Log out") return;
  cancelUsage(CODEX_DIR);
  const logout = codexCommand(["logout"]);
  await promisify(execFile)(logout.file, logout.args, { env: logout.env, timeout: 30_000, windowsHide: true });
  fs.rmSync(path.join(USAGE_DIR, `${usageKey(CODEX_DIR)}.json`), { force: true });
  await rescan();
}
