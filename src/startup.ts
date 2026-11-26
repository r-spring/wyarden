import * as vscode from "vscode";

// the user, 2 November 2026: on a reload only Entomatical and the session tabs that were open come back. VS Code restores those tabs
// itself; this keeps the right (secondary) sidebar shut and stops the Codex extension focusing its sidebar there on startup
// (its chatgpt.openOnStartup), which also loads Codex's view. Off with entomatical.quietStartup.
export async function quietStartup(api: typeof vscode = vscode): Promise<void> {
  if (!api.workspace.getConfiguration("entomatical").get<boolean>("quietStartup", true)) return;
  const codex = api.workspace.getConfiguration("chatgpt");
  const set = codex.inspect<boolean>("openOnStartup");
  const scopes: [unknown, vscode.ConfigurationTarget][] = [[set?.globalValue, api.ConfigurationTarget.Global], [set?.workspaceValue, api.ConfigurationTarget.Workspace]];
  for (const [value, target] of scopes) {
    if (value === true) await Promise.resolve(codex.update("openOnStartup", false, target)).catch(() => undefined);
  }
  for (const command of ["workbench.action.closeAuxiliaryBar", "entomatical.board.focus"]) {
    await Promise.resolve(api.commands.executeCommand(command)).catch(() => undefined);
  }
}
