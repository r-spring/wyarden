# Entomatical for agents: plans, workflows and the orchestrator

For any agent (Claude, Codex, Grok or Antigravity) that hands out work on this board. The code is the source of truth; the two
schemas mirror it and `test/agent-schemas.test.js` fails when they drift.

- [schemas/plan.schema.json](https://github.com/r-spring/wyarden/blob/main/docs/agents/schemas/plan.schema.json): a workflow plan file (`src/plan.ts` `validatePlanFile`).
- [schemas/orchestrator.schema.json](https://github.com/r-spring/wyarden/blob/main/docs/agents/schemas/orchestrator.schema.json): `$defs` for each `board.js` request body
  (`src/orchestrator.ts` `validateRequest`), the caps file, the policy file and `.entomatical/capabilities.json`.
- [HANDOFF-FORMAT.md](HANDOFF-FORMAT.md): how to write a handoff doc a fresh session can take as its prompt.
- Background: `docs/orchestrator/BRIEF.md` (the delegation brief), `workflows/README.md` (check catalogue),
  `src/plan.ts` (plan loading and validation).

`board.js` is `node ~/.entomatical/board.js` (source `tools/board.js`). It needs a VS Code window open on the repo that owns the board.

## Which one to use

| You have | Use | Why |
|---|---|---|
| One bounded job | **A single card** (`board.js add`, or the user's Add task form) | One worktree, one session, optional checks. |
| Steps known in advance, same shape each time (per feature, per question, fix then verify) | **A workflow plan file** in `workflows/*.plan.json` | No model plans at run time: the board checks the file, writes each prompt from one template, makes the cards, and (with `"review": "checks"`) merges each step when its checks pass. the user approves by pressing Run. |
| Work you must plan, split, review and re-plan as results come in | **Allow delegation** on a new or existing card (`ORCHESTRATION.md` and `board.js plan`, then `add`, `wait`, `integrate`) | A model decides the cards. the user approves one plan and caps for the whole tree. |

A saved plan supplies the initial assignments. Its reviewer may `add` extra work only when that v1 model-reviewed plan explicitly enables delegation. To bring work from an earlier run under review, use `claim`, `claim-tree` or `request-takeover` (see “When another card holds the card you need”).

## Writing a workflow plan file

Put it in `workflows/<name>.plan.json` (shared) or `.entomatical/workflows/<name>.plan.json` (private). the user runs it with
**Run a plan…**. From a card, a new plan file written with Write goes to the **main checkout's** `workflows/` (F98,
`hook/plan-folder.js`) so the picker lists it at once, and is committed there on `main` once, when the card's turn ends (never pushed). The hook puts the day's
date in front of a new plan's name (`2026-11-14-<name>.plan.json`; a name that already starts with a date is kept), and the picker
lists dated plans first, newest first. It is not in your worktree or
branch: edit it at the path the hook names (edits in the same turn go into that one commit), and never commit a copy of it on your branch. Every field is in [plan.schema.json](https://github.com/r-spring/wyarden/blob/main/docs/agents/schemas/plan.schema.json); unknown fields are refused so a typo shows.
When its run finishes, the board moves the plan file to `archive/` in its folder (F99), so Run a plan… lists only plans not yet run.
A plan with a non-empty `vars` object is the exception: it takes inputs, so it is reusable and stays listed after it finishes.

```json
{
  "v": 1, "name": "Example: two small steps", "review": "checks", "model": "haiku", "effort": "low",
  "steps": [
    { "id": "write", "title": "Write the note", "goal": "Create docs/x.md …", "files": ["docs/x.md"], "checks": ["example-note"] },
    { "id": "extend", "title": "Extend it", "goal": "Add a sentence …", "checks": ["example-note"], "after": ["write"] }
  ]
}
```

Rules the schema cannot show, all checked by the board before it makes any card:

- `checks` are **names** in `workflows/checks.json`, not commands. With `"review": "checks"` every step needs one. Add a catalogue entry
  (`{ "run": "…", "what": "…", "minutes": 1 }`) before you name it.
- `after` names steps of this plan or six-hex card ids already on the board. No self-waits, no circles.
- `{{name}}` must be a `vars` key, or the item of the step's `each` (`as`, else the list name minus its plural `s`, or `item`).
  `each` splits on `;` or new lines when present, else on spaces and commas; 1 to 20 items.
- `account`, `model`, `effort`, `permission` are checked per card against that card's account (step overrides plan). See Models.
- Cards (steps × items, plus `judge` and `scribe`) ≤ `entomatical.orchestrator.caps` `total` (default 600).
- `"judge": true` on a step needs the plan's `judge` model and at least one check.
- Top-level `"mayOpen": true` lets a v1 model reviewer open additional workers using `board.js add` after the operator approves the plan. The preview shows this permission. A file without this permission keeps its original assignments. Checks-only plans have no reviewer session, and v2 approval pins its assignments.
- `"mayOpen": true` on a step lets that step open its own cards with `board.js add` (F119). The step accepts its children before `board.js ready`. Each child counts against the same run limits, including when it uses a different provider.
- The worker cannot ask questions. Put everything in `goal` (or a `source` file), say what to reply in `reply`.

Examples that pass, in `docs/agents/examples/`: `example.plan.json`, `parity-sweep.plan.json`, `research-write.plan.json`, `test-fix.plan.json`. Copy one into `workflows/` to run it.

Use `board.js add --json` to read the allocation receipt, including its `id`, `started` and `launchState`. The default output keeps its card-id format for scripts. A `dispatched` launch has a recorded terminal dispatch. A `confirmed` session has reported a matching card-level `SessionStart`. `show <id>` reads subsequent launch state and shows the assigned controller and grouping parent. `waiting`, `queued`, `failed` and `exited-unconfirmed` distinguish work still to start from a launch that needs attention.

## Writing a handoff doc

When you hand work to a later session, follow [HANDOFF-FORMAT.md](HANDOFF-FORMAT.md): a header, then Goal, State, Next steps,
Constraints, Pointers, Open questions and optional History. Save it as `<repo>/docs/handoffs/<yyyy-mm-dd>-<short-kebab-name>.md`
in the main checkout; the user's **Load handoff** lists that folder newest first and puts the doc's text in the prompt box.

## Writing ORCHESTRATION.md so `board.js plan` counts it

`board.js plan` reads `ORCHESTRATION.md` in **your worktree** and counts steps with `planSummary` (`src/orchestrator.ts`). Zero steps
is refused: "ORCHESTRATION.md lists no steps (a list under a Steps heading)". The count is shown to the user (2 points per step).

- The section is the **first heading whose text contains** `step`, `steps`, `plan`, `card` or `cards` (any level, any case), for
  example `## Steps`.
- A **later** heading with one of those words starts the section over. So `# Plan` then `## Steps` counts only under `## Steps`, and a
  `## Plan notes` after your steps would replace them. Do not reuse those words in later headings.
- The section ends at the first other heading after it has items.
- A step is a list line starting with at most 3 spaces then `-`, `*`, `+`, `1.` or `1)`. **Put sub-detail 4+ spaces deep** (or
  as plain text) so it is not counted. `- [x]` items are not counted. Tables are not counted.
- With no matching heading, every top-level list line in the file counts.

```markdown
## Steps

1. Schema for plan files (card 5c41bc). Files: docs/agents/. Evidence: npm test.
    - after: none; owner: claude sonnet
2. Review and merge (root).

## Risks
```

## `board.js` verbs

Read verbs need no rights. Write verbs drop a request in `.entomatical/inbox/` and wait up to 20 s; a refusal prints `refused: <why>`
and exits 1. Write verbs other than `send`, `receive`, `rebind`, `screen`, `type`, `turn-done`, `submit`, `readiness` need a card with delegation rights, and every write needs your own bound session.

| Verb | Flags | Example |
|---|---|---|
| `list` | `--mine` (your run, with descendants), `--all` (include Done and yourself), `--live` (only live cards; needs a snapshot under 30 s old), `--ids a,b` | `board.js list --all --live` |
| `show` | `<id\|self>`, `--last N` (1–1000 events, default 5) | `board.js show 5c41bc --last 20` |
| `models` | `--json` | `board.js models` |
| `accounts` | `--json` | `board.js accounts` |
| `capabilities` | (always JSON) | `board.js capabilities` |
| `wait` | `--mine` or `--ids a,b`, `--timeout S` (default 600); exit 2 on timeout; remembers what you saw | `board.js wait --mine --timeout 600` |
| `watch` | `--mine`; never exits (for a Monitor tool) | `board.js watch --mine` |
| `events` | `<id\|self>`, `--from N` | `board.js events self --from 40` |
| `add` | `--title T` and `--prompt-file F` (or `--prompt T`); `--parent id`, `--account A`, `--runtime claude\|codex\|grok\|antigravity`, `--model M`, `--effort E`, `--permission P`, `--rule-file F.json` or `--autoRule`, `--after a,b`, `--start auto\|manual`, `--json`, `--may-open` (or `--orchestrator`), `--role judge\|scribe\|research`, `--judge`, `--watch id,id` | `board.js add --title "Fix parser" --prompt-file p.md --runtime codex --model gpt-6.1-sol --rule-file rule.json` |
| `send` | `<id>` `--text-file F` or `--text T` | `board.js send 744cc3 --text "Step 2 is merged."` |
| `receive` | — | `board.js receive` |
| `stop` / `resume` / `done` / `cancel` / `adopt` | `<id>` | `board.js done 5c41bc` |
| `claim` | `<id>` `--reason T`; the card's holders finished (see below) | `board.js claim 5b3cc6 --reason "run 9126b7 is done; I cancel its leftover"` |
| `claim-tree` | `<root>` `--reason T`; every open card a finished or idle run left behind | `board.js claim-tree 9126b7 --reason "superseded by this run"` |
| `request-takeover` | `<id>` `--reason T`; the user answers Approve or Deny | `board.js request-takeover 5b3cc6 --reason "duplicate of my step 2da895"` |
| `handoff` | `<id\|self>` `--to <card>`, `--reason T` | `board.js handoff 5c41bc --to 744cc3` |
| `rebind` | `--session S` | `board.js rebind --session "$CLAUDE_CODE_SESSION_ID"` |
| `ready` | — | `board.js ready` |
| `note` | `"<text>"` | `board.js note "Plan ready for review"` |
| `plan` | `--caps-file F.json`, `--policy-file F.json` | `board.js plan --caps-file caps.json --policy-file policy.json` |
| `switch` | `<id>` `--account A` | `board.js switch 1a2b3c --account "Codex · Work"` |
| `finish` | `self`: your own run, reviewed when the turn ends. `<id>` (F120): the root of an approved run closes a card of its run or of the user's whose work is in the target already (in Review, session ended, clean worktree, every commit landed); only its worktree and branch are removed, nothing is merged or pushed | `board.js finish self`, `board.js finish 5c41bc` |
| `screen` | `<id>`, `--lines N` (1–500); any ancestor, orchestrator or not | `board.js screen 5c41bc --lines 60` |
| `type` | `<id>`, `--text T` or `--text-file F`, `--key K` (repeatable: `escape`, `ctrl-c`, …), `--enter`, `--override`; refused if the user typed there since your last `screen` | `board.js type 5c41bc --key escape --text "yes" --enter` |
| `turn-done` | — ; only your own Grok or Antigravity card terminal while it is Running (works with the orchestrator off); moves it to Review, not Interrupted; Enter typed in the terminal runs it again | `board.js turn-done` |
| `submit` | governed run only: `--head <commit>` and `--summary-file F` (or `--summary T`); `--base <commit>`, `--files a,b`, `--check "…"` (repeatable; claims), `--covers A-01,A-02`, `--limitations T`, `--decision T` (repeatable) | `board.js submit --head $(git rev-parse HEAD) --summary-file done.md` |
| `integrate` | `<child>` you opened. Accepts its clean revision into your card branch and marks it Done. Checks and any judgment must match that revision. Governed runs also require the approved submission. A conflict keeps the child open. | `board.js integrate 5c41bc` |
| `readiness` | governed run only: `[<id>\|self]`; read-only. A child: can it be integrated; the root: what blocks the user's Finish | `board.js readiness self` |
| `council` | governed root with a council only: `convene <checkpoint>`, `reconcile <checkpoint> --file F.json`, `retry <checkpoint> <member>`, `show [<checkpoint>]` | `board.js council convene final` |
| `overview` | governed run only: `[<root>\|self]`, `--since <seq>`; JSON brief, project state and the material events after your cursor | `board.js overview --since 42` |
| `discard` | `<id>`: always refused to agents; ask the user | — |
| `reload-windows` | — (reloads every Entomatical window and ends their sessions; only when told to) | `board.js reload-windows` |

A `--rule-file` holds `{ "commands": ["test"], "doneWhen": "…", "goal": "…" }`; each command must be a `workflows/checks.json` name
or its exact `run` text.

## Models, effort and permissions

Use only what `board.js models` and `board.js accounts` print. **Never invent a model name.**

| Runtime | Models | Effort | Permission |
|---|---|---|---|
| Claude | `opus`, `sonnet`, `haiku`, `fable` (full `claude-…` ids are shortened to these) | `low`, `medium`, `high`, `xhigh`, `max` | `ask`, `edits`, `auto`, `bypass` |
| Codex | ids from `board.js models` (for example `gpt-6.1-sol`) | that model's `efforts` in `models --json` | `ask`, `auto`, `bypass` |
| Grok, Antigravity | only ids the account **last advertised** (`models` shows them with the account and "last seen") | its advertised thought levels | `ask`, `bypass` |

Before a Grok or Antigravity account has advertised anything, a model or effort is kept and checked when the session opens; an
unknown one fails that card. Unattended cards have nobody to answer prompts: `ask` stops at the first tool request. Orchestrated cards
default to Bypass; a Grok or Antigravity child given a mode it lacks gets `ask`, never something wider.

## Run approval: caps and policy

`board.js plan` proposes your plan; the user approves it once for the whole tree. Only the root sends caps or policy.

- **Caps file** (`capsFile` in the schema): `{ "open": 4, "total": 600, "depth": 4 }`. Keys `open`, `total`, `depth` (≤ 8),
  `followUps`, `pending`, `watchers`, `perWatcher`, `pointsFiveHour`, `points`; whole numbers ≥ 0. Omitted keys keep their value.
- **Policy file** (`policyFile`): `{ "allow": ["…"], "deny": ["…"], "noSync": true }`, all three required, up to 30 items of 200
  characters each. It is copied into every child's first prompt as "Run instructions"; it states scope, it does not change tool rights.

## Governed runs (phases 3 and 4)

the user may tick **Governed run** when he approves a root's plan. Then, and only for that run:

- **Limits he typed** (there are no defaults): active executions (root, coordinators, workers and judges together), direct active
  children per card, delegation depth. A card runs only while it holds an execution lease; the lease is released when its session has
  ended, not when its column says Review. End your turn while you wait for children: a live session keeps its lease.
- **Profiles**: `board.js capabilities` lists only the profiles you may delegate (`governed.delegate`), `--profile REF` the full pinned
  manifest. `add` takes `--profile REF` (omitted: your default child profile; no default is refused), `--assignment-file F.json`
  (required: `{ "key", "outcome", "owns"?, "acceptance"?, "evidence"?, "returns"? }`) and, with `--may-open`, `--delegate-file F.json`
  (`{ "allowed"?, "defaultChild"?, "depth"? }`, a subset of yours and shallower). Your own profile does not bound what you delegate;
  the user's allowance does. A request never changes the run's limits or profiles (`plan` with caps or policy is refused).
- **Same key, same card**: an `add` with an assignment key you already used returns that card; another payload under it is refused.
- **Handoffs**: a child commits, then `board.js submit`; the board checks the clean HEAD and base, records the files git says changed
  and tells you. You accept with `board.js done <id>` only while that submission is still its HEAD. Claimed checks stay claims.
- **State**: `board.js overview` prints the brief, the leases and the cards grouped as running, queued, waiting, blocked, ready to
  integrate, completed, cancelled, plus decisions (needs input, launch failures, capacity deadlock, overlapping `owns`). `--since <seq>`
  prints only the events after your cursor; `expired: true` means rebuild from the snapshot it includes.
- **Integration (phase 4)**: a coordinator or the root integrates a child it opened with `board.js integrate <child>` (the user's Merge on
  the child does the same). The board merges the child's exact submitted commit into your branch after its readiness check: the
  submission is still the child's clean HEAD, its checks passed at that commit, its dependencies are completed, the child's session has
  stopped, your worktree is clean and no operation of the run is open. Declared and actual overlaps are reported as notes. A conflict is
  aborted: nothing changes and the child keeps its worktree; serialize the work or name one integration owner. Integrating moves your
  HEAD, so your own checks and submission are stale afterwards.
- **Target (phase 4)**: only the user's Finish on the root takes the run to the target. The board checks the root's clean HEAD (the
  candidate) contains every member's submitted commit, the root's checks passed at exactly that commit, no Done review of it is
  unresolved, the target is clean and already contained in the candidate (Finish only fast-forwards it: no commit, merge commit or
  conflict resolver), and no operation is uncertain. Push is a separate button in that Finish. Periodic delivery, `finish self`,
  self-finish, the Merge button on the root and plan merges and archival stay refused for every card of the run. `board.js readiness
  self` shows what still blocks.
- **Council (phase 5)**: only when the user chose a saved council at approval (`workflows/councils.json`; every member, checkpoint, rubric,
  round limit and unavailable-member rule is chosen there, nothing has a default). The root convenes a checkpoint with `board.js council
  convene plan|milestone|final`: the board freezes one package (spec, configuration and council revisions, candidate commit and tree,
  target, checks) and starts one read-only judge card per member on exactly its saved account, model and effort, under the run's leases.
  It refuses while the evidence is unknown (no clean candidate, checks not passed at it). An unavailable member is recorded, never
  replaced. Members end with one JSON judgment (pass, changes-required or unable-to-assess; scores never decide). Dispose of every
  material finding with `board.js council reconcile <checkpoint> --file F.json`: confirmed, disproved (with evidence), outside-scope
  (with a rationale; never a listed requirement) or unresolved. Finish needs each saved checkpoint's last round passed for a package
  that still matches the run; at the round limit the user decides (a waiver, recorded as an exception, is never a pass).
- **Not supported** in a governed run: `--watch`, `adopt`, `claim`, `claim-tree`, `handoff`, `request-takeover`, Battle Royale,
  plan-file runs and adopted sessions. A missing or failed (cancelled, discarded, never started) dependency blocks; it is never
  counted as accepted.

## When another card holds the card you need

A card is held by its opener chain (the card that opened it, that card's opener, up to the run's root) and its watcher. Verbs like
`stop`, `cancel`, `done` on a card you do not hold are refused, and the refusal ends with the verb that would work, ids filled in.

- **`claim <id> --reason T`** moves the card, with the cards under it, to you without asking when: every holder is Done, cancelled,
  gone, or in Review, Queued or Needs input with no live session for 30 minutes (`entomatical.orchestrator.claimAfterMinutes`; no
  wait when the holder's run ran the same plan file as yours); the card and the cards under it have no live session; the user did not
  take it over; and nobody claimed it in the last hour. Only the run's root claims, unless the approved caps carry `"mayClaim": 1`.
  A claimed card keeps its branch, worktree, session and checks; you now review, merge or cancel it as your brief says.
- **`claim-tree <root> --reason T`** does the same for every open card of another run whose root is finished or idle. Live cards,
  the cards above and under them, and the cards they watch stay where they are and are listed in the reply. The root stays with the user.
- **`request-takeover <id> --reason T`** when `claim` is refused (a live owner, a live card, an unrelated run, no right to claim).
  the user gets a notification with Approve and Deny; a live owner is told and may `handoff` it to you first. The answer comes as a
  message; `board.js wait --ids <id>` also wakes when the card changes hands. Keep working meanwhile.
- **`handoff <id|self> --to <card>`** gives a card you hold (or, with `self`, every open card you opened) to another orchestrator
  card. No approval.

Every move is recorded on the card (`show <id>`: "taken over" or "handed" lines, chip `taken over by <id>` or `handed to <id>`) and
in `.entomatical/transfers.jsonl` (`events <id>` prints the card's records after its hook events). `discard` and `finish` never move.

## Common refusals

| Refusal | Do this |
|---|---|
| `Not an orchestrator` | Check your card’s role against the [write permissions for board.js verbs](#boardjs-verbs). Ask the user or the card’s assigned controller to perform a restricted operation. |
| `Not bound: …` | Run `board.js` inside the card's own session. After a takeover: `rebind --session <current id>`. |
| `Rate: at most one request per second` | board.js retries once; space your calls. |
| `Plan not approved` | Run `plan`, end your turn, wait for the user. |
| `Run paused…` | the user's Resume run continues it; open nothing meanwhile. |
| `open cap (N)` / `total cap` / `depth cap` | Finish or cancel cards first; a bigger cap needs a new `plan`. |
| `Account not signed in: …` | Use a label from `board.js accounts`. |
| `Unknown model …` / `Unknown effort …` / `Unknown permission …` | Pick from the list in the message (from `models`). |
| `Check not in workflows/checks.json: …` | Add the catalogue entry first, or name an existing one. |
| `after: no card …` | Use ids from `list`. |
| `add: this run follows a plan file…` | The plan file lists every step; edit the file instead. |
| `Card … is controlled by … (…). You may board.js claim …` | Run the `claim` it names; the card is yours afterwards. |
| `Card … is controlled by … (…). Ask with board.js request-takeover …` | Run it, keep working, and wait for the answer as a message; or `send` the owner a message. |
| `Card … is the root of another run …` | Run the `claim-tree` it names, or `request-takeover`. |
| `Card … is not yours: no orchestrator opened it (the user's card)` | Outside a plan-file run, `adopt` it; otherwise `request-takeover`. |
| `adopt: this run follows a plan file…` | Use the `claim`, `claim-tree` or `request-takeover` the refusal names. |
| `busy` / `Stop the card before cancelling it` | `stop` first. |
| `Never started successfully; use cancel, not done` | `cancel`. |
| `Acceptance checks have not passed` / `A passing judge verdict is required` | Read `show <id>`, `send` a fix, wait. |
| `Orchestrator must declare ready first` / `Descendants are not finished` | The child coordinator must finish its cards and run `ready`. |
| `ORCHESTRATION.md lists no steps…` | See the planSummary rules above. |
| `No answer from the board in 20 s` | No VS Code window owns this repo; tell the user. |
| Plan file: `Unknown field "x"…`, `… names no checks…`, `… is not a signed-in account`, `… "model" must be one of …` | Fix the file; the board lists every problem at once. |

## Governed plan files (v2)

Use `v: 2` with explicit `reusable`, worker `permission`, and `reviewer.permission`
when `review` is `model`. `execution` supplies the existing governed run's
`limits: {active, directChildren, depth}`, `allowed` profile references and
`defaultChild`. Choosing `provider-defaults` is explicit; strict profiles retain
their existing fail-closed provider-route checks. The reviewer uses the same
pinned default capability profile, with its separately chosen permission.

Every step needs a `contract` with `reads`, `writes`, `artifacts`, `acceptance`
and `resources` arrays. Reads name existing repository files whose bytes are
pinned at preview. Writes are exact paths or directory prefixes, without globs.
Artifacts must be committed files within writes. A dependent step can read its
predecessor's artifacts through the accepted submission; do not list a future
output as an existing read input. Only the listed read inputs are pinned; these
lists do not restrict what the provider can read.

The preview approval binds the expanded cards, typed input values, check
definitions, source hashes and pinned governance. Run refuses drift. Replaying
the same approval returns the same assignments, without dispatching again.
`inputs` replaces v1 `vars`: each definition has `type: "text" | "list"`, a
`required` boolean and an optional `default`. List defaults and answers are JSON
arrays; `each` preserves spaces and commas within their items. The `reusable`
flag is independent of whether the plan has inputs. V1 splitting stays unchanged.

An optional `contract.gate` names `action`, stable `target`, exact `candidate`
and existing `evidence` paths. **Approve scope** binds those values and the
evidence hashes to one step and one dispatch. This is an operator decision,
not device authentication or evidence of a hardware-key touch. An ended gated
attempt cannot be resumed as another dispatch. After an ownership change, a v2
attempt must be reconciled and its result recorded before another launch.

Use resource names such as `named:router-wireless-window` only where serialization
is needed. The existing workflow store claims them exclusively across plans and
windows **of this repository**. Unknown or interrupted operations retain claims
until the owner records a result. This is not a distributed lock across repos or
machines.

Workers commit and `board.js submit`. The owner uses **Record result** to accept
an exact submitted commit and its artifact hashes, or records held, blocked,
failed, deferred, not-applicable or cancelled with the appropriate reason.
Blocked, deferred and not-applicable require a reason and never count as a pass.
Accepted results release dependents only after governed integration. A model
reviewer uses `board.js integrate`; a checks-reviewed plan asks the board to
integrate after acceptance. Finish remains the owner's explicit action.

Integration refuses changes outside writes, including intermediate or reverted
changes. Checks must pass at the clean submitted commit. Receipts retain artifact
hashes and commit identity after worktree cleanup; missing or stale evidence holds
dependencies. These are integration and provider permission controls, **not an
OS filesystem or network sandbox**. Keep live privileged operations out of an
unattended preparation plan. Preparing a report does not establish live device
acceptance. V2 uses governed review; the legacy standing `judge`/`scribe` plan
fields remain available in v1.
