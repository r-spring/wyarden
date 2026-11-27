# Contributing to Entomatical

Keep contributions focused on a concrete problem and a reviewable change. For a larger feature, dependency or workflow change, discuss the proposal in [GitHub Issues](https://github.com/r-spring/wyarden/issues) before implementing it. Report suspected vulnerabilities using the [security policy](https://github.com/r-spring/wyarden/blob/main/SECURITY.md).

The [code of conduct](https://github.com/r-spring/wyarden/blob/main/CODE_OF_CONDUCT.md) applies to project discussions and contributions.

## Work on a branch

Use a source checkout of [r-spring/wyarden](https://github.com/r-spring/wyarden). Start a branch from its current `main`; keep unrelated changes out of your pull request. If using Git worktrees, give each task its own worktree and preserve other contributors' edits.

Describe the trigger, current behavior and intended result. A bug report should include the extension version, operating system, editor version, relevant provider/CLI version and a minimal reproduction. Use a disposable example repository rather than a live project or work board.

## Build and check

Use Git, Node.js and npm. The extension manifest requires VS Code `^1.140.0`; it does not declare a minimum standalone Node.js version. Windows wrapper builds also need PowerShell 7 (`pwsh`) and the .NET Framework C# compiler referenced by `wrapper/build.ps1`.

Run commands from the checkout root:

| Purpose | Windows | Linux |
|---|---|---|
| Install development dependencies | `npm ci` | `npm ci` |
| Build native helpers | `npm run build:wrapper` | Not required |
| Compile TypeScript | `npm run build` | `npm run build` |
| Run unit and mechanical parity checks | `npm test`, then `npm run parity` | Same |
| Read the recorded platform status | `node tools/parity.js --status` | Same |
| Build and inspect a VSIX | `npm run package:windows` | `npm run package:linux` |
| List and check archive contents | `npm run vsix-check -- dist/entomatical-windows.vsix --os windows --list` | `npm run vsix-check -- dist/entomatical-linux.vsix --os linux --list` |

`npm test` performs a temporary-directory safety check, compiles TypeScript and runs the tests. The tests' folder is made under the main checkout's `.entomatical/tmp/`, inside the workspace, and deleted afterwards; do not set `TMP`, `TEMP` or `TMPDIR`. A marker file there stops git and the board's searches from climbing into the repository above.

Packaging runs the required builds and archive inspection, writes to `dist/`, and installs nothing. It invokes pinned VS Code packaging tooling through `npx`, which may need network access. Inspect the archive before choosing to install it. Do not use an install or publish command as a substitute for a package check.

For runtime changes, exercise the affected workflow in an Extension Development Host using a throwaway repository. Check start, stop, resume and multi-line follow-ups when session behavior changes. Real provider sessions can consume quota and act on files; use your own authorized test environment. Report which provider, operating system and editor you checked, along with commands, results and any skipped checks. A unit-test or archive pass does not establish native behavior on another platform.

Keep shared code portable and isolate OS-specific behavior with platform checks or separate helpers. Windows uses `wrapper/launcher.cs`, `wrapper/recorder.cs` and `wrapper/build.ps1`; Linux uses the shared Node wrapper without those executables. Update `docs/parity/FEATURES.md` when changing registered board text or feature behavior, and leave untested platform behavior explicitly pending. Keep this feature file in source checkouts because the checker and tests read it. See the [development guide](https://github.com/r-spring/wyarden/blob/main/docs/development.md) for more detail.

## Prepare the pull request

- Explain the problem and resulting behavior, with a small before/after example when useful.
- Include relevant checks and their results. For UI changes, include sanitized screenshots and keyboard behavior where affected.
- Keep unrelated refactors, generated artifacts and dependency changes out of the patch. Explain any dependency that is necessary.
- Preserve existing copyright and license notices. For adapted code, name the upstream repository, file, commit, license and modifications in a source comment; update `THIRD_PARTY_NOTICES.md` and retain the license text in `licenses/`.
- Use synthetic prompts, paths and records in tests and examples. Remove tokens, account details, private project names, transcripts and personal paths from reports, logs and screenshots. Share only the smallest sanitized excerpt needed to reproduce the issue.

Entomatical uses the GNU General Public License, version 3; see [LICENSE](https://github.com/r-spring/wyarden/blob/main/LICENSE). Third-party components retain their own notices and license terms in `THIRD_PARTY_NOTICES.md` and `licenses/`.

The agent command and schema guide is `docs/agents/README.md`: https://github.com/r-spring/wyarden/blob/main/docs/agents/README.md.
