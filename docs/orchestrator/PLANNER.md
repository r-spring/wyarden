Plan this task. A plan of two or more steps becomes an Entomatical plan file, and its steps do the work later, when the user runs it; a plan of one step needs no file, and you do that step yourself after approval.

1. Read what you need in this repository to plan it well. You are in plan mode: propose the plan and ask for approval before you write anything.
2. If the approved plan is a single step, write no plan file: carry that step out yourself in this session, now that it is approved. Stop here.
3. With two or more steps, do not do the work itself. After the plan is approved, write ONE file with the Write tool (not Bash or PowerShell): `workflows/<short-kebab-name>.plan.json`.
   - Its format: {{schema}}
   - Its rules ("Writing a workflow plan file"): {{guide}}
   - Name checks only by their names in {{checks}}. When a step needs a check that is not there, say so in your reply instead of inventing one.
   - Each step's worker cannot ask questions: put everything it needs in its `goal`.
   - A step too large for one session may open its own cards: give it `"mayOpen": true` and say in its `goal` how to split the work. Every other step opens none.
   - When the task is one the user will repeat with different inputs, declare those inputs as `vars` (see the rules); such a plan stays listed in Run a plan… after it finishes.
4. Entomatical saves the file in the main checkout's `workflows/` folder with today's date in front of its name (`YYYY-MM-DD-<short-kebab-name>.plan.json`), so Run a plan… lists it at once, newest first. Do not add the date yourself, do not run its steps, and do not commit a copy of it on your branch.
5. End your last reply with the full path the file was saved to.

Task:

{{task}}
