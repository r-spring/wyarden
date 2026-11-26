// Strict capability profiles on Claude's terminal routes: the launch recipe under test (the user, 17 November 2026: "start proving routes").
// A strict profile runs with exactly its manifest. Per process, without touching the account folder:
//   --strict-mcp-config --mcp-config <file>   only the selected MCP servers' own definitions;
//   --disable-slash-commands                  no user, project or plugin skills (no per-process flag selects a subset of skills);
//   enabledPlugins: every plugin false        in the card's own --settings file, so no plugin's hooks, agents, skills or servers load;
//                                              the CLI's own built-in plugins too (BUILTIN_PLUGINS), which no inventory file lists;
//   --no-chrome                                the built-in claude-in-chrome MCP server, which --strict-mcp-config keeps (probe, 17 November).
// So only a manifest of MCP servers can be enforced; a skill or plugin in it is refused. Whether the CLI really honours all three is
// what the dev-host probe checks (docs/evidence/capability-profiles-gap-closure/strict-terminal-probe.md); until then nothing but a
// developer host uses this.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { samePath, type Inventory, type Item } from "./profiles";

export interface StrictClaude { args: string[]; enabledPlugins: Record<string, boolean>; mcpConfig: { mcpServers: Record<string, unknown> } }

/** Built-in plugins bundled in the CLI (2.1.327, read from the binary): easel adds an MCP server (chart) and hooks. sec-default is left alone:
 * it is a security default that seats itself only under managed settings or a Team or Enterprise organization. */
export const BUILTIN_PLUGINS = ["easel@builtin", "plugin-authoring@builtin"];

const readJson = (f: string): Record<string, unknown> | undefined => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
const servers = (o: unknown): Record<string, unknown> => o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : {};

/** Where a selected MCP server is defined, in the CLI's order of precedence: local (this folder in .claude.json), project (.mcp.json), user. */
export function mcpDefinition(id: string, configDir: string, cwd: string, platform: string = process.platform): unknown {
  const state = readJson(configDir ? path.join(configDir, ".claude.json") : path.join(os.homedir(), ".claude.json")) ?? {};
  for (const [k, p] of Object.entries(servers(state.projects))) if (samePath(k, cwd, platform) && servers((p as { mcpServers?: unknown })?.mcpServers)[id]) return servers((p as { mcpServers?: unknown }).mcpServers)[id];
  return servers(readJson(path.join(cwd, ".mcp.json"))?.mcpServers)[id] ?? servers(state.mcpServers)[id];
}

/**
 * The recipe for a strict manifest, or why it cannot be enforced. mcpFile is where the caller writes mcpConfig (named in the args).
 */
export function strictClaude(items: Item[], inv: Inventory, configDir: string, cwd: string, mcpFile: string, platform: string = process.platform): StrictClaude | string {
  const other = items.filter((i) => i.kind !== "mcp");
  if (other.length) return `this launch recipe enforces only MCP servers; ${other.map((i) => `${i.kind} ${i.id}`).join(", ")} cannot be selected alone (--disable-slash-commands turns off every skill)`;
  const mcpServers: Record<string, unknown> = {};
  for (const i of items) {
    const def = mcpDefinition(i.id, configDir, cwd, platform);
    if (!def) return `MCP server ${i.id} has no definition in this account's .claude.json or the worktree's .mcp.json (a plugin's server cannot be selected without its plugin)`;
    mcpServers[i.id] = def;
  }
  const enabledPlugins = Object.fromEntries([...inv.items.filter((f) => f.kind === "plugin").map((f) => f.id), ...BUILTIN_PLUGINS].map((id) => [id, false]));
  return { args: ["--strict-mcp-config", "--mcp-config", mcpFile, "--disable-slash-commands", "--no-chrome"], enabledPlugins, mcpConfig: { mcpServers } };
}
