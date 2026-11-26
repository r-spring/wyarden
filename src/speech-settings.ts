import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { makeTemp } from "./workspace";
import { PROVIDERS, Provider, SpeechOptions, validateSpeech } from "./voice";
import { parakeetDetails, runParakeet, speechEnv } from "./parakeet";
import { hasWhisperHeader, hasParakeetHeader } from "./whisper-model";
const PREFIX = "entomatical.speech";
export type SpeechProvider = Provider;
export type SpeechSelection = Omit<SpeechOptions, "provider"> & { provider: SpeechProvider };
export const SPEECH_PROVIDERS = [
  { id: "local", label: "Local Whisper" }, { id: "parakeet", label: "Local Parakeet" },
  { id: "openai", label: "OpenAI" }, { id: "groq", label: "Groq" }, { id: "deepgram", label: "Deepgram" },
];
const valid = (p: unknown): p is SpeechProvider => SPEECH_PROVIDERS.some(v => v.id === p);
/** The stored provider. A retired or unknown value (such as the removed "claude") falls back to local Whisper; the stored setting is left untouched. */
const storedProvider = (config: vscode.WorkspaceConfiguration): SpeechProvider => { const p = config.get<string>("provider", "local"); return valid(p) ? p : "local"; };
const keyName = (p: Provider) => `speech.apiKey.${p}`;

/** Bounded discovery, skipping symlinks and dependency/source-control trees. */
export function discoverWhisper(folder: string, engine: "local" | "parakeet" = "local"): { executable?: string; models: { label: string; path: string }[] } {
  if (!folder || !path.isAbsolute(folder)) return { models: [] };
  const files: string[] = [], queue = [{ dir: folder, depth: 0 }];
  let entries = 0;
  while (queue.length && entries < 5000) {
    const { dir, depth } = queue.shift()!;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (++entries > 5000) break;
      const name = path.join(dir, child.name);
      if (child.isFile()) files.push(name);
      else if (child.isDirectory() && depth < 4 && !child.name.startsWith(".") && child.name !== "node_modules") queue.push({ dir: name, depth: depth + 1 });
    }
  }
  const executable = files.filter(f => path.basename(f) === (`${engine === "parakeet" ? "parakeet" : "whisper"}-cli${process.platform === "win32" ? ".exe" : ""}`))
    .sort((a, b) => a.length - b.length)[0];
  const models = files.filter(f => /^ggml-.+\.bin$/i.test(path.basename(f)) && (engine === "parakeet" ? hasParakeetHeader(f) : hasWhisperHeader(f))).map(f => ({
    label: path.basename(f).replace(/^ggml-/, "").replace(/\.bin$/i, ""), path: f,
  })).sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
  return { executable, models };
}

export function commonWhisperFolder(executable: string, model: string): string {
  if (!path.isAbsolute(executable) || !path.isAbsolute(model)) return "";
  let folder = path.dirname(executable);
  while (folder !== path.dirname(folder)) {
    const relative = path.relative(folder, model);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return folder;
    folder = path.dirname(folder);
  }
  return "";
}

/** Carry user settings forward, without overwriting any setting in the unified edition. */
export async function migrateSpeechSettings() {
  let config = vscode.workspace.getConfiguration(PREFIX);
  const legacy = vscode.workspace.getConfiguration("entomaticalSpeech.speech");
  for (const name of ["provider", "whisperPath", "modelPath", "language", "model", "silenceSeconds"]) {
    const value = legacy.inspect(name)?.globalValue;
    if (config.inspect(name)?.globalValue === undefined && value !== undefined) await config.update(name, value, vscode.ConfigurationTarget.Global);
  }
  config = vscode.workspace.getConfiguration(PREFIX); // a snapshot: it does not see the paths just carried forward
  if (!config.get<string>("whisperFolder", "")) {
    const folder = commonWhisperFolder(config.get<string>("whisperPath", ""), config.get<string>("modelPath", ""));
    if (folder) await config.update("whisperFolder", folder, vscode.ConfigurationTarget.Global);
  }
}

function localSelection(config: vscode.WorkspaceConfiguration, provider: string) {
  const parakeet = provider === "parakeet";
  const folder = config.get<string>(parakeet ? "parakeetFolder" : "whisperFolder", "")
    || (parakeet ? config.get<string>("whisperFolder", "") : "");
  const local = discoverWhisper(folder, parakeet ? "parakeet" : "local");
  const selected = config.get<string>(parakeet ? "parakeetModelPath" : "modelPath", "");
  // First Parakeet use can reuse the installation folder, never the Whisper model or executable.
  const modelPath = selected || (parakeet ? local.models[0]?.path ?? "" : "");
  const executable = local.executable || config.get<string>(parakeet ? "parakeetPath" : "whisperPath", "");
  return { ...local, executable, folder, modelPath };
}

export function speechSnapshot() {
  const config = vscode.workspace.getConfiguration(PREFIX), provider = storedProvider(config);
  const local = localSelection(config, provider);
  return { provider, providers: SPEECH_PROVIDERS, ...local, ready: !!local.executable && local.models.length > 0 };
}

export async function speechOptions(secrets: vscode.SecretStorage, selectedProvider?: SpeechProvider): Promise<SpeechSelection> {
  const config = vscode.workspace.getConfiguration(PREFIX), provider = selectedProvider ?? storedProvider(config);
  if (!valid(provider)) throw new Error("Choose a speech provider in Speech Settings.");
  const isLocal = provider === "local" || provider === "parakeet";
  const local = localSelection(config, provider);
  if (isLocal && local.folder && !local.models.some(m => m.path === local.modelPath)) throw new Error(`Choose a model from the ${provider === "parakeet" ? "Parakeet" : "Whisper"} model dropdown.`);
  return { provider, executable: local.executable, modelPath: local.modelPath,
    language: config.get<string>("language", "en"), model: config.get<string>("model", ""),
    silenceSeconds: config.get<number>("silenceSeconds", 4),
    parakeet: provider === "parakeet" ? {
      threads: config.get<number>("parakeetThreads", 4), useGpu: config.get<boolean>("parakeetUseGpu", true),
      gpuDevice: config.get<number>("parakeetGpuDevice", 0), printSegments: config.get<boolean>("parakeetPrintSegments", false),
      quiet: config.get<boolean>("parakeetQuiet", false),
    } : undefined,
    apiKey: isLocal ? undefined : await secrets.get(keyName(provider)) };
}

export async function setSpeechProvider(provider: unknown) {
  if (!valid(provider)) throw new Error("Unknown speech provider.");
  await vscode.workspace.getConfiguration(PREFIX).update("provider", provider, vscode.ConfigurationTarget.Global);
}
export async function setWhisperModel(model: unknown) {
  const config = vscode.workspace.getConfiguration(PREFIX);
  const parakeet = storedProvider(config) === "parakeet";
  const choices = localSelection(config, parakeet ? "parakeet" : "local").models;
  if (typeof model !== "string" || !choices.some(m => m.path === model)) throw new Error("That model is not in the selected engine's folder.");
  await config.update(parakeet ? "parakeetModelPath" : "modelPath", model, vscode.ConfigurationTarget.Global);
}

export function registerSpeechSettings(context: vscode.ExtensionContext) {
  const openSettings = (topic: string) => vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id} ${topic}`);
  const open = () => openSettings("speech");
  const choose = () => vscode.window.showQuickPick(Object.keys(PROVIDERS), { title: "Choose the speech provider whose API key to manage" });
  const showText = async (content: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "plaintext", content }), { preview: false });
  const parakeetOptions = async () => {
    const selected = await speechOptions(context.secrets, "parakeet");
    const options = { ...selected, provider: "parakeet" as const };
    validateSpeech(options); return options;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("entomatical.parakeetTools", async () => {
      const selected = await vscode.window.showQuickPick([
        { label: "Parakeet settings", description: "Threads, GPU, device, segments and quiet output", command: "entomatical.parakeetSettings" },
        { label: "Transcribe audio files", description: "Open transcripts or save text files", command: "entomatical.parakeetFiles" },
        { label: "Last transcription details", description: "Timing, segments and token details when enabled", command: "entomatical.parakeetDetails" },
        { label: "Installed CLI help", description: "All switches supported by this executable", command: "entomatical.parakeetHelp" },
      ], { title: "Parakeet tools" });
      if (selected) await vscode.commands.executeCommand(selected.command);
    }),
    vscode.commands.registerCommand("entomatical.parakeetSettings", () => openSettings("parakeet")),
    vscode.commands.registerCommand("entomatical.parakeetDetails", () => showText(parakeetDetails())),
    vscode.commands.registerCommand("entomatical.parakeetHelp", async () => {
      const options = localSelection(vscode.workspace.getConfiguration(PREFIX), "parakeet");
      if (!options.executable || !path.isAbsolute(options.executable) || !/^parakeet-cli(?:\.exe)?$/i.test(path.basename(options.executable))) throw new Error("Choose a Parakeet folder containing parakeet-cli.");
      const { execFile } = await import("child_process"), { promisify } = await import("util");
      try { const result = await promisify(execFile)(options.executable!, ["--help"], { env: speechEnv(options.executable!), timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }); await showText(result.stderr + result.stdout); }
      catch { throw new Error("Parakeet help could not start. Check the configured executable."); }
    }),
    vscode.commands.registerCommand("entomatical.parakeetFiles", async () => {
      const options = await parakeetOptions();
      const files = await vscode.window.showOpenDialog({ title: "Transcribe audio with Parakeet", canSelectMany: true, canSelectFiles: true, canSelectFolders: false, filters: { Audio: ["wav", "flac", "mp3", "ogg"] } });
      if (!files?.length) return;
      const mode = await vscode.window.showQuickPick(["Open transcripts in the editor", "Save text files to a folder"], { title: "Parakeet output" });
      if (!mode) return;
      const target = mode === "Save text files to a folder" ? (await vscode.window.showOpenDialog({ title: "Save Parakeet transcripts here", canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0] : undefined;
      if (mode === "Save text files to a folder" && !target) return;
      // Resolve every destination before executing; never let the CLI overwrite existing user files.
      const outputs = files.map(f => target ? path.join(target.fsPath, path.parse(f.fsPath).name + ".txt") : undefined);
      if (target && (new Set(outputs).size !== outputs.length || outputs.some(f => fs.existsSync(f!)))) throw new Error("A transcript filename already exists or two inputs have the same name. Choose another output folder.");
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Parakeet transcription", cancellable: true }, async (progress, token) => {
        const controller = new AbortController(), subscription = token.onCancellationRequested(() => controller.abort());
        try {
          if (!target) {
            const result = await runParakeet(options, files.map(f => f.fsPath), controller.signal);
            await showText(result.stdout);
          } else {
            for (let i = 0; i < files.length; i++) {
              controller.signal.throwIfAborted();
              progress.report({ message: `${i + 1} of ${files.length}` });
              // Produce temporary output, then atomically create the chosen destination without overwrite.
              const output = outputs[i]!, dir = makeTemp("parakeet-"); // the workspace's .entomatical/tmp/parakeet (workspace.ts)
              try {
                const prefix = path.join(dir, "transcript");
                await runParakeet(options, [files[i].fsPath], controller.signal, prefix);
                const text = await fs.promises.readFile(prefix + ".txt");
                controller.signal.throwIfAborted();
                await fs.promises.writeFile(output, text, { flag: "wx", mode: 0o600 });
              } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
            }
            void vscode.window.showInformationMessage(`Saved ${files.length} Parakeet transcript(s).`);
          }
        } catch (e) { if (!controller.signal.aborted) throw e; }
        finally { subscription.dispose(); }
      });
    }),
    vscode.commands.registerCommand("entomatical.configureLocalSpeech", async () => {
      const config = vscode.workspace.getConfiguration(PREFIX);
      const parakeet = storedProvider(config) === "parakeet", name = parakeet ? "Parakeet" : "Whisper";
      const chosen = await vscode.window.showOpenDialog({ title: `Choose the ${name} folder (containing its programs and models)`, canSelectMany: false, canSelectFiles: false, canSelectFolders: true });
      if (!chosen?.[0]) return;
      const folder = chosen[0].fsPath, local = discoverWhisper(folder, parakeet ? "parakeet" : "local");
      if (!local.executable || !local.models.length) throw new Error(`This folder needs ${name.toLowerCase()}-cli and at least one compatible ${name} GGML model, in it or its subfolders.`);
      const key = parakeet ? "parakeetModelPath" : "modelPath", previous = config.get<string>(key, "");
      await config.update(parakeet ? "parakeetFolder" : "whisperFolder", folder, vscode.ConfigurationTarget.Global);
      await config.update(parakeet ? "parakeetPath" : "whisperPath", local.executable, vscode.ConfigurationTarget.Global);
      await config.update(key, local.models.some(m => m.path === previous) ? previous : local.models[0].path, vscode.ConfigurationTarget.Global);
      await config.update("provider", parakeet ? "parakeet" : "local", vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("entomatical.chooseWhisperModel", async () => {
      const items = speechSnapshot().models.map(m => ({ label: m.label, description: m.path, path: m.path }));
      if (!items.length) return vscode.commands.executeCommand("entomatical.configureLocalSpeech");
      const selected = await vscode.window.showQuickPick(items, { title: speechSnapshot().provider === "parakeet" ? "Parakeet model" : "Whisper model" });
      if (selected) await setWhisperModel(selected.path);
    }),
    vscode.commands.registerCommand("entomatical.speechSettings", open),
    vscode.commands.registerCommand("entomatical.setSpeechApiKey", async () => {
      const provider = await choose(); if (!provider || !Object.hasOwn(PROVIDERS, provider)) return;
      const key = await vscode.window.showInputBox({ title: `Speech API key — ${provider}`, password: true, ignoreFocusOut: true,
        prompt: "Stored in VS Code SecretStorage for this provider; never in settings.json or the board.",
        validateInput: value => value.trim() && !/[\r\n]/.test(value) ? undefined : "Enter one API key on one line." });
      if (key === undefined) return;
      await context.secrets.store(keyName(provider as Provider), key.trim());
      void vscode.window.showInformationMessage(`Speech API key saved for ${provider}.`);
    }),
    vscode.commands.registerCommand("entomatical.clearSpeechApiKey", async () => {
      const provider = await choose(); if (!provider || !Object.hasOwn(PROVIDERS, provider)) return;
      await context.secrets.delete(keyName(provider as Provider));
      void vscode.window.showInformationMessage(`Speech API key removed for ${provider}.`);
    }),
  );
}
