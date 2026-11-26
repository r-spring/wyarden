import * as fs from "fs";
import * as path from "path";
import { runSpeechFile } from "./speech-process";
import type { SpeechOptions } from "./voice";

export interface ParakeetControls { threads?: number; useGpu?: boolean; gpuDevice?: number; printSegments?: boolean; quiet?: boolean }
/** Linux: a local speech program loads its libraries from its own folder, because a moved or renamed install keeps a stale RUNPATH. Windows already looks beside the executable. */
export function speechEnv(executable: string): NodeJS.ProcessEnv {
  if (process.platform !== "linux") return process.env;
  return { ...process.env, LD_LIBRARY_PATH: [path.dirname(executable), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
}
let lastDetails ="No Parakeet transcription has run in this window yet.";
let running = false;
export const parakeetDetails = () => lastDetails;

/** Only supported, typed switches; never accept a free-form shell or argument string. */
export function validateParakeetControls(options: SpeechOptions): void {
  const p = options.parakeet ?? {};
  if (p.threads !== undefined && (!Number.isSafeInteger(p.threads) || p.threads < 1)) throw new Error("Parakeet threads must be a positive integer.");
  if (p.gpuDevice !== undefined && (!Number.isSafeInteger(p.gpuDevice) || p.gpuDevice < 0)) throw new Error("Parakeet GPU device must be a nonnegative integer.");
  for (const name of ["useGpu", "printSegments", "quiet"] as const) if (p[name] !== undefined && typeof p[name] !== "boolean") throw new Error(`Invalid Parakeet ${name} setting.`);
}

export function parakeetArgs(options: SpeechOptions, files: string[], outputPrefix?: string): string[] {
  validateParakeetControls(options);
  const p = options.parakeet ?? {};
  const args = ["-m", options.modelPath!, "-t", String(p.threads ?? 4), "-dev", String(p.gpuDevice ?? 0)];
  if (p.useGpu === false) args.push("-ng");
  if (p.printSegments) args.push("-ps");
  if (p.quiet) args.push("-np");
  if (outputPrefix) {
    if (files.length !== 1 || !path.isAbsolute(outputPrefix)) throw new Error("Parakeet text export needs one input and an absolute output prefix.");
    args.push("-otxt", "-of", outputPrefix);
  }
  for (const file of files) {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error("Choose existing local audio files for Parakeet.");
    args.push("-f", file);
  }
  if (!files.length) throw new Error("Choose at least one audio file for Parakeet.");
  return args;
}

export async function runParakeet(options: SpeechOptions, files: string[], signal: AbortSignal, outputPrefix?: string) {
  const args = parakeetArgs(options, files, outputPrefix);
  signal.throwIfAborted();
  if (running) throw new Error("Parakeet is already transcribing. Stop or wait for the current recording first.");
  running = true;
  const started = Date.now();
  lastDetails = "Parakeet is transcribing…";
  try {
    const result = await runSpeechFile(options.executable!, args, speechEnv(options.executable!), signal);
    lastDetails = `Parakeet completed in ${Date.now() - started} ms.\n\n${result.stderr}\nTranscript:\n${result.stdout}`;
    // This CLI can exit zero after a per-file read/decode/write failure.
    if (/^error:/mi.test(result.stderr)) throw new Error("Parakeet could not process every selected file. Open Parakeet details for the result.");
    return result;
  } catch (e) {
    if (e && typeof e === "object" && "stderr" in e) {
      const result = e as { stderr?: string; stdout?: string };
      lastDetails = `Parakeet failed after ${Date.now() - started} ms.\n\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    }
    if (signal.aborted) throw e;
    throw new Error("Parakeet transcription failed. Check the model, audio and GPU settings, or open Parakeet details.");
  } finally { running = false; }
}
