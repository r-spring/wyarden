// Independent speech dictation. No provider login files or Claude extension internals.
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { makeTemp } from "./workspace";
import { runSpeechFile, trackSpeechChild } from "./speech-process";
import { hasWhisperHeader, hasParakeetHeader } from "./whisper-model";
import { ParakeetControls, validateParakeetControls, runParakeet, speechEnv } from "./parakeet";

export type Provider = "local" | "parakeet" | "openai" | "groq" | "deepgram";
export interface SpeechOptions { provider: Provider; executable?: string; modelPath?: string; model?: string; language?: string; apiKey?: string; silenceSeconds?: number; parakeet?: ParakeetControls }
/** Live dictation stops after this much silence. Tenths of a second are allowed. */
export const SILENCE_MIN = 0.5, SILENCE_MAX = 60;
/** Mean level of 16-bit samples (0-32767) at or above which a 100 ms chunk counts as speech. Measured 2 Nov 2026 on the user's mic: quiet room about 5-7; normal speech median 170, 10th percentile 22 (pauses). */
export const SPEECH_LEVEL = 40;
export const PROVIDERS = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  groq: { url: "https://api.groq.com/openai/v1/audio/transcriptions", model: "whisper-large-v3-turbo" },
  deepgram: { url: "https://api.deepgram.com/v1/listen", model: "nova-3" },
} as const;
export function validateSpeech(options: SpeechOptions) {
  if (options.provider === "local" || options.provider === "parakeet") {
    const engine = options.provider === "parakeet" ? "Parakeet" : "Whisper";
    for (const [label, value] of [[`${engine} executable`, options.executable], [`${engine} model`, options.modelPath]]) {
      if (!value || !path.isAbsolute(value)) throw new Error(`${label}: choose an absolute file path in Speech Settings.`);
      try { if (!fs.statSync(value).isFile()) throw new Error(); } catch { throw new Error(`${label} file was not found. Check Speech Settings.`); }
    }
    if (options.provider === "parakeet") {
      if (!/^parakeet-cli(?:\.exe)?$/i.test(path.basename(options.executable!))) throw new Error("Parakeet requires parakeet-cli, not a Whisper executable. Choose the Parakeet folder.");
      if (!hasParakeetHeader(options.modelPath!)) throw new Error("Choose a supported Parakeet TDT GGML model from the Parakeet dropdown.");
      validateParakeetControls(options);
    } else if (!hasWhisperHeader(options.modelPath!)) throw new Error("The selected file is not a supported Whisper model. Parakeet and VAD models need different engines. Choose a Whisper model in the dropdown.");
  } else if (!Object.hasOwn(PROVIDERS, options.provider)) throw new Error("Choose a supported speech provider in Speech Settings.");
  else if (!options.apiKey?.trim()) throw new Error("Set a Speech API Key for the selected provider before recording.");
  if (options.language && !/^(auto|[a-z]{2,3}(?:-[a-zA-Z]{2,4})?)$/.test(options.language)) throw new Error("Use a language code such as en, or auto.");
  if (options.model && !/^[a-zA-Z0-9._/-]{1,100}$/.test(options.model)) throw new Error("Invalid speech model name.");
  if (options.silenceSeconds !== undefined && !(Number.isFinite(options.silenceSeconds) && options.silenceSeconds >= SILENCE_MIN && options.silenceSeconds <= SILENCE_MAX))
    throw new Error(`Silence timeout must be between ${SILENCE_MIN} and ${SILENCE_MAX} seconds. Check Speech Settings.`);
}

/** Recorder output is 16 kHz, mono, signed 16-bit little-endian PCM. */
export function pcmToWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error("The microphone returned incomplete audio. Please record again.");
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function transcribe(wav: Buffer, options: SpeechOptions, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  validateSpeech(options);
  signal.throwIfAborted();
  if (options.provider === "local" || options.provider === "parakeet") {
    const dir = makeTemp("speech-"); // the workspace's .entomatical/tmp/speech (workspace.ts)
    try {
      const audio = path.join(dir, "audio.wav"), output = path.join(dir, "transcript");
      await fs.promises.writeFile(audio, wav, { mode: 0o600 });
      // Argument array, never a shell command. No credentials are supplied to the executable.
      if (options.provider === "parakeet") await runParakeet(options, [audio], signal, output);
      else await runSpeechFile(options.executable!, ["-m", options.modelPath!, "-f", audio, "-l", options.language || "en", "-otxt", "-of", output],
        speechEnv(options.executable!), signal, dir);
      signal.throwIfAborted();
      return (await fs.promises.readFile(output + ".txt", "utf8")).trim();
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(options.provider === "parakeet" ? "Local Parakeet could not transcribe. Check parakeet-cli and the Parakeet model in Speech Settings." : "Local Whisper could not transcribe. Check the executable, model and language in Speech Settings.");
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  }
  const provider = PROVIDERS[options.provider];
  const url = new URL(provider.url);
  let body: FormData | Uint8Array;
  const headers: Record<string, string> = { Authorization: `${options.provider === "deepgram" ? "Token" : "Bearer"} ${options.apiKey!.trim()}` };
  if (options.provider === "deepgram") {
    url.searchParams.set("model", options.model || provider.model);
    url.searchParams.set("smart_format", "true");
    if (options.language === "auto") url.searchParams.set("detect_language", "true");
    else url.searchParams.set("language", options.language || "en");
    headers["Content-Type"] = "audio/wav"; body = new Uint8Array(wav);
  } else {
    body = new FormData();
    body.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "dictation.wav");
    body.append("model", options.model || provider.model);
    if (options.provider === "openai") {
      if (options.language && options.language !== "auto") body.append("languages[]", options.language);
    } else if (options.language && options.language !== "auto") body.append("language", options.language);
  }
  // Never follow a redirect carrying a credential. The endpoint is fixed by provider, not a workspace setting.
  let response: Response;
  try { response = await request(url, { method: "POST", headers, body, signal, redirect: "error" }); }
  catch (e) { if (signal.aborted) throw e; throw new Error("The speech service could not be reached. Check your connection and try again."); }
  if (!response.ok) throw new Error(`Speech service returned HTTP ${response.status}. Check your API key, model, quota and provider account.`);
  // Never echo provider bodies/errors: they can include user audio-derived text or credentials.
  let data: any;
  try { data = await response.json(); } catch { throw new Error("The speech service returned an invalid response."); }
  const text = options.provider === "deepgram" ? data?.results?.channels?.[0]?.alternatives?.[0]?.transcript : data?.text;
  if (typeof text !== "string") throw new Error("The speech service returned no transcript.");
  return text.trim();
}

export type Voice = { stop: () => Promise<void>; cancel: () => void; closed: Promise<void> };
export type VoiceEvents = { text: (sentence: string) => void; recording: () => void; transcribing: () => void; error: (message: string) => void;
  /** Parakeet only: the whole recording so far, transcribed while it runs. Each call replaces the one before; `text` still delivers the final transcript. */
  partial?: (soFar: string) => void };

/** Seconds of new audio between two live Parakeet passes. Measured 19 November 2026 on linux (RTX 3050): 11 s of audio takes 0.6 s. */
export const LIVE_STEP_SECONDS = 1;
function startRecorder(recorder: string) {
  const args = recorder.endsWith(".exe") ? [] : ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"];
  return spawn(recorder, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** Bounded record-then-transcribe. Audio is uploaded only after Stop. Parakeet with `on.partial` also transcribes the recording so far, locally, while it runs. */
export function dictate(options: SpeechOptions, on: VoiceEvents, recorder = "arecord"): Voice {
  validateSpeech(options); // refuse missing configuration before microphone access
  const rec = startRecorder(recorder);
  const controller = new AbortController();
  const capture = trackSpeechChild(rec);
  let stopping = false, bytes = 0;
  let timer: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
  let lastSpeech = Date.now(), carry = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let live: Promise<void> | undefined, liveAbort: AbortController | undefined, liveBytes = 0;
  const cancel = () => {
    controller.abort(); liveAbort?.abort();
    chunks.length = 0; clearTimeout(timer); clearTimeout(deadline);
    capture.terminate();
  };
  const fail = (message: string) => { if (!controller.signal.aborted) { cancel(); on.error(message); } };
  const stop = () => {
    if (!stopping && !controller.signal.aborted) {
      stopping = true; clearTimeout(timer); liveAbort?.abort(); on.transcribing(); capture.terminate();
    }
    return closed;
  };
  rec.once("spawn", () => {
    if (stopping || controller.signal.aborted) return;
    timer = setTimeout(() => void stop(), 120_000);
    on.recording();
  });
  rec.once("error", () => fail("The microphone recorder could not start. On Linux install alsa-utils; on Windows rebuild the recorder. Check microphone permissions."));
  rec.stderr?.resume(); // don't retain arbitrary recorder output
  rec.stdout?.on("data", (chunk: Buffer) => {
    if (controller.signal.aborted) return;
    const remaining = 120 * 32000 - bytes;
    if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); bytes += kept.length; }
    if (options.provider === "parakeet") {
      const buf = Buffer.concat([carry, chunk]), usable = buf.length - buf.length % 2;
      carry = Buffer.from(buf.subarray(usable));
      let sum = 0;
      for (let i = 0; i < usable; i += 2) sum += buf.readInt16LE(i) ** 2;
      if (usable && Math.sqrt(sum / (usable / 2)) >= SPEECH_LEVEL) lastSpeech = Date.now();
      if (Date.now() - lastSpeech >= (options.silenceSeconds ?? 4) * 1000) void stop();
      // Live text: one pass at a time over everything recorded so far, so each result replaces the last. A failed pass is skipped; the final pass reports errors.
      if (on.partial && !live && !stopping && bytes - liveBytes >= LIVE_STEP_SECONDS * 32000) {
        liveBytes = bytes; liveAbort = new AbortController();
        const pcm = Buffer.concat(chunks);
        live = transcribe(pcmToWav(pcm.subarray(0, pcm.length - pcm.length % 2)), options, liveAbort.signal)
          .then(text => { if (text && !stopping && !controller.signal.aborted) on.partial!(text); }, () => { /* skipped */ })
          .finally(() => { live = undefined; });
      }
    }
    if (bytes >= 120 * 32000) void stop();
  });
  rec.once("close", () => {
    if (!stopping) fail("The microphone recorder stopped unexpectedly. Check the selected input device and permissions.");
  });
  const closed = capture.closed.then(async () => {
    await live; // The live process and its temp files must be gone before the final pass or another recording.
    if (controller.signal.aborted) return;
    if (bytes < 3200) return fail("No usable audio was recorded. Please speak for a moment and try again.");
    deadline = setTimeout(() => fail("Transcription timed out. Try a shorter recording or a smaller local model."), 120_000);
    try { const text = await transcribe(pcmToWav(Buffer.concat(chunks)), options, controller.signal); if (!controller.signal.aborted && text) on.text(text); }
    catch (e) { if (!controller.signal.aborted) on.error(e instanceof Error ? e.message : "Transcription failed."); }
    finally { clearTimeout(deadline); chunks.length = 0; }
  });
  return { stop, cancel, closed };
}

/** whisper.cpp's stream example sits beside whisper-cli in the same folder. */
export function streamSibling(whisperCli: string): string {
  return path.join(path.dirname(whisperCli), path.basename(whisperCli).replace(/whisper-cli(?=\.exe$|$)/, "whisper-stream"));
}

/** One line of whisper-stream output without redraw codes, bracket tags such as [Start speaking] or [BLANK_AUDIO], or padding. */
function visibleText(line: string): string {
  const current = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\r").map(s => s.trim()).filter(Boolean).pop() ?? "";
  const text = current.replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

/** whisper-stream redraws its current guess in place (CR, ESC[2K) and ends a finished utterance with CRLF. Returns finished utterances only. */
export function streamLines(state: { pending: string }, chunk: string): string[] {
  const parts = (state.pending + chunk).split(/\r?\n/);
  state.pending = parts.pop() ?? "";
  return parts.map(visibleText).filter(Boolean);
}

export function whisperExitMessage(code: number | null, diagnostic: string): string {
  if (/failed to load model|failed to initialize whisper|invalid model data|unknown tensor/i.test(diagnostic))
    return "Whisper could not load the selected model. Choose a compatible Whisper model in the dropdown (Parakeet and VAD models are not supported by this engine).";
  if (/failed to open.*(?:audio|capture)|could not open.*(?:audio|capture)|no (?:audio|capture) devices/i.test(diagnostic))
    return "Whisper could not open the microphone. Check the default input device and microphone permissions.";
  return `Live Whisper exited unexpectedly (exit ${code ?? "unknown"}). Check the model and Whisper installation; microphone permission may also be required.`;
}

/** Real-time local dictation: whisper-stream captures the microphone itself and prints text while you speak. */
export function dictateStream(options: SpeechOptions, on: VoiceEvents, recorder = "arecord"): Voice {
  if (options.provider !== "local") throw new Error("Live Whisper requires the Whisper provider. Parakeet uses its own recording and transcription engine.");
  validateSpeech(options); // refuse missing configuration before microphone access
  const exe = streamSibling(options.executable!);
  if (!path.isAbsolute(exe) || !fs.existsSync(exe)) throw new Error("whisper-stream was not found beside whisper-cli. Check Speech Settings.");
  const args = ["-m", options.modelPath!, "-l", options.language || "en"];
  const proc = spawn(exe, args, { env: speechEnv(exe), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Second capture only for silence detection: whisper-stream does not report silence. Its text is still from whisper-stream.
  const recognizer = trackSpeechChild(proc);
  let meter: ReturnType<typeof startRecorder>;
  const meterError = "The microphone could not be opened for silence detection. Check microphone permissions.";
  try { meter = startRecorder(recorder); }
  catch {
    recognizer.terminate();
    on.error(meterError);
    return { stop: () => recognizer.closed, cancel: recognizer.terminate, closed: recognizer.closed };
  }
  const silenceMs = (options.silenceSeconds ?? 4) * 1000;
  let lastSpeech = Date.now();
  let stopping = false, cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  const state = { pending: "" };
  const monitor = trackSpeechChild(meter);
  const terminate = () => {
    clearTimeout(timer);
    recognizer.terminate(); monitor.terminate();
  };
  const cancel = () => { cancelled = true; state.pending = ""; terminate(); };
  const fail = (message: string) => { if (!cancelled) { cancel(); on.error(message); } };
  const stop = () => {
    if (!stopping && !cancelled) {
      stopping = true; on.transcribing(); terminate();
    }
    return closed;
  };
  let meterCarry: Buffer = Buffer.alloc(0);
  meter.stdout?.on("data", (chunk: Buffer) => {
    if (cancelled || stopping) return;
    const buf = Buffer.concat([meterCarry, chunk]), usable = buf.length - (buf.length % 2);
    meterCarry = Buffer.from(buf.subarray(usable));
    let sum = 0;
    for (let i = 0; i < usable; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
    if (usable && Math.sqrt(sum / (usable / 2)) >= SPEECH_LEVEL) lastSpeech = Date.now();
    if (Date.now() - lastSpeech >= silenceMs) void stop(); // silence long enough: stop, keep the text already shown, put the rest in the box
  });
  meter.once("error", () => fail(meterError));
  meter.once("close", () => { if (!stopping) fail("The microphone stopped unexpectedly. Check the selected input device and permissions."); });
  meter.stderr?.resume();
  proc.once("spawn", () => {
    if (stopping || cancelled) return;
    lastSpeech = Date.now();
    timer = setTimeout(() => void stop(), 120_000);
    on.recording();
  });
  proc.once("error", () => fail("Live Whisper could not start. Check the whisper-stream file and microphone permissions."));
  let diagnostic = "";
  proc.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); }); // bounded, never persisted or displayed verbatim
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    if (cancelled) return;
    for (const sentence of streamLines(state, chunk)) {
      if (cancelled) break;
      on.text(sentence);
    }
  });
  proc.once("close", (code) => {
    if (!stopping) fail(whisperExitMessage(code, diagnostic));
  });
  const closed = Promise.all([recognizer.closed, monitor.closed]).then(() => {
    const last = visibleText(state.pending);
    if (!cancelled && last) on.text(last);
  });
  return { stop, cancel, closed };
}
