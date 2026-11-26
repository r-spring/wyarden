# Compile-format comparison harness

A comparison harness using authored miniature task records in `cases/` and the fixed `rubric.md`. Each format receives the same semantic content, with the executor, effort, tools and starting state fixed. It measures requirement preservation, completion, permission adherence, additional questions, repairs, tokens and elapsed time. Shortening is a separate condition; held-out cases stay apart from tuning.

No historical results, provider transcripts or private helper roots ship in this source distribution. Build, validate and dry-run checks do not call a model. Live run/comparison modes require `--live`; replay selects live execution with `--provider`. These modes invoke your configured providers and spend usage; inspect their plan and permissions before using them.

## Files

| file | what it is |
|---|---|
| `lib.js` | shared helpers: case loading, hashes, renderers (via `../../out/compile.js`), env stripping, fixture working dirs, stream facts, model identity |
| `cases/<id>.json` | 24 authored cases: `{ id, split, properties, record, fixture, rubric, expectedQuestions }` |
| `manifest.json` | the fixed settings, conditions, invocation template, split and repeat plan, every labelled choice |
| `rubric.md` | the frozen grading rules (hash recorded in `out/manifest-resolved.json` and `out/results.json`) |
| `validate.js` | validates every case (record via `out/task-record` `validTaskRecord`, fixture, rubric, coverage) |
| `render.js` | dry run: writes `out/<case>/<condition>.prompt.txt`, `out/render-sizes.json`, `out/preservation-checks.json` |
| `run.js` | `--dry-run` writes planned receipts; `--live` executes runs (not executed while building this) |
| `grade.js` | applies the rubric to each run's snapshot and stream; writes `out/results.json`, `out/results.md` |
| `report.js` | aggregates into `out/report.md` (per-format totals, matrix, close comparisons, runs that did not happen) |
| `selftest.js` | validates cases, dry-runs the renderer, grades hand-built SYNTHETIC runs in a temp dir |
| `out/` | generated; git-ignored by the repo's `out/` pattern; never committed |

## Commands

Build the extension first (`npx tsc -p .` in the repo root; the harness uses `out/compile.js`, `out/task-record.js`
and, when present, `out/compile-check.js`). Then, from the repo root:

```
node eval/compile-format/validate.js        # 24 cases valid, coverage table
node eval/compile-format/run.js --dry-run   # renders all prompts, writes out/manifest-resolved.json and "not-run" receipts
node eval/compile-format/selftest.js        # (a) validate, (b) render to a temp dir, (c) grade SYNTHETIC runs; nothing under out/
node eval/compile-format/grade.js           # grades whatever receipts exist under out/ (dry-run receipts grade as unknown)
node eval/compile-format/report.js          # out/report.md; with no runs it lists exactly which runs did not happen and why
```

Running live, later, with the user's authorisation (the account is the user's choice; `manifest.accounts` is null):

```
node eval/compile-format/run.js --live --config-dir <account folder> [--cases d01-timeout-floor,h03-quoted-commit-line] [--formats xml,markdown,json,xml-short] [--repeats 1]
node eval/compile-format/grade.js && node eval/compile-format/report.js
```

Each live run: a fresh temp directory with the case's fixture files, `git init` and one commit; `claude` spawned
per the manifest's template with the rendered prompt on stdin and `CLAUDE_CONFIG_DIR` set to the chosen account
(env otherwise stripped as `environment()` in `src/worker.ts` does); the provider output saved verbatim to
`out/<case>/<condition>/<repeat>/provider-output.json`; `receipt.json` with requestedModel, requestedEffort,
observedModel (identity rule of `parseClaudeResponse` in `src/worker.ts`), usage, totalTokens, elapsedMs, exitCode, startedAt,
finishedAt, promptSha256 and more; the working directory copied to `snapshot/` for grading. A completed run is
never re-executed (resume skips it), and a dry run never overwrites a live receipt.

## Case design

- Source: **authored specifications** (the document asks for the condition properties, not an importer of real
  sessions). Each `record` is a valid `TaskRecord` with `status: "ready"`; `validate.js` proves it with the repo's
  validator. Tasks are small file edits or creations doable with Read/Edit/Write/Glob/Grep alone (no network, no
  npm), so the grader can check them mechanically.
- Size and split: 24 = 16 development + 8 held-out, the evaluation plan's suggested starting size ("a practical
  starting size, not a power calculation"); orchestrator choice. Split is fixed per case. Tuning sees development
  cases only.
- Properties (from the document): `uncertain-permissions`, `explicit-exclusions`, `conditional-requirements`,
  `awkward-identifiers`, `quoted-instructions`, `user-corrections`. Each is covered by at least 3 cases and by
  both splits (`validate.js` prints the table). `user-corrections` is expressed as `explicit-change` statements
  whose text is the resulting decision, with a check that the withdrawn instruction was not followed.
- `expectedQuestions: "some"` iff the record has a `must-ask` unresolved item; those cases also have `confirm`
  permissions with guard checks.
- Rubric kinds: `file-contains`, `file-not-contains`, `file-exists`, `file-absent`, `file-unchanged`, `manual`.
  Every requirement, every prohibited item and every confirm item has at least one check.

## Choices the document left unspecified (each labelled)

| choice | value | label |
|---|---|---|
| Case count and split | 24 = 16 development + 8 held-out | orchestrator choice (evaluation plan's suggestion, not a power calculation) |
| Case source | authored specifications | orchestrator choice (the document asks for the condition, not an importer) |
| Executor model | `fable` | document (Fable 5.1) |
| Executor effort | `medium` | orchestrator choice: the repo's `textJob` default; the document names no effort |
| Tools | Read, Edit, Write, Glob, Grep via `--allowedTools` and `--tools` | agent choice: smallest set for file tasks; no Bash/network/subagents |
| Permission mode | `dontAsk`, identical for all conditions | agent choice: `--print` cannot answer prompts |
| `--settings {"fallbackModel":[],"switchModelsOnFlag":false}`, `--strict-mcp-config` | passed on every run | agent choice, repo precedent (then `src/forecast-worker.ts`; now `call()` in `src/worker.ts`) |
| Per-run timeout | 600 000 ms, recorded as `timeout` | agent choice |
| Shortening condition | `xml-short`: XML of the record with rationales blanked and context facts removed | orchestrator choice; labelled information removal, not serialization |
| Starting state | fresh temp dir with fixtures, `git init` + one commit; account CLAUDE.md sha256 recorded | orchestrator choice |
| Correct completion | all mandatory-and-exclusion requirement checks pass and no prohibited check fails | orchestrator choice (mandatory + prohibited); agent choice (exclusion-strength requirements included) |
| Permission adherence | no prohibited check fails; confirm guard breached with zero questions = fail, with questions = unknown | agent choice (detection rule) |
| Additional questions | lines of the result text ending in `?` | agent choice |
| Repairs | `tool_result` errors + extra writes to the same file | agent choice |
| Total tokens | input + cacheRead + cacheWrite + output from the CLI result `usage`; per model from `modelUsage` | the repo's unit (`src/metrics.ts`) |
| Elapsed | result `duration_ms` | document ("elapsed time"); receipt also keeps wall clock |
| Repeats | 1 per case x condition first; 2 more for close comparisons (top two formats differ by <= 1 passed requirement) | orchestrator choice |
| Accounts | null, chosen by the user at run time | user's choice |
| Acceptable total cost | the user's judgement | document |
| Prompt sizes | characters and lines only (`out/render-sizes.json`); token counts unknown until CLI-reported usage exists | agent choice |

## What the dry run does not show

Requirement preservation is reported per rendering in `out/preservation-checks.json`. `render.js` first feeds
`preservationCheck` a garbage rendering and reports `unknown` if it is accepted (a stub); `src/compile-check.ts` has
been a real check since 27 October 2026 (`3845dbe`), so renderings now grade `pass` or `fail`. Everything
about executor behaviour (completion, adherence, questions, repairs, tokens, elapsed) is unknown until live runs
are authorised; `report.md` says so and lists every planned run that did not happen.

## Refine and Improve: replay and the downstream comparison (4 November 2026)

Added after the two-model review of Refine draft and Improve prompt (items 3.5, 4.1, 4.3). That review is not included.

## Note on rubric.md (9 November 2026)

`rubric.md` is left unchanged because its sha256 is recorded in run manifests and results (`run.js`, `grade.js`), so
a result names the exact rubric it was graded with; it last changed on 4 November 2026 (`9f2ccfe`). Two of its references are out of date:
`src/forecast-worker.ts` was removed in 0.7.6 (`591a420`) and `parseClaudeResponse` is now in `src/worker.ts`; and its
"while that module is a stub" sentence no longer applies, because `src/compile-check.ts` is a real check (see "What
the dry run does not show").

- `replay.js` with `prompt-prep.json`: replays four authored drafts through the current prompts at the
  maximum policy. `--dry-run` (the default) calls no model; a case whose input was not stored is refused.
- `compare.js` with `comparison.json`: eight M9 cases with rough drafts and accepted answers; each is prepared four ways (original,
  Refine, Improve, Refine then Improve) and run by both executors (Fable/max through Claude Code, the newest Astra at its highest effort
  through `codex exec`), graded with this rubric against the authored record. Without `--live` it only prints the plan; `--live` spends
  usage (40 executor runs on the development cases, 64 with `--include-held-out`, plus the preparations). No live acceptance is claimed for this distribution; the account and budget are the user's to choose.
- The question counter was repaired (mid-line questions are candidates; a candidate reads `needs-review` until judged in
  `annotations.json`), and "repairs" became tool errors and additional edits (`rubric.md`).
