# Entomatical

Entomatical brings coding-agent tasks into a board in VS Code. Give each task its own Git worktree, follow its session, and review the work before bringing it back into your project.

Homepage: [wyarden.com](https://wyarden.com)

Entomatical was called AgentBoard until 16 November 2026. Its folders, settings and extension id (`agentboard`) were renamed to `entomatical` on 18 November 2026 by the cutover (`node tools/cutover-entomatical.js`), and the GitHub repository became `r-spring/entomatical` the same day.

Connect Claude Code, Codex, Grok or Antigravity. Keep a small fix on one card, split a larger job into subtasks, or approve a coordinated run with a defined scope and limits. The board keeps the task, session status and review controls together while you work.

## From prompt to reviewed change

- **Separate working copies.** Starting a board task creates or reuses its branch and worktree. Subtasks branch from their parent, so related work can build on the same starting point.
- **Sessions you can follow.** Open a card's editor session or terminal, send a follow-up, stop work, or see which card needs input. Session and resume behavior varies by provider.
- **Provider choice per task.** Choose a connected provider and its available model and effort options. Entomatical uses the provider's CLI and your sign-in.
- **A review step.** Read the reply, inspect changes in source control and examine any configured checks. Review means the session's turn ended; you decide whether the result meets the task.
- **Coordination when you need it.** Run saved assignments with dependencies and checks, or enable delegation on a card and approve its plan and limits. Optional review roles and watchers support larger runs.
- **Optional dictation.** Draft prompts with local Whisper or Parakeet, or select a cloud speech service with your own API key.

## Before you start

You need a compatible desktop editor (VS Code 1.140 or later), Git, a recent Node.js available on the editor's PATH, and a trusted local Git repository with an initial commit. Entomatical is developed on Windows 11 with VS Code and Linux with VSCodium; individual provider and platform paths have different verification coverage. macOS support is not established.

### Required workspace setup

Entomatical runs only in a window that meets all three of these. Without them the board lists what is missing and runs nothing.

1. **A folder is open.** Open your project folder (**File → Open Folder…** or **File → Add Folder to Workspace…**).
2. **That folder is a git repository's top folder.** Run `git init` in it (and make a first commit) if it is not one yet. A folder inside a larger repository is not enough: open the repository's top folder.
3. **The window is saved as a workspace.** Run **File → Save Workspace As…** and keep the `.code-workspace` file. Open your project through that file from then on.

The board keeps each card's worktree in `.entomatical/wt/<card>` and gives its session `.entomatical/tmp/<card>` as `TMP`, `TEMP` and `TMPDIR`. Helper working folders, dictation and acceptance checks also use the workspace's git-ignored `.entomatical/tmp/`. Finishing or deleting a card removes its temporary folder when it is no longer in use.

The Claude panel wrapper writes `entomatical-wrapper.log` in its process's temporary directory (`os.tmpdir()`) and rotates it to `entomatical-wrapper.log.1`. That directory can be the system temp folder even with a board open. Wrapper updates and usage-cache updates stage temporary copies beside their destination files, normally under `~/.entomatical/`.

Without an active board, dictation and Parakeet jobs use the process's temporary directory. A helper tries that directory, then `~/.entomatical/helper-cwd/`, for a working folder outside Git. If neither qualifies, it uses the process's temporary directory. Repository test runs normally use the workspace temp area. Outside a repository they can use the system temp folder.

Install and sign into the coding-provider CLI you plan to use separately. Claude panel mode also needs the Claude Code editor extension; Codex editor mode needs the Codex editor extension. Terminal modes are available. Installing Entomatical does not install provider CLIs, supply accounts or include model usage. Provider access, charges, limits and compliance with provider terms remain your responsibility.

## Install and try one task

Once the listing is live, search for `@id:r-spring.entomatical` in Extensions and click **Install**. VS Code uses the Visual Studio Marketplace and VSCodium uses Open VSX by default. With the editor's extension auto-update setting enabled, a fresh marketplace install uses automatic updates by default. A manual VSIX install turns off auto-update for that copy.

For a local install, use a reviewed Windows or Linux VSIX. Check [GitHub Releases](https://github.com/r-spring/wyarden/releases) for release notes and any attached packages. If the release has no VSIX attached, build one from source using the [development guide](https://github.com/r-spring/wyarden/blob/main/docs/development.md).

1. If you are installing locally, choose the VSIX for your operating system, run **Extensions: Install from VSIX…**, select the archive, and reload when prompted. See the official [VSIX installation instructions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix).
2. Open your project's saved workspace (see [Required workspace setup](#required-workspace-setup)) and the **Entomatical** activity-bar view. Select your signed-in provider account. **Entomatical: Open Board in Editor Tab** gives the board more room.
3. Enter a title and a small, specific prompt, then add the task. New cards start automatically by default; set `entomatical.autoStart` to `false` to queue them instead. Leave prompt helpers, completion-rule generation and orchestration off for your first task; these can add model calls.
4. Approve any required provider hook or repository trust request, then follow the card through **Running**, **Needs input** and **Review**. Open the session to answer a question or continue the work.
5. Inspect the changes and check results. **Merge** integrates committed work locally. **Finish** presents a plan that can commit, integrate, **push to the configured upstream**, and remove the worktree. Review that plan before confirming. **Mark done** changes status without integrating the branch.

Detailed controls, provider setup, settings and troubleshooting are in the [user guide](https://github.com/r-spring/wyarden/blob/main/docs/user-guide.md). Build and package instructions are in the [development guide](https://github.com/r-spring/wyarden/blob/main/docs/development.md).

## Speak a draft

Choose a provider in the board's **Dictation** dropdown. Local Whisper and Local Parakeet need separately installed executables and compatible models. Whisper and Parakeet show text while you speak; Parakeet transcribes the recording so far about every second, locally, and the final transcript replaces it after Stop or silence. Linux microphone recording also needs `arecord` from `alsa-utils`.

To dictate into a VS Code terminal, focus it and press **F8**, or run **Entomatical: Dictate into Terminal**. Press F8 again to stop. It uses the same speech settings and inserts the transcript into the original terminal without pressing Enter; review the text before sending it.

OpenAI, Groq and Deepgram speech use an explicit speech API key saved through **Entomatical: Set Speech API Key**. Audio is uploaded to the selected cloud service after recording stops. Coding-provider sign-in does not supply this key. A failed transcription does not silently switch providers. Text you later submit to a coding agent follows that agent's normal data handling, including text transcribed locally.

## Status and support

Entomatical is under active development. Local builds and automated checks do not establish acceptance in every native editor, provider or speech configuration. Provider CLI changes can affect hooks, session discovery, usage readings and editor integration. The user guide records known limits, including provider-specific resume behavior and the optional experimental Codex panel bridge.

Report bugs and feature requests in [GitHub Issues](https://github.com/r-spring/wyarden/issues). Include the extension, editor and CLI versions, operating system, chosen session mode and steps to reproduce; remove credentials, prompts and private project details from shared logs. For suspected vulnerabilities, follow the [security policy](https://github.com/r-spring/wyarden/blob/main/SECURITY.md).

Source and documentation: [r-spring/wyarden](https://github.com/r-spring/wyarden). See the [changelog](https://github.com/r-spring/wyarden/blob/main/CHANGELOG.md) for changes and [contributing guide](https://github.com/r-spring/wyarden/blob/main/CONTRIBUTING.md) for development contributions.

Entomatical is licensed under the GNU General Public License, version 3. See [LICENSE](https://github.com/r-spring/wyarden/blob/main/LICENSE) for the terms and [THIRD_PARTY_NOTICES.md](https://github.com/r-spring/wyarden/blob/main/THIRD_PARTY_NOTICES.md) for component attribution and licenses.
