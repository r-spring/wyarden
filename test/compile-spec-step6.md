# Step 6 webview scenarios (compile stage)

Labels are the current ones: 0.6.2 renamed "Compile prompt" to "Improve prompt" and "Apply compiled prompt" to
"Apply improved prompt" (`media/board.js`); the code and message names (`compile`, `compilation`) did not change.

Document step 6: "On the user's completion action, replace the task-box text with the rendered specification and
retain the original for restoration." and "If the user subsequently edits the task-box text, that edit must become
authoritative or trigger deliberate reconciliation before regeneration." Contract (orchestrator choice): the edit
becomes authoritative; Apply refuses when the draft changed since compile; Restore refuses when the draft changed
after Apply; unfinished shows an alert and no Apply button.

Notation: `D` = the draft text in the task box before compiling; `X` = the rendered execution prompt returned for
`D`; `D2` = a different text typed into the box; `X+"edit"` = `X` with extra characters typed after it. "Box" = the
task-box textarea (`promptBox` / `draftValue(target)`). "Persisted state" = what `saveDrafts()` writes
(`compilations` Map entry for the target). webview-dev implements each row as a test in
`test/compile-webview.test.js` and as a step of the Extension Development Host log.

| # | Action | Expected task-box contents after the action | Other expectations |
|---|---|---|---|
| 1 | Box holds `D`. Click "Improve prompt". Host posts `{ compilation: { status: "ready", original: D, rendered: { format, text: X } } }`. | `D` (unchanged) | The read-only compiled textarea shows `X` and its format label ("xml" or "prose"). "Apply improved prompt" is visible. "Restore original" is not visible. |
| 2 | Click "Apply improved prompt". | `X` | "Restore original" is visible. The compilation entry keeps `original: D`. |
| 3 | Click "Restore original". | `D` | "Restore original" is no longer visible (or disabled); "Apply improved prompt" is available again. |
| 4 | From state 2 (box = `X`), type into the box so it holds `X+"edit"`, then click "Restore original". | `X+"edit"` (unchanged) | Restore is refused. A `role="alert"` message says the draft changed after Apply. The original `D` is shown read-only (not written into the box). |
| 5 | Box holds `D`. Click "Improve prompt" (result `X` for `D`). Before clicking Apply, change the box to `D2`. Click "Apply improved prompt". | `D2` (unchanged) | Apply is refused with a message saying the draft changed since compile. `X` is still shown read-only. |
| 6 | From state 2 (box = `X`), type so the box holds `X+"edit"`, then click "Improve prompt" again. | `X+"edit"` (unchanged until the new result is applied) | The new `compile` message's `draft` equals `X+"edit"` exactly (the edit is authoritative). The previous compilation entry for the target is discarded when the request is sent: no `X`, no `original: D`, no "Apply"/"Restore" from the old result while the new request is pending. The pending state shows a cancel control. |
| 7 | Box holds `D`. Click "Improve prompt". Host posts `{ compilation: { status: "unfinished", conflicts: [{ earlier, later, why }], record } }` with no `rendered`. | `D` (unchanged) | A `role="alert"` element reads "Clarification is unfinished". Each conflict's `earlier`, `later` and `why` texts are listed. There is no "Apply improved prompt" button and no compiled textarea. |
| 8 | After each of steps 1-7, read the persisted state (`saveDrafts()` output / `vscode.getState()`). | as above | The `compilations` entry for the target is present and matches the visible state: after 1 `{ status: "ready", original: D, rendered: X, applied: false }`; after 2 `applied: true`; after 3 `applied: false`; after 4 and 5 the entry is unchanged by the refused action; after 6 the old entry is gone and a pending entry (with the new request id and `draft: X+"edit"`) is present; after 7 `{ status: "unfinished", conflicts: [...] }` with no `rendered`. Field names are webview-dev's choice; the facts above must be recoverable from the entry. |

Error path (not numbered in the brief, included for completeness): host posts `{ compilation: { requestId, target, error } }`
-> box unchanged, the error text shown, no Apply button, persisted entry records the error or is removed.

Compiled text leaves Entomatical only through the existing create (first prompt of a new session) and follow-up
(new message) paths: Apply changes the task box only; it never sends anything.
