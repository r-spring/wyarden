# Live providers in Wyarden

Run `80cf35` covers Codex, Grok Build and Antigravity. Robert should be able to open Wyarden, start each provider in an open workspace, see a node bearing its name and watch that node report a real tool call. The three providers may use different sources. Wyarden must identify each source accurately and show a session only once.

At the starting revision `4704617`, the scene and event contract already know all three names. The normaliser emits Claude events, the hub discovers Claude sessions and the collector setup and status commands handle Claude settings. The local Windows host resolves `codex`, `grok`, `agy` and `code`. A working sign-in, hook delivery and visible provider activity still need live checks. The older design in `docs/monitor-3d/02-live-signals.md` and `04-wiring-plan.md` supplies leads. The implementation belongs in the standalone extension under `ui-concepts/monitor-3d-live/`. All file names in the steps are relative to that extension unless stated otherwise.

## Steps

1. **Route provider events through the existing live hub.** One integration worker owns `lib/normalise.js`, the necessary parts of `lib/hub-core.js` and `lib/hub-server.js`, a shared hook transport under `lib/` if required, and focused hub tests. Depends on root approval. Define the smallest interface that lets each worker supply its provider's normaliser and configuration changes. Preserve existing Claude hooks and derived discovery. Done when the real loopback ingress, workspace filter and snapshot keep two providers with the same session identifier distinct, reject unsafe or unsupported records, and pass the existing Claude regressions. Supply the interface and passing test output before the three workers start.
2. **Make a Codex session and its tools visible.** One Codex adapter worker owns `lib/providers/codex.js`, `test/codex-provider.test.js` and sanitized Codex fixtures. Depends on 1. Verify the event schema and hook registration on the installed build. Handle named tools, start and result pairing, workspace attribution, and MCP or patch resources when the signal supports them. Preserve existing hooks and their approval state. Check a supported local session source for already-running sessions. Done when a provider-native signal reaches a Codex session in the monitor model, its tool activity updates that session, and setup, repeat setup, removal and pending approval have tests in a temporary home. Return source, version, evidence and commit.
3. **Make a Grok Build session and its tools visible.** One Grok adapter worker owns `lib/providers/grok.js`, `test/grok-provider.test.js` and sanitized Grok fixtures. Depends on 1. Verify hook shape and registration with the installed Grok CLI. Recognize Grok in deliveries made through compatible Claude settings and deduplicate repeated events. Map reported workspace, tool and file information. Done when a Grok-native signal reaches one Grok node, activity updates it, the shared-settings case produces one call, and temporary-home setup and removal preserve other hooks. Return source, version, evidence and commit.
4. **Make an Antigravity session and its tools visible.** One Antigravity adapter worker owns `lib/providers/antigravity.js`, `test/antigravity-provider.test.js` and sanitized Antigravity fixtures. Depends on 1. Verify the supported command hook and the fields identifying a conversation, workspace and tool step on the installed `agy`. Pair starts and results, keep reported failures, and handle silence using the hub's existing lifecycle rule. Done when an Antigravity-native signal reaches an Antigravity node, a later tool event updates it, a silent session ages out in a controlled-clock test, and temporary-home setup and removal preserve other hooks. Return source, version, evidence and commit.
5. **Connect the three adapters to normal editor startup, setup and status.** One extension worker owns the final adapter registrations, `extension.js`, `lib/install.js`, necessary changes in `lib/discover.js`, `lib/view.js` and the collector status portion of `media/page.js`, plus host/installer/page tests, the extension manifest and its packaged README. Depends on accepted commits from 1–4. Root coordinates the local package version with 7917d5 before this worker updates the manifest. Display the setup required for each provider, surface approval or restart requirements, and show available sessions in both their workspace and All open. Keep writes behind Wyarden's existing reviewed setup flow. Ensure a provider-qualified session selection cannot reveal a Claude session with the same id. Done when tests exercise activation through the user-facing commands, all four providers coexist, opening a new window preserves the correct scope, and cancellation or removal preserves unrelated settings.
6. **Prove all three appear in the installed monitor.** One acceptance worker owns the live editor run, targeted acceptance tests or a development probe under `test/`, and sanitized evidence. Depends on integration of 5. Build with `node ui-concepts/monitor-3d-live/tools/pack.js` from the repository root. Install that artifact in an isolated VS Code profile. Start one genuine session of each provider in a disposable workspace and have each use a tool on a harmless local fixture. Observe the rendered provider names and tool updates through the normal Wyarden surface. Check workspace selection, All open and absence of duplicates. Done when a screenshot or rendered accessibility capture plus a timestamped observation identifies each real provider and its update on the packaged build. Return build revision, VSIX hash, provider and editor versions, full suite counts including skips, and any blocker by provider. A fixture, a status indicator or a successful launch alone leaves that provider's live acceptance open.
7. **Deliver the verified build and usage instructions.** Root `80cf35` owns integration, final review, the root README, `docs/wyarden-guide.md`, `CHANGELOG.md`, and this run's record. Depends on 6. Coordinate installation with `7917d5`. Update current-build instructions with the actual setup, hook approval and session restart behavior for each provider. Install the verified build in Robert's normal VS Code profile when approved in this run, and verify the installed extension version. Respect the editor and provider's own confirmation prompts and preserve running work. Record accepted child ids and SHAs, the three live observations, and any pending user action. Deliver to the main folder by the authorized local fast-forward workflow.

## Execution

Root requests three open children, eight total and one level of delegation. Six direct child packets cover the work, with capacity for two focused repairs. Steps 2–4 can run together after step 1 is integrated. At each addition, record its actual id below, pass the written outcome and evidence via `--rule-file`, request the existing `monitor-live-tests` check, and use `--after` with the actual dependency ids. Inspect the complete result and revision in Review, then integrate before starting dependent work. Recheck board capabilities on approval.

Live editor work uses one lane. Card `1ce761` owns the monitor window and cross-workspace actions, `9a8eb9` and `575957` own looks, `33ceee` owns thinking, `7917d5` is rebuilding the installed extension, and `1d9e1b` handles public releases. Recheck current ownership before editing shared sections or changing the installed package. Preserve their concurrent work. Keep live evidence local and sanitized. Use normal provider sign-in and hook approval. Publishing is outside this run.

## Run record

| Owner | Outcome | State |
| --- | --- | --- |
| `80cf35` | All three real providers visible in Wyarden | Submitted for root approval |
| Steps 1–6 | Implementation, integration and live evidence | No child allocated at planning time |

---

# Looks run 9a8eb9: every look idea, switchable

**Goal:** every idea on [the list](docs/looks/README.md) exists as a look, and one switcher offers all of them.
**Root:** 9a8eb9. **Asked for by:** Robert, 27 November 2026.

## Decisions taken

- **Where the looks live** (Robert, 27 November): the live 3D Monitor tab, `ui-concepts/monitor-3d-live/media/`, with a browser preview of that same page on invented data. One set of look files.
- **Which ideas** (Robert, 27 November): the 15 this repository shows, and of the five it only names, those that are quite different, not the derivatives. Root's judgment: kept `skyline`, `control-room`, `signal-house`; left out Godot's Synapse and Orbit. So 18 looks.
- **Entries Robert may still strike as derivatives** (root's judgment, named to him at approval): the three versions of NEXUS (`nexus`, `nexus-mockup`, `lattice`), the three of Glasshouse (`glasshouse`, `glasshouse-mockup`, `glasshouse-original`), `paper-dark` beside `paper`, and `signal-house` beside `paper`.
- **What a look carries** (this repository's rule): colours, shapes, line weight and glow, caption style, lettering, the page's own colours and fonts, and a still backdrop. Never where a thing stands, never movement that runs by itself, never a new control, never a state shown by colour.
- **How true to an original:** as its picture shows it. Where an original gives every type one shape, the look keeps that. The rules "five silhouettes, five colours" and "one hue for each provider" hold only for looks that claim them in the registry; the four that exist today claim them.
- **The switcher is buttons.** The page has no `select` or `input`, and stays that way.
- **The preview is the same page.** It is `media/page.html` and `media/page.js` with a stand-in for the editor and a seeded invented feed. It is not the older page in `ui-concepts/monitor-3d/`, which is left as it is.
- **Entomatical is not touched.** Its extension left this repository on 27 November (commit `9f73bb0`, card 1d9e1b). `editor-theme` and `battle-neon` stay on the list Robert approved; their source is read from this repository's history: `git show 0a8c20c:media/board.css`.
- **A test writes nothing that git tracks.** Test pictures go to an ignored folder. A look's committed picture is made by the shoot tool, for that look's id only.

## The 18 ids

`nexus`, `glasshouse`, `nexus-mockup`, `glasshouse-mockup`, `lattice`, `circuit-city`, `orbital`, `glasshouse-original`, `synapse`, `event-horizon`, `signal-terrain`, `editor-theme`, `battle-neon`, `paper`, `paper-dark`, `skyline`, `control-room`, `signal-house`.

## Steps

1. **Foundation: registry, switcher, backdrop, the looks test, the shoot tool.** Owner: one child, Claude Fable. After: none.
    - Outcome: a registry names all 18 ids in the list's order. The switcher is built from it, as buttons, with previous and next, usable at 800 x 600 and by keyboard. Every id not yet built is a stub that the test reports as "to do". `nexus-mockup` and `glasshouse-mockup` are built here, from `ui-concepts/monitor-3d/look-*.js`.
    - Outcome: a look may carry a still backdrop and the page's lettering. The backdrop's cost is bounded here, once, for every look: one batched path for each line style, or a picture kept until the camera or the size changes. The 8 ms frame test at 200 nodes covers a backdrop of 1,000 segments.
    - Outcome: `test/looks.test.js` in the live suite. It holds the registry, `docs/looks/looks.json` and the buttons to the same 18 ids. For each built look it makes a real click on its button in headless Edge, reads `dataset.look` and `aria-pressed`, requires a drawn scene, and requires 0 frames at rest afterwards. No two built looks may draw the same picture. It writes only to an ignored folder, and it is safe to run in four worktrees at once (a free port, its own browser profile).
    - Outcome: `tools/shoot-looks.js <id>…` writes `docs/looks/img/<id>.png` for the ids named, on a fixed invented scene.
    - Outcome: `ui-concepts/monitor-3d-live/LOOKS.md`, one page on how to write a look.
    - Card 33ceee is adding a display of agent thinking to the same monitor: keep changes to `page.js` and `engine.js` in new functions where possible, and new tests in new files.
    - Files: `ui-concepts/monitor-3d-live/media/**`, `lib/view.js`, `test/**`, `tools/**`, `LOOKS.md`; `docs/looks/looks.json`, `docs/looks/img/`.
    - Evidence: check `monitor-live-tests` passes with the same 4 skips as before (344 tests at version 0.1.3) and 14 looks "to do"; the two rebuilt looks' pictures; 0 frames at rest still measured.
2. **Look `lattice`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: Entridir `nexus-lattice-29d4d1/scene.js`, `style.css`; picture `docs/monitor-3d/img/before/lattice.png`.
    - Files: `media/look-lattice.js`, `docs/looks/img/lattice.png`. Evidence: the looks test names it built; its picture beside the original.
3. **Looks `circuit-city` and `orbital`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: Entridir `nexus-worlds-29d4d1/modes-city-orbit.js`, `worlds.css`; pictures `city.png`, `orbit.png`.
    - Files: `media/look-circuit-city.js`, `media/look-orbital.js`, their two pictures. Evidence: as 2, for each.
4. **Looks `glasshouse-original` and `synapse`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: Entridir `modes-glass-synapse.js`, `worlds.css`; pictures `glass.png`, `synapse.png`.
    - Files: the two look files and pictures. Evidence: as 2, for each.
5. **Looks `event-horizon` and `signal-terrain`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: Entridir `modes-horizon-terrain.js`, `worlds.css`; pictures `horizon.png`, `terrain.png`.
    - Files: the two look files and pictures. Evidence: as 2, for each.
6. **Looks `editor-theme` and `battle-neon`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: Entomatical's `media/board.css` as it stood here, `git show 0a8c20c:media/board.css`: the theme variables and F52's skin; F105's neon.
    - `editor-theme` reads the editor's colours in the tab, reads them again when the editor's theme changes even if Robert chose the look himself, and has fixed fall-backs in the preview.
    - Evidence: as 2, for each, and `editor-theme` photographed under a dark and a light set of variables.
7. **Looks `paper`, `paper-dark` and `signal-house`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: `public/index.html` (read only); Entridir `signal-house-29d4d1/style.css`.
    - One child for the three relatives, so that each stays told apart from the others. Evidence: as 2, for each.
8. **Looks `skyline` and `control-room`.** Owner: one child, Claude Opus. Opened after 1 is integrated.
    - Source: Entridir `godot/looks/skyline.gd`, `control_room.gd`, `docs/verification/godot-looks/looks.png`.
    - Their colours stand for states in the original; here they are given to the classes. Evidence: as 2, for each.
9. **The preview.** Owner: one child, Claude Opus. Opened after 1 is integrated, beside 2 to 8.
    - Outcome: `node ui-concepts/monitor-3d-live/tools/preview.js` serves the same page on invented data at a loopback address and prints it; `?look=<id>` picks a look; the stand-in for the editor lives outside `media/`, so the VSIX does not carry it.
    - Files: `tools/preview.js`, a folder for the stand-in, one test, a section of `README.md`. Evidence: its test; a picture of the preview on a look other than the default.
10. **Acceptance run.** Owner: one child, Claude Opus. Opened after 2 to 9 are integrated and main is merged in.
    - Outcome: the allowance for stubs is deleted, so the suite fails on any look that is not built, from then on. The whole live suite passes. A contact sheet of the 18 pictures. The VSIX packs with every look file in it. The host's HTML lists every look script with its nonce.
    - Outcome: one isolated editor (its own user-data and extensions folders, never Robert's) opens the tab from the packed VSIX and shows a look other than the default. If that cannot be done cleanly it is reported as not verified.
    - Files: `ui-concepts/monitor-3d-live/package.json` (version), `README.md`, `test/looks.test.js`, `docs/monitor-3d/05-working-mockup.md` (a section on looks), `docs/looks/`.
    - Evidence: check `monitor-live-tests` at that revision, the contact sheet, the VSIX's file list, the editor's picture.
11. **Review, write-up and finish.** Owner: root.
    - At each child's Review: read its evidence, look at each new picture beside its original, then `board.js integrate`.
    - Write "How to switch" and the built state into `docs/looks/README.md`. Tell Robert how to switch. `board.js finish self`.

## Waiting on other work

- **7917d5** (Robert's own) landed on main at 14:22 on 27 November as monitor 0.1.3, and is in this branch since the merge `ac7437b`. It may still add to the monitor.
- **1d9e1b** (Robert's own) published the 0.1.3 preview and took the Entomatical extension out of this repository (`9f73bb0`). This repository is now the public Wyarden monitor.
- **33ceee** (Robert's own, live) changed course at about 14:20: it now adds a display of agent thinking to this same monitor. The root told it on 27 November which files and parts this run changes, and asked which it will change.
- **The board delivers this branch to main when a turn of the root ends.** So main carries this run's work as it is integrated, and other cards meet it there.

## Limits asked for

- Open at once: 4. Total: 16 (10 children, and room for 6 repairs). Depth: 2.
- Checks: `monitor-live-tests` (in `workflows/checks.json`; at version 0.1.3: 344 tests, 340 pass, 4 skipped, 58 s).
- After approval and before any `add`: run `capabilities` again. If the run is governed, each `add` takes a profile and an assignment file, and children `submit`.

## Ledger

| Id | Task | State | Outcome |
|---|---|---|---|
| 9a8eb9 | Root | Running | List written and delivered (`docs/looks/README.md`); where and which settled with Robert; approved 27 November 14:17, not a governed run; `monitor-live-tests` on main (e7082f3) |
| e9327e | 1. Foundation, first try | Cancelled 14:26 | Opened 14:19; its session was interrupted at 14:23 when the board's windows restarted; it had read and changed nothing |
| 575957 | 1. Foundation | Opened 14:27 from `e2730d6`, Claude Fable, effort high, check `monitor-live-tests` | |

## Risks

- **Two runs edit one page.** See "Waiting on other work".
- **A faithful original can be hard to read.** Two colours and one shape say little about class. The floor, the caption and the state mark carry it; the review compares each picture with its original and with the default look.
- **Eighteen buttons.** The switcher must stay usable at 800 x 600 and by keyboard. Step 1 owns that, and step 10 photographs it.
- **Step 1 is the whole critical path.** Nothing else opens until it is integrated. If it stalls, it is split: registry and switcher first, backdrop second.
