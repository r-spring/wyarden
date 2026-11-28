# Wyarden 0.2.0 delivery VSIX and signed-in replay

Card `cbe1fe` tested the parent-supplied archive on 2026-11-28 UTC. The source was `afe5c20d8a6e5ec5adeab4d640b592ac67322c5f`. Running `node ui-concepts/monitor-3d-live/tools/pack.js` at that revision reproduced the 56-entry, 277,384-byte VSIX with SHA-256 `BDF7E4711A4A2BFD291C6C4F22D488FA4EF7CF03FCBD829BD08BAF142058A616`.

VS Code 1.148.0 x64 (`661626d0e72f97806550790a98fb87116c9db825`) installed and listed `r-spring.wyarden-monitor-3d@0.2.0` using a disposable user-data directory, extensions directory and monitor hub. Of the 54 package payload files, 53 matched byte for byte. The installed `package.json` matched after excluding VS Code's added `__metadata`. VS Code's copy of the VSIX manifest was also byte-identical. See `final-install.json`. Run `python verify-installed-vsix.py <vsix> <installed-extension-directory>` from this evidence directory to repeat the comparison. The verifier accepted the delivery archive and rejected the earlier repair archive by hash.

## Collector setup and native reviews

1. In the installed delivery build, run **Wyarden 3D Monitor: Remove Collectors**, choose **Show every change**, and confirm **Remove from 4 files**. VS Code reported **Updated 4 of 4 files**.
2. Run **Wyarden 3D Monitor: Set Up Collectors…**, choose **Show every change**, and confirm **Add to 4 files**. VS Code again reported **Updated 4 of 4 files**. The isolated command bridge was already present and remained in use.
3. Use the reviewed registrations in the disposable workspace folders. The Codex, Grok Build and Antigravity project copies matched the corresponding editor-reviewed files by hash. The CLIs used their existing sign-ins and ran with the board's task and repo variables removed in those processes. Antigravity presented and accepted trust for the fixture folder.
4. Codex opened its own hook review. A read-only `hooks/list` matched the project source and command bytes for all ten untrusted Wyarden rows. Four unrelated rows were already trusted. Each Wyarden row was approved individually in Codex, leaving zero pending. The editor footer describes the separate disposable profile registration. The signed-in Codex session used the approved project registration.

## Observed tool activity

| Provider and executable | Fixture action | Result in the installed floating editor |
| --- | --- | --- |
| Grok Build 1.0.92 stable (`b06756fd6256`), `grok-4.7-build-fast` | `Read` returned the line from `grok-fixture.txt` in Fixture-Alpha. | At 10:38:41 UTC, idle with one `read_file` call, zero open, zero failed and one resource read. |
| Antigravity 1.5.19, `--model=claude-opus-5-5 --effort=high` | `view_file` returned the line from `antigravity-fixture.txt` in Fixture-Beta. | At 10:39:13 UTC, idle with one `read_file` call, zero open, zero failed and one resource read. |
| Codex 0.172.0, `gpt-6.2-sol` | Its Windows shell attempted `Get-Content -LiteralPath codex-fixture.txt` in Fixture-Alpha and reported **Access is denied** starting the shell. | At 10:39:37 UTC, Codex was idle and Bash was at rest with one call, zero open and zero failed. Its inspector reported **Last call: end not observed**. |
| Same Codex session | `wyarden_fixture.read_fixture` entered the vendor's permission prompt. After a one-time **Allow**, the tool returned the fixture line. | The floating editor showed one open MCP call during the wait. At 10:41:24 UTC, Codex was idle with two total calls and zero open or failed. The MCP server was at rest with one call, zero open, and a successful last call. |

The Bash inspector records Wyarden's observation. No matching tool end reached the monitor for that call. The actual shell error came from native Codex. The separate focused test covers a scrubbed `PreToolUse → Stop` sequence without a matching post and verifies that closing the call leaves its result unknown, including after snapshot restore.

At 10:41:27–31 UTC, scope switching showed **All open → Fixture-Alpha → Fixture-Beta → All open** with **3 → 2 → 1 → 3** sessions. Alpha contained Codex and Grok. Beta contained Antigravity. Each scope had one column per applicable provider, zero sessions left out and zero clashes. The MCP permission wait displayed a separate accessibility shortcut to the existing Codex column.

The sanitized rendered labels are in `final-session-observations.json`. The five floating editor captures are `final-codex-ended.png`, `final-codex-permission.png`, `final-all-open.png`, `final-fixture-alpha.png` and `final-fixture-beta.png`. The fixture child processes exited and the disposable editor closed. Fixture tooling was retained privately for parent card `80cf35`, which owns normal-profile installation.

## Suite results

On Node.js 26.7.0, the delivery source's full serialized suite reported **562 tests, 558 passed, 0 failed, 0 cancelled, 4 skipped and 0 TODO**. Two skips were loopback back-pressure cases, one was POSIX mode preservation, and one was the Windows symlink privilege check. The focused call lifecycle suite passed **5 of 5** with zero failures, skips or TODO. Commands and reporter totals are in `final-suite.txt`.

The initial candidate in `README.md` has SHA-256 `83359B3E86F9579457DDFDC69E79B684E2C45A60E7A66A1409D1CEB80D99413C` and retains its dated stale-call observation. The intermediate repair archive `E91A937164DC996F32502AB21443E8E258FF12CE3DB33F373563BAE2E63457B1` passed the exact installation comparison. Its default-concurrency test run reported 539 tests, 534 passed, 1 failed, 4 skipped and 0 TODO. The floating window test's fixture hook invocation failed with error code `null`. The helper uses a five-second deadline. That test passed in the delivery source's serialized run. The signed-in captures above identify the delivery archive by its `BDF7E471` checksum.
