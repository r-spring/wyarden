# Writing a handoff doc

A handoff is the first prompt of a session that has none of your context. Write it so that session can act from this file and the
files it points to. Entomatical's **Load handoff** puts the doc's whole text in the prompt box, so the doc itself is the prompt.

Basis: `docs/research/handoff-prompts-2026-11-12.md` in the Entomatical repository (14 November 2026). The sections and word budgets
are our judgement, not measured.

## Sections, in this order

A **header** of one to three lines comes first (40 words at most): date and time zone, the writing card or session, branch and base
commit, and a status: `not started`, `partial` or `blocked`. It tells the reader how old State is.

1. **Goal** (≤ 50 words). One end state, checkable when reached, with its reason in one clause.
2. **State** (≤ 300). Three lists: *done and verified*, each item with its evidence (command and result, commit, test, evidence
   file); *done but unverified*; *not started*.
3. **Next steps** (≤ 300, 3 to 7 steps). In order, each with a done-when. Step 1 re-checks State with named commands, never from
   memory. A step that waits on a question says "waits on Q1".
4. **Constraints** (≤ 150). Permissions, exclusions, what not to touch, and the user's decisions with their dates.
5. **Pointers** (≤ 150). Absolute paths (with symbols where useful), branch, commits, check commands, evidence files.
6. **Open questions** (≤ 100, at most 3). Questions for the user, each with a suggested answer. Do not guess the answer into State.
7. **History** (optional, ≤ 150). Dead ends a new session would repeat, one line each with the reason.

## Balance rules

- **State over history.** State describes now. Incident narratives stay in linked evidence files.
- **Verified vs unverified, plainly.** Before you write State, check each claim against a tool result from this session. Put
  anything you cannot point to under *done but unverified*. Never write an unverified item as fact.
- **Point, do not paste.** Write paths as plain absolute paths in code text, for example
  `C:/Users/me/repo/src/x.ts`, not as escaped links. Point to structured state (a feature list, a test file, `git log`) rather
  than copying it.
- **Decisions keep their dates**, for example "the user, 12 November 2026: no new dependencies".
- **Imperatives.** Next steps and Constraints say what to do. Background appears only where it changes a decision, as a
  one-clause reason.
- **Length.** 400 to 1,200 words. Past about 1,500, move detail into linked files.

## Where to save it

`<repo>/docs/handoffs/<yyyy-mm-dd>-<short-kebab-name>.md` in the repository's main checkout, not in a worktree, for example
`docs/handoffs/2026-11-14-speech-model-picker.md`. Load handoff lists that folder's `*.md` files newest first (by file time) and
leaves out `README.md`.

## Template

```markdown
# Handoff: <short title>

<yyyy-mm-dd hh:mm, time zone> · written by <card id or session> · branch `<branch>` at `<commit>` · status: <not started | partial | blocked>

## Goal
<One checkable end state>, because <one-clause reason>.

## State
Done and verified:
- <item>. Evidence: `<command>` → <result> / commit `<sha>` / `<test file>`.

Done but unverified:
- <item>. Check with `<command>` before building on it.

Not started:
- <item>.

## Next steps
1. Re-check State: run `<command>` and `<command>`; done when the results match State above.
2. <action>. Done when <file, behaviour, command result or count>.
3. <action>. Waits on Q1. Done when <...>.

## Constraints
- <permission or exclusion>.
- Do not touch <path or area>.
- <User>, <date>: <decision>.

## Pointers
- `<absolute path>` (`<symbol>`): <what it is>.
- Checks: `<command>`.
- Evidence: `<absolute path>`.

## Open questions
- Q1: <question>? Suggested: <answer>.

## History
- Tried <approach>; dropped because <reason>.
```
