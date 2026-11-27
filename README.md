# Entomatical

Entomatical is a VS Code board for coding-agent work. Give each task its own Git branch and worktree, follow the agent's session, and review the changes before bringing them back into your project.

[Download for Windows or Linux](https://github.com/r-spring/wyarden/releases/latest) · [User guide](https://github.com/r-spring/wyarden/blob/main/docs/user-guide.md) · [Report an issue](https://github.com/r-spring/wyarden/issues)

## What you can do

- **Keep work separate.** Run Claude Code, Codex, Grok or Antigravity from cards in isolated worktrees. Subtasks branch from their parent. You use your own provider account and can choose models and effort where the provider exposes them.
- **Follow a task from prompt to review.** Open its session, answer questions, send a follow-up, inspect the diff and run configured checks. The **Review** status means the turn ended. You decide whether the result meets the task.
- **Coordinate larger jobs.** Run saved assignments with dependencies and checks, or approve a card's delegation plan and limits before it starts.
- **Dictate a prompt.** Use local Whisper or Parakeet, or select OpenAI, Groq or Deepgram speech with your own API key. Press **F8** in a focused VS Code terminal to insert a transcript for review before sending it.

## Install

You need VS Code or VSCodium compatible with VS Code **1.140 or later in the 1.x series**, Git, and a recent Node.js on the editor's PATH. This release provides x64 packages for Windows and Linux. Install and sign in to at least one supported coding-agent CLI separately. Claude and Codex editor modes also require their corresponding editor extensions.

1. Download the Windows x64 or Linux x64 VSIX from [GitHub Releases](https://github.com/r-spring/wyarden/releases/latest).
2. In the editor, run **Extensions: Install from VSIX…**, choose the downloaded file, and reload if prompted. [VSIX installation guide](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
3. Open a trusted Git repository at its top folder, with at least one commit. Run **File → Save Workspace As…** to create a `.code-workspace` file and use that file to reopen the project. In a multi-root workspace, the first folder holds the board.

## Run your first task

1. Open **Entomatical** from the activity bar and select a signed-in provider account. Use **Entomatical: Open Board in Editor Tab** for a wider view.
2. Add a title and a small, specific prompt. New cards start automatically by default. Set `entomatical.autoStart` to `false` if you want to queue them first.
3. Follow the card and open its session when it needs input. When the card reaches **Review**, inspect the changes and check results.
4. Use **Merge** to integrate committed work locally. **Finish** shows a plan before it commits, integrates, potentially pushes to the configured upstream, and removes the worktree. **Mark done** closes the card without integrating the branch.

## Local data and provider access

The board stores worktrees and task records in the workspace's Git-ignored `.entomatical/` folder. Those records and provider logs can contain prompts, replies and project paths. Remove sensitive details before sharing them. Coding tasks follow your chosen provider's account, usage limits and data handling. Cloud dictation sends recorded audio to the selected speech service. [Provider setup and data handling](https://github.com/r-spring/wyarden/blob/main/docs/user-guide.md)

## About and support

The extension appears as **Entomatical** in your editor. Wyarden is its GitHub repository and project website. Robert Spring maintains the project. [Wyarden website](https://wyarden.com) · [Robert Spring on GitHub](https://github.com/r-spring)

Entomatical is under active development. Available session modes and resume behavior vary by provider and editor. See the [release notes](https://github.com/r-spring/wyarden/releases/latest) and [changelog](https://github.com/r-spring/wyarden/blob/main/CHANGELOG.md) for version details.

- [Build from source](https://github.com/r-spring/wyarden/blob/main/docs/development.md) or [contribute a change](https://github.com/r-spring/wyarden/blob/main/CONTRIBUTING.md).
- [Ask a question or report a bug](https://github.com/r-spring/wyarden/issues). For a suspected vulnerability, follow the [private reporting instructions](https://github.com/r-spring/wyarden/blob/main/SECURITY.md).
- Entomatical is licensed under the GNU General Public License v3. [License](https://github.com/r-spring/wyarden/blob/main/LICENSE) · [Third-party notices](https://github.com/r-spring/wyarden/blob/main/THIRD_PARTY_NOTICES.md)
