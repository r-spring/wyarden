Plan this task. A plan of two or more steps becomes an Entomatical plan file, and its steps do the work later, when the user runs it; a plan of one step needs no file, and you do that step yourself after approval.

1. Read what you need in this repository to plan it well. Codex has no plan mode here, so change no file yet: propose the plan in your reply, ask the user to approve it, and stop there until the user answers.
2. If the approved plan is a single step, write no plan file: carry that step out yourself in this session, now that it is approved. Stop here.
3. With two or more steps, do not do the work itself. After the plan is approved, write ONE file, `{{workflows}}/<short-kebab-name>.plan.json`, by that full path: the main checkout's `workflows/` folder, not your worktree.
   - Its format: {{schema}}
   - Its rules ("Writing a workflow plan file"): {{guide}}
   - Name checks only by their names in {{checks}}. When a step needs a check that is not there, say so in your reply instead of inventing one.
   - Each step's worker cannot ask questions: put everything it needs in its `goal`.
   - When the task is one the user will repeat with different inputs, declare those inputs as `vars` (see the rules); such a plan stays listed in Run a plan… after it finishes.
4. Run a plan… lists that folder at once. Do not run its steps, do not commit it, and do not write a copy of it on your branch.
5. End your last reply with the full path the file was saved to.

Task:

{{task}}
