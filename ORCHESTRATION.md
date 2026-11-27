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
- **The main extension is not touched.** Nothing under the top-level `src`, `media`, `hook`, `tools`, `test` or `public`.
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
    - First: read card 7917d5's changes in its worktree, and keep clear of its lines in `page.html` and `page.js`.
    - Files: `ui-concepts/monitor-3d-live/media/**`, `lib/view.js`, `test/**`, `tools/**`, `LOOKS.md`; `docs/looks/looks.json`, `docs/looks/img/`.
    - Evidence: check `monitor-live-tests` passes with the same 4 skips as before and 14 looks "to do"; the two rebuilt looks' pictures; 0 frames at rest still measured.
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
    - Source: `media/board.css` (read only): the theme variables and F52's skin; F105's neon.
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

- **7917d5** (Robert's own, live) is changing `ui-concepts/monitor-3d-live/media/page.html`, `page.js`, `nav.js`, `lib/view.js`, tests and `package.json`. Step 1 changes some of the same files. If 7917d5 is on main when step 1 opens, main is merged in first. If not, step 1 starts anyway and reads its diff; the root merges main in when 7917d5 lands and settles any clash before step 10.
- **1d9e1b** (Robert's own, live) is preparing the public release. This run changes nothing it ships except one new entry in `workflows/checks.json`, which stays on this branch until the first child is opened.

## Limits asked for

- Open at once: 4. Total: 16 (10 children, and room for 6 repairs). Depth: 2.
- Checks: `monitor-live-tests` (new in `workflows/checks.json`; 61 s today, 300 tests, 4 skipped).
- After approval and before any `add`: run `capabilities` again. If the run is governed, each `add` takes a profile and an assignment file, and children `submit`.

## Ledger

| Id | Task | State | Outcome |
|---|---|---|---|
| 9a8eb9 | Root | Running | List written and delivered (`docs/looks/README.md`); where and which settled with Robert; approved 27 November 14:17, not a governed run; `monitor-live-tests` on main (e7082f3) |
| e9327e | 1. Foundation | Opened 14:19, Claude Fable, effort high, check `monitor-live-tests` | |

## Risks

- **Two runs edit one page.** See "Waiting on other work".
- **A faithful original can be hard to read.** Two colours and one shape say little about class. The floor, the caption and the state mark carry it; the review compares each picture with its original and with the default look.
- **Eighteen buttons.** The switcher must stay usable at 800 x 600 and by keyboard. Step 1 owns that, and step 10 photographs it.
- **Step 1 is the whole critical path.** Nothing else opens until it is integrated. If it stalls, it is split: registry and switcher first, backdrop second.
