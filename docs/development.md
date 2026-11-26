# Entomatical development guide

Use a checkout of [r-spring/wyarden](https://github.com/r-spring/wyarden) and start a focused branch from its current `main`. Read the [contributing guide](https://github.com/r-spring/wyarden/blob/main/CONTRIBUTING.md) before preparing a pull request. Preserve other contributors' edits and worktrees.

## Build and package

Use Git, Node.js and npm. The editor also needs Node on its PATH for runtime helpers. The manifest requires VS Code `^1.140.0`; it does not declare a minimum standalone Node version. Use a verified recent Node environment. Clock tests need suitable timezone data, and some measurements need SQLite in the editor's embedded Node; updating shell Node does not update that runtime.

Windows packaging needs PowerShell 7 (`pwsh`) and the C# compiler used by `wrapper/build.ps1`. That script builds the process launcher and microphone recorder. Linux does not compile or ship those executables. Card terminals use node-pty and xterm; install dependencies in the intended build environment.

Run each command from the source checkout root:

| Step | Windows, PowerShell 7 | Linux |
|---|---|---|
| Dependencies | `npm ci` | `npm ci` |
| Compile | `npm run build:wrapper`, then `npm run build` | `npm run build` |
| Unit and parity checks | `npm test`, then `npm run parity` | Same |
| Package only | `npm run package:windows` | `npm run package:linux` |
| Inspect archive | `npm run vsix-check -- dist/entomatical-windows.vsix --os windows --list` | `npm run vsix-check -- dist/entomatical-linux.vsix --os linux --list` |

`npm run package` selects the host's OS. The package script runs required builds, invokes pinned `vsce` through `npx`, then inspects the archive. Initial use may need network access. It writes `dist/entomatical-windows.vsix` or `dist/entomatical-linux.vsix` and installs nothing. A Linux archive can also be packaged on Windows for inspection; that does not validate Linux execution. OS filenames alone do not establish Marketplace target-platform metadata or CPU support.

To package existing build output, run `npm run package:linux -- --skip-build` or `npm run package:windows -- --skip-build`. Both routes inspect the archive against the intended checkout. The inspector compiles TypeScript in memory and compares every emitted JS path and its bytes, all five orchestration briefs, the selected installed terminal dependencies, and the panel wrapper.

On Windows, `npm run build:wrapper` compiles the two C# sources in a fresh directory. It records SHA-256 hashes of the inputs, build script and compiler outputs before copying the executables to staging. Windows protects this local build record for the current user and machine. Keep `dist/native-wrapper-build.proof` in the same checkout for subsequent inspection or skip-build packaging. Run the build again after moving the checkout or changing the sources.

For an offline Windows cross-package, extract the two executables from `test/fixtures/windows-wrappers-0.8.24.zip` into the checkout root, preserving their `wrapper/` paths, then run `npm run package:windows`. This fixture contains the reviewed PE files from the 0.8.24 win32-x64 VSIX. The inspector independently pins both executable hashes and both C# source hashes. To approve a new cross-build, review its source and compiler outputs together and update the pins and fixture. To inspect a historical archive, use its matching source, dependencies and approved wrapper build.

Installation is deliberate and separate. After reviewing the archive, use **Extensions: Install from VSIX…** in the intended editor/profile, or its CLI:

```powershell
code --install-extension dist/entomatical-windows.vsix
```

```sh
codium --install-extension dist/entomatical-linux.vsix
```

Use your actual editor command/profile and reload after installation. Prefer explicit package/inspect/install steps so you choose the archive and destination profile. F5 with **Run Entomatical** opens an Extension Development Host; Windows development also needs the native helpers built first.

Official references: [VSIX installation](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix) and [extension publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). Packaging creates a local archive; it does not publish a Marketplace listing or attach a GitHub release asset.

## Checks and evidence

`npm test` runs the temporary-directory preflight, TypeScript compilation and tests, including mechanical parity checks. Tests create temporary boards and Git worktrees. Their folder is made inside the workspace, under the main checkout's `.entomatical/tmp/` (a card's own folder there when a card runs the tests), and deleted afterwards; set no `TMP`, `TEMP` or `TMPDIR`. That folder's marker file `ENTOMATICAL-TEMP-ROOT` stops git (`GIT_CEILING_DIRECTORIES`), `tools/board.js` and the preflight from climbing into the repository or board above; any other temporary directory must still be outside every Git repository and Entomatical board (a folder holding `.git` or `.entomatical/tasks.json`). Outside a Git repository the system temporary directory is used.

`node tools/parity.js --status` reports `docs/parity/FEATURES.md`. Keep this file in source checkouts: the mechanical checker and tests depend on it. Update a feature's registered wording when changing board text and record which platforms and workflows you actually exercised. The checker does not establish layout, keyboard usability or native behavior. A `done` row can cite unit-test-only evidence; treat it according to the evidence stated.

`tools/vsix-check.js` checks required runtime files, source mirrors, OS executables and forbidden paths. Packages contain compiled extension code, wrapper, hooks, board CLI, webview, selected workflows/documentation and terminal dependencies. Intended exclusions include source/tests, evidence, board state, maps, transcripts and credentials. **Inspect the actual entry list.** A structural pass is not a privacy audit, complete metadata comparison, proof that compiled code matches clean source, or validation of all documentation links.

## Native self-tests

These start real provider sessions and consume quota. Use a fresh throwaway Git repository with an initial commit, sign-in and required trust. Launch an Extension Development Host from a plain terminal with isolated editor user data. The extension accepts these triggers only in VS Code's Development or Test mode.

Under the checkout's marked `.entomatical/tmp/` directory, make a fresh fixture directory with a standalone Git checkout named `repo` and a sibling `fixture.code-workspace`. Save `{"folders":[{"path":"repo"}]}` in that workspace file and open the file in the development host. The directory containing the fixture must have the `ENTOMATICAL-TEMP-ROOT` file (the board creates it in `.entomatical/tmp/`). Before opening the host, create `repo/.entomatical/` and write the desired trigger as JSON. Set `test` to its filename, `repo` to the checkout's canonical absolute path, `head` to the current `git rev-parse HEAD` output, and `armedAt` to the current Unix time in milliseconds from `node -p "Date.now()"`. To print the canonical path from the checkout, run `node -p "require('node:fs').realpathSync.native(process.cwd())"`. Escape backslashes when writing a Windows path in JSON.

The gate checks the saved workspace, checkout and Git directory, and consumes the trigger immediately before dispatch. Empty legacy triggers, files copied from other checkouts, markers for earlier HEADs and triggers older than 15 minutes stay in place. Use a fresh fixture for each route.

| Test | Trigger file in throwaway repo | Result |
|---|---|---|
| Claude terminal | `.entomatical/selftest` | `.entomatical/selftest-result.jsonl`; host closes itself. |
| Claude panel | `.entomatical/selftest-panel` | `.entomatical/selftest-panel-result.jsonl`; needs Claude extension and turns wrapper on. |
| Codex, Linux | `.entomatical/selftest-codex` | `.entomatical/selftest-codex-result.jsonl`; start, permission, interrupt, worker, measurement, resume and discovery exercises. |
| Finish | `.entomatical/selftest-finish` | `.entomatical/selftest-finish-result.jsonl`; tests a conflict against the fixture's bare origin, then closes the host. |

For Finish, create `origin.git` as a standalone bare repository next to `repo`, add it as `origin` by absolute path, and push the fixture's `main` with `-u origin main`. Both effective fetch and push URLs and the bare repository's Git storage must stay in the fixture. Commit a starter `a.txt` and configure the fixture's Claude session to edit it and run Git. The trigger may include an `account` string naming an available account folder. An omitted or empty string selects the first account. An unavailable named account stops Finish before creating a card.

Run only when side effects and model calls are authorized. Rerun relevant host checks after CLI/editor changes; historical results retain their exact environment/version. Unit tests, browser rendering, isolated-host probes, normal installed-host acceptance and publication/readback are distinct evidence.

## Runtime layout

| Source | Responsibility |
|---|---|
| `src/board.ts` | Tasks, worktrees, sessions, status, checks and coordination. |
| `src/git.ts`, `src/finish.ts` | Git operations and reviewed Finish plan. |
| `src/extension.ts`, `media/` | Editor commands and board webview. |
| `src/sessions.ts`, `src/accounts.ts`, `src/codex.ts`, `src/acp.ts`, `src/wsl.ts` | Provider/account discovery and launch/protocol integration. |
| `src/cardTerminal.ts` | node-pty/xterm card terminals. |
| `src/plan.ts`, `src/orchestrator.ts`, `tools/board.js` | Plan validation, run policy and board CLI. |
| `src/checks.ts`, `src/metrics.ts`, `src/providerUsage.ts`, `src/ledger.ts` | Checks, measurements and completeness/gaps. |
| `src/voice.ts`, `src/speech-settings.ts`, `src/parakeet.ts` | Recording, configuration and speech engines. |
| `src/asana*.ts`, `src/obsidian*.ts` | Optional context links and writebacks. |
| `hook/`, `wrapper/`, `test/` | Status/usage hooks, shared wrapper, launchers/recorder and tests. |

Entomatical's GNU General Public License, version 3, is in `LICENSE`. Borrowed code retains attribution in `THIRD_PARTY_NOTICES.md` and `licenses/`. Preserve these files and source attribution comments when changing or redistributing adapted code.

## Local files and data

Entomatical keeps repository state under `.entomatical/` and creates its ignore rule. Check exclusions before sharing a source export or backup.

| Path under `.entomatical/` | Contents |
|---|---|
| `tasks.json`, `owner.json`, `dismissed.json` | Board state, ownership and hidden found sessions. |
| `wt/<id>` | Task worktrees, potentially containing uncommitted work. |
| `hooks/`, `events/`, `launch/` | Provider settings, activity and launch records. |
| `checks/` | Check runs/logs. |
| `metrics/`, `measurements/` | Numeric records, context snapshots, summaries and diagnostics. |
| `helpers/` | Helper inputs/outputs, schemas, receipts and provider output; no automatic retention pruning. |
| `inbox/`, `capabilities.json`, `status.jsonl` | Command requests, capabilities and status snapshots. |

In the user's home, `.entomatical/` holds installed helper scripts, wrapper, usage caches and ledger files. Approved Codex hook/trust settings go into `.codex/config.toml` through Codex's API. Providers keep their own sign-in/session history in their configuration folders. Claude hard links expose the same transcript under additional paths. Wrapper decisions are logged in the OS temporary directory as `entomatical-wrapper.log`.

Local records can contain prompts, replies, project paths and tool output. Process arguments can contain prompts. Grok identity display reads its authentication file to extract identity; avoid absolute claims that authentication files are never read. Speech keys and a saved Asana token use SecretStorage; `ASANA_PAT` can supply Asana credentials through the environment. Cloud speech receives audio; linked context enters coding prompts; linked Finish/Merge results can be written back. See the user guide before sharing logs or configuring integrations.

Unified-edition migration carries forward existing speech settings/history without deleting sources. Retired Claude dictation selections resolve to Local Whisper; no Claude speech engine remains. Preserve original settings/history while diagnosing migration.

## Releases and support

Check [GitHub Releases](https://github.com/r-spring/wyarden/releases) for release notes and any attached packages, and the [changelog](https://github.com/r-spring/wyarden/blob/main/CHANGELOG.md) for source changes. Report bugs through [GitHub Issues](https://github.com/r-spring/wyarden/issues), with the relevant versions, reproduction and sanitized evidence. Follow the [security policy](https://github.com/r-spring/wyarden/blob/main/SECURITY.md) for suspected vulnerabilities.
