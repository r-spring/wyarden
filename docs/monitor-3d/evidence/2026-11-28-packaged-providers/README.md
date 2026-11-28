# Wyarden 0.2.0 signed-in provider acceptance

Card `56e6ee` tested source `bc6a7ad2a514ee61b5fc1e072110971b19a14679`, which includes host integration `4e06abe311f28516e0526a98549246008c0bbf86`. On 2026-11-28, `node ui-concepts/monitor-3d-live/tools/pack.js` reproduced the parent card's 55-entry, 248,451-byte VSIX. Both archives had SHA-256 `83359B3E86F9579457DDFDC69E79B684E2C45A60E7A66A1409D1CEB80D99413C`.

VS Code 1.148.0 x64 (`661626d0e72f97806550790a98fb87116c9db825`) installed that VSIX and listed `r-spring.wyarden-monitor-3d@0.2.0`. Of the 53 installed payload files, 52 matched byte for byte. The installed manifest matched after removing VS Code's added `__metadata` field. Both fixture windows used disposable editor data, extensions, and `WYARDEN_MONITOR_HOME` directories. The captures came from the installed extension's floating monitor webview. Node.js was `v26.7.0`.

## Collector review

In VS Code, **Set Up Collectors…** opened five previews. The dialog listed the three provider profiles, the empty Claude profile used to isolate Claude discovery, and the local command bridge. **Show every change** opened each diff. **Add to 5 files** produced the expected registrations and bridge. The editor reported **Updated 5 of 5 files**. **Status** opened the extension's output channel, and the monitor showed Grok Build and Antigravity as installed. The Codex status line describes the disposable profile registration, which still awaited approval. The native sign-in used an identical copy of the reviewed file scoped to the fixture project.

The signed-in programs used workspace-local copies of the three reviewed registrations, verified by hash before launch. Antigravity and Codex presented workspace trust for the fixture folders. Codex showed its native hook overview. A read-only `hooks/list` inventory matched all ten project entries against their reviewed command bytes and source file. Four unrelated entries were already trusted. The individual Wyarden `PreToolUse` entry changed from pending to trusted, and the overview showed zero pending after approving the remaining reviewed entries. [Antigravity CLI hook documentation](https://antigravity.google/docs/hooks)

## Observed provider activity

All times are UTC on 2026-11-28. `scope-completion.json` retains the final rendered accessibility labels and timestamps. `all-open.png`, `fixture-alpha.png` and `fixture-beta.png` show the packaged extension's actual canvas and workspace chips. The view labels Grok Build as **Grok**.

| Installed executable | Fixture action | Rendered result |
| --- | --- | --- |
| `agy.exe` 1.5.19 | Existing sign-in, `claude-opus-5-5` at `high`. Read `antigravity-fixture.txt` with the file-view tool in `Fixture-Beta`. | Antigravity idle at 10:09:30, one `read_file` call, zero open or failed, and one read on the named resource. |
| `grok.exe` 1.0.92 stable (`b06756fd6256`) | Existing service sign-in, `grok-4.7-build-fast`. `Read` returned the line from `grok-fixture.txt` in `Fixture-Alpha`. | Grok idle at 10:09:54, one `read_file` call, zero open or failed, and one read on the named resource. |
| `codex.exe` 0.172.0 | Existing ChatGPT sign-in, `gpt-6.2-sol`. Called `wyarden_fixture.read_fixture` in the resumed `Fixture-Alpha` session, approved it once in Codex, and received the expected line from `codex-fixture.txt`. | Codex asked for permission at 10:18:10. At 10:18:33 it was idle with one call, zero open and zero failed. The `wyarden_fixture` MCP node was at rest with one call and zero open. |

At 10:18:44–47, **All open** showed three sessions, **Fixture-Alpha** showed only Codex and Grok, **Fixture-Beta** showed only Antigravity, and switching back to **All open** restored the same three sessions. Each expected provider appeared once per applicable scope. The monitor reported zero sessions left out and zero clashes on all four views. During the permission wait, the accessibility list repeated the Codex option in its **Needs you** shortcut. The canvas and accessibility column list each showed one Codex session. See `codex-permission-wait.png` and `codex-permission-ax.json`.

## Windows shell failure

The first Codex turn tried to read the same fixture through its Windows shell. At 10:15:15 Codex reported “Access is denied” starting the shell and the fixture read did not run. Wyarden returned the agent to idle while retaining one open `Bash` call and zero failures. A retry with the vendor's **Ask for approval** workspace mode produced a second attempted call and the same shell error at 10:16:45. `all-open-initial.png` and `scope-observations.json` preserve the first failure alongside the scope checks. The successful MCP read above exercises completion through the shipped collector. Closure of a shell call after a launch failure remains open on repair card `2b5fe8`.

## Test results

- Provider and routing tests reported 26 passed and zero failed.
- The first full monitor run reported 485 tests, 476 passed, zero failed, four skipped and five marked todo.
- A concurrent repeat hit four test-case failures across the floating-window, browser looks and browser preview checks. The reporter also listed two enclosing suite failures. The first runs and the live packaged captures record their own coverage above.

The isolated editor and fixture registrations remain available for parent card `80cf35` to retest the repair. The parent owns their teardown and any installation in the normal local editor.
