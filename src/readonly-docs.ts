import * as vscode from "vscode";

/**
 * Read-only documents for text Entomatical shows in an editor: a helper's result or input (Open in editor) and both sides of Show changes.
 * Untitled documents opened with that text were editable and asked to be saved on close (item 10 of session 3482f4's second review).
 * A content provider's documents are read-only. The text lives in memory only, newest 50 kept.
 */
export const READONLY_SCHEME = "entomatical-text";
const texts = new Map<string, string>();
let next = 0;

/** Each URI names its own text, which never changes, so the provider needs no change event. */
export function registerReadOnlyDocs(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(READONLY_SCHEME, { provideTextDocumentContent: (uri) => texts.get(uri.query) ?? "" });
}

/** A read-only document's URI for this text; name is the tab title (an extension picks the language: .md for Markdown). */
export function readOnlyUri(name: string, text: string): vscode.Uri {
  const id = String(++next);
  texts.set(id, text);
  if (texts.size > 50) texts.delete(texts.keys().next().value!);
  return vscode.Uri.from({ scheme: READONLY_SCHEME, path: `/${name.replace(/[\\/?#]/g, "-")}`, query: id });
}

/** The text behind a read-only URI (what the provider serves). */
export const readOnlyText = (uri: vscode.Uri) => texts.get(uri.query);

export async function showReadOnly(name: string, text: string) {
  const doc = await vscode.workspace.openTextDocument(readOnlyUri(name, text));
  await vscode.window.showTextDocument(doc, { preview: false });
}
