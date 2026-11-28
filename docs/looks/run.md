# Looks run 9a8eb9: how the 18 looks were built and checked

**What this is:** the run's own record: what was decided, each card that did a part, and what each was checked against. It was kept as `ORCHESTRATION.md` at the top of the repository until 28 November 03:48, when run 80cf35's file of the same name took that place on main.

**Goal:** every idea on [the list](README.md) exists as a look, and one switcher offers all of them.
**Root:** 9a8eb9. **Asked for by:** Robert, 27 November 2026.

## What was checked, and what was not

- **Every look displays when it is selected.** `test/looks.test.js` makes a real click on each look's button in a headless browser, then requires its id on the page, its button pressed, a drawn scene, no script error and 0 frames in the 3 seconds after. It also requires that no two looks draw the same picture. The board ran the whole suite on every card before it was integrated; the last run, on 28 November at 04:00 at `5189ea7`, passed.
- **Every look was looked at.** The root compared each of the 14 new looks' pictures with its original, and looked at the contact sheet of all 18.
- **The installed build has them.** The 0.2.0 VSIX that run 80cf35 installed in the owner's editor (SHA-256 starting `BDF7E471`) holds 18 `media/look-<id>.js` files and `media/looks.js`; so does the installed folder.
- **Not checked: a real editor tab.** No card of this run opened the tab in an editor and switched a look there. The page files are the same ones the headless browser ran.
- **Not checked: a screen reader,** and the switcher by keyboard beyond what the tests press.
- **Known and left:** `test/preview.test.js` fails about 1 run in 4 with "the scene was drawn: nodes 0", also before any look was built; the cause was not found. The suite still lets a look be a stub, though none is. `editor-theme`'s dark and light sample colours were written from memory of the editor's own themes.

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
- **637e7b** (Robert's own, live since 28 November 01:18, on Grok) works on Codex and workspace agents in this monitor. The root sent it the same note, and asked to hear of any new provider, so that every look gets a colour for it.
- **80cf35** (another approved run, on Codex, live since 28 November 02:04) builds the Codex, Grok and Antigravity feature as version 0.2.0, checks it in an isolated editor, then installs it. It wrote on 28 November at about 02:43. The root answered: this run does not use 0.2.0 and installs nothing in the normal profile; it will tell 80cf35 before and after step 10's one isolated editor; and it asked to hear of any new provider.
- **Versions:** run 80cf35 delivered 0.2.0 to main at `907ddee` on 28 November 03:48 and installed that build in Robert's normal editor. It carries the 18 looks as they stood at `47efcb8`. So this run takes no version of its own: `package.json` keeps main's, and what 262487 set is taken out at integration. This branch was fast-forwarded to `907ddee` at 03:50.
- **The board delivers this branch to main when a turn of the root ends,** and commits whatever is uncommitted then. So this branch holds only integrated, passing work at the end of every turn.
- **A window reload ends every card's session.** It cut off the foundation twice on 27 November. Children are told to commit after each part.

## Limits asked for

- Open at once: 4. Total: 16 (10 children, and room for 6 repairs). Depth: 2.
- Checks: `monitor-live-tests` (in `workflows/checks.json`; at version 0.1.3: 344 tests, 340 pass, 4 skipped, 58 s).
- After approval and before any `add`: run `capabilities` again. If the run is governed, each `add` takes a profile and an assignment file, and children `submit`.

## Ledger

| Id | Task | State | Outcome |
|---|---|---|---|
| 9a8eb9 | Root | Finishing | List written and delivered; where and which settled with Robert; plan approved 27 November 14:17; 12 cards opened of 16 allowed (11 done, 1 cancelled); every child's reply read, every look's picture looked at beside its original, each child integrated only after the board's run of `monitor-live-tests` passed at its head; changelog, user guide and `docs/looks/README.md` written by the root |
| e9327e | 1. Foundation, first try | Cancelled 14:26 | Opened 14:19; its session was interrupted at 14:23 when the board's windows restarted; it had read and changed nothing |
| 575957 | 1. Foundation | Done. Integrated 28 November 02:08 as `ab7b9a8` (its head `721c7da`); check passed | Registry `media/looks.js` and `docs/looks/looks.json` with the 18 ids; a switcher opened from the current look's name, with previous and next; 4 looks built, 14 stubs marked "not built"; a look may carry `backdrop`, `page`, `fromPage`, `samples`, `palette.outline`, mesh `faces`, `captionSize`, `claims`; `test/looks.test.js`; `tools/shoot-looks.js`; `LOOKS.md`. Suite at its head: 417 tests, 399 pass, 0 fail, 4 skipped, 14 to do. Root looked at the switcher at 800 x 600 and at two of its four pictures |
| 9520d4 | 2. `lattice` | Done. Integrated 28 November 02:24 as `eca84cb` (its head `e289fe7`); check passed | The original's grid, three rings and four zone names on the ground; its octahedrons, cube and spoked ring in its own colours; `claims` empty. Suite at its head: 420 tests, 403 pass, 0 fail, 4 skipped, 13 to do. Root compared its picture with `before/lattice.png`: named at a glance. Its gaps: one colour for each class (the second violet and amber went to the floors); a wide page font wraps a row at 800 x 600 and fails the size check |
| 876353 | 5. `event-horizon`, `signal-terrain` | Done. Integrated 28 November 02:40 as `cd73c75` (its head `1caad71`); check passed | Horizon: the tunnel of amber and grey rings standing still, the one clock face for every class in amber or pale cyan, the agent a tall amber diamond, PRESENT, PAST and CONSEQUENCE, a thin wide-spaced title. Terrain: the height field worked out once (1,141 segments) under the floors with contours, a north arrow and three region names, the one beacon for every class in olive or gold, an italic serif title in cream. Frames at 265 nodes: 4.3 ms and 3.3 ms against a budget of 9.73 ms. Root compared both with `before/horizon.png` and `before/terrain.png`: named at a glance. Its gaps: no background gradient; the title cannot be centred; every caption one colour; the legend's icon cuts off a mesh taller than about 55 (sent to 5a6363) |
| e0cd44 | 6. `editor-theme`, `battle-neon` | Done. Integrated 28 November 03:18 as `39f791b` (its head `c2eaa5f`); check passed | Editor theme: reads the editor's colours each time it is applied and when the theme changes, with dark fall-backs; the board's provider colours, darker on a light ground; thin lines, no glow; three pictures (fall-back, dark and light samples, the sample values written from memory). Battle neon: near-black, the four neons on the providers with a glow, the poster face in capitals for the title, headings and captions, the popup's orange border under the floors. Root looked at the fall-back, the light sample and Battle neon. Its findings: a caption cannot be slanted; with Impact the status line took one line at 560 x 600 and failed the old size check, so the page's running text starts at the second font (to be given back in step 10 under 5a6363's new rule); `test/preview.test.js` failed about 1 run in 4 here, also with the stubs (to be fixed in step 10) |
| 8e5921 | 7. `paper`, `paper-dark`, `signal-house` | Done. Integrated 28 November 03:06 as `dd2531b` (its head `beefda4`); check passed | Paper: one brown-black ink on warm paper, Palatino, thin engraved shapes, "Wyarden" large over a hairline behind the scene. Paper dark: the same turned over, cream on brown-black. Signal House: a paper stage beside slate panels, vermilion agents, sage tools, blue MCP servers, slate subagents, monospaced capital captions, a vermilion italic title, a dot grid and the brand mark. Palatino did not wrap the page, so no font was swapped. Root looked at all three pictures: each is told apart from the others at a glance. Its gaps: the title takes one style; backdrop text uses the look's one font |
| 8cce80 | 8. `skyline`, `control-room` | Done. Integrated 28 November 02:46 as `00f249b` (its head `9b2adee`); check passed. The board answered the integrate late ("No answer in 20 s") and had done it | Skyline: an off-white ground, every shape solid and outlined in dark ink: amber pointed towers for agents, blue for subagents, red six-sided kiosks for MCP servers, teal-green glass blocks for tools, grey blocks for resources; kerbs and dashed street lines. Control Room: black, flat solid marks (amber hexagon, hollow violet hexagon, green square, blue bar, grey pages), large white captions, grey rules with an amber bar over each column. In both, the originals' state colours went to the classes. Root compared both with the lower quarters of Entridir's `looks.png`: named at a glance. Its gaps: a floor has one colour for tint, outline and title (no white slabs); a shape has one fill; no ground gradient |
| 5a6363 | Repair: the look contract, round 2 | Done. Integrated 28 November 03:29 as `65c084b` (its head `9eda82b`); check passed. Two turns: settled 03:07 at `e70ee76`, then a follow-up | `palette.ground` (one still gradient, round or straight), `palette.captionNode` (a caption's first line in its node's colour, with a floor of 4.5 to 1), `page.labelFont`, the size rule (exact at 1280 x 720; below that only the status line may differ by whole lines; a failure names look and row), and an icon that shows the whole of any mesh the contract allows. The row that wrapped was the status line. Used, from each original's own values, in `lattice` (and Cascadia Code back), `circuit-city`, `orbital`, `glasshouse-original`, `synapse`, `event-horizon`, `signal-terrain` (its beacon back at the 42 stem), `skyline`, `signal-house`; `control-room`, `paper`, `paper-dark` needed nothing. `nexus`, `glasshouse` and the two mock-up looks shoot byte for byte as before. Suite at its head: 486 tests, 480 pass, 0 fail, 4 skipped, 2 to do (the two looks not yet in its branch). Root looked at the re-shot Synapse, Circuit City, Signal Terrain and Skyline. It also saw `test/preview.test.js` fail once in three runs |
| 262487 | 10. Acceptance run, cut down | Done. Integrated 28 November 04:01 as `f63ef16` (its head `5189ea7`); check passed at that head, which holds main's 0.2.0 and every look | Opened 03:32. At 03:42 Robert said this was too much testing and to finish up; the root stopped the card and cut its brief. Delivered: `docs/looks/img/contact-sheet.png` with its small tool, and a "Looks" section in the extension's README. Its 0.1.8 was taken out again: 0.2.0 from run 80cf35 already carries the looks. Not done, on that word: the allowance for a stub stays in the suite; no re-shoot of the 18; no preview check; no isolated editor; `battle-neon` keeps its second font for running text; `test/preview.test.js` still fails about 1 run in 4 ("the scene was drawn: nodes 0"). Its own last suite run hung because the root stopped its three headless browsers by mistake at 03:45 |
| 993a2d | 3. `circuit-city`, `orbital` | Done. Integrated 28 November 02:26 as `28332a6` (its head `291d631`); check passed | City: cyan towers with a line at every floor, amber blocks, a blueprint street grid with districts and a low skyline, a light wide-spaced title. Orbital: lilac latticed globes, peach pyramids, rings and drums, seven tilted rings and about 180 stars, an italic serif title, pills. Both in the source's own colours; neither claims a rule. Root compared both pictures with `before/city.png` and `before/orbit.png`: named at a glance. Its gaps: one background colour (no glow, no scan lines); every caption one colour (the originals letter each node in its own); one corner radius for panels and buttons; one font for every panel heading (the legend's small headings come out in Georgia) |
| 153f06 | 4. `glasshouse-original`, `synapse` | Done. Integrated 28 November 02:26 as `ec64c8d` (its head `b4506a6`); check passed | Glasshouse original: teal and sage flat chips, glass slabs with a fine grid, the lowest floor in salmon, four lift shafts, the sign, a serif title. Synapse: pink ringed beads, mint diamonds, the root glyph for a tool, still nerve strands to each column, an italic serif title, pills. Root compared both with `before/glass.png` and `before/synapse.png`: named at a glance. Its gaps: one background colour (no gradient); the title at most 20 px; every caption one colour; a backdrop is not told where nodes are (by design) |
| 86bd88 | 9. The preview | Done. Integrated 28 November 02:26 as `b243a67` (its head `240614a`); check passed | `node ui-concepts/monitor-3d-live/tools/preview.js [port]` serves the same `media/` page on 127.0.0.1 with the older page's seeded simulator; `?look=`, `?agents=`, `?load=`, `?seed=`; the stand-in is in `tools/preview/` and not in the VSIX; `test/preview.test.js` (12 checks); a "Preview" section in `LOOKS.md`. Root looked at its picture of the Glasshouse mock-up look on invented data |

## Risks

- **Two runs edit one page.** See "Waiting on other work".
- **A faithful original can be hard to read.** Two colours and one shape say little about class. The floor, the caption and the state mark carry it; the review compares each picture with its original and with the default look.
- **Eighteen buttons.** The switcher must stay usable at 800 x 600 and by keyboard. Step 1 owns that, and step 10 photographs it.
- **Step 1 is the whole critical path.** Nothing else opens until it is integrated. If it stalls, it is split: registry and switcher first, backdrop second.
- **A wide page font changes the scene's size** (found by 9520d4, and named as open by 575957): a row of the page wraps at 800 x 600. If a second card reports it, a repair opens: find the row, hold it to one line, and have the test name the row.
