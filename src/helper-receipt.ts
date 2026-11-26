import * as fs from "fs";
import * as path from "path";
import { saveJson } from "./jobs";
import type { HelperAttempt } from "./worker";

/**
 * One helper operation's receipt (4 November 2026 review, item 1.2): Refine draft or Improve prompt, written as "pending" before the
 * first provider process starts (receiptStatus) and updated with the outcome, so a crash leaves the exact input behind, and the stored runs can be
 * replayed and judged later. Atomic and fsynced (jobs.ts saveJson). A "pending" receipt with no live process is interrupted work: it is
 * shown, never re-run automatically. Never holds environment variables or credentials.
 */
export type ReceiptStatus = "pending" | "done" | "failed" | "cancelled";
/** A Review's receipt (F97) gets accept, auto (sent by an automatic round), superseded (a newer review) and worked-after-done. */
export interface ReceiptDecision { action: "apply" | "keep" | "restore" | "accept" | "auto" | "superseded" | "worked-after-done"; at: string }

export function openReceipt(file: string, base: Record<string, unknown>) {
  const startedAt = Date.now();
  let entry: Record<string, unknown> = { ...base, receiptStatus: "pending" as ReceiptStatus, startedAt: new Date(startedAt).toISOString() };
  const write = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); saveJson(file, { ...entry, at: new Date().toISOString() }); };
  write();
  const ended = (status: ReceiptStatus, fields: Record<string, unknown>) => {
    entry = { ...entry, ...fields, receiptStatus: status, endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
    write();
  };
  return {
    file,
    /** Adds fields while the operation runs (the attempts, the validation results). */
    set(fields: Record<string, unknown>) { entry = { ...entry, ...fields }; },
    done(fields: Record<string, unknown> = {}) { ended("done", fields); },
    /** A failure or a cancel; the provider attempts the error carries are kept, failed ones included. */
    failed(error: unknown, cancelled: boolean, fields: Record<string, unknown> = {}) {
      const attempts = (error as { attempts?: HelperAttempt[] })?.attempts;
      ended(cancelled ? "cancelled" : "failed", { ...(attempts ? { attempts } : {}), ...fields, error: error instanceof Error ? error.message : String(error) });
    },
  };
}

/** The user's Apply, Keep or Restore on a finished proposal, appended to its receipt (item 1.3). Unknown or unreadable receipts are left alone. */
export function recordDecision(file: string, action: ReceiptDecision["action"]) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    entry.decisions = [...(Array.isArray(entry.decisions) ? entry.decisions : []), { action, at: new Date().toISOString() }];
    saveJson(file, entry);
  } catch { /* no receipt to append to */ }
}
