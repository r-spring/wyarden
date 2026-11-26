// F95 item 5 (docs/agents/README.md): the user's own terminal acts on the board as the operator, as the
// board's buttons do. Each window makes a per-machine token at ~/.entomatical/operator-token (mode 600) once. `board.js` run with
// ENTOMATICAL_OPERATOR_TOKEN (or --operator, which reads the file) and no ENTOMATICAL_TASK signs its request with an HMAC of the token,
// so the token itself never lands in the inbox or its answers. This keeps honest agents out, not a hostile process running as the user:
// such a process can read the file. Briefs never mention it. Pure apart from the token file.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const OPERATOR_TOKEN_FILE = () => path.join(os.homedir(), ".entomatical", "operator-token");
/** What the operator may do from a terminal: what the card's own buttons do, plus answering a takeover request. Never Discard or Finish. */
export const OPERATOR_OPS = ["stop", "resume", "done", "cancel", "send", "handoff", "approve", "deny"] as const;
export type OperatorOp = typeof OPERATOR_OPS[number];
export interface OperatorRequest { op: OperatorOp; id: string; text?: string; to?: string; reason?: string }
/** How far a request's `at` may be from the board's clock. */
export const OPERATOR_SKEW_MS = 5 * 60_000;

/** Makes the token once; a token already there is kept (two windows starting together: the first write wins). */
export function ensureOperatorToken(file = OPERATOR_TOKEN_FILE()): void {
  if (readOperatorToken(file)) { if (process.platform !== "win32") try { fs.chmodSync(file, 0o600); } catch { /* not ours to fix */ } return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.rmSync(file, { force: true }); fs.writeFileSync(file, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}
export function readOperatorToken(file = OPERATOR_TOKEN_FILE()): string | undefined {
  try { const t = fs.readFileSync(file, "utf8").trim(); return /^[0-9a-f]{64}$/.test(t) ? t : undefined; } catch { return undefined; }
}
/** The request's signature: HMAC-SHA256 of the nonce and the request without `mac`, as board.js wrote it (tools/board.js operatorMac). */
export const operatorMac = (token: string, nonce: string, body: object) => crypto.createHmac("sha256", token).update(`${nonce}\n${JSON.stringify(body)}`).digest("hex");

/** Whether a request signed as the operator carries a valid signature from this machine's token, made in the last few minutes. */
export function verifyOperator(raw: Record<string, unknown>, nonce: string, token: string | undefined, now = Date.now()): boolean {
  if (!token || typeof raw.mac !== "string" || !/^[0-9a-f]{64}$/.test(raw.mac)) return false;
  const at = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
  if (!Number.isFinite(at) || Math.abs(now - at) > OPERATOR_SKEW_MS) return false;
  const { mac, ...rest } = raw;
  const want = Buffer.from(operatorMac(token, nonce, rest), "hex"), got = Buffer.from(mac as string, "hex");
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const ID = /^[0-9a-f]{6}$/;
/** The operator request's own small schema: unknown fields refused, as for a card's requests. */
export function validateOperatorRequest(raw: Record<string, unknown>): { request: OperatorRequest } | { error: string } {
  const op = raw.op as OperatorOp;
  if (!(OPERATOR_OPS as readonly string[]).includes(String(op))) return { error: `The operator may ${OPERATOR_OPS.join(", ")}; not ${String(raw.op)} (Discard and Finish stay on the card)` };
  for (const k of Object.keys(raw)) if (!["v", "op", "by", "session", "at", "mac", "id", "text", "to", "reason"].includes(k)) return { error: `Unknown field "${k}" for ${op}` };
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return { error: "id is not a card id" };
  const request: OperatorRequest = { op, id: raw.id };
  if (op === "send") { if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 24_000) return { error: "send needs text (up to 24000 characters)" }; request.text = raw.text; }
  if (op === "handoff") { if (typeof raw.to !== "string" || !ID.test(raw.to)) return { error: "handoff needs --to <card id>" }; request.to = raw.to; }
  if (raw.reason !== undefined) { if (typeof raw.reason !== "string" || raw.reason.length > 500) return { error: "reason must be text of at most 500 characters" }; request.reason = raw.reason.trim(); }
  return { request };
}
