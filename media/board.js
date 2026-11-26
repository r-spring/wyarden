// Entomatical webview. Builds the board with DOM calls only (no innerHTML), so task text is never parsed as HTML.
const vscode = acquireVsCodeApi();
const COLUMNS = [
  ["queued", "Queued"],
  ["running", "Running"],
  ["needs-input", "Needs input"],
  ["review", "Review"],
  ["done", "Done"],
];
// How many of COLUMNS, in order, each stack holds: the work under way (Queued, Running), what waits for the user (Needs input, Review), Done.
const STACKS = [2, 2, 1];
let state = { tasks: [], live: [], accounts: [] };
const stamp = (at) => formatHostDate(at, state, "toLocaleString");
// A card's role chip (F73, F74), each label spelled out so the parity check (tools/parity.js) finds it on the board.
const ROLE_CHIPS = { sub: { textContent: "sub-orchestrator" }, judge: { textContent: "judge" }, scribe: { textContent: "scribe" }, research: { textContent: "research" } };
let selectedPlan;
let doneOpen = false; // the Done column starts collapsed; whether the user opened it survives redraws
const savedDrafts = vscode.getState?.() || {};
// Undefined uses the form defaults (including older drafts). Null keeps Add blocked until an explicit replacement.
let { parentId = "", account: draftAccount, profile: draftProfile } = savedDrafts;
let snapshotReady = false;
const drafts = new Map(savedDrafts.followUps || []); // task id -> follow-up text; present while the follow-up box is open
const pendingSends = new Map(); // card -> request currently being handled by this webview's host
// A reloaded view keeps an unconfirmed submission as an editable draft. It never resends it automatically.
const bounced = new Set(savedDrafts.recoverFollowUps || []);

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
const cardTerminals = window.createCardTerminals?.(send);
const button = (label, onclick, title) => el("button", { textContent: label, onclick, title: title || "" });

// The new-task form is built once so status updates never wipe what is being typed.
const subtaskOf = el("div", { className: "muted" });
// The add-task title box was removed (F101, the user, 12 November 2026): the Haiku title toggle or the prompt's first line names the card.
// A title that comes back with a refused create (or an old draft) is held here and sent with the next Add task.
let pendingTitle = "";
const promptBox = el("textarea", { placeholder: "Task prompt", rows: 4 });
const accountBox = el("select", { ariaLabel: "Account for new task" });
const choose = (label, options) => el("select", { ariaLabel: label, title: label }, ...options.map(([value, text]) => el("option", { value, textContent: text })));
// Claude choices are MODELS and EFFORTS in src/board.ts; a Codex account offers the models and efforts its CLI lists (state.codex). A Grok or
// Antigravity account offers only what its agent last advertised (state.acpCatalogs, from the board's acp-catalog.json): no names are built in. "" leaves the default.
const CLAUDE_MODELS = [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"]];
// the user, 23 November 2026: every model menu names the version ("Fable 5.2", from the host's state.claudeModels), a task or plan menu
// lists every model the provider's CLI lists, and its first entry names the account's default ("Default: Fable 5.2", state.defaultModels).
const claudeModels = () => state.claudeModels || CLAUDE_MODELS;
const defaultChoice = (account, unknown = "Default model") => ["", state.defaultModels?.[account] ? `Default: ${state.defaultModels[account]}` : unknown];
const codexChoices = () => (state.codex?.models || []).map((m) => [m.model, m.label && m.label !== m.model ? `${m.label} (${m.model})` : m.model]);
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const isCodex = (account) => (state.codex?.accounts || []).includes(account);
const externalProvider = (account) => state.externalProviders?.[account];
const isAcpTask = (task) => task.provider === "grok" || task.provider === "antigravity";
const ACP_NAMES = { grok: "Grok", antigravity: "Antigravity" };
const acpCatalog = (account) => state.acpCatalogs?.[account];
const codexModel = (model) => (state.codex?.models || []).find((m) => m.model === model);
const modelBox = choose("Model for new task", []);
const effortBox = choose("Effort for new task", []);
// Permission modes (PERMISSIONS in src/board.ts, CODEX_PERMISSIONS in src/codex.ts). Codex has no separate accept-edits mode.
const PERMISSION_CHOICES = [["ask", "Ask permissions"], ["edits", "Accept edits"], ["auto", "Auto mode"], ["bypass", "Bypass permissions"]];
// ACP_PERMISSIONS in src/board.ts: a Grok or Antigravity unattended card asks or allows once automatically; there is no edits or auto mode.
const ACP_TERMINAL_DEFAULTS = "A card opened in the provider's own terminal uses the agent's default model and effort; this choice applies to its unattended runs and follow-ups.";
const ACP_PERMISSION_CHOICES = PERMISSION_CHOICES.filter(([p]) => p === "ask" || p === "bypass");
const permissionBox = choose("Permission mode for new task", []);
/** Refills a menu only when its choices change (a refill closes an open menu). data-want is the last pick, kept for when it is offered again. */
function setChoices(box, options, fallback = "") {
  const key = JSON.stringify(options);
  if (box.dataset.choices === key) return;
  box.replaceChildren(...options.map(([value, text]) => el("option", { value, textContent: text })));
  box.value = options.some(([v]) => v === box.dataset.want) ? box.dataset.want : fallback;
  box.dataset.choices = key;
}
// Antigravity (F88; ANTIGRAVITY_* in src/acp.ts): only Opus, Argon (the user, 6 November 2026) and Carbon (the user, 14 November 2026),
// and agy's three effort levels, with no "Default" entry, so a task never falls back to another of its models. Opus at high is preselected: agy offers no max.
// Fix 11 (F92): a model menu offers short names, each running the newest version its provider lists (state.antigravityModels and
// state.codex.short, from src/models.ts); the label names the id it runs now.
const ANTIGRAVITY_EFFORTS = ["low", "medium", "high"];
const codexShort = (name) => (state.codex?.short || []).find((n) => n.name === name);
/** The card's model as Session details shows it: the short name and the id it runs now, e.g. "sol → gpt-6.1-sol". */
// The exact id the card's launch sends (F92, 17 November 2026), also for a card on Default model: "Default model → gpt-6.1-sol".
const modelText = (t) => t.runModel ? `${t.model || "Default model"} → ${t.runModel}` : t.model;
// F88: what agy lists for its sign-in, as [value, label] (src/acp.ts antigravityModels): the user's three (Opus, Argon, Carbon) as short
// names where it lists them, else agy's own ids; the three until it has answered. Only the user's three (ANTIGRAVITY_FAMILIES) take an effort.
const AGY_FALLBACK = [["opus", "Opus (newest)"], ["argon", "Argon (newest)"], ["carbon", "Carbon (newest)"]];
const agyModels = () => (state.antigravityModels?.length ? state.antigravityModels : AGY_FALLBACK);
const agyEffort = (model) => AGY_FALLBACK.some(([m]) => m === model);
function syncChoices() {
  const codex = isCodex(accountBox.value), acp = externalProvider(accountBox.value), models = state.codex?.models || [];
  // Unattended Grok or Antigravity (Orchestrator ticked) runs over ACP: the models, efforts and Ask its agent last advertised (run 0db6d1).
  // In the provider's own terminal: Antigravity's two models and agy's efforts, Grok's own defaults, every permission mode (F88).
  const unattended = !!acp && orchestrator.box.checked, seen = unattended ? acpCatalog(accountBox.value) : undefined;
  const name = ACP_NAMES[acp] || "";
  if (unattended) {
    setChoices(modelBox, [defaultChoice(accountBox.value, !seen?.models.length ? "Default model (none seen yet)" : undefined), ...(seen?.models || [])]);
    setChoices(effortBox, [["", !seen?.efforts.length ? "Default effort (none seen yet)" : "Default effort"], ...(seen?.efforts || [])]);
    // Ask runs it in the mode its agent advertised as asking first (askMode in src/acp.ts); an account that advertised none offers no Ask.
    setChoices(permissionBox, ACP_PERMISSION_CHOICES.filter(([p]) => p !== "ask" || seen?.ask !== null), "bypass");
  } else if (acp === "antigravity") {
    setChoices(modelBox, agyModels(), agyModels()[0][0]);
    if (agyEffort(modelBox.value)) setChoices(effortBox, ANTIGRAVITY_EFFORTS.map((e) => [e, `${e} effort`]), "high");
    else setChoices(effortBox, [["", "Default effort"]]);
  } else if (codex && planFirst.box.checked && !orchestrator.box.checked) {
    // Plan first on Codex (the user, 12 November 2026): the newest Astra at ultra effort (src/board.ts add), shown and fixed while ticked.
    // The picks stay in data-want, so unticking brings them back.
    const astra = codexShort("astra");
    setChoices(modelBox, [["astra", astra ? `${astra.label} (${astra.id})` : "Astra (none listed)"]], "astra");
    setChoices(effortBox, [["ultra", "ultra effort"]], "ultra");
  } else {
    setChoices(modelBox, [defaultChoice(accountBox.value), ...(acp ? [] : codex ? codexChoices() : claudeModels())]);
    const efforts = acp ? [] : !codex ? CLAUDE_EFFORTS : modelBox.value ? codexModel(codexShort(modelBox.value)?.id || modelBox.value)?.efforts || [] : [...new Set(models.flatMap((m) => m.efforts))];
    setChoices(effortBox, [["", "Default effort"], ...efforts.map((e) => [e, `${e} effort`])]);
  }
  // Every provider starts on its most permissive mode, Bypass permissions, with no "Default permissions" entry (the user, 6 November
  // 2026, F88): Claude's bypassPermissions, Codex's never-ask full access, Grok's bypassPermissions, Antigravity's
  // --dangerously-skip-permissions. Codex has no separate Accept edits.
  if (!unattended) setChoices(permissionBox, PERMISSION_CHOICES.filter(([p]) => !codex || p !== "edits"), "bypass");
  const astraPlan = codex && planFirst.box.checked && !orchestrator.box.checked;
  modelBox.disabled = effortBox.disabled = astraPlan;
  modelBox.title = astraPlan ? PLAN_FIRST_ASTRA : !unattended ? "Model for new task" : seen?.models.length ? `Models ${accountBox.value} last advertised, ${stamp(seen.at)}` : `${name} lists no models until a session of this account has opened.`;
  effortBox.title = astraPlan ? PLAN_FIRST_ASTRA : !unattended ? "Effort for new task" : seen?.efforts.length ? `Effort levels ${accountBox.value} last advertised, ${stamp(seen.at)}` : `${name} lists no effort levels until a session of this account has opened.`;
  permissionBox.title = unattended ? "Permission mode for an unattended Grok or Antigravity card (orchestrator, plan step or worker). A card opened in the provider's own terminal uses that provider's permissions." + " " + (seen?.ask ? `Ask runs it in the agent's advertised mode ${seen.ask}.` : seen?.ask === null ? `${accountBox.value} advertises no mode that asks for approval, so Ask is not offered.` : "Ask runs it in a mode the agent advertises as asking first; an account that advertises none refuses Ask.") : "Permission mode for new task";
  // Plan first (F78): Claude's plan mode, or Astra at ultra effort on Codex; greyed out with the reason for a Grok or Antigravity account.
  planFirst.box.disabled = !!acp;
  planFirst.label.title = acp ? PLAN_FIRST_ACP : codex ? PLAN_FIRST_CODEX : PLAN_FIRST_TIP;
  // Titles, completion rules and the Orchestrator tickbox are offered for every provider: the host names and writes with Claude where the provider has no such model.
  autoTitle.box.disabled = state.autoStart === false;
  autoTitle.label.title = state.autoStart === false ? "Auto-start is off (entomatical.autoStart), so an untitled task is not named automatically. Type a title, or use Generate title with Haiku from the card's menu." : AUTO_TITLE_TIP;
  autoRule.label.title = AUTO_RULE_TIP;
  // The drop-downs pick a Claude model: a title for a Claude task only, a Done when for a Claude or Codex task (written on Claude).
  const titleOff = state.autoStart === false ? autoTitle.label.title : codex ? "A Codex task is named by Luna at low effort, so this model and effort are for Claude accounts."
    : acp ? `A ${name} task is named by its agent's default model, so this model and effort are for Claude accounts.` : "";
  const ruleOff = acp ? `A ${name} task's Done when is written by its agent's default model, so this model and effort are for Claude and Codex accounts.` : "";
  for (const [split, off, tip] of [[titleSplit, titleOff, "Model and effort for titles"], [ruleSplit, ruleOff, "Model and effort for Done when"]]) {
    split.arrow.disabled = !!off; split.arrow.title = off || tip; split.draw();
    if (off) split.shut(false);
  }
  orchestrator.label.title = ORCHESTRATOR_TIP;
  const termOnly = !!acp && !unattended;
  if (termOnly && !cardTerminal.box.disabled) { cardTerminal.box.dataset.was = String(cardTerminal.box.checked); cardTerminal.box.checked = true; cardTerminal.box.disabled = true; }
  else if (!termOnly && cardTerminal.box.disabled) { cardTerminal.box.checked = cardTerminal.box.dataset.was === "true"; cardTerminal.box.disabled = false; }
  cardTerminal.label.title = termOnly ? "Grok and Antigravity always run in the card's terminal." : CARD_TERMINAL_TIP;
  syncPlanPrompt();
}
// Beside Add task: Haiku names the task; Fable writes its completion rule at high effort before the card is added (src/extension.ts prepareRule).
// Each one is drawn as a toggle button (.toggle in board.css, the user, 11 November 2026): filled when on, outlined when off, its explanation
// on mouse-over. The checkbox inside stays for the keyboard, screen readers and saved drafts; only its drawing is hidden.
const toggle = (id, label, title, on = false) => {
  const box = el("input", { type: "checkbox", id, checked: savedDrafts[id] ?? on, onchange: () => saveDrafts() });
  return { box, label: el("label", { htmlFor: id, className: "toggle", title }, box, label) };
};
// Ticked by default: an untitled task is named before it starts (the user, 30 October 2026); unticking keeps the prompt's first line.
const AUTO_TITLE_TIP = "When the title box is empty, the task is named from its prompt as it starts automatically: Haiku, Luna for a Codex task, or the agent's default model on the task's own Grok or Antigravity account.";
const autoTitle = toggle("autoTitle", "Title: Haiku", AUTO_TITLE_TIP, true);
const AUTO_RULE_TIP = "Fable at high effort (on the Claude IDE default account for a Codex task; the agent's default model on the task's own account for a Grok or Antigravity task) writes the task's goal and when it is done before the card is added. With delegation enabled it also writes commands that check the run's work when it reaches Review.";
const autoRule = toggle("autoRule", "Done When: Fable", AUTO_RULE_TIP);
// Both are split buttons (the user, 13 November 2026): the toggle, a 1 px line, then ▾, which opens one menu of the Claude model and effort
// that helper runs on (no Sonnet). A pick applies at once and the menu stays open; a click outside or Esc closes it. The label names a pick
// other than the default. Remembered with the drafts and sent with Add task (src/extension.ts helperPick); syncChoices greys ▾ where the
// account's helper is not Claude.
const HELPER_MODELS = [["haiku", "Haiku"], ["opus", "Opus"], ["fable", "Fable"]];
const helperName = (model) => claudeModels().find(([m]) => m === model)?.[1] || model; // "Fable 5.2"
const attrs = (e, a) => { for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
function splitToggle(t, key, def, menuLabel, text) {
  const saved = savedDrafts[key] || {};
  const pick = { model: HELPER_MODELS.some(([m]) => m === saved.model) ? saved.model : def.model, effort: CLAUDE_EFFORTS.includes(saved.effort) ? saved.effort : def.effort };
  const words = t.label.lastChild; // the label's text, after its hidden checkbox
  const arrow = attrs(el("button", { type: "button", className: "split-arrow", textContent: "▾", ariaLabel: menuLabel }), { "aria-haspopup": "menu", "aria-expanded": "false" });
  const item = (group, value, label) => attrs(el("button", { type: "button", textContent: label, onclick: () => { pick[group] = value; draw(); saveDrafts(); } }), { role: "menuitemradio", "data-group": group, "data-value": value });
  const group = (label, items) => attrs(el("div", { className: "split-group" }, el("span", { textContent: label }), ...items), { role: "group", "aria-label": label });
  const menu = attrs(el("div", { className: "split-menu", hidden: true },
    group("Model", HELPER_MODELS.map(([m, n]) => item("model", m, n))), group("Effort", CLAUDE_EFFORTS.map((e) => item("effort", e, e)))), { role: "menu", "aria-label": menuLabel });
  const wrap = el("span", { className: "split" }, t.label, arrow, menu);
  function draw() {
    words.nodeValue = text(helperName(pick.model), pick.effort);
    for (const b of menu.querySelectorAll("button")) {
      b.setAttribute("aria-checked", String(pick[b.dataset.group] === b.dataset.value));
      if (b.dataset.group === "model") b.textContent = helperName(b.dataset.value); // the version arrives with the host's state
    }
  }
  const shut = (focus) => { if (menu.hidden) return; menu.hidden = true; arrow.setAttribute("aria-expanded", "false"); if (focus) arrow.focus(); };
  arrow.onclick = () => {
    if (!menu.hidden) return shut(false);
    menu.hidden = false; arrow.setAttribute("aria-expanded", "true");
    // Under the control, shifted left as far as it would pass the panel's right edge (a 283 px side bar), never past its left edge.
    // clientWidth leaves out a vertical scroll bar, which 100vw would count.
    const vw = document.documentElement.clientWidth;
    menu.style.left = "0px"; menu.style.maxWidth = `${vw - 16}px`;
    const r = menu.getBoundingClientRect(), over = r.right - (vw - 8);
    if (over > 0) menu.style.left = `${-Math.min(over, r.left - 8)}px`;
    menu.querySelector('[aria-checked="true"]')?.focus();
  };
  // F102: a right-click on either part opens this same menu, as on every other helper button; not VS Code's own menu.
  wrap.addEventListener("contextmenu", (e) => {
    if (menu.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (!arrow.disabled && menu.hidden) arrow.onclick();
  });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) shut(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { e.preventDefault(); shut(true); } });
  draw();
  return { wrap, arrow, pick, shut, draw };
}
const titleSplit = splitToggle(autoTitle, "titlePick", { model: "haiku", effort: "low" }, "Model and effort for titles",
  (name, effort) => effort === "low" ? `Title: ${name}` : `Title: ${name}·${effort}`);
const ruleSplit = splitToggle(autoRule, "rulePick", { model: "fable", effort: "high" }, "Model and effort for Done when",
  (name, effort) => effort === "high" ? `Done When: ${name}` : `Done When: ${name}·${effort}`);
// The Orchestrator tickbox (F69): the card gets the brief in its first message and may open cards of its own; a Claude one runs in a board terminal, the others headless. Never remembered: it is unticked after Add task.
const ORCHESTRATOR_TIP = "After plan approval this card can open and manage child cards on any supported provider within the run limits.";
const orchestrator = toggle("orchestrator", "Allow delegation", ORCHESTRATOR_TIP);
orchestrator.box.checked = false;
// Ticking Orchestrator switches a Grok or Antigravity account between its terminal choices and its unattended ones.
orchestrator.box.addEventListener("change", () => { syncChoices(); updateBindingNotes(); });
// Plan first (F78): the first turn runs in Claude's plan mode (permissions.defaultMode "plan" in the task's --settings file, src/board.ts
// writeHooks), and the next turns in the permission mode picked above. Remembered like the tickboxes beside it; off by default.
const PLAN_FIRST_TIP = "The task is sent the planning prompt shown below and starts in Claude's plan mode: it reads and proposes a plan, and asks you to approve it before it changes anything. Then it writes a plan file to workflows/, where Run a plan… lists it, or does a one-step plan itself. The next turns use the permission mode picked above.";
const PLAN_FIRST_CODEX = "Codex has no plan mode, so on a Codex account the task runs on the newest Astra at ultra effort, whatever model is picked. It is sent the planning prompt shown below: it proposes a plan and waits for your approval, then writes a plan file to the main checkout's workflows/, where Run a plan… lists it, or does a one-step plan itself.";
const PLAN_FIRST_ASTRA = "Plan first on Codex runs the newest Astra at ultra effort. Untick Plan first to pick another model.";
const PLAN_FIRST_ACP = "Grok and Antigravity have no plan mode here, so Plan first is for Claude accounts.";
const planFirst = toggle("planFirst", "Plan first", PLAN_FIRST_TIP);
// On a Codex account it also fixes the model and effort menus (syncChoices).
planFirst.box.addEventListener("change", () => { syncChoices(); updateBindingNotes(); });
// Plan first's planning prompt (F99; the user, 11 November 2026: "I would like that to be printed in line so I can inspect it"), shown
// under the form while Plan first is ticked: the host's text (docs/orchestrator/PLANNER.md, its paths filled, src/extension.ts
// plannerPrompt) with the task as typed in place of {{task}}, which is what the card is sent.
const PLAN_PROMPT_TIP = "What a Plan first card is sent: this text with your task in it. A plan of two or more steps goes to workflows/ as a file, so Run a plan… lists it.";
const planPromptBox = el("textarea", { readOnly: true, rows: 12, ariaLabel: "Planning prompt" });
const planPromptView = el("details", { className: "plan-prompt", hidden: true, open: true }, el("summary", { textContent: "Planning prompt", title: PLAN_PROMPT_TIP }), planPromptBox);
function syncPlanPrompt() {
  const template = isCodex(accountBox.value) ? state.planningPromptCodex : state.planningPrompt;
  const on = planFirst.box.checked && !planFirst.box.disabled && !orchestrator.box.checked && typeof template === "string";
  planPromptView.hidden = !on;
  if (!on) return;
  const text = template.split("{{task}}").join(promptBox.value.trim());
  if (planPromptBox.value !== text) { planPromptBox.value = text; planPromptBox.rows = Math.min(24, text.split("\n").length + 2); }
}
// Card terminal (F89): the Claude or Codex session runs in a terminal on its card. Its parent cards can read it and type in it, and are
// told when you type there. Grok and Antigravity always run there, so the box is ticked and greyed for them.
const CARD_TERMINAL_TIP = "Run this task in a terminal inside its card instead of a VS Code terminal or the Claude panel. Its parent card (and theirs) can read that terminal and type into it, and is told when you type there.";
const cardTerminal = toggle("cardTerminal", "Card terminal", CARD_TERMINAL_TIP);
// Capability profile (phase 2, src/profiles.ts): shown only once a profile file exists. Provider defaults is its own explicit choice; a
// profile is pinned when the card is added, and its line says why Start refuses it on the chosen account (no strict route is enabled yet).
const profileBox = choose("Capability profile for new task", []);
const profileNote = el("p", { className: "muted profile-note", role: "status" });
// The whole lists a Blocked line cuts to a few names (F110 finding F2: one Claude account's line was 3,000 characters).
const profileListBody = el("div", { className: "muted" });
const profileLists = el("details", { className: "profile-lists", hidden: true }, el("summary", { textContent: "Show all" }), profileListBody);
const shownProfile = () => profileBox.value ? { ref: profileBox.value, revision: state.profiles?.entries.find((e) => e.ref === profileBox.value)?.revision } : undefined;
function syncProfiles() {
  const p = state.profiles;
  if (snapshotReady && draftProfile && draftProfile.ref !== "provider-defaults" &&
      !p?.entries.some((e) => e.ref === draftProfile.ref && e.revision === draftProfile.revision)) draftProfile = null;
  profileBox.hidden = !p && draftProfile === undefined;
  profileNote.hidden = !p || draftProfile === null;
  profileLists.hidden = true;
  if (profileBox.hidden) return;
  const choices = [["provider-defaults", "Provider defaults"], ...(p?.entries || []).map((e) => [e.ref, `${e.name} (${e.scope}) r${e.revision}`])];
  if (draftProfile === null) choices.unshift(["", "Choose a capability profile"]);
  setChoices(profileBox, choices, "provider-defaults");
  if (draftProfile !== undefined) profileBox.value = profileBox.dataset.want = draftProfile?.ref || "";
  if (profileNote.hidden) return;
  const e = p.entries.find((x) => x.ref === profileBox.value), why = e?.blocked?.[accountBox.value], lists = (why && e.lists?.[accountBox.value]) || [];
  // The full choice in the mouse-over and at the start of the line: a 180 px side bar cuts the menu to "Docs reader (w…" (F110 finding F3).
  profileBox.title = profileBox.selectedOptions[0]?.textContent || "Capability profile for new task";
  profileNote.textContent = [e ? (why ? `Blocked: ${e.name} r${e.revision}: ${why}` : `${e.name} r${e.revision} runs with exactly its manifest.`)
    : "Capabilities: Provider defaults (the account's own MCP servers, skills and plugins, as the provider is set up).", ...p.errors].join(" ");
  profileNote.classList.toggle("asks", !!why || p.errors.length > 0);
  profileListBody.replaceChildren(...lists.map((x) => el("p", { textContent: x })));
  profileLists.hidden = !lists.length;
}
profileBox.addEventListener("change", () => {
  if (!profileBox.value) return;
  draftProfile = shownProfile(); syncProfiles(); syncDraftBlock(); saveDrafts();
});
accountBox.addEventListener("change", syncProfiles);
// The linked Asana task (src/asana-board.ts): shown only when the workspace has an Asana project. Its context goes in with the first prompt.
const asanaBox = choose("Asana task for new task", []);
let asanaGeneration;
function syncAsana() {
  const a = state.asana;
  asanaBox.hidden = state.contextSource === "obsidian" || state.contextSource === "none" || !a;
  if (asanaGeneration !== a?.generation) {
    asanaGeneration = a?.generation;
    asanaBox.value = asanaBox.dataset.want = "";
    delete asanaBox.dataset.choices;
  }
  if (!a) return;
  const open = (a.tasks || []).map((t) => [t.gid, t.name]);
  setChoices(asanaBox, [["", a.error ? "Asana: not readable" : "No Asana task"], ["new", "New Asana task"], ...open]);
  asanaBox.title = a.error || `Asana project: ${a.projectName || ""}${a.truncated ? " (only the first 500 open tasks are listed)" : ""}`;
}
asanaBox.addEventListener("change", () => { asanaBox.dataset.want = asanaBox.value; });
// The selected Obsidian folder replaces the Asana selector for new cards.
const obsidianBox = choose("Obsidian note for new task", []);
function syncObsidian() {
  const o = state.obsidian;
  obsidianBox.hidden = state.contextSource !== "obsidian" || !o;
  if (!o) return;
  obsidianBox.disabled = !!o.error;
  setChoices(obsidianBox, [["", o.error ? "Obsidian: not readable" : "No Obsidian note"], ["new", "New Obsidian note"], ...(o.notes || []).map((n) => [n, n])]);
  obsidianBox.title = o.error || `Obsidian folder: ${o.folderName || ""}${o.truncated ? " (only the first 500 notes are listed; choose a smaller folder)" : ""}`;
}
obsidianBox.addEventListener("change", () => { obsidianBox.dataset.want = obsidianBox.value; });
// At the top of the board: picks the Asana workspace, then the project (Entomatical: Choose Asana Project). Names the project once set.
const asanaButton = button("Choose context source", () => send("contextSource"), "Choose an Asana project or Obsidian folder for new cards");
const asanaBar = el("div", { className: "row asana-bar" }, asanaButton);
function paintAsanaButton() {
  const a = state.asana, o = state.obsidian;
  asanaButton.textContent = state.contextSource === "obsidian" ? (!o ? "Choose context source" : o.error ? "Obsidian: not readable" : `Obsidian: ${o.folderName || "folder"}`) : state.contextSource === "none" || !a ? "Choose context source" : a.error ? "Asana: not readable" : `Asana: ${a.projectName || "project"}`;
  asanaButton.title = (state.contextSource === "obsidian" ? o?.error : a?.error) || "Choose an Asana project or Obsidian folder for new cards";
}
// What Add task sends with `create`; Battle Royale (F105) sends the same fields with each of its messages.
const newTaskFields = () => ({ title: pendingTitle, prompt: promptBox.value, account: accountBox.value, model: modelBox.value, effort: effortBox.value, permission: permissionBox.value, profile: profileBox.hidden ? "" : profileBox.value, parentId, helpers: helperChain("new"),
  autoTitle: autoTitle.box.checked && !autoTitle.box.disabled, autoRule: autoRule.box.checked && !autoRule.box.disabled,
  titleModel: titleSplit.pick.model, titleEffort: titleSplit.pick.effort, ruleModel: ruleSplit.pick.model, ruleEffort: ruleSplit.pick.effort, mayOpen: orchestrator.box.checked && state.orchestratorEnabled !== false, planFirst: planFirst.box.checked && !planFirst.box.disabled, cardTerminal: cardTerminal.box.checked && !cardTerminal.box.disabled,
  asana: asanaBox.hidden ? "" : asanaBox.value, asanaProject: state.asana?.project, asanaGeneration: state.asana?.generation, obsidian: obsidianBox.hidden ? "" : obsidianBox.value });
/** Sends the form as `type` and clears it, as Add task always has; the box always empties; the host refuses an empty prompt and a refusal puts the text back. */
let battleSubmitted;
const pendingCreates = new Map(savedDrafts.pendingCreates || []), refusedCreates = new Map(savedDrafts.refusedCreates || []);
let latestCreate = savedDrafts.latestCreate;
// Compare the operator's draft choices. Snapshot-derived menu defaults can differ while the view loads.
const createFormKey = () => JSON.stringify([
  promptBox.value, pendingTitle, parentId, draftAccount, draftProfile,
  ...[modelBox, effortBox, permissionBox, asanaBox, obsidianBox].map((box) => box.dataset.want || ""),
  ...[autoTitle, autoRule, planFirst, orchestrator].map(({ box }) => box.checked),
  cardTerminal.box.disabled ? cardTerminal.box.dataset.was === "true" : cardTerminal.box.checked,
  titleSplit.pick, ruleSplit.pick, helperChain("new"),
]);
const submitTask = (type) => {
  if (taskButton.disabled) return;
  const fields = newTaskFields();
  const helpers = { compilation: compilations.get("new"), refinement: refinements.get("new") };
  if (type === "create") {
    fields.createId = latestCreate = newRequestId();
    fields.profileRevision = shownProfile()?.revision;
  } else {
    battleSubmitted = helpers;
    send(type, fields);
  }
  const filled = promptBox.value.trim(); promptBox.value = ""; grow(promptBox);
  if (filled) { pendingTitle = ""; parentId = ""; draftAccount = draftProfile = undefined; asanaBox.value = asanaBox.dataset.want = ""; obsidianBox.value = obsidianBox.dataset.want = ""; orchestrator.box.checked = false; clearRefinement("new"); clearCompilation("new"); }
  if (type === "create") {
    pendingCreates.set(latestCreate, { message: { type, ...fields }, ...helpers, emptyForm: createFormKey() });
    saveDrafts(); // Save the cleared composer and its pending submission together before dispatch.
    send(type, fields);
  } else if (filled) saveDrafts();
  if (filled) render();
};
const addTask = () => submitTask("create");
// Battle Royale (F105, the user, 14 November 2026): the button right after Add task, and its two-step warning in a popup inside the board.
// The host (src/extension.ts, src/arena.ts) answers battlePrepare with battleReady or battleRefused; battleWarn gives every running card its
// 30 seconds, battleCancel calls that off, and battle clears the arena and starts the contestants. The button shows only with the setting
// entomatical.battleRoyale.enabled on (state.battleRoyale: { size, clearArena }). the user, 17 November 2026: "a lot more offensive and
// aggressive and sarcastic", ten ways per text box, rotated: each opening of the popup takes the next set, and the tip moves on with it.
const BATTLE_TIPS = [
  (n) => `Attention, crawler! Press this and ${n} models fight over your one prompt at top effort, each in its own card terminal. Your wallet has been notified. It is crying.`,
  (n) => `The "I can't write a decent prompt so I'll throw ${n} models at it" button. Go on, you've earned it. Not really.`,
  (n) => `Press me, coward. ${n} models, one prompt, and not a single brain cell involved. Yours, specifically.`,
  (n) => `${n} models doing a job one could do, because you can't make a damn decision. Classic you.`,
  (n) => `For when one model ignoring your vague garbage prompt isn't enough. Now ${n} of them can ignore it at once.`,
  (n) => `Click here to set fire to ${n} models' worth of tokens. Very mature. Very adult. Very broke.`,
  (n) => `Oh, you again? Fine. ${n} models, one prompt, and your bank account as the guaranteed loser.`,
  (n) => `Side effects include ${n} times the bill and zero times the competence on your end of the keyboard.`,
  (n) => `Hire ${n} geniuses to clean up the mess you typed. They'll still blame you. Rightly.`,
  (n) => `Go ahead, press it. Nothing says "senior developer" like ${n} AIs doing your homework while you eat crisps.`,
];
const BATTLE_OPENS = [
  "WARNING, CRAWLER! Put the mouse down and step away from the button, you absolute walnut.",
  "Oh look, it's you again. Bored? Broke? Both? Let's find out.",
  "Congratulations, genius. You found the most expensive button in this whole damn extension.",
  "Hey, dumbass. Quick reality check before you set your money on fire.",
  "Wow. Couldn't pick one model, so you're hiring all of them? Peak leadership.",
  "Listen up, you magnificent waste of electricity.",
  "Ah, Battle Royale: the button for people whose prompts are too weak for one model.",
  "STOP. Read this. Yes, actually read it. I know that's hard for you.",
  "Back for more? Your bank called. It wants a restraining order.",
  "Alright, big shot. So your prompt deserves a whole damn tournament now?",
];
const BATTLE_CLOSES = [
  "Is this a good idea? No. Proceed anyway, like you always do?",
  "Any sane developer would press No. So, Yes?",
  "Your call, champ. It's always your call, and look where that got you.",
  "Press Yes if you hate money. Press No if you own one working brain cell.",
  "Go on. Make the worst decision of your afternoon.",
  "Proceed? I'm not your mother, but she'd say no too.",
  "Think it over. Ha, kidding, you never do. Proceed?",
  "Yes or No. Even you can manage two buttons.",
  "Last chance to pretend you're a responsible adult. Proceed?",
  "Do it. I dare you. Coward.",
];
// What happens, said every time whatever the insult around it: with the arena cleared, and without.
const battleFacts = (n, clear) => clear
  ? `Here is what you're about to do. One: every running card on every board in this window gets 30 seconds to save its work. Two: they're shut down and parked in Review, where you can resume them later if you can be bothered. Three: leftover agent processes are hunted down and killed. Four: ${n} absurdly expensive models get your one prompt, every permission, and nobody to stop them.`
  : `Here is what you're about to do: ${n} absurdly expensive models get your one prompt, every permission, and nobody to stop them. Your running cards are left alone, so they get to fight the newcomers for memory and rate limits too.`;
const BATTLE_SECONDS = [
  (n) => `New achievement: Money Is No Object! Oh, you must be SO rich. Your reward: the same answer, ${n} times, slightly different.`,
  (n) => `Achievement unlocked: Can't Pick A Model! ${n} answers incoming, and you'll still copy-paste the wrong one.`,
  (n) => `Bold. Stupid, but bold. ${n} models are sharpening their knives over your half-baked prompt.`,
  (n) => `You actually pressed Yes. Of course you did. ${n} times the tokens, same old you.`,
  (n) => `Fantastic. ${n} frontier models are about to read the prompt you wrote in four seconds. They're embarrassed for you.`,
  (n) => `Achievement unlocked: Climate Villain! ${n} data centres just sighed in unison.`,
  (n) => `Oh good, you're committed. To being wrong, mostly. ${n} contestants are warming up.`,
  (n) => `Brave little crawler. ${n} models enter, one answer survives, and you still won't read it properly.`,
  (n) => `Look at you, CEO of ${n} robots and still unable to name a variable.`,
  (n) => `Yes? Really? Fine. ${n} models, one prompt, and a bill you'll pretend not to see.`,
];
const BATTLE_GOS = [
  "Yes, I'm sure! Now make them fight!",
  "Yes, burn my money!",
  "Yes, I have no self-control!",
  "Yes, I'm an idiot, release them!",
  "Do it, I hate my wallet!",
  "Yes! Let the bloodbath begin!",
  "Fight, you expensive bastards!",
  "Yes, and I won't read any of it!",
  "Unleash hell (and the invoice)!",
  "Yes, I'm sure, stop judging me!",
];
let battleRound = Math.floor(Math.random() * BATTLE_TIPS.length); // where the rotation starts in this webview
const battleSize = () => state.battleRoyale?.size || 4;
const battleButton = button("Battle Royale", () => openBattle(), BATTLE_TIPS[battleRound](battleSize()));
battleButton.className = "battle-button"; // the neon look (board.css)
battleButton.hidden = true; // until the host says the setting is on
const battleNote = el("p", { role: "alert", className: "battle-note", hidden: true }); // a refused battlePrepare or battleWarn says why here
const battleText = el("p", { id: "battle-text" });
const battleCount = el("p", { className: "muted", hidden: true });
const battleWater = el("p", { className: "battle-water", hidden: true });
const battleYes = button("Yes", () => battleYesClicked());
const battleNo = button("No", () => closeBattle(true));
battleYes.className = "danger";
const battleDialog = attrs(el("div", { className: "battle-dialog", role: "dialog" }, battleText, battleCount, battleWater, el("div", { className: "row" }, battleYes, battleNo)),
  { "aria-modal": "true", "aria-labelledby": "battle-text" });
const battleOverlay = el("div", { className: "battle-overlay", hidden: true }, battleDialog);
let battleStep = 0; // 0 closed, 1 the first text, 2 after the first Yes (the cards have been warned)
let waterTimer, water = 0;
const paintWater = () => { battleWater.textContent = `Estimated water about to evaporate: ${water.toLocaleString("en-US")} litres`; };
function openBattle() {
  if (taskButton.disabled) return;
  battleNote.hidden = true; battleNote.textContent = "";
  // An empty prompt goes straight to the host, which refuses it as it refuses an empty Add task.
  if (!promptBox.value.trim()) { submitTask("battle"); return; }
  battleStep = 1;
  battleButton.classList.add("battle-armed");
  const i = battleRound % BATTLE_OPENS.length, n = battleSize(), clear = state.battleRoyale?.clearArena !== false;
  battleText.textContent = `${BATTLE_OPENS[i]} ${battleFacts(n, clear)} ${BATTLE_CLOSES[i]}`;
  battleText.dataset.round = String(i); // the second text and the last Yes come from the same set
  battleCount.hidden = battleWater.hidden = true; battleCount.textContent = "";
  battleYes.textContent = "Yes";
  battleOverlay.hidden = false;
  send("battlePrepare", newTaskFields());
  battleNo.focus();
}
function battleYesClicked() {
  if (taskButton.disabled) { closeBattle(true); return; }
  if (battleStep === 1) {
    battleStep = 2;
    send("battleWarn", newTaskFields());
    const i = Number(battleText.dataset.round);
    battleText.textContent = BATTLE_SECONDS[i](battleSize()) + (state.battleRoyale?.clearArena !== false ? " The arena is being swept while you read this." : "");
    battleYes.textContent = BATTLE_GOS[i];
    // Millions of litres, rising by silly amounts several times a second; one fixed silly number when motion is reduced.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    water = still ? 8675309 : 3000000 + Math.floor(Math.random() * 5000000);
    paintWater(); battleWater.hidden = false;
    clearInterval(waterTimer);
    if (!still) waterTimer = setInterval(() => { water += 1000 + Math.floor(Math.random() * 250000); paintWater(); }, 150);
    battleNo.focus();
    return;
  }
  closeBattle(false);
  submitTask("battle");
}
/** Closes the popup and puts the button back. `cancel`: No or Escape, which calls off the warning the first Yes sent. The prompt stays. */
function closeBattle(cancel) {
  if (!battleStep) return;
  if (cancel && battleStep === 2) send("battleCancel", newTaskFields());
  battleStep = 0;
  battleRound++; battleButton.title = BATTLE_TIPS[battleRound % BATTLE_TIPS.length](battleSize()); // the next set, the tip with it
  clearInterval(waterTimer); waterTimer = undefined;
  battleOverlay.hidden = true;
  battleButton.classList.remove("battle-armed");
  battleButton.focus();
}
document.addEventListener("keydown", (e) => {
  if (!battleStep) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBattle(true); return; }
  // Tab stays inside the popup while it is open.
  if (e.key === "Tab") {
    const keys = [battleYes, battleNo], i = keys.indexOf(document.activeElement);
    e.preventDefault(); keys[(i + (e.shiftKey ? keys.length - 1 : 1)) % keys.length].focus();
  }
}, true);
// Handlers use statement bodies: a DOM0 handler that returns false cancels the keystroke.
promptBox.onkeydown = (e) => { if (e.key === "Enter" && e.ctrlKey) addTask(); };
// All providers use the same draft. Provider and local-model choices are persisted by the host.
let dictateInto = "new";
let recording = "";
let liveText = ""; // the live transcript now at the end of the dictation box
const micTask = box => state.tasks.find(t => t.id === box.dataset.draftTarget);
const draftBox = target => target === "new" ? promptBox : document.querySelector(`textarea[data-draft-target="${target}"]`);
const micOff = _box => "";
const speechProvider = el("select", { ariaLabel: "Dictation provider", onchange: () => send("speechProvider", { provider: speechProvider.value }) });
const whisperModel = el("select", { ariaLabel: "Whisper model", onchange: () => send("speechModel", { model: whisperModel.value }) });
const whisperFolder = button("Choose Whisper folder", () => send("speechLocal"));
const parakeetTools = button("Parakeet tools", () => send("parakeetTools"));
const speechKey = button("Set speech API key", () => send("speechKey"));
const speechNote = el("div", { className: "muted" });
const syncProvider = el("select", { ariaLabel: "Provider to sync models for" }, ...[["claude", "Claude"], ["codex", "Codex"], ["grok", "Grok"], ["antigravity", "Antigravity"]].map(([value, textContent]) => el("option", { value, textContent })));
const syncRow = el("div", { className: "row" }, el("label", { textContent: "Models" }, syncProvider),
  button("Sync models", () => send("syncModels", { provider: syncProvider.value }), "Ask this provider which models it lists now and update its model list"));
const speechControls = el("details", { className: "speech-controls", ariaLabel: "Speech dictation", open: savedDrafts.speechOpen ?? false, ontoggle: saveDrafts },
  el("summary", { textContent: "Speech settings" }),
  el("div", { className: "row" }, el("label", { textContent: "Dictation" }, speechProvider), whisperFolder,
    el("label", { textContent: "Model" }, whisperModel), parakeetTools, speechKey, button("Speech settings", () => send("speechSettings"))), syncRow, speechNote);
function paintSpeechSettings() {
  const speech = state.speech || { provider: "local", providers: [{ id: "local", label: "Local Whisper" }], models: [] };
  const providerKey = JSON.stringify(speech.providers);
  if (speechProvider.dataset.options !== providerKey) {
    speechProvider.replaceChildren(...speech.providers.map(p => el("option", { value: p.id, textContent: p.label })));
    speechProvider.dataset.options = providerKey;
  }
  speechProvider.value = speech.provider;
  const parakeet = speech.provider === "parakeet", local = speech.provider === "local" || parakeet, cloud = !local;
  whisperFolder.textContent = parakeet ? "Choose Parakeet folder" : "Choose Whisper folder";
  whisperModel.setAttribute("aria-label", parakeet ? "Parakeet model" : "Whisper model");
  parakeetTools.hidden = !parakeet; parakeetTools.disabled = !!recording;
  whisperFolder.hidden = !local; whisperModel.parentElement.hidden = !local; speechKey.hidden = !cloud;
  const modelKey = JSON.stringify(speech.models);
  if (whisperModel.dataset.options !== modelKey) { whisperModel.replaceChildren(...(speech.models.length ? speech.models.map(m => el("option", { value: m.path, textContent: m.label, title: m.path })) : [el("option", { value: "", textContent: "No models found" })])); whisperModel.dataset.options = modelKey; }
  whisperModel.value = speech.modelPath || ""; whisperModel.disabled = !speech.models.length || !!recording;
  speechProvider.disabled = !!recording; whisperFolder.disabled = !!recording;
  speechNote.textContent = parakeet ? (speech.folder ? "Parakeet transcribes locally while you speak. Language is detected automatically." : "Choose the folder containing Parakeet and its models.")
    : local ? speech.folder || "Choose the folder containing Whisper and its models."
    : "Audio is sent to the selected provider when you stop recording.";
}
const paintMic = (b) => {
  const on = recording && dictateInto === b.box.dataset.draftTarget, off = micOff(b.box);
  b.textContent = on && recording !== "recording" ? "…" : on ? "Stop" : "Mic";
  b.disabled = !on && (!!off || !!recording); // one dictation at a time
  b.title = !on ? off || state.dictation || ""
    : recording === "starting" ? "Starting microphone…"
    : recording === "stopping" ? "Finishing dictation…" : "Stop and put the text here";
};
const paintMics = () => { document.querySelectorAll(".dictate button").forEach(paintMic); if (state.speech) paintSpeechSettings(); };
const mic = (box) => {
  const b = button("Mic", () => {
    if (!recording) dictateInto = box.dataset.draftTarget;
    box.focus();
    const t = micTask(box);
    send("dictate", t ? { id: t.id } : { account: accountBox.value });
  });
  b.box = box;
  paintMic(b);
  return b;
};
accountBox.addEventListener("change", paintMics);
// Text boxes grow with their content up to the CSS max-height; past that the box scrolls.
const grow = (box) => { box.style.height = "auto"; box.style.height = `${box.scrollHeight + 2}px`; };
window.addEventListener("resize", () => { for (const box of document.querySelectorAll(".dictate textarea")) grow(box); });
const withMic = (box) => { box.addEventListener("input", () => grow(box)); return el("div", { className: "dictate" }, box, mic(box)); };
const openPrompts = new Set(); // task ids whose prompt list is expanded
const showAll = new Set(); // task ids showing every prompt, not just the latest
const agentToggle = new Map(); // task id -> whether the user opened or closed its subagent list
const RECENT = 3;
// Accounts stay visible: compare limits and choose the default for new IDE sessions.
const accountList = el("div");
const accountSummary = el("summary");
const refreshAccounts = button("Refresh", () => send("accountRefresh"));
const addAccount = el("select", { ariaLabel: "Add account" },
  el("option", { value: "", textContent: "Add account" }),
  ...[["claude", "Claude"], ["codex", "Codex"], ["grok", "Grok"], ["antigravity", "Antigravity"]]
    .map(([value, textContent]) => el("option", { value, textContent, title: value === "antigravity" ? "Uses Antigravity's shared Google sign-in" : "" })),
  ...["Gemini", "Microsoft Copilot", "Perplexity", "Kimi", "Mistral", "Poe", "GitHub Copilot", "DeepSeek"]
    .map(name => el("option", { value: name, textContent: `${name} · Not supported yet`, disabled: true })));
addAccount.onchange = () => {
  const provider = addAccount.value;
  addAccount.value = "";
  if (["claude", "codex", "grok", "antigravity"].includes(provider)) send("accountAdd", provider === "claude" ? {} : { provider });
};
// Open while nothing runs, so limits can be compared and the default chosen; collapsed once a task is running, to make room for the
// cards. Where the user put it stays put (also across reloads) until they move it again; the summary line keeps the usage in view.
let accountsChoice = savedDrafts.accountsOpen; // true/false: the user's own choice; undefined: follow the board
let accountsKnownOpen = true; // what the box was last set to; the toggle event comes later, so a toggle to anything else is the user's
const accountsBox = el("details", { className: "accounts", open: true, ontoggle() {
  if (this.open === accountsKnownOpen) return;
  accountsKnownOpen = accountsChoice = this.open;
  saveDrafts();
  renderAccounts();
} }, accountSummary,
  el("p", { className: "muted", textContent: "IDE default applies to new Claude chats in all VS Code windows. Existing sessions keep their accounts. Codex accounts are picked per task." }),
  el("p", { className: "muted", textContent: "Grok and Antigravity rows show what their CLIs record on this computer. Neither reports plan limits." }), accountList,
  el("div", { className: "row" }, addAccount, refreshAccounts, "Refresh sign-ins and usage. Usage also updates after sign-in."));
let switchingAccount;
const loginOpen = new Set();

// Model efficiency (F93): finished cards by main model, from the same token counts the cards show. Closed until opened; stays as left.
const modelsBody = el("div", { className: "model-scroll" });
const modelsBox = el("details", { className: "accounts models", open: !!savedDrafts.modelsOpen, ontoggle() { savedDrafts.modelsOpen = this.open; saveDrafts(); } },
  el("summary", { textContent: "Model efficiency" }),
  el("p", { className: "muted", textContent: "Cards in Done, except discarded ones, grouped by the model that used most of each card's tokens (Antigravity: the card's chosen model, as its files do not name one). Medians per card, as each CLI reports them. Cards removed from the board are not counted." }),
  modelsBody);
function renderModels() {
  const rows = state.modelEfficiency || [];
  const provider = (p) => ({ claude: "Claude", codex: "Codex", grok: "Grok", antigravity: "Antigravity" })[p] || p;
  const short = (v) => v === undefined ? "–" : tokensShort(v);
  const cell = (v) => el("td", { textContent: short(v) });
  // Each model's name heads its own row above its five numbers: six columns did not fit the sidebar (linux dev host, 6 November 2026).
  modelsBody.replaceChildren(rows.length ? el("table", { className: "model-table" },
    el("thead", {}, el("tr", {}, el("th", { colSpan: 5, textContent: "Model" })),
      el("tr", {}, ...["Done", "Measured", "Tokens", "Without cache reads", "Output"].map((h) => el("th", { textContent: h })))),
    ...rows.map((r) => el("tbody", {},
      el("tr", {}, el("th", { colSpan: 5, scope: "rowgroup" }, el("span", { className: `provider ${r.provider}`, textContent: provider(r.provider) }), ` · ${r.model}`)),
      el("tr", {},
        el("td", { textContent: String(r.finished) }),
        el("td", { textContent: r.partial ? `${r.measured} (${r.partial} partial)` : String(r.measured) }),
        cell(r.medianTotal), cell(r.medianFresh), cell(r.medianOutput)),
      // F106: tokens per passed task, as one line across the five columns (no sixth column: see above).
      el("tr", { className: r.fewCards ? "model-outcome model-few" : "model-outcome" },
        el("td", { colSpan: 5, className: "muted",
          textContent: `${r.passed ?? 0}/${r.attempts ?? 0} passed · ${short(r.perPassed)} per passed task · follow-ups ${r.medianFollowUps ?? "–"}`,
          title: `Passed: acceptance checks passed, or Review said done. ${r.failed ?? 0} failed (discarded, or checks failed), ${r.unverified ?? 0} unverified. Per passed task: all tokens of these cards, failed ones included, divided by the passed ones; ${short(r.freshPerPassed)} without cache reads.${r.fewCards ? " Too few cards to compare (under 5 measured)." : ""}` })))))
    : el("p", { className: "muted", textContent: "No cards in Done yet." }));
}

// A provider's own windows (Codex) are labelled by the length it reports, so a plan without a 5-hour limit never shows one.
// Codex Plus has 5-hour and weekly windows, Pro weekly only (OpenAI pricing and help pages, read 29 Oct 2026; see src/codex.ts).
const windowLabel = (m) => m === 300 ? "5-hour limit" : m === 7 * 1440 ? "Weekly limit" : m < 1440 ? `${m / 60}-hour limit` : `${m / 1440}-day limit`;
const fmtPts = (n) => (Math.round(n * 10) / 10).toString(); // whole points, one decimal when the move was small
function accountWindows(u, plan) {
  if (u?.windows) return u.windows.map((w) => [w.minutes, { at: u.at, w: w.pct, wResets: w.resets }, "w"]);
  const windows = [];
  if (fiveHourShown(plan, u)) windows.push([300, u, "fiveHour"]);
  windows.push([7 * 1440, u, "week"]);
  return windows;
}
// tail: the reading's age, on the same line as the last window's reset (the user, 3 November 2026); tip says how it updates.
function quota(label, u, key, tail = "", tip = "") {
  const q = usageWindow(u, key, Date.now(), state.hostTimezone, state.hostTimeOffsets);
  const meter = q.value === undefined ? null : el("meter", { min: 0, max: 100, low: 80, high: 95, optimum: 0, value: q.value });
  if (meter) meter.setAttribute("aria-label", `${label}: ${q.text}`);
  return el("div", { className: `quota ${q.tone}` },
    el("div", { className: "quota-label" }, el("span", { textContent: label }), el("span", { textContent: q.text })),
    meter, el("div", { className: "muted usage-age", textContent: [q.reset, tail].filter(Boolean).join(" · "), title: tip }));
}

/** Token counts as 950, 12.3k, 4.5M (F93). */
function tokensShort(x) { return x >= 999_950 ? `${Math.round(x / 1e5) / 10}M` : x >= 1000 ? `${Math.round(x / 100) / 10}k` : String(Math.round(x)); }
function renderAccounts() {
  const focused = accountList.contains(document.activeElement) ? document.activeElement : undefined;
  const focusKey = focused?.dataset.focusKey;
  const rows = state.accountRows || [];
  refreshAccounts.disabled = rows.some((r) => r.usageRefreshing);
  refreshAccounts.textContent = refreshAccounts.disabled ? "Refreshing…" : "Refresh";
  const active = rows.find((r) => r.active);
  const busy = state.tasks.some((t) => t.status === "running" || t.status === "needs-input");
  const want = accountsChoice ?? !busy;
  if (accountsBox.open !== want) accountsBox.open = accountsKnownOpen = want;
  // Collapsed, the summary still shows each signed-in account's usage, the one thing needed while tasks run.
  const chip = (r) => {
    if (r.provider === "grok" || r.provider === "antigravity") // F93: no plan limits from either CLI, so the chip shows the day's tokens
      return el("span", { className: "usage-chip", textContent: `${r.email || r.folder}: 24 h ${tokensShort(r.recent?.day || 0)} tokens`,
        title: r.provider === "grok" ? "Grok" : "Antigravity: conversations active in the last 24 hours" });
    const parts = accountWindows(r.usage, r.plan).flatMap(([minutes, reading, key]) => {
      const { value } = usageWindow(reading, key);
      return value === undefined ? [] : [`${windowShort(minutes)} ${Math.round(value)}%`];
    }).join(" · ");
    return el("span", { className: "usage-chip", textContent: `${r.email || r.folder}: ${parts || "usage not reported"}`, title: r.provider === "codex" ? "Codex" : "Claude" });
  };
  accountSummary.replaceChildren(`Accounts · Claude IDE default: ${active?.email || "none selected"}`,
    ...(accountsBox.open ? [] : rows.filter((r) => r.loggedIn).map(chip)));
  accountList.replaceChildren(...rows.map((r) => {
    if (r.provider === "grok" || r.provider === "antigravity") {
      const grok = r.provider === "grok", name = grok ? "Grok" : "Antigravity";
      const act = (label, type, title) => {
        const b = button(label, () => send(type, { configDir: r.configDir, provider: r.provider }), title);
        b.dataset.focusKey = "provider-" + r.provider + ":" + r.configDir + ":" + type;
        return b;
      };
      // F93: the email from the CLI's own sign-in record (Grok's auth.json, agy's log), and the tokens its sessions used on this computer.
      const rc = r.recent, signed = r.loggedIn ? (r.email || "Signed in") : "Not signed in";
      const where = grok ? `Profile ${r.folder}` : `Shared Google sign-in${r.seenAt ? ` · from Antigravity's log written ${stamp(r.seenAt)}` : ""}`;
      return el("div", { className: "account" },
        el("div", { className: "account-who" }, el("span", { className: "provider", textContent: name }), ` · ${signed}`),
        el("div", { className: "muted", textContent: where }),
        rc ? el("div", { className: "usage", textContent: grok
          ? `This computer: 24 h ${tokensShort(rc.day)} tokens (${tokensShort(rc.dayOutput)} output) · 7 days ${tokensShort(rc.week)} (${tokensShort(rc.weekOutput)} output)`
          : `This computer, conversations active in the last 24 h: ${tokensShort(rc.day)} tokens (${tokensShort(rc.dayOutput)} output) · 7 days ${tokensShort(rc.week)} (${tokensShort(rc.weekOutput)} output)`,
          title: grok ? "Every Grok session of this profile on this computer, from its usage.json, by each turn's end. Grok reports no plan limits."
            : "Each Antigravity conversation's whole total, counted when it last changed: Antigravity records no time per call. Antigravity reports no plan limits." }) : null,
        el("div", { className: "row" }, act(r.loggedIn ? "Sign in again" : "Sign in", "accountLogin"), act(`Open ${name}`, "accountOpen"),
          !grok || r.removable ? act(grok ? "Remove" : "Hide", "accountRemove", grok ? "Move this profile and its history to the trash" : "Hide this row without changing the Google sign-in") : null));
    }
    const codex = r.provider === "codex";
    // The provider name gets its own colour (Claude orange, Codex blue); the rest of the line turns blue on the active account.
    const who = el("div", { className: "account-who" }, el("span", { className: `provider ${codex ? "codex" : "claude"}`, textContent: codex ? "Codex" : "Claude" }),
      ` · ${r.loggedIn ? `${r.email || r.folder}${r.plan ? ` · ${r.plan}` : ""}` : "Not signed in"}`);
    const u = r.usage;
    const mins = u ? Math.max(0, Math.floor((Date.now() - u.at) / 60000)) : 0;
    // One line under the meters: the last window's reset, then how old the reading is. How it updates moves to the tooltip.
    const age = u ? `reported ${mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`}${mins >= 15 ? " · stale reading" : ""}` : "";
    const tip = u ? `${stamp(u.at)}. ${codex ? "Codex usage updates on Refresh and when the board opens." : "Updates when Claude reports usage."}` : "";
    const windows = accountWindows(u, r.plan);
    const notes = [
      !r.loggedIn && `Folder: ${r.folder}`,
      r.expected && `Meant for ${r.expected}. Log in again to fix.`,
      r.sameAs && `Same login as folder ${r.sameAs}; these folders share a quota.`,
    ].filter(Boolean);
    const id = `${r.provider}:${r.configDir}`; // both providers have a main folder ""
    const act = (label, type, title) => {
      const b = button(label, () => send(type, { configDir: r.configDir, provider: r.provider }), title);
      b.dataset.focusKey = `${r.configDir}:${type}`;
      return b;
    };
    const use = act(switchingAccount === r.configDir ? "Switching…" : r.active ? "IDE default" : "Use in IDE", "accountUse", "Choose the default for new Claude chats and board tasks");
    use.disabled = switchingAccount !== undefined || r.active || !r.loggedIn || !!r.expected;
    use.onclick = () => { switchingAccount = r.configDir; renderAccounts(); send("accountUse", { configDir: r.configDir }); };
    // ⚙ opens the account's settings on the web. The browser shows whichever account it is signed into, so the tooltip names this one.
    const site = r.provider === "codex" ? "chatgpt.com" : "claude.ai";
    const settings = r.loggedIn ? act("⚙", "accountSettings", `Open settings on ${site}${r.email ? ` for ${r.email}` : ""}. Your browser shows the account it is signed into.`) : null;
    if (settings) settings.ariaLabel = `Account settings on ${site}`;
    const login = el("details", { className: "account-login", open: loginOpen.has(r.configDir) }, el("summary", { textContent: "Manage login" }),
      el("div", { className: "row" }, settings, act(r.loggedIn ? "Sign in again" : "Log in", "accountLogin"), r.loggedIn ? act("Log out", "accountLogout") : null,
        r.configDir && !r.provider && !r.active ? act("Remove", "accountRemove", "Move this account folder to the trash") : null)); // not ~/.claude, Codex or the IDE default
    login.ontoggle = () => { if (login.open) loginOpen.add(r.configDir); else loginOpen.delete(r.configDir); };
    login.firstChild.dataset.focusKey = `${r.configDir}:manage`;
    const quotas = windows.map(([minutes, reading, key], i) =>
      quota(windowLabel(minutes), reading, key, i === windows.length - 1 ? age : "", tip));
    const status = quotas.at(-1)?.querySelector(".usage-age")
      || el("div", { className: "muted usage-age", textContent: "Usage not available yet. Select Refresh to request it." });
    // Keep the disclosure beside the final reset/age, without a separate empty controls row.
    const statusText = el("span", { textContent: u ? status.textContent : "Usage not available yet. Select Refresh to request it." });
    status.replaceChildren(statusText, login);
    status.classList.add("account-status");
    return el("div", { className: "account" + (r.active ? " active" : "") },
      who,
      el("div", { className: "usage" }, ...quotas, quotas.length ? null : status),
      r.usageRefreshing ? el("div", { className: "muted", role: "status", textContent: "Refreshing usage…" }) : null,
      r.usageError ? el("div", { className: "muted", role: "status", textContent: r.usageError }) : null,
      notes.length ? el("div", { className: "muted", textContent: notes.join(" · ") }) : null,
      r.provider === "codex" ? null : el("div", { className: "row" }, use)); // the IDE default is Claude Code's setting
  }));
  if (focusKey !== undefined) [...accountList.querySelectorAll("[data-focus-key]")].find((e) => e.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
}
// The board posts only when a task or session changes, so an idle board would show "just now" forever. Redraw each minute.
setInterval(renderAccounts, 60_000);

const refinements = new Map((savedDrafts.refinements || []).map(([id, { deep, ...r }]) => [id, !r.pending ? r
  // A "Use answers" round interrupted by a reload gives its questions and typed answers back (F59-6 in session 3482f4's review).
  : r.previous ? { ...r.previous, notice: "Refinement interrupted. Your answers are kept; send them again." }
  : { ...r, pending: false, error: "Refinement interrupted. Your draft is preserved; try again." }]));
// target -> compile state. A compilation never edits the task box until the user applies it; the box text is always authoritative.
const compilations = new Map((savedDrafts.compilations || []).map(([id, { deep, ...c }]) => [id, c.pending ? { ...c, pending: false,
  error: c.kind === "review" ? "Review interrupted. Your draft is preserved; try again." : "Improvement interrupted. Your draft is preserved; try again." } : c]));
// Review prompt is an experimental command since 4 November 2026 (Entomatical: Review Prompt (Experimental)); the old tickbox state is ignored.
promptBox.value = savedDrafts.prompt || "";
pendingTitle = typeof savedDrafts.title === "string" ? savedDrafts.title : "";
modelBox.dataset.want = savedDrafts.model || "";
effortBox.dataset.want = savedDrafts.effort || "";
permissionBox.dataset.want = savedDrafts.permission || "";
syncChoices();
promptBox.dataset.draftTarget = "new";
// Right-click in the box: Entomatical: Review Prompt (Experimental) runs on it (package.json webview/context, section "draft").
promptBox.setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "draft", draftTarget: "new", preventDefaultContextMenuItems: false }));
promptBox.addEventListener("input", () => { saveDrafts(); updateBindingNotes(); });
function saveDrafts() {
  syncPlanPrompt();
  paintRefusedCreates();
  const prompt = selectedPlan ? selectedPlan.draft : promptBox.value;
  if (snapshotReady && prompt.trim()) {
    if (draftAccount === undefined && accountBox.value) draftAccount = accountBox.value;
    if (draftProfile === undefined && !profileBox.hidden) draftProfile = shownProfile();
  }
  vscode.setState?.({
    prompt, title: pendingTitle, parentId, account: draftAccount, profile: draftProfile,
    planSetupOpen: !!selectedPlan,
    model: selectedPlan ? selectedPlan.model : modelBox.dataset.want,
    effort: selectedPlan ? selectedPlan.effort : effortBox.dataset.want,
    permission: selectedPlan ? selectedPlan.permission : permissionBox.dataset.want,
    accountsOpen: accountsChoice, speechOpen: speechControls.open, modelsOpen: savedDrafts.modelsOpen,
    autoTitle: autoTitle.box.checked, autoRule: autoRule.box.checked, titlePick: { ...titleSplit.pick }, rulePick: { ...ruleSplit.pick },
    planFirst: selectedPlan ? selectedPlan.planFirst : planFirst.box.checked,
    cardTerminal: selectedPlan ? selectedPlan.cardTerminal : cardTerminal.box.disabled ? cardTerminal.box.dataset.was === "true" : cardTerminal.box.checked,
    pendingCreates: [...pendingCreates], latestCreate: pendingCreates.size ? latestCreate : undefined, refusedCreates: [...refusedCreates],
    followUps: [...drafts], recoverFollowUps: [...bounced, ...pendingSends.keys()], refinements: [...refinements], compilations: [...compilations],
  });
}
for (const box of [modelBox, effortBox, permissionBox]) box.addEventListener("change", () => { box.dataset.want = box.value; });
permissionBox.addEventListener("change", () => { saveDrafts(); updateBindingNotes(); });
accountBox.addEventListener("change", () => {
  if (!accountBox.value) return;
  const replacing = draftAccount === null;
  draftAccount = accountBox.value;
  if (replacing) render();
});
for (const box of [accountBox, modelBox, effortBox]) box.addEventListener("change", () => { syncChoices(); saveDrafts(); updateRefinementControls(); updateBindingNotes(); });
// the user, 4 November 2026 (Q2): Refine draft and Improve prompt always use the most capable model at its highest effort; the account picks
// Claude, Codex, Grok or Antigravity. The model and effort menus are for the task only. The host says which model that is (state.helperModels).
// A Grok or Antigravity account's helpers run on that same account through its agent (one headless ACP prompt). It has no fixed
// most-capable model, so they use the agent's default model (orchestrator run 0db6d1).
function refinementSelection() {
  return { account: accountBox.value, model: modelBox.value, effort: effortBox.value };
}
const helperModel = (account) => externalProvider(account) ? "the agent's default model" : (isCodex(account) ? state.helperModels?.codex : state.helperModels?.claude || "fable · max effort");
// F102 (the user, 13 November 2026): every button that calls a helper model opens, on right-click, one menu in the split buttons' look
// (.split-menu) of the provider (a signed-in account), model, effort and, for Finish, permission mode that action runs on. A pick applies
// at once and is that action's default from now on: the host keeps it (src/action-picks.ts, globalState) and applies it only on the
// provider it was picked for. The button's mouse-over names a pick; Reset to default clears it. preventDefault and stopPropagation keep
// VS Code's own card menu (data-vscode-context) off these buttons only.
const PICK_HINT = "Right-click to pick another provider, model or effort.";
const FINISH_PICK_HINT = "Right-click to pick another model, effort or permission mode.";
const FINISH_PROVIDER = "Finish runs on the card's Claude account, which holds its conversation.";
const NO_PERMISSIONS = "This helper runs without tools, so it has no permission mode.";
const providerOf = (account) => isCodex(account) ? "codex" : externalProvider(account) || "claude";
const actionPick = (action) => state.actionPicks?.[action] || {};
/** The account an action runs on: its pick's while that account is on the board, else its own (the form's, or the card's). */
const pickedAccount = (action, own) => { const a = actionPick(action).account; return action !== "finish" && a && state.accounts.includes(a) ? a : own; };
/** The pick's model and effort when they were picked for this provider (the host applies them only then), else undefined. */
const pickedModel = (action, provider) => { const p = actionPick(action); return p.provider === provider && (p.model || p.effort) ? p : undefined; };
const pickModels = (provider, account) => provider === "claude" ? HELPER_MODELS.map(([m]) => [m, helperName(m)]) : provider === "codex" ? (state.codex?.short || []).map((n) => [n.name, n.label]) : acpCatalog(account)?.newest || acpCatalog(account)?.models || [];
function pickEfforts(provider, account, model) {
  if (provider === "claude") return CLAUDE_EFFORTS.map((e) => [e, e]);
  if (provider === "codex") return (model ? codexModel(codexShort(model)?.id || model)?.efforts || [] : [...new Set((state.codex?.models || []).flatMap((m) => m.efforts))]).map((e) => [e, e]);
  return acpCatalog(account)?.efforts || [];
}
/** What a pick changes, for the button's mouse-over: its account, model and effort, permission mode. Empty when nothing applies. */
function pickWords(action, own) {
  const pick = actionPick(action), account = pickedAccount(action, own), p = pickedModel(action, providerOf(account));
  const model = p?.model && (pickModels(providerOf(account), account).find(([v]) => v === p.model)?.[1] || p.model);
  return [account !== own ? account : "", [model, p?.effort ? `${p.effort} effort` : ""].filter(Boolean).join(" · "),
    pick.permission ? PERMISSION_CHOICES.find(([v]) => v === pick.permission)?.[1] : ""].filter(Boolean).join(" · ");
}
const pickHint = (action, own) => { const words = pickWords(action, own); return words ? `Your pick: ${words}. Right-click to change it.` : action === "finish" ? FINISH_PICK_HINT : PICK_HINT; };
/** Refine draft's or Improve prompt's model and account for the line under them: the pick's, else the maximum policy (helperModel). */
function helperUses(action, own) {
  const account = pickedAccount(action, own), provider = providerOf(account), p = pickedModel(action, provider);
  const words = !p ? helperModel(account) : provider === "claude" ? `${helperName(p.model || "fable")} · ${p.effort || "max"} effort`
    : provider === "codex" ? `${codexShort(p.model || "astra")?.label || p.model || "astra"} · ${p.effort || "highest"} effort` : [p.model || "the agent's default model", p.effort ? `${p.effort} effort` : ""].filter(Boolean).join(" · ");
  return { words: words || "no model listed", account };
}
const actionMenu = attrs(el("div", { className: "split-menu action-menu", hidden: true }), { role: "menu" });
document.body.append(actionMenu);
let menuFor; // { action, anchor, own }: the button the menu was opened on
function drawActionMenu() {
  const { action, own } = menuFor, pick = actionPick(action);
  const account = pickedAccount(action, own), provider = providerOf(account), p = pickedModel(action, provider) || {};
  const set = (next) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    if (!clean.model && !clean.effort) delete clean.provider;
    state.actionPicks = { ...(state.actionPicks || {}) };
    if (Object.keys(clean).length) state.actionPicks[action] = clean; else delete state.actionPicks[action];
    send("setActionPick", { action, pick: clean });
    drawActionMenu(); render(); updateRefinementControls();
  };
  const item = (group, value, label, checked, onclick) => attrs(el("button", { type: "button", textContent: label, onclick }), { role: "menuitemradio", "data-group": group, "data-value": value, "aria-checked": String(checked) });
  const group = (label, items, note) => attrs(el("div", { className: "split-group" }, el("span", { textContent: label }), ...items,
    note ? el("span", { className: "split-note", textContent: note }) : null), { role: "group", "aria-label": label });
  const onAccount = (value) => {
    const next = { ...pick, account: value };
    // A model and effort picked for another provider do not carry over to this account's.
    if (pick.provider && providerOf(value || own) !== pick.provider) Object.assign(next, { provider: "", model: "", effort: "" });
    set(next);
  };
  const models = pickModels(provider, account), efforts = pickEfforts(provider, account, p.model);
  const onModel = (value) => {
    const fits = !p.effort || pickEfforts(provider, account, value).some(([e]) => e === p.effort);
    set({ ...pick, provider, model: value, effort: fits ? p.effort : "" });
  };
  const none = provider === "claude" || provider === "codex" ? undefined : `${ACP_NAMES[provider]} lists no models until a session of this account has opened.`;
  actionMenu.setAttribute("aria-label", `Provider, model and effort for ${ACTION_NAMES[action]}`);
  actionMenu.replaceChildren(
    action === "finish" ? group("Provider", [], FINISH_PROVIDER)
      : group("Provider", [item("account", "", action === "review" ? "Card's account" : "Selected account", account === own, () => onAccount("")),
        ...state.accounts.map((a) => item("account", a, a, !!pick.account && account === a, () => onAccount(a)))]),
    group("Model", [item("model", "", "Default", !p.model, () => onModel("")), ...models.map(([v, label]) => item("model", v, label, p.model === v, () => onModel(v)))], models.length ? undefined : none),
    group("Effort", [item("effort", "", "Default", !p.effort, () => set({ ...pick, provider, model: p.model, effort: "" })),
      ...efforts.map(([v, label]) => item("effort", v, label, p.effort === v, () => set({ ...pick, provider, model: p.model, effort: v })))]),
    action === "finish" ? group("Permissions", PERMISSION_CHOICES.filter(([v]) => v !== "ask").map(([v, label]) => item("permission", v, label, (pick.permission || "edits") === v, () => set({ ...pick, permission: v === "edits" ? "" : v }))))
      : group("Permissions", [], NO_PERMISSIONS),
    attrs(el("button", { type: "button", textContent: "Reset to default", disabled: !Object.keys(pick).length, onclick: () => set({}) }), { role: "menuitem" }));
}
const ACTION_NAMES = { refine: "Refine draft", improve: "Improve prompt", review: "Review", finish: "Finish" };
function openActionMenu(action, anchor, own, x, y) {
  titleSplit.shut(false); ruleSplit.shut(false);
  menuFor = { action, anchor, own };
  drawActionMenu();
  actionMenu.hidden = false;
  // At the pointer, moved back inside the panel where it would pass its right or bottom edge.
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  actionMenu.style.maxWidth = `${Math.min(vw - 16, 420)}px`; actionMenu.style.left = "0px"; actionMenu.style.top = "0px";
  const r = actionMenu.getBoundingClientRect();
  actionMenu.style.left = `${Math.max(8, Math.min(x, vw - 8 - r.width))}px`;
  actionMenu.style.top = `${Math.max(8, y + r.height > vh - 8 ? y - r.height : y)}px`;
  actionMenu.querySelector('[aria-checked="true"]')?.focus();
}
const shutActionMenu = (focus) => { if (actionMenu.hidden) return; actionMenu.hidden = true; if (focus && menuFor?.anchor.isConnected) menuFor.anchor.focus(); };
// The path is taken at dispatch, so a pick (which redraws the menu and detaches the clicked item) does not count as a click outside.
document.addEventListener("click", (e) => { if (!e.composedPath().includes(actionMenu)) shutActionMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !actionMenu.hidden) { e.preventDefault(); shutActionMenu(true); } });
/** Makes a helper button right-clickable into the menu, and puts the current pick on its mouse-over. own: the account it runs on unpicked. */
function pickable(b, action, own, tip) {
  b.title = `${tip} ${pickHint(action, own())}`;
  b.dataset.pickAction = action; b.dataset.tip = tip;
  b.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openActionMenu(action, b, own(), e.clientX, e.clientY); });
  return b;
}
/** Refine draft and Improve prompt as split buttons like Title and Done When (the user, 14 November 2026): ▾ opens the same menu as a right-click, under it. */
function withArrow(b, action, own) {
  const arrow = attrs(el("button", { type: "button", className: "split-arrow", textContent: "▾", ariaLabel: `Provider, model and effort for ${ACTION_NAMES[action]}`, title: `Provider, model and effort for ${ACTION_NAMES[action]}` }), { "aria-haspopup": "menu" });
  arrow.onclick = (e) => {
    e.stopPropagation(); // the document's click listener would take this click for one outside the menu
    if (!actionMenu.hidden && menuFor?.anchor === arrow) return shutActionMenu(false);
    const r = arrow.getBoundingClientRect();
    openActionMenu(action, arrow, own(), r.left, r.bottom + 2);
  };
  return el("span", { className: "split" }, b, arrow);
}
function validRefinementSelection(s, action = "refine") {
  const account = s && pickedAccount(action, s.account);
  return !!(s && s.account && state.accounts.includes(s.account) && (helperModel(account) || pickedModel(action, providerOf(account))?.model));
}
function updateRefinementControl(controls) {
  const r = refinements.get(controls.dataset.refineTarget), c = compilations.get(controls.dataset.refineTarget);
  const selection = refinementSelection(), ok = validRefinementSelection(selection), okImprove = validRefinementSelection(selection, "improve");
  controls.querySelector('[data-refine-start]').disabled = !!r?.pending || !ok;
  // A refinement running in its tab no longer holds Improve back (the user, 4 November 2026: the board stays usable meanwhile).
  controls.querySelector('[data-compile-start]').disabled = !!c?.pending || !okImprove;
  // F102: each one's pick is on its mouse-over and in this line; one line when both run on the same model and account.
  const refine = helperUses("refine", selection.account), improve = helperUses("improve", selection.account);
  controls.querySelector('[data-refine-selection]').textContent = !ok && !okImprove ? (selection.account && isCodex(selection.account) ? "The Codex CLI lists no Astra model, so Refine and Improve cannot run on Codex." : "Select an account above.")
    : refine.words === improve.words && refine.account === improve.account ? `Uses ${refine.words} · ${refine.account}`
    : `Refine draft uses ${refine.words} · ${refine.account}; Improve prompt uses ${improve.words} · ${improve.account}`;
  for (const b of controls.querySelectorAll('[data-pick-action]')) b.title = `${b.dataset.tip} ${pickHint(b.dataset.pickAction, selection.account)}`;
  for (const b of controls.querySelectorAll('[data-refine-answers]')) b.disabled = !validRefinementSelection(r?.selection, b.dataset.pickAction);
}
function updateRefinementControls() {
  for (const controls of document.querySelectorAll('[data-refine-target]')) updateRefinementControl(controls);
}
function draftValue(target) { return target === "new" ? promptBox.value : drafts.get(target) || ""; }
function clearRefinement(target) {
  const r = refinements.get(target);
  if (r?.pending) send("cancelHelper", { requestId: r.requestId });
  refinements.delete(target);
  if (target === "new") refreshRefinement(target);
}
function refreshRefinement(target) {
  if (target === "new") newRefinement.replaceChildren(refinementControls("new")); else render();
}
function setDraft(target, value) {
  if (target === "new") { promptBox.value = value; grow(promptBox); } else drafts.set(target, value);
  saveDrafts(); refreshRefinement(target);
}
const newRequestId = () => Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
/** The user's Apply, Keep or Restore on a finished proposal, for its receipt (item 1.3). */
const decide = (requestId, action) => { if (requestId) send("helperDecision", { requestId, action }); };
/** Clarification answers as sent: each question with its box's text; an empty or spaces-only box is unanswered (F59-7). */
const answerText = (r, boxes) => r.questions.map((q, i) => `${q.question}\n${boxes[i].value.trim() || "Unanswered; preserve ambiguity."}`).join("\n\n");
function requestRefinement(target, answers = "", boxes) {
  const prev = refinements.get(target);
  const original = answers ? prev.original : draftValue(target);
  const selection = answers ? prev.selection : refinementSelection();
  if (!original.trim() || !validRefinementSelection(selection)) return;
  const requestId = newRequestId();
  // A "Use answers" round keeps the questions and the typed answers, so a failure or cancel gives them back (F59-6).
  const previous = answers && prev?.kind === "questions" ? { ...prev, answerDrafts: boxes ? boxes.map((b) => b.value) : prev.answerDrafts, notice: undefined } : undefined;
  refinements.set(target, { requestId, original, pending: true, answers, answersFor: answers ? original : undefined, selection, previous }); saveDrafts(); refreshRefinement(target);
  send("refine", { requestId, id: target === "new" ? undefined : target, ...selection, draft: original, answers });
}
function refinementControls(target) {
  const controls = refinementSection(target);
  controls.append(...compilationView(target));
  return controls;
}
/** Opens the proposal next to the text it would replace in VS Code's diff editor (item 2.5). */
const showChanges = (before, after, title) => button("Show changes", () => send("showDiff", { before, after, title }), "Compare the proposal with your draft in VS Code's diff editor");
const REFINE_TIP = "Use project context to clarify this draft only where it needs it, on the most capable model at its highest effort for the selected account's provider. May ask up to three questions or leave a clear draft unchanged. Runs in its own editor tab beside the board, which stays usable meanwhile. Review before applying. Uses account usage.";
const IMPROVE_TIP = "For a long draft or one with pasted material: turn it into a structured execution prompt, on the most capable model at its highest effort. Obligations the model assumed are held back and listed. Flags unresolved contradictions. Review before applying. Uses account usage.";
const IMPROVE_WITH_TIP = "Send this draft and the answers shown, suggested ones included, straight to Improve prompt";
const USE_ANSWERS_TIP = "Refine the draft again with the answers shown, suggested ones included";
function refinementSection(target) {
  const r = refinements.get(target);
  const start = pickable(button("Refine draft", () => requestRefinement(target)), "refine", () => accountBox.value, REFINE_TIP);
  start.dataset.refineStart = "";
  const compile = pickable(button("Improve prompt", () => requestCompilation(target)), "improve", () => accountBox.value, IMPROVE_TIP);
  compile.dataset.compileStart = "";
  const selection = el("p", { className: "muted", role: "status" }); selection.dataset.refineSelection = "";
  const controls = el("section", { className: "refinement" }, el("div", { className: "row" }, withArrow(start, "refine", () => accountBox.value), withArrow(compile, "improve", () => accountBox.value)), selection);
  controls.dataset.refineTarget = target;
  controls.setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "draft", draftTarget: target, preventDefaultContextMenuItems: false }));
  updateRefinementControl(controls);
  if (!r) return controls;
  if (r.pending) {
    // The run itself shows in its own tab (src/helper-tab.ts); the result still comes back here.
    // Handoff mode (plan 70d079 step 4): the host says when it found a handoff, before the call.
    if (r.handoff) controls.append(el("p", { role: "status", textContent: `Handoff detected: writing a task prompt from ${r.handoff}.` }));
    controls.append(el("p", { role: "status", textContent: "Refining your draft in its own tab. The board stays usable meanwhile." }),
      showProgress(r.requestId), button("Cancel refinement", () => {
      send("cancelHelper", { requestId: r.requestId });
      if (r.previous) refinements.set(target, r.previous); else refinements.delete(target);
      saveDrafts(); refreshRefinement(target);
    })); return controls;
  }
  if (r.error) {
    controls.append(el("p", { role: "alert", textContent: r.error }), button("Dismiss", () => { clearRefinement(target); saveDrafts(); refreshRefinement(target); }));
    return controls;
  }
  if (r.handoff) controls.append(el("p", { className: "muted", textContent: `Handoff mode: a task prompt for a new session, written from ${r.handoff}. Apply replaces the handoff in the box.` }));
  if (r.kind === "questions") {
    if (r.notice) controls.append(el("p", { role: "alert", textContent: r.notice }));
    const boxes = r.questions.map((q, i) => {
      // Pre-filled with the helper's suggested answer until you edit it; clearing the box means no answer.
      const box = el("textarea", { rows: 2, value: r.answerDrafts?.[i] ?? q.suggested ?? "", ariaLabel: q.question });
      box.dataset.refineFocus = `${target}:${i}`;
      box.oninput = () => { r.answerDrafts ||= []; r.answerDrafts[i] = box.value; saveDrafts(); };
      controls.append(el("label", {}, q.question, el("p", { className: "muted", textContent: q.reason }), box)); return box;
    });
    const useAnswers = pickable(button("Use answers", () => requestRefinement(target, answerText(r, boxes), boxes)), "refine", () => accountBox.value, USE_ANSWERS_TIP);
    useAnswers.dataset.refineAnswers = "";
    // Straight to Improve with the answers as shown: no second Refine call (item 2.1). The draft they answered must still be in the box.
    const improveWith = button("Improve with these answers", () => {
      if (draftValue(target) !== r.original) { r.notice = "Your draft changed after these questions were asked. Refine it again, or improve it without these answers."; saveDrafts(); refreshRefinement(target); return; }
      requestCompilation(target, answerText(r, boxes));
    });
    pickable(improveWith, "improve", () => accountBox.value, IMPROVE_WITH_TIP);
    improveWith.dataset.refineAnswers = "";
    controls.append(el("p", { className: "muted", textContent: "Both buttons send the answers as shown, including suggested answers you left in place." }), el("div", { className: "row" }, useAnswers, improveWith));
    updateRefinementControl(controls);
  } else {
    controls.append(el("p", { role: "status", textContent: r.kind === "unchanged" ? "Your draft is already clear." : `Proposal from ${r.model}${r.effort ? ` · ${r.effort} effort` : ""}` }));
    // the user, 11 November 2026: the options sit above the returned text, so they are in view without scrolling past it.
    if (r.kind === "revision") {
      const apply = button("Apply proposal", () => {
        if (draftValue(target) !== r.original) { r.error = "Your draft changed. Refine it again to avoid overwriting your edits."; saveDrafts(); refreshRefinement(target); return; }
        r.applied = true; decide(r.requestId, "apply"); setDraft(target, r.revision);
      }); apply.disabled = !!r.applied;
      controls.append(el("div", { className: "row" }, apply, showChanges(r.original, r.revision, "Refine draft: your draft ↔ proposal")));
    }
    if (r.applied) controls.append(button("Restore original", () => {
      if (draftValue(target) !== r.revision) { r.restoreConflict = true; saveDrafts(); refreshRefinement(target); return; }
      r.applied = false; r.restoreConflict = false; decide(r.requestId, "restore"); setDraft(target, r.original);
    }));
    if (r.restoreConflict) controls.append(el("p", { role: "alert", textContent: "Your draft changed after applying. Your edits were preserved. Copy from the original below if needed." }), el("textarea", { readOnly: true, rows: 6, value: r.original, ariaLabel: "Original draft" }));
    controls.append(button(r.applied ? "Keep applied draft" : "Keep original", () => { if (!r.applied) decide(r.requestId, "keep"); clearRefinement(target); saveDrafts(); refreshRefinement(target); }));
    if (r.kind === "revision") {
      controls.append(el("textarea", { readOnly: true, rows: 6, value: r.revision, ariaLabel: "Proposed draft" }));
      for (const a of r.assumptions || []) controls.append(el("p", { className: "muted", textContent: `Assumption: ${a}` }));
      // Advisory checks from the host (src/prompt-lint.ts): missing files or scripts, leaked helper paths, a much longer text.
      for (const f of r.lint || []) controls.append(el("p", { className: "muted", textContent: `Check: ${f.message} (${f.text})` }));
    }
    return controls;
  }
  controls.append(button("Dismiss", () => { clearRefinement(target); saveDrafts(); refreshRefinement(target); }));
  return controls;
}
// Refine, Improve and Review each run in their own tab (src/helper-tab.ts); this brings a running one's tab back if it was closed.
const showProgress = (requestId) => button("Show progress", () => send("showHelper", { requestId }), "Bring back the tab that shows this run's progress: each model's thinking and answer as they stream in");
// Compile: the current box text (the user's edit is authoritative) plus the latest clarification answers become one execution prompt.
function clearCompilation(target) {
  const c = compilations.get(target);
  if (c?.pending) send("cancelHelper", { requestId: c.requestId });
  compilations.delete(target);
}
/** The four settings an Improve result is bound to (phase 1): the form's for a new task, the card's own for a follow-up. */
function currentControls(target) {
  if (target === "new") return { account: accountBox.value, model: modelBox.value, effort: effortBox.value, permission: permissionBox.value };
  const t = (state.tasks || []).find((x) => x.id === target) || {};
  return { account: t.account || "", model: t.model || "", effort: t.effort || "", permission: t.permission || "" };
}
const controlDrift = (was, now) => !was ? [] : ["account", "model", "effort", "permission"].filter((k) => (was[k] || "") !== (now[k] || "")).map((k) => `${k}: ${was[k] || "default"} → ${now[k] || "default"}`);
const controlWords = (c) => [c.account || "default account", c.model || "default model", c.effort ? `${c.effort} effort` : "default effort",
  PERMISSION_CHOICES.find(([v]) => v === c.permission)?.[1] || "account's default permissions"].join(" · ");
/** What the form's own options will change on a new task after Improve, so the preview names the settings it really runs with. */
function formOverrides(target) {
  if (target !== "new") return [];
  const out = [];
  if (planFirst.box.checked && !planFirst.box.disabled && isCodex(accountBox.value)) out.push("Plan first on Codex runs Astra at ultra effort.");
  if (orchestrator.box.checked && !orchestrator.box.disabled && !permissionBox.value) out.push("Delegation defaults to Bypass permissions.");
  return out;
}
/** Redraws an Improve result when its binding changes (settings or text edited after Apply), not on every keystroke. */
const bindingKeys = new Map();
const bindingKey = (target) => { const c = compilations.get(target);
  return !c || c.pending || c.error || c.kind === "review" || !c.rendered ? "" : JSON.stringify([controlDrift(c.controls, currentControls(target)), !!c.applied && draftValue(target) !== c.rendered.text, formOverrides(target)]); };
function updateBindingNotes() { for (const target of [...compilations.keys()]) if ((bindingKeys.get(target) ?? "") !== bindingKey(target)) refreshRefinement(target); }
/** The card's accepted specification (phase 1): its revision, the stable ids, and what its last start or resume found. */
function specChips(t) {
  const s = t.specSummary;
  if (!s) return [];
  if (s.error) return [el("span", { className: "chip asks", textContent: "Specification unreadable", title: s.error })];
  const ids = [...s.requirements, ...s.acceptance].join(", ") || "no requirement or check ids";
  const out = [el("span", { className: "chip", textContent: `Improved spec r${s.revision}`, title: `Accepted from Improve prompt: ${ids}${s.superseded.length ? `; replaced ${s.superseded.join(", ")}` : ""}. Settings: ${controlWords(s.execution)}.${s.execution.configured?.length ? ` Set by the form's options: ${s.execution.configured.join("; ")}.` : ""} Capabilities: ${s.execution.capabilities === "provider-defaults" || !s.execution.capabilities ? "Provider defaults" : `profile ${s.execution.capabilities}`}.` })];
  if (s.last?.drift?.length) out.push(el("span", { className: "chip asks", textContent: "Settings changed since Improve", title: s.last.drift.join("; ") }));
  if (s.last?.replay === "mismatch" || s.last?.carried === false) out.push(el("span", { className: "chip asks", textContent: "Prompt differs from the improved specification", title: s.last.replay === "mismatch" ? "The saved specification no longer renders to the text that was accepted." : "The first prompt no longer contains the accepted text." }));
  return out;
}
/** answers given: "Improve with these answers". Otherwise submitted answers go only with the draft they answered (item 2.1). */
function requestCompilation(target, explicitAnswers) {
  const draft = draftValue(target), selection = refinementSelection();
  if (!draft.trim() || !validRefinementSelection(selection, "improve")) return;
  const requestId = newRequestId();
  const r = refinements.get(target);
  // Answers already folded into an applied revision are not sent again; answers to another version of the draft are not sent at all.
  const bound = r && !r.applied && r.answers && r.answersFor === draft;
  const answers = explicitAnswers ?? (bound ? r.answers : "");
  const answersDropped = explicitAnswers === undefined && !!r?.answers && !r.applied && !bound;
  // Re-running on an applied improvement keeps the hand-written draft as the restore point (base).
  const prev = compilations.get(target);
  const base = prev?.applied && prev.rendered && draft === prev.rendered.text ? (prev.base ?? prev.original) : draft;
  clearCompilation(target);
  compilations.set(target, { requestId, original: draft, base, pending: true, selection, controls: currentControls(target), answersSent: !!answers, answersDropped }); saveDrafts(); refreshRefinement(target);
  send("compile", { requestId, id: target === "new" ? undefined : target, ...selection, permission: permissionBox.value, draft, answers });
}
/** Entomatical: Review Prompt (Experimental), from the command palette or a draft's context menu (item 1.4). Nothing in it is applied. */
function requestReview(target) {
  const draft = draftValue(target), selection = refinementSelection();
  if (!draft.trim()) return;
  const requestId = newRequestId(), r = refinements.get(target), prev = compilations.get(target);
  const answers = r && !r.applied && r.answers && r.answersFor === draft ? r.answers : "";
  const base = prev?.applied && prev.rendered && draft === prev.rendered.text ? (prev.base ?? prev.original) : draft;
  if (prev?.pending) send("cancelHelper", { requestId: prev.requestId });
  // Dismiss review brings back the result it replaced.
  compilations.set(target, { requestId, original: draft, base, pending: true, kind: "review", answersSent: !!answers, previous: prev && !prev.pending && prev.kind !== "review" ? prev : undefined });
  saveDrafts(); refreshRefinement(target);
  send("reviewPrompt", { requestId, id: target === "new" ? undefined : target, account: selection.account, model: selection.model, draft: base, answers });
}
// Review prompt's result: Astra's review as read-only text, then each improver's attempt to read against it. Nothing here is applied.
function reviewText(v) {
  const out = [v.overview];
  for (const a of v.attempts) out.push([`${a.model}: ${a.approach}`, ...a.worked.map((w) => `Worked: ${w}`), ...a.didNotWork.map((w) => `Did not work: ${w}`)].join("\n"));
  if (v.comparison) out.push(`Comparison: ${v.comparison}`);
  if (v.takeaways.length) out.push(["Takeaways:", ...v.takeaways.map((t) => `- ${t}`)].join("\n"));
  return out.join("\n\n");
}
function reviewView(target, c) {
  const view = el("div", { className: "compilation" });
  const dismiss = (label) => button(label, () => { clearCompilation(target); if (c.previous) compilations.set(target, c.previous); saveDrafts(); refreshRefinement(target); });
  if (c.pending) {
    view.append(el("p", { role: "status", textContent: c.stage || "Terra and Sol are improving the prompt…" }),
      el("p", { className: "muted", textContent: "Two max-effort improvements, then an ultra-effort review: this can take many minutes." }), showProgress(c.requestId), dismiss("Cancel review"));
    return view;
  }
  if (c.error) { view.append(el("p", { role: "alert", textContent: c.error }), dismiss("Dismiss")); return view; }
  if (c.review) view.append(el("p", { role: "status", textContent: `Review by ${c.review.model} · ${c.review.effort} effort` }),
    el("textarea", { readOnly: true, rows: 16, value: reviewText(c.review), ariaLabel: "Prompt review" }));
  else view.append(el("p", { role: "alert", textContent: `Astra could not review the attempts: ${c.reviewError}` }));
  for (const a of c.attempts || []) {
    const body = a.error ? `Failed: ${a.error}` : a.status === "unfinished"
      ? (a.conflicts || []).map((k) => [`Earlier: ${k.earlier}`, `Later: ${k.later}`, `Why: ${k.why}`].join("\n")).join("\n\n") : a.prompt || "";
    view.append(el("details", {}, el("summary", { textContent: `${a.label} attempt (${a.model || "no model"} · ${a.effort} effort)${a.error ? ": failed" : a.status === "unfinished" ? ": unfinished" : ""}` }),
      el("textarea", { readOnly: true, rows: 8, value: body, ariaLabel: `${a.label} attempt` })));
  }
  view.append(dismiss("Dismiss review"));
  return view;
}
const firstOf = (list, n = 20) => list.slice(0, n).join(", ") + (list.length > n ? `, and ${list.length - n} more` : "");
const KIND = { requirement: "Requirement", acceptance: "Check", authorized: "Authorized", confirm: "Requires confirmation", prohibited: "Not authorized" };
function compilationView(target) {
  const c = compilations.get(target);
  if (!c) return [];
  if (c.kind === "review") return [reviewView(target, c)];
  const view = el("div", { className: "compilation" });
  const dismiss = (label) => button(label, () => { if (label === "Keep original" && !c.pending && !c.error) decide(c.requestId, "keep"); clearCompilation(target); saveDrafts(); refreshRefinement(target); });
  if (c.pending) { view.append(el("p", { role: "status", textContent: "Improving your prompt in its own tab. The board stays usable meanwhile." }), showProgress(c.requestId), dismiss("Cancel improvement")); return [view]; }
  if (c.error) { view.append(el("p", { role: "alert", textContent: c.error }), dismiss("Dismiss")); return [view]; }
  if (c.status === "unfinished") {
    view.append(el("p", { role: "alert", textContent: "Clarification is unfinished: a consequential contradiction remains. Edit the draft to resolve it, then improve it again." }),
      el("ul", { className: "conflicts" }, ...(c.conflicts || []).map((k) => el("li", {}, el("div", { textContent: `Earlier: ${k.earlier}` }), el("div", { textContent: `Later: ${k.later}` }), el("div", { className: "muted", textContent: `Why: ${k.why}` })))),
      dismiss("Dismiss"));
    return [view];
  }
  view.append(el("p", { role: "status", textContent: `Improved with ${c.model} · ${c.effort} effort · ${c.rendered.format} format` }));
  // the user, 11 November 2026: the options sit above the returned text, so they are in view without scrolling past it.
  if (c.oversize) view.append(el("p", { role: "alert", textContent: `This prompt is ${c.oversize.chars.toLocaleString()} characters, over the ${c.oversize.limit.toLocaleString()}-character limit: applied, it could not be refined, improved or given a completion rule. Copy what you need instead.` }));
  const changed = controlDrift(c.controls, currentControls(target));
  bindingKeys.set(target, bindingKey(target));
  const apply = button("Apply improved prompt", () => {
    if (draftValue(target) !== c.original) { c.applyConflict = true; saveDrafts(); refreshRefinement(target); return; }
    if (controlDrift(c.controls, currentControls(target)).length) { refreshRefinement(target); return; }
    c.applied = true; decide(c.requestId, "apply"); setDraft(target, c.rendered.text);
  }); apply.disabled = !!c.applied || !!c.oversize || changed.length > 0;
  // Phase 1 (master plan): the settings the task runs with, which Improve never changes, and why the result would not be kept.
  view.append(el("p", { className: "muted", textContent: `Runs with your settings: ${controlWords(currentControls(target))}` }),
    el("p", { className: "muted", textContent: "Capabilities: Provider defaults (the account's own MCP servers, skills and plugins, as the provider is set up). Improve does not change these settings." }));
  for (const note of formOverrides(target)) view.append(el("p", { className: "muted", textContent: note }));
  if (changed.length) view.append(el("p", { role: "alert", textContent: `Settings changed after Improve (${changed.join("; ")}). Improve again to keep the improved specification, or send the text as written without it.` }));
  else if (c.applied && draftValue(target) !== c.rendered.text) view.append(el("p", { role: "alert", textContent: "Your draft changed after Apply, so it will be sent as written, without the improved specification. Improve again to keep it." }));
  else if (c.bindable === false && !c.oversize) view.append(el("p", { role: "alert", textContent: "The improved specification could not be saved, so the text will be sent as written, without it." }));
  view.append(el("div", { className: "row" }, apply, showChanges(c.base ?? c.original, c.rendered.text, "Improve prompt: your draft ↔ improved prompt")));
  // The compiled text stays visible after a refused Apply so it can be copied; a fresh compile replaces the entry.
  if (c.applyConflict) view.append(el("p", { role: "alert", textContent: "Your draft changed. Improve it again to avoid overwriting your edits." }));
  if (c.applied) view.append(button("Restore original", () => {
    if (draftValue(target) !== c.rendered.text) { c.restoreConflict = true; saveDrafts(); refreshRefinement(target); return; }
    c.applied = false; c.restoreConflict = false; decide(c.requestId, "restore"); setDraft(target, c.base ?? c.original);
  }));
  if (c.restoreConflict) view.append(el("p", { role: "alert", textContent: "Your draft changed after applying. Your edits were preserved. Copy from the original below if needed." }), el("textarea", { readOnly: true, rows: 6, value: c.base ?? c.original, ariaLabel: "Original draft" }));
  view.append(dismiss(c.applied ? "Keep improved draft" : "Keep original"));
  // What the model added on its own is what to check before applying: obligations it assumed are held back (item 2.5, consensus 46).
  if (c.tally) view.append(el("p", { className: "muted", textContent: `${c.tally.requirements} requirements · ${c.tally.criteria} checks · ${c.tally.quarantined ?? 0} held back because the model assumed them · ${c.tally.assumed} assumed facts sent as unconfirmed · ${c.tally.mustAsk} questions to ask first` }));
  if (c.answersSent) view.append(el("p", { className: "muted", textContent: "Sent with your clarification answers from Refine draft." }));
  if (c.answersDropped) view.append(el("p", { className: "muted", textContent: "Your clarification answers were not sent: the draft changed after you answered." }));
  view.append(el("textarea", { readOnly: true, rows: 8, value: c.rendered.text, ariaLabel: "Improved prompt" }));
  if (c.quarantined?.length) view.append(el("details", {}, el("summary", { textContent: "The model assumed these; not sent" }),
    ...c.quarantined.map((q) => el("p", { className: "muted", textContent: `${KIND[q.kind] || q.kind}: ${q.text}` }))));
  // One line per list: a pasted log gave hundreds of anchors, one paragraph each (Linux machine, 4 November 2026).
  // At most 20 anchors per line: a pasted log once gave 628 (the receipt keeps the whole list).
  if (c.dropped?.length) view.append(el("p", { className: "muted", textContent: `Possibly not carried into the prompt: ${firstOf(c.dropped)}` }));
  if (c.sourceOnly?.length) view.append(el("p", { className: "muted", textContent: `Only in pasted material, not as an instruction: ${firstOf(c.sourceOnly)}` }));
  for (const f of c.lint || []) view.append(el("p", { className: "muted", textContent: `Check: ${f.message} (${f.text})` }));
  return [view];
}
/** What helpers shaped a box's text, sent with Add task and Send so the host can record provenance (item 1.3): applied runs, and whether
 *  the text was edited after the last one. */
function helperChain(target) {
  const text = draftValue(target), chain = [];
  const r = refinements.get(target), c = compilations.get(target);
  if (r?.applied) chain.push({ requestId: r.requestId, kind: "refine", edited: r.revision !== text && !(c?.applied && c.rendered?.text === text) });
  if (c?.applied && c.kind !== "review") chain.push({ requestId: c.requestId, kind: "improve", edited: c.rendered.text !== text });
  return chain;
}
const newRefinement = el("div", {}, refinementControls("new"));
function measurementView(m) {
  if (!m) return el("p", { className: "muted", textContent: "Token consumption not yet measured." });
  const n = value => Number(value || 0).toLocaleString();
  return el("div", { className: "measurement" },
    el("p", { textContent: m.source === "unknown" ? "Token consumption not yet measured." : m.complete ? `${n(m.total)} tokens · complete session` : "Partial measurement · full consumption unknown" }),
    m.source !== "unknown" ? el("p", { textContent: `Input ${n(m.tokens.input)} · cache read ${n(m.tokens.cacheRead)} · cache write ${n(m.tokens.cacheWrite)} · output ${m.source === "transcript" ? "unknown" : n(m.tokens.output)}` }) : null,
    m.at ? el("p", { className: "muted", textContent: `Measured ${stamp(m.at)}` }) : null,
    ...(m.gaps || []).map(g => el("p", { className: "muted", textContent: g })),
    m.context ? el("p", { textContent: `Context window ${m.context.usedPercent}% full · ${stamp(m.context.at)} (separate from consumption)` }) : null);
}

const columns = el("div", { className: "columns" });
const errorBox = el("p");
const taskButton = Object.assign(button("Add task", addTask, "Ctrl+Enter"), { className: "primary", disabled: true });
const draftContextNote = el("p", { role: "alert", hidden: true });
const refusedCreateBox = el("div", { hidden: true });
const unsentFollowUps = el("div", { hidden: true });
function restoreCreate({ message, issue, compilation, refinement }) {
  pendingTitle = message.title;
  promptBox.value = message.prompt;
  parentId = issue === "parent" ? null : message.parentId;
  draftAccount = issue === "account" ? null : message.account || undefined;
  draftProfile = issue === "profile" ? null : message.profile ? { ref: message.profile, revision: message.profileRevision } : undefined;
  delete accountBox.dataset.names;
  for (const [box, value] of [[modelBox, message.model], [effortBox, message.effort], [permissionBox, message.permission]]) {
    box.dataset.want = value; delete box.dataset.choices;
  }
  orchestrator.box.checked = (message.mayOpen ?? message.orchestrator) === true;
  planFirst.box.checked = message.planFirst;
  if (!cardTerminal.box.disabled) cardTerminal.box.checked = message.cardTerminal;
  if (compilation && !compilations.has("new")) compilations.set("new", compilation);
  if (refinement && !refinements.has("new")) refinements.set("new", refinement);
  grow(promptBox); render(); saveDrafts(); refreshRefinement("new");
}
function paintRefusedCreates() {
  if (!refusedCreates.size && refusedCreateBox.hidden) return;
  refusedCreateBox.hidden = !refusedCreates.size;
  const busy = !!selectedPlan || !!promptBox.value;
  refusedCreateBox.replaceChildren(
    ...(busy ? [el("p", { textContent: "Finish the current draft before restoring a refused draft." })] : []),
    ...[...refusedCreates].map(([id, entry]) => Object.assign(button(`Restore refused draft: ${entry.message.prompt.split("\n")[0].slice(0, 80)}`, () => {
      if (selectedPlan || promptBox.value) return;
      refusedCreates.delete(id); restoreCreate(entry); promptBox.focus();
    }), { disabled: busy })));
}
function syncDraftBlock() {
  const issues = [];
  if (parentId === null) issues.push("The saved parent is unavailable. Choose a parent with Subtask on a card, or select Use no parent.");
  if (draftAccount === null) issues.push("The saved account is unavailable. Choose an account for this draft.");
  if (draftProfile === null) issues.push("The saved capability profile is unavailable or changed. Choose a capability profile for this draft.");
  const message = issues.join(" ");
  if (draftContextNote.textContent !== message) draftContextNote.textContent = message;
  draftContextNote.hidden = !message;
  taskButton.disabled = !snapshotReady || !!message;
}
const taskActions = [battleButton, titleSplit.wrap, ruleSplit.wrap, planFirst.label, cardTerminal.label, orchestrator.label];
const planSetup = window.createPlanSetup?.({ send, onCancel: () => { send("cancelPlan"); leavePlan(); } });
function leavePlan() {
  if (!selectedPlan) return;
  const previous = selectedPlan; selectedPlan = undefined;
  promptBox.value = previous.draft;
  if (draftAccount !== null && [...accountBox.options].some((o) => o.value === previous.account)) accountBox.value = draftAccount || previous.account;
  for (const [box, value] of [[modelBox, previous.model], [effortBox, previous.effort], [permissionBox, previous.permission]]) { box.dataset.want = value || ""; box.dataset.choices = ""; }
  orchestrator.box.checked = previous.orchestrator; planFirst.box.checked = previous.planFirst;
  cardTerminal.box.disabled = false; cardTerminal.box.checked = previous.cardTerminal;
  profileBox.dataset.want = previous.profile || ""; profileBox.dataset.choices = "";
  if (planSetup) planSetup.element.hidden = true;
  taskForm.hidden = false;
  orchestrator.label.hidden = state.orchestratorEnabled === false;
  syncChoices(); syncProfiles(); grow(promptBox); saveDrafts(); promptBox.focus();
}
// The Workflow box (Import plan, Run ready preparation, Run authorized ready steps, the lanes) was retired on 6 November 2026
// (the user): Run a plan… is the one way to run a plan. Cards imported before keep Approve scope and Record result on the card.
const taskForm = el("section", { className: "form" }, subtaskOf,
  // The prompt row (F101): two separate buttons above the prompt box.
  el("div", { className: "row prompt-row" },
    button("Run a plan…", () => send("runPlan"), "Pick a plan file from workflows/ and run its steps in order. It shows the steps first; nothing starts until you press Run."),
    button("Load handoff", () => send("loadHandoff"), "Pick a handoff doc from docs/handoffs/ and put its text in the prompt box. Nothing starts.")),
  withMic(promptBox),
  el("div", { className: "row" }, accountBox, modelBox, effortBox, permissionBox, profileBox, asanaBox, obsidianBox), profileNote, profileLists, draftContextNote, refusedCreateBox, newRefinement,
  el("div", { className: "row" }, taskButton, ...taskActions), battleNote, planPromptView);
document.body.append(asanaBar, accountsBox, modelsBox, errorBox, speechControls, taskForm, ...(planSetup ? [planSetup.element] : []), unsentFollowUps, columns, battleOverlay);
paintRefusedCreates();

// Times on a card: when it started, and how long since it last changed.
const clock = (iso) => formatHostDate(iso, state, "toLocaleTimeString", { hour: "2-digit", minute: "2-digit" });
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
// Who last typed in a card terminal (F89): you, or a parent card through board.js type.
const terminalInputLine = (t) => t.terminalInput && (isAcpTask(t) || t.cardTerminal) ? el("div", { className: "muted",
  textContent: t.terminalInput.by === "you" ? `You typed in the terminal ${ago(t.terminalInput.at)}` : `Card ${t.terminalInput.by} typed in the terminal ${ago(t.terminalInput.at)}` }) : null;
// Where a card's work stands against the main folder (the user, 15 November 2026): delivered, waiting, or the last delivery refused.
// Only on a card the host counts (t.countsWork: a worktree and branch, not done, not a plan or workflow step). t.delivers: the board also
// delivers it every few turns and at Review; a card it counts but never delivers by itself (an orchestrator's card, the plan card, a
// branch outside task/) shows only its waiting work, with a mouse-over that promises no delivery.
const DELIVERY_OFF = "Automatic delivery is off (entomatical.deliver.everyTurns is 0). Finish delivers it.";
const NOT_DELIVERED_BY_ITSELF = "Entomatical does not deliver this card by itself. Its work reaches the main folder when it is finished.";
const deliveryLine = (t) => {
  if (!t.countsWork || !t.worktree || t.status === "done") return null;
  if (!t.delivers) return t.notInMain > 0 ? el("div", { className: "muted delivery", textContent: `Not in main folder yet: ${t.notInMain} change${t.notInMain === 1 ? "" : "s"}`, title: NOT_DELIVERED_BY_ITSELF }) : null;
  const d = t.delivery, n = state.deliverEveryTurns ?? 3, waiting = t.notInMain;
  if (d?.refused && waiting !== 0) return el("div", { className: "muted delivery refused", textContent: `Not delivered: ${d.refused}`, title: `Delivery refused ${stamp(d.at)}: ${d.refused}` });
  if (waiting > 0) return el("div", { className: "muted delivery", textContent: `Not in main folder yet: ${waiting} changes`,
    title: n > 0 ? `Next delivery in ${Math.max(n - (t.deliveryTurns || 0), 1)} turns, or when this card reaches Review. Finish delivers it now.` : DELIVERY_OFF });
  if (!d?.sha) return null;
  return el("div", { className: "muted delivery", textContent: "In main folder", title: n > 0
    ? `Delivered ${stamp(d.at)}: ${d.files} files, commit ${d.sha}. Entomatical brings this card's work into the main folder every ${n} turns and when it reaches Review.`
    : `Delivered ${stamp(d.at)}: ${d.files} files, commit ${d.sha}. ${DELIVERY_OFF}` });
};
// A card's muted line. Its own function so the timer below can redraw just this text.
const meta = (t) => {
  const parent = state.tasks.find((p) => p.id === t.parentId);
  return [t.id, t.account || "~/.claude", modelText(t), t.effort && `${t.effort} effort`, t.permission && (PERMISSION_CHOICES.find(([p]) => p === t.permission)?.[1] || t.permission), t.adopted && "found running", t.merged && "merged", t.asana && `Asana: ${t.asana.name}`, t.obsidian && `Obsidian: ${t.obsidian.note}`, parent && `↳ ${parent.title}`, `started ${clock(t.createdAt)}`, ago(t.updatedAt)].filter(Boolean).join(" · ");
};
// Same reason as the Accounts rows: an idle board posts nothing, so card ages would freeze. Re-set only that text each minute (no rebuild, so a follow-up being typed is left alone).
setInterval(() => {
  let redraw = false;
  for (const t of state.tasks) {
    const m = columns.querySelector(`.card[data-task="${t.id}"] .meta`);
    if (m) m.textContent = meta(t);
    // The Quiet chip (F80) counts up in place; appearing or going needs the card drawn again (render keeps focus and selection).
    const shown = columns.querySelector(`.card[data-task="${t.id}"] .chip.quiet`), fresh = quietChip(t);
    if (!!shown !== !!fresh) redraw = true;
    else if (shown && fresh) { shown.textContent = fresh.textContent; shown.className = fresh.className; }
  }
  if (redraw) render();
}, 60_000);

// F91 (hook/hook.js refusalStop): a headless Claude run stops itself when the same call is refused twice in one prompt, or 8 in a row.
const REFUSAL_STOP_TIP = "This headless run needed approval that nobody can give here. Send a follow-up with another way to do it, or resume it with Bypass permissions.";
const REFUSAL_RESUME_TIP = "Set this card to Bypass permissions and continue the same session: the calls refused before are allowed now.";
const RUN_PLAN_NOW_TIP = "Run the plan this card wrote. It shows the steps first; nothing starts until you press Run.";
const REVIEW_TIP = "Review this card's work against its Done when, on Fable or Astra at medium effort. Uses account usage.";
const FINISH_TIP = "Close the session, commit, merge with the remote's latest, push, update the local branch, then delete the worktree. Never stops work still running. Shows the plan first; stops and keeps the worktree if a step fails, and if the remote (GitHub) does not accept it, asks the task's session whether to fix the cause.";
function canFollowUp(t) {
  return t && !t.cardTerminalStarted && (((state.own || []).includes(t.id) && !(state.firstTurn || []).includes(t.id) && !(t.headless && !t.takenOver))
    || (isAcpTask(t) && !state.live.includes(t.id) && t.sessionId && t.worktree));
}
function card(t) {
  const live = state.live.includes(t.id);
  const own = (state.own || []).includes(t.id); // running in a terminal this board opened
  // A Codex first turn in the background can only be stopped: its conversation opens in Codex's editor when the turn ends.
  const firstTurn = (state.firstTurn || []).includes(t.id);
  const panelFirstTurn = (state.panelFirstTurn || []).includes(t.id);
  const parent = state.tasks.find((p) => p.id === t.parentId);
  // Buttons by weight: primary is the one thing to do next, danger ends something, the rest are secondary (board.css).
  const act = (label, type, weight = "secondary") => { const b = button(label, () => send(type, { id: t.id })); b.classList.add(weight); return b; };
  const actions = [];
  // O5: a blocked strict card offers the user's explicit switch; the host shows what would be inherited before it records the choice.
  if (t.profile?.mode === "strict" && t.profileBlocked && !live && t.status !== "done") actions.push(button("Run with Provider defaults instead", () => send("profileDefaults", { id: t.id }), "Drop this card's strict capability profile and inherit the account's own MCP servers, skills and plugins. You see the list first; the choice is recorded on the card."));
  // An in-card terminal that ended (Stop, exit, window reload): Resume continues the card in a new terminal; Start terminal starts over.
  const terminalResume = isAcpTask(t) && !!t.cardTerminalStarted && !!t.worktree && !live && !t.cancelled;
  // A checks-only plan card runs no session (F72): the board runs its steps and merges them into it; Finish is its one action.
  if (!t.sessionId && !live && t.planRun?.review !== "checks" && !terminalResume) actions.push(act("Start", "start", "primary"));
  if (terminalResume) actions.push(Object.assign(button("Resume", () => send("resume", { id: t.id }), "Continue this card in a new terminal on the same worktree. The provider's earlier terminal conversation is not reopened."), { className: "primary" }));
  if ((t.openedBy || t.orchestrator) && !live && !t.cancelled && !t.sessionId) actions.push(act("Cancel card", "cancel"));
  if (live && (!firstTurn || panelFirstTurn)) {
    if ((isAcpTask(t) && t.cardTerminalStarted) || t.cardTerminal) actions.push(Object.assign(button("Focus terminal", () => cardTerminals?.focus(t.id)), { className: "primary" }));
    else actions.push(act("Open", "open", "primary"));
  }
  if (own) actions.push(act("Stop", "stop", "danger"));
  if (t.sessionId && t.worktree && isAcpTask(t)) {
    if (!live) {
      if (!t.cardTerminalStarted) actions.push(Object.assign(button("Follow-up", () => {
        drafts.set(t.id, drafts.get(t.id) || ""); saveDrafts(); render(); draftBox(t.id)?.focus({ preventScroll: true });
      }), { className: "secondary", disabled: pendingSends.has(t.id) }));
      actions.push(act("Start terminal", "startTerminal"));
    }
  } else if (terminalResume) actions.push(act("Start terminal", "startTerminal"));
  else if (t.sessionId && t.worktree && (!live || t.interrupted && t.status === "review" || t.resuming)) {
    // F91: a headless run its own hook stopped after refused calls continues in the same session with Bypass permissions.
    if (t.refusalStop && !live) actions.push(Object.assign(button("Resume with Bypass", () => send("resumeBypass", { id: t.id }), REFUSAL_RESUME_TIP), { className: "primary" }));
    const resume = act(t.resuming ? "Resuming…" : "Resume", "resume");
    resume.disabled = !!t.resuming;
    actions.push(resume);
  }
  // F97: a reviewer model checks the work against the Done when. The host decides which cards are reviewable.
  // F102: right-click picks the reviewer's account, model and effort for every card's Review.
  if (t.reviewable) actions.push(pickable(act("Review", "reviewWork"), "review", () => t.account, REVIEW_TIP));
  // F99: the plan file this card wrote, while it is still in workflows/ (the host checks); the host runs it as Run a plan… does.
  if (t.planReady && t.status !== "running") actions.push(Object.assign(button("Run this plan now", () => send("runPlan", { id: t.id }), RUN_PLAN_NOW_TIP), { className: "primary" }));
  // One press: close the session, commit, merge with the remote, push, update the local branch, delete the worktree. The extension confirms the plan first.
  // Never greyed out (the user, 6 November 2026): work still under way is stopped, after a warning in that dialog.
  if (t.worktree && !t.adopted) {
    const finish = pickable(button("Finish", () => send("finish", { id: t.id })), "finish", () => t.account, FINISH_TIP);
    finish.classList.add("secondary");
    actions.push(finish);
  }
  const menuButton = button("More", () => {
    const rect = menuButton.getBoundingClientRect();
    menuButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left, clientY: rect.bottom }));
  }, "Task actions (also available by right-clicking this card)");
  menuButton.setAttribute("aria-haspopup", "menu");
  actions.push(menuButton);

  let followUp = null;
  if (drafts.has(t.id) && !pendingSends.has(t.id) && canFollowUp(t)) {
    const box = el("textarea", { rows: 3, placeholder: "Follow-up (Ctrl+Enter sends)", value: drafts.get(t.id) });
    box.oninput = () => { drafts.set(t.id, box.value); saveDrafts(); updateBindingNotes(); };
    box.dataset.draftTarget = t.id;
    box.setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "draft", draftTarget: t.id, preventDefaultContextMenuItems: false }));
    // The box's refinement and Improve result stay until the host confirms the send ("sent"); a refused send gets the text back.
    const go = () => {
      if (pendingSends.has(t.id)) return;
      const sendId = newRequestId();
      drafts.set(t.id, box.value); bounced.delete(t.id); pendingSends.set(t.id, sendId);
      saveDrafts();
      send("send", { id: t.id, sendId, text: box.value, helpers: helperChain(t.id) });
      render();
    };
    box.onkeydown = (e) => { if (e.key === "Enter" && e.ctrlKey) go(); };
    followUp = el("div", {}, withMic(box), refinementControls(t.id), Object.assign(button("Send", go), { className: "primary" }));
  }
  // Every prompt the session got, in full, each with the answer it got (its readout). Collapsed it shows the latest one's first line.
  // Newest first; expanded shows the latest RECENT, "Show all" reveals the rest.
  const prompts = (t.prompts || [{ text: t.prompt }]).map((p, i) => ({ ...p, n: i + 1 })).reverse();
  const latest = prompts[0].text.split("\n")[0];
  const all = showAll.has(t.id);
  const shown = all ? prompts : prompts.slice(0, RECENT);
  const more = prompts.length > RECENT
    ? button(all ? "Show latest only" : `Show all ${prompts.length}`, () => { if (all) showAll.delete(t.id); else showAll.add(t.id); render(); })
    : null;
  if (more) more.className = "link";
  const promptList = el("details", { className: "prompts", open: openPrompts.has(t.id) },
    el("summary", { textContent: prompts.length > 1 ? `${prompts.length} prompts · ${latest}` : latest, title: "Show full prompts" }),
    el("div", { className: "prompt-list" },
      ...shown.map((p) => el("div", { className: "prompt" }, el("span", { className: "prompt-n", textContent: `#${p.n} ` }), p.text,
        p.reply ? el("div", { className: "readout", textContent: `${p.replyStatus === "partial" ? "Partial reply: " : "↩ "}${p.reply}`, title: p.replyStatus === "partial" ? "Partial reply; the turn has not completed (first 600 characters)" : "The answer this prompt got (first 600 characters)" }) : null))),
    more);
  promptList.ontoggle = () => { if (promptList.open) openPrompts.add(t.id); else openPrompts.delete(t.id); };
  const partial = prompts[0].replyStatus === "partial" ? prompts[0].reply : undefined;
  const reply = partial ? el("div", { className: "reply", textContent: `Partial reply: ${partial}`, title: "Partial reply; the turn has not completed (first 600 characters)" })
    : t.reply ? el("div", { className: "reply", textContent: `↩ ${t.reply}`, title: "Latest answer (first line)" }) : null;
  // What the task cost the account, in percentage points of each window, from the readings at the start and end of each run.
  // Other sessions on the same account move the same windows, so it reads "the account moved", not "this task used".
  const cost = t.cost?.windows.length ? el("div", { className: "muted cost",
    textContent: `Account usage moved ${t.cost.windows.map((w) => w.reset && !w.incomplete ? `${w.name}: reset during the task${typeof w.points === "number" ? `, +${fmtPts(w.points)} pts since` : ""}` : `+${w.incomplete ? "?" : fmtPts(w.points)} pts ${w.name}`).join(" · ")}${t.cost.open ? " so far" : ""}.`,
    title: "Percentage points of the account's usage windows between the start and end of this task's runs. Other sessions on the same account count too." }) : null;
  // Subagents the session delegated to, each with what it is doing right now. Open by itself while any is working.
  const agents = t.subagents || [];
  const working = agents.filter((a) => !a.done).length;
  let agentList = null;
  if (agents.length) {
    const open = agentToggle.has(t.id) ? agentToggle.get(t.id) : working > 0 && live;
    agentList = el("details", { className: "agents", open },
      el("summary", { textContent: `${agents.length} subagent${agents.length === 1 ? "" : "s"}` + (working && live ? ` · ${working} working` : "") }),
      ...agents.map((a) => el("div", { className: "agent" + (a.done ? " done" : live ? " working" : " stopped") },
        el("div", { className: "agent-head", textContent: `${a.done ? "✓" : live ? "●" : "○"} ${a.type}${a.description ? ` · ${a.description}` : ""}` }),
        el("div", { className: "muted", textContent: `${a.done ? "run ended" : live ? "now" : "stopped"}: ${a.doing}${a.known === false ? "" : ` · ${a.steps} step${a.steps === 1 ? "" : "s"}`}${a.model ? ` · ${a.model}` : ""}${a.effort ? ` · ${a.effort} effort` : ""}` }))));
    agentList.ontoggle = () => agentToggle.set(t.id, agentList.open);
  }
  // A plan step: its readiness or waiting reason, its outcome (kept apart from the column), and its own actions.
  const step = t.workflow ? stepView(t) : null;
  // The session sits on a prompt in its terminal before it starts (first-run setup, sign-in, folder trust). Open shows that terminal.
  // A held card's wait (Start after, or the running limit), and a last turn that ended without a Stop (src/queue.ts).
  const queued = t.queueWait ? el("div", { className: "waiting", textContent: t.queueWait }) : null;
  // A plan step the board stopped acting on (F72): why it waits for the user.
  const held = t.stepHold && t.status !== "done" ? el("div", { className: "waiting", textContent: `Needs you: ${t.stepHold}` }) : null;
  const interrupted = t.resuming ? el("div", { className: "waiting", textContent: "Resuming: waiting for the session to start its next turn." })
    : t.interrupted && t.status === "review" ? el("div", { className: "waiting", textContent: "Interrupted: the last turn ended without finishing. Resume to continue." }) : null;
  const waiting = t.waiting ? el("div", { className: "waiting", textContent: `Waiting for ${t.provider === "codex" ? "Codex" : ACP_NAMES[t.provider] || "Claude"} to start: answer the prompt in its terminal (Open)` }) : null;
  const title = el("div", { className: "title" }, el("span", { className: live ? "dot live" : "dot", title: live ? "Session running" : "No session" }), t.title);
  // Triple-click the title: the same "open" as the Open button (F67). Single and double clicks keep doing nothing here.
  title.addEventListener("click", (e) => { if (e.detail === 3) send("open", { id: t.id }); });
  // The live line (F70): what the session is doing right now, from its latest tool call, while its turn runs.
  const doing = t.doing && live ? el("div", { className: "doing", textContent: `doing: ${t.doing.text} · ${secondsAgo(t.doing.at)}`, title: "What the session is doing right now, from its latest tool call" }) : null;
  // Chips of a run (F69, F71, F75, F76): who opened the card, how it runs, and what the board did to it.
  const chips = [
    t.controller ? el("span", { className: "chip", textContent: `Controller: external session ${t.controller.sessionId.slice(0, 8)}` })
      : (t.watchedBy || t.openedBy) && !t.takenOver ? el("span", { className: "chip", textContent: `Controller: ${t.controllerTitle || "card"} (${t.watchedBy || t.openedBy})` })
      : t.parentId || t.takenOver ? el("span", { className: "chip", textContent: "Controller: you" }) : null,
    // Two plain literals, not one conditional: the parity check reads only a literal textContent (F72).
    t.planRun?.review === "model" ? el("span", { className: "chip", textContent: "plan · a model reviews each step" }) : null,
    t.planRun?.review === "checks" ? el("span", { className: "chip", textContent: "plan · checks decide each step" }) : null,
    t.headless && !t.takenOver ? el("span", { className: "chip", textContent: "headless" }) : null,
    t.takenOver ? el("span", { className: "chip", textContent: "taken over" }) : null,
    // F95: the last transfer while the card stays where it put it, and an open takeover request (the user answers on its notification).
    t.transfers?.length && t.transfers.at(-1).to === t.openedBy && t.transfers.at(-1).op === "takeover" ? el("span", { className: "chip", textContent: `taken over by ${t.transfers.at(-1).to}` }) : null,
    t.transfers?.length && t.transfers.at(-1).to === t.openedBy && t.transfers.at(-1).op === "handoff" ? el("span", { className: "chip", textContent: `handed to ${t.transfers.at(-1).to}` }) : null,
    t.takeoverAsk ? el("span", { className: "chip", textContent: `takeover asked by ${t.takeoverAsk.by}` }) : null,
    t.paused ? el("span", { className: "chip", textContent: "paused" }) : null,
    t.cancelled ? el("span", { className: "chip", textContent: "cancelled" }) : null,
    t.deliveryReady ? el("span", { className: "chip", textContent: "delivery ready" }) : null,
    // Two plain literals again (F72's reason): the parity check reads only a literal textContent.
    waitingOn.get(t.id) === 1 ? el("span", { className: "chip", textContent: "Waiting on 1 card", title: "This card's own turn ended, but a card under it is still queued or working" }) : null,
    waitingOn.get(t.id) > 1 ? el("span", { className: "chip", textContent: `Waiting on ${waitingOn.get(t.id)} cards`, title: "This card's own turn ended, but cards under it are still queued or working" }) : null,
    t.switchedTo ? el("span", { className: "chip", textContent: `switched to ${t.switchedTo}` }) : null,
    t.waitsForReset ? el("span", { className: "chip", textContent: `waits for reset ${clock(new Date(t.waitsForReset.at).toISOString())}` }) : null,
    // F78 to F80: plan mode in force, a reply that asked something, the same tool call over and over, and a long silence. Hints only.
    ...specChips(t),
    // A blocked profile's reason opens from its chip by keyboard too (F110 finding F5: it was only a mouse-over).
    ...(t.profile?.mode === "strict" && t.profileBlocked ? [el("details", { className: "chip asks profile-chip", open: profileOpen.has(t.id), ontoggle() { this.open ? profileOpen.add(t.id) : profileOpen.delete(t.id); } },
      el("summary", { textContent: `Profile ${t.profile.snapshot.name} r${t.profile.snapshot.revision} · blocked` }), el("span", { textContent: t.profileBlocked }))] : []),
    ...(t.profile?.mode === "strict" && !t.profileBlocked ? [el("span", { className: "chip", textContent: `Profile ${t.profile.snapshot.name} r${t.profile.snapshot.revision}`,
      title: `Pinned ${t.profile.snapshot.id} r${t.profile.snapshot.revision}; later edits of the profile do not change this card.` })] : []),
    t.planFirst && t.status !== "done" ? el("span", { className: "chip", textContent: "Plan", title: t.provider === "codex" ? "Planning on Astra at ultra effort, until the first turn ends" : "Claude's plan mode, until the first turn ends or its plan is approved" }) : null,
    t.asks && t.status === "review" ? el("span", { className: "chip asks", textContent: "Asked you something", title: "The last reply ends with a question or a list of options to choose from" }) : null,
    t.pressureError ? el("span", { className: "chip asks", textContent: "watcher needs attention", title: t.pressureError }) : null,
    t.role ? el("span", { className: "chip", ...(ROLE_CHIPS[t.role] ?? { textContent: t.role }) }) : null,
    t.judged ? el("span", { className: "chip", textContent: `judged: ${t.judged}` }) : null,
    // F97: the last review's verdict. Three plain literals (the parity check reads only a literal textContent).
    // A Done the card has worked past is no longer about what is there (workedAfter: a follow-up was sent after it).
    t.doneReview?.verdict === "done" ? el("span", { className: "chip verdict-done", textContent: t.doneReview.workedAfter ? "Done, worked since" : "Done", title: t.doneReview.workedAfter ? "This review is older than the card's latest work. Press Review to review it again." : "" }) : null,
    t.doneReview?.verdict === "not-done" ? el("span", { className: "chip verdict-not-done", textContent: "Not done" }) : null,
    t.doneReview?.verdict === "unsure" ? el("span", { className: "chip verdict-unsure", textContent: "Unsure" }) : null,
    t.repeating ? el("span", { className: "chip repeating", textContent: `Repeating ${t.repeating.tool} ×${t.repeating.n}`, title: "The same tool call with the same input, this many times in a row in this prompt" }) : null,
    t.refusalStop && t.status === "needs-input" ? el("span", { className: "chip asks", textContent: `Stopped after ${t.refusalStop.n} refused calls`, title: REFUSAL_STOP_TIP + (t.refusalStop.desc ? ` Last refused: ${t.refusalStop.desc}` : "") }) : null,
    quietChip(t),
    governedChip(t),
    // The run's measured budget (F76): points of the 5-hour window its cards moved, against caps.points; unmeasured cards are named, not counted as 0.
    t.run?.budget ? el("span", { className: "chip", textContent: `budget ${t.run.budget.percent}% used`,
      title: `${t.run.budget.used} of ${t.run.budget.cap} points of the 5-hour window, measured from the readings at the start and end of each card's runs; ${t.run.budget.unknown.length} cards have no measurable reading and count as unknown` }) : null,
  ].filter(Boolean);
  const chipRow = chips.length ? el("div", { className: "chips" }, ...chips) : null;
  // The master card (F69, F75, F76): its counts, the plan waiting for the user, and its children collapsed under one run row.
  const run = t.run;
  const caps = t.orchestrator?.caps || {};
  const orchLine = run ? el("div", { className: "muted", textContent: `${run.open} open · ${run.done} done · ${run.cancelled || 0} cancelled · ${t.orchestrator.opened} of ${caps.total ?? "?"} opened` }) : null;
  // Phase 3: the governed root's project line, from the board's actual state (board.js overview has the same groups).
  const gv = t.governedView && t.governedView.isRoot ? t.governedView.counts : null;
  const projectLine = gv ? el("div", { className: "muted", role: "status", textContent: `Project: ${gv.running} running · ${gv.queued} queued · ${gv.waiting} waiting · ${gv.blocked} blocked · ${gv.ready} ready to integrate · ${gv.decisions} decisions` }) : null;
  // Phase 5: the council's state per saved checkpoint, from the board's record; never a badge for a review that did not happen or went stale.
  const cv = t.governedView && t.governedView.isRoot ? t.governedView.council : null;
  const councilLine = cv ? el("div", { className: "row council" },
    el("span", { className: "muted", role: "status", textContent: `Council: ${cv.checkpoints.map((c) => `${c.checkpoint} ${c.state}${c.round ? ` (round ${c.round}${c.degraded ? ", degraded" : ""})` : ""}${c.decisionRequired ? ", decision required" : ""}`).join(" · ")}`,
      title: `${cv.council}. Members: ${cv.members.join("; ")}. At most ${cv.rounds} rounds per checkpoint without a pass; unavailable members: ${cv.passing.unavailable === "quorum" ? `a quorum of ${cv.passing.quorum} gives a degraded outcome` : "block"}. Finish re-checks every pass against the current candidate and target.` }),
    button("Council…", () => send("council", { id: t.id }), "Convene a checkpoint, read the full council record, or decide after the round limit")) : null;
  const proposed = t.plan?.caps || caps;
  const capInputs = [["open", "Open cards"], ["total", "Total cards"], ["depth", "Maximum depth"], ["pending", "Notices before a watcher"], ["watchers", "Maximum watchers"], ["perWatcher", "Cards per watcher"]].map(([key, title]) => ({ key, title, input: el("input", { type: "number", min: 1, ...(key === "depth" ? { max: 8 } : {}), value: proposed[key] ?? 1, ariaLabel: title }) }));
  const PRESSURE_TIP = "Allow the board to open additional watcher cards when notices accumulate (uses run slots and model usage)";
  const pressure = el("input", { type: "checkbox", checked: false, ariaLabel: "Allow automatic pressure watchers" });
  // The on/off state sits right after the box and follows each click (F73, the user, 9 November 2026).
  const pressureState = el("strong", { className: "pressure-state", textContent: "Watchers off" });
  pressure.onchange = () => { pressureState.textContent = pressure.checked ? "Watchers on" : "Watchers off"; };
  const policy = t.plan?.policy || t.runPolicy;
  // Phase 3: the user may approve the run as governed. Off unless ticked; its limits have no defaults (O2 is undecided), and the profiles
  // children may use are pinned at Approve. Phase 4: only the user's Finish on the root reaches the target, after the readiness check.
  const governedBox = el("input", { type: "checkbox", checked: false, ariaLabel: "Approve as a governed run" });
  const govInputs = [["active", "Active executions (root, coordinators, workers, judges)", 32], ["directChildren", "Direct active children per card", 32], ["depth", "Delegation depth", 8]]
    .map(([key, title, max]) => ({ key, title, input: el("input", { type: "number", min: 1, max, required: true, placeholder: "required", ariaLabel: title }) }));
  // A profile the board would refuse on the root's account says so, with the board's reason, as the new-task form does (src/profiles.ts).
  const govProfiles = [["provider-defaults", "Provider defaults"], ...((state.profiles && state.profiles.entries) || []).map((e) => [`${e.ref}@${e.revision}`, `${e.name} (${e.scope}) r${e.revision}`, e.blocked?.[t.account]])]
    .map(([ref, name, why]) => { const label = why ? `${name} · blocked` : name; return { ref, name, why, label, box: el("input", { type: "checkbox", ariaLabel: `Children may use ${label}` }) }; });
  const GOV_PROFILE_TIP = "Children of this governed run may use this profile; it is pinned when you press Approve";
  const govDefault = choose("Default child profile", [["", "No default (each add names one)"], ...govProfiles.map((p) => [p.ref, p.label])]);
  // Phase 5: a saved council only when chosen here (no default council, members or rounds: O3 and O6 are open decisions).
  const govCouncil = choose("Council", [["", "No council"], ...((state.councils && state.councils.entries) || []).map((e) => [`${e.ref}@${e.revision}`, `${e.name} r${e.revision} (${e.members} member${e.members === 1 ? "" : "s"})`])]);
  const govSection = el("fieldset", { className: "governed", hidden: true },
    el("legend", { textContent: "Governed run" }),
    el("div", { className: "muted", textContent: "No defaults: the team limits are an open decision (O2). The master plan proposes 6 active, 3 direct children and depth 2; type your own." }),
    ...govInputs.map(({ title, input }) => el("label", {}, title, input)),
    el("div", { className: "muted", textContent: "Profiles children may use" }),
    ...govProfiles.flatMap(({ ref, box, label, name, why }) => [el("label", { className: "toggle", title: GOV_PROFILE_TIP }, box, label),
      why ? el("details", { className: "waiting", open: openWhy.has(`${t.id} ${ref}`), ontoggle: (e) => openWhy[e.target.open ? "add" : "delete"](`${t.id} ${ref}`) },
        el("summary", { textContent: `Why ${name} is blocked on ${t.account}` }), el("p", { textContent: why })) : null]),
    el("label", {}, "Default child profile", govDefault),
    el("label", { title: "A saved council (workflows/councils.json) reviews the checkpoints it lists, read-only, before your Finish; pinned when you press Approve" }, "Council", govCouncil),
    state.councils && state.councils.error ? el("div", { className: "waiting", role: "alert", textContent: `Saved councils unreadable: ${state.councils.error}` }) : null,
    el("div", { className: "muted", textContent: "Only your Finish on the root takes a governed run to the target, after the board's readiness check; push is a separate choice there. Children reach the root's branch by Integrate (Merge on the child). Delivery and finish self stay off." }));
  governedBox.onchange = () => { govSection.hidden = !governedBox.checked; };
  const governedChoice = () => {
    if (!governedBox.checked) return undefined;
    if (!govInputs.every(({ input }) => input.reportValidity())) return null;
    const allowed = govProfiles.filter((p) => p.box.checked).map((p) => p.ref);
    govProfiles[0].box.setCustomValidity(allowed.length ? "" : "Choose at least one profile children may use");
    if (!allowed.length) { govProfiles[0].box.reportValidity(); return null; }
    return { limits: Object.fromEntries(govInputs.map(({ key, input }) => [key, Number(input.value)])), allowed, ...(govDefault.value ? { defaultChild: govDefault.value } : {}), ...(govCouncil.value ? { council: govCouncil.value } : {}) };
  };
  const planRow = t.plan && !t.approved ? el("div", { className: "plan" },
    el("div", { className: "waiting", textContent: `Plan ready: ${t.plan.steps} steps. The ${t.plan.points} pp estimate is a heuristic.` }),
    ...capInputs.map(({ title, input }) => el("label", {}, title, input)),
    el("div", { className: "row" }, el("label", { className: "toggle", title: PRESSURE_TIP }, pressure, pressureState), el("span", { className: "muted", textContent: PRESSURE_TIP })),
    policy ? el("div", { className: "muted", textContent: `Allow: ${policy.allow.join(", ") || "task scope"}. Deny: ${policy.deny.join(", ") || "none specified"}. External sync opt-out: ${policy.noSync ? "on" : "off"}.` }) : null,
    t.planRun || t.battle ? null : el("label", { className: "toggle", title: "Approve as a governed run: execution leases, delegable profiles, assignments and submissions" }, governedBox, "Governed run"),
    govSection,
    el("div", { className: "row" }, Object.assign(button("Approve", () => { const governed = governedChoice(); if (governed === null) return; if (capInputs.every(({ input }) => input.reportValidity())) send("approvePlan", { id: t.id, pressureWatchers: pressure.checked, caps: Object.fromEntries(capInputs.map(({ key, input }) => [key, Number(input.value)])), ...(governed ? { governed } : {}) }); }, "Allow this card to delegate within the approved limits"), { className: "primary" }),
      button("Edit plan", () => send("editPlan", { id: t.id }), "Open ORCHESTRATION.md to edit the proposed run"))) : null;
  // render() rebuilds every card on each board update (every second while a card works): keep what was typed or ticked in this row.
  if (planRow) {
    const controls = [...capInputs.map((c) => c.input), pressure, governedBox, ...govInputs.map((c) => c.input), ...govProfiles.map((p) => p.box), govDefault, govCouncil];
    const saved = approvalDrafts.get(t.id) || {};
    for (const c of controls) if (c.ariaLabel in saved) c[c.type === "checkbox" ? "checked" : "value"] = saved[c.ariaLabel];
    pressure.onchange(); governedBox.onchange();
    const save = () => approvalDrafts.set(t.id, Object.fromEntries(controls.map((c) => [c.ariaLabel, c.type === "checkbox" ? c.checked : c.value])));
    planRow.addEventListener("input", save);
    planRow.addEventListener("change", save);
  } else approvalDrafts.delete(t.id);
  let runRow = null, runChildren = null;
  if (run && run.children.length) {
    const open = runOpen.has(t.id);
    runRow = button(`${t.title} · ${run.running} running · ${run.needsYou} needs you · ${run.done} done · ${run.points ?? "?"} pp`, () => { if (open) runOpen.delete(t.id); else runOpen.add(t.id); render(); }, "Show or hide this run's cards");
    runRow.className = "run-row";
    const hidden = run.children.filter((c) => hiddenInRun(c, t)).map((c) => state.tasks.find((x) => x.id === c.id)).filter(Boolean);
    if (open && hidden.length) runChildren = el("div", { className: "run-children" }, ...hidden.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(card));
  }
  const agentOptions = isAcpTask(t) && !t.cardTerminalStarted ? (t.acpOptions || []).filter((o) => ["model", "thought_level"].includes(o.category) && Array.isArray(o.values) && o.values.length).map((o) => {
    const select = el("select", { ariaLabel: o.name, disabled: live, title: "Applied on the next follow-up. Keep agent setting leaves the provider's current setting unchanged." },
      el("option", { value: "", textContent: "Keep agent setting" }), ...o.values.map((v) => el("option", { value: v.value, textContent: v.name })));
    select.value = t.acpSelections?.[o.id] || "";
    select.onchange = () => send("setAcpOption", { id: t.id, optionId: o.id, value: select.value });
    return el("label", {}, o.name, select);
  }) : [];
  const report = run ? el("details", { className: "report" }, el("summary", { textContent: "Run report" }),
    el("div", { className: "readout", textContent: t.finalReply || "No report yet." }),
    ...run.children.map((c) => el("div", { className: "muted", textContent: `${c.title} · ${c.status} · ${c.points ?? "?"} pp` })),
    button("Open report", () => send("report", { id: t.id }), "The run report as a document: the final reply, each card's outcome and cost, and where the plan is")) : null;
  // A Battle Royale card (F105, the user, 14 November 2026): its provider's name and a Battle Royale tag over the title, in neon (board.css).
  const battleHead = t.battle ? el("div", { className: "battle-head" },
    el("span", { className: "battle-provider", textContent: t.provider === "codex" ? "Codex" : ACP_NAMES[t.provider] || "Claude" }),
    el("span", { className: "battle-tag", textContent: "Battle Royale" })) : null;
  const node = el("div", { className: "card" + (parent ? " child" : "") + (run ? " master" : "") },
    battleHead, title, chipRow, doing, orchLine, projectLine, councilLine, planRow, step, waiting, queued, held, interrupted,
    t.launchError ? el("div", { role: "alert", textContent: `Launch failed: ${t.launchError}` }) : null,
    el("details", { open: detailOpen.has(t.id), ontoggle(e) { this.open ? detailOpen.add(t.id) : detailOpen.delete(t.id); } }, el("summary", { textContent: "Session details" }), el("div", { className: "muted meta", textContent: meta(t) }),
      t.controller ? el("div", { className: "muted", textContent: `Controller: external session ${t.controller.sessionId} (last request ${clock(t.controller.at)})` }) : null,
      t.runPolicy ? el("div", { className: "muted", textContent: `Run permissions: ${JSON.stringify(t.runPolicy)}` }) : null,
      ...agentOptions, efficiencyView(t), measurementView(t.measurement), timelineView(t), report),
    promptList, reply, (isAcpTask(t) || t.cardTerminal) && t.worktree ? cardTerminals?.view(t) : null, deliveryLine(t), terminalInputLine(t), cost, agentList, completionView(t), doneReviewView(t), el("div", { className: "row" }, ...actions), followUp, runRow, runChildren);
  node.dataset.task = t.id;
  node.dataset.status = t.status; // the stripe colour (board.css); needs-input is the loud one
  node.dataset.provider = t.provider || "claude"; // the top edge in the provider's colour
  if (t.battle) node.dataset.battle = t.battle; // F105: the neon look (board.css)
  node.setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "entomaticalTask", taskId: t.id, entomaticalOwn: own && !firstTurn && !(t.headless && !t.takenOver), entomaticalDone: t.status === "done", entomaticalCanSwitch: t.status !== "done", entomaticalAsana: !!state.asana && t.status !== "done", entomaticalObsidian: (!!state.obsidian && state.contextSource === "obsidian" || !!t.obsidian) && t.status !== "done", entomaticalCanMerge: !!t.worktree && !t.adopted && !live, entomaticalCanFinish: !!t.worktree && !t.adopted,
    entomaticalMaster: !!run, entomaticalPaused: !!t.paused,
    // F117: Make orchestrator, for a card of the user's own that is not one yet (Board.makeOrchestratorRefusal asks the same and decides).
    entomaticalCanOrchestrate: state.orchestratorEnabled !== false && !t.orchestrator && !t.openedBy && !t.planRun && !t.workflow && !t.battle && !t.role && !t.council && !t.governedBy && t.status !== "done",
    preventDefaultContextMenuItems: true }));
  return node;
}
// The Done column's footer (F75): runs Archive run moved to .entomatical/archive, by title and date, each with its report and Restore.
function archivedRuns() {
  const runs = state.archived || [];
  if (!runs.length) return null;
  return el("details", { className: "archived" }, el("summary", { textContent: `Archived runs (${runs.length})` }),
    ...runs.map((r) => el("div", { className: "row" },
      el("span", { className: "muted", textContent: [r.title, formatHostDate(r.archivedAt, state, "toLocaleDateString"), r.cards + " cards"].join(" · ") }),
      button("Open report", () => send("archivedReport", { key: r.key }), "The run report as a document: the final reply, each card's outcome and cost, and where the plan is"),
      button("Export", () => send("exportRun", { key: r.key }), "The run's export as JSON: exact specification, settings, profile, harness, source and review identities, retained evidence with its gaps, and tokens by role (unknown stays unknown); secrets redacted"),
      button("Restore", () => send("restoreRun", { key: r.key }), "Put this run's cards back on the board, in Done"))));
}
// A run's children sit under the master's run row unless they need attention or a plan step is held.
const runOpen = new Set(); // masters whose children are shown
const approvalDrafts = new Map(); // card id -> what the user typed or ticked in its plan-approval row, by control aria-label
const openWhy = new Set(); // "<card id> <profile ref>" of the blocked-profile reasons open in a plan-approval row
// Under a Done run only its Done cards stay folded in the run row; an unfinished one goes back to its own column, where it can be
// seen and closed (25 November 2026: three Review cards were out of sight under Done plans).
const hiddenInRun = (c, m) => c.status !== "needs-input" && !c.interrupted && !c.takenOver && !c.held && !c.asked && (m?.status !== "done" || c.status === "done");
function hiddenChildren() {
  const ids = new Set();
  for (const m of state.tasks) if (m.run) for (const c of m.run.children) if (hiddenInRun(c, m)) ids.add(c.id);
  return ids;
}

// An orchestrator or plan card whose own turn ended (status review) while its cards still work stays in Running (F75): how many are
// still active under it, or 0 when it belongs in Review. Display only; the stored status is untouched. Review stays for a card that
// asks the user something, is interrupted or has declared ready. Blocked queued cards, cancelled and discarded cards do not count.
function waitingOnCards(t, tasks) {
  if (t.status !== "review" || !(t.orchestrator || t.planRun) || t.asks || t.interrupted || t.deliveryReady) return 0;
  let n = 0;
  const seen = new Set([t.id]);
  const visit = (id) => {
    for (const c of tasks) {
      if (c.parentId !== id || seen.has(c.id)) continue;
      seen.add(c.id);
      if (!c.cancelled && !c.discarded && (c.status === "running" || c.status === "needs-input" || (c.status === "queued" && !c.blocked))) n++;
      visit(c.id);
    }
  };
  visit(t.id);
  return n;
}
let waitingOn = new Map(); // task id -> waitingOnCards, worked out once per draw

// Quiet (F80): no observed session or subagent activity for 10 minutes; orange from 20.
// Not for found sessions (the host sends no lastEventAt for them). The minute timer below redraws it as the minutes go by.
const QUIET_FROM = 10, QUIET_LATE = 20;
const quietMinutes = (t) => (t.status === "running" && !t.resuming && typeof t.lastEventAt === "number" ? Math.max(0, Math.floor((Date.now() - t.lastEventAt) / 60000)) : -1);
// Phase 3: a governed root says its leases and limits; a member says its run, profile, assignment and submission. Text, not colour.
function governedChip(t) {
  const v = t.governedView;
  if (!v) return null;
  if (v.isRoot) return el("span", { className: "chip", textContent: `Governed · ${v.active} of ${v.limit} active`,
    title: `Governed run: at most ${v.limit} sessions at once, ${v.directChildren} direct children per card, depth ${v.depth}. Children may use ${v.allowed.join(", ")}${v.defaultChild ? ` (default ${v.defaultChild})` : " (no default)"}. Only your Finish reaches the target, after the readiness check; delivery and finish self stay off.` });
  if (v.council) return el("span", { className: "chip", textContent: `Council member ${v.council.member} · ${v.council.checkpoint} round ${v.council.round}`,
    title: `Read-only review of one fixed council package for governed run ${v.root}. Its judgment counts only if its worktree stays unchanged; it opens no cards.` });
  return el("span", { className: v.missing || v.conflict ? "chip asks" : "chip", textContent: v.conflict ? `Governed · conflict in ${v.conflict.join(", ")}` : v.integrated ? `Governed · integrated ${v.integrated.slice(0, 7)}` : v.submitted ? `Governed · submitted ${v.submitted.slice(0, 7)}` : `Governed · ${v.root}`,
    title: `${v.missing ? `Governed run ${v.root} has no root on the board; this card is blocked. ` : `Card of governed run ${v.root}. `}Profile ${v.profile || "none"}${v.key ? `; assignment ${v.key}` : ""}${v.lease ? "; holds an execution lease" : ""}. Merge integrates its submitted commit into its opener's branch after the readiness check; it never reaches the target by itself.` });
}
function quietChip(t) {
  const m = quietMinutes(t);
  if (m < QUIET_FROM) return null;
  return el("span", { className: "chip quiet" + (m >= QUIET_LATE ? " late" : ""), textContent: `Quiet ${m} min`, title: "Minutes since the last observed session or subagent activity. A long tool call can be quiet while still running." });
}
// The efficiency summary (F77) from the call ledger: prompts, calls, calls per prompt, mean and last context, and the correction tail
// (tokens on prompts after the first Stop). No numbers until the ledger has the session: a Codex card, or one not indexed yet.
const kilo = (x) => (x >= 10000 ? Math.round(x / 1000) + "k" : x >= 1000 ? Math.round(x / 100) / 10 + "k" : String(x));
function efficiencyView(t) {
  if (!t.sessionId) return null;
  const e = t.efficiency;
  if (!e) return el("div", { className: "muted", textContent: "No ledger data yet", title: "The call ledger covers Claude sessions and reads them every 30 seconds" });
  const checks = t.checks?.status === "complete" ? " · checks passed" : t.checks?.status === "error" ? " · checks failed" : t.checks?.status === "running" ? " · checks running" : "";
  return el("div", { className: "muted efficiency", textContent: `${e.prompts} prompts · ${e.calls} calls · ${e.perPrompt}/prompt · ctx ${kilo(e.meanContext)} mean, ${kilo(e.endContext)} end · tail ${e.tail}%${checks}`,
    title: "From the call ledger: calls per prompt, mean context per call (input + cache read + cache write), the last call's context, and the share of tokens spent on prompts after the first Stop. node ~/.entomatical/ledger/ledger.js summary <session> has the per-prompt table." });
}

// Seconds since the live line's event, as "12 s" or "3 min" (plain concatenation: not board text).
const secondsAgo = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + " s" : Math.round(s / 60) + " min"; };
// The card's last twenty events, one line each (F70): the drawer's timeline.
function timelineView(t) {
  if (!t.timeline?.length) return null;
  return el("details", { className: "timeline" }, el("summary", { textContent: "Timeline" }), ...t.timeline.map((l) => el("div", { className: "muted", textContent: l.text })));
}

// A plan step (workflow.ts): "Ready", a dependency wait ("Needs accepted result of …"), a resource wait ("Waiting for external worker"), a policy
// blocker ("Awaiting resolution of …"), or its attempt. The outcome line is the step's, never the column's: Review or Done do not accept it.
function stepView(t) {
  const w = t.workflow, r = t.readiness || { state: "ready", text: "Ready" };
  const actions = [];
  if (w.scope && /scope review/.test(r.text)) actions.push(button("Approve scope", () => send("approveScope", { id: t.id }), "Remember the owner's authorization of exactly this scope, for one dispatch."));
  if (w.attempt) actions.push(button("Record result", () => send("closeStep", { id: t.id }), "Say how this step went: accepted, held, failed or cancelled. It frees what the step was holding. Only accepted lets the steps waiting for it start."));
  return el("div", { className: "step" },
    el("div", { className: "readiness " + r.state, textContent: r.text }),
    el("div", { className: "muted", textContent: `Outcome: ${w.outcome}${w.attempt ? ` · attempt ${w.attempt}` : ""}${w.receipt ? ` · receipt ${w.receipt}` : ""}${w.resources.length ? ` · holds ${w.resources.join(", ")}` : ""}` }),
    t.dependsOn?.length ? el("div", { className: "muted", textContent: `Depends on: ${t.dependsOn.map((id) => state.tasks.find((d) => d.id === id)?.title ?? id).join(" · ")}` }) : null,
    actions.length ? el("div", { className: "row" }, ...actions) : null);
}

// The task's completion rule and its latest acceptance-check run.
function completionView(t) {
  const c = t.completion, run = t.checks;
  if (!c?.doneWhen && !c?.commands?.length) return null;
  // While running too: a check that never exits (a dev server, an open handle) would otherwise hold Finish, Merge and Discard for good.
  const retry = run?.status === "error" || run?.status === "running" ? button("Retry checks", () => send("checksRetry", { id: t.id })) : null;
  if (retry) retry.className = "secondary";
  // A failed check names what failed and shows why (the lines naming the failure, then the end of its output), with Fix it.
  const f = run?.status === "error" ? run.failure : undefined;
  const fix = f ? button("Fix it", () => send("checksFix", { id: t.id }), "Send this failure to the task's session and ask it to fix the cause. The checks run again when its work comes back to Review.") : null;
  const readout = f && (f.lines.length || f.tail) ? el("details", { className: "check-failure" },
    el("summary", { textContent: "What failed" }),
    f.lines.length ? el("pre", { textContent: f.lines.join("\n") }) : null,
    f.tail ? el("div", { className: "muted", textContent: "End of its output" }) : null,
    f.tail ? el("pre", { textContent: f.tail }) : null) : null;
  return el("div", { className: "completion" },
    c.doneWhen ? el("div", { textContent: `Done when: ${c.doneWhen}`, title: c.goal || "" }) : null,
    c.writer ? el("div", { className: "muted", textContent: `Done when written by ${c.writer}${c.effort ? ` · ${c.effort} effort` : ""}.` }) : null,
    c.haiku || c.opus ? rulesPanel(t) : null,
    c.commands?.length ? el("div", { className: "muted", textContent: `Checks: ${c.commands.join(" · ")}` }) : null,
    run ? el("div", { className: run.status === "error" ? "error" : "muted", title: run.run ? `Logs: ${run.run}` : "",
      textContent: run.status === "running" ? "Acceptance checks running…" : run.status === "complete" ? "Acceptance checks passed." : run.error }) : null,
    readout, fix || retry ? el("div", { className: "row" }, fix, retry) : null);
}

// F97: a running review, its error, or the last verdict with the findings, the prompt for the session and the reviewer's questions.
const reviewOpen = new Map(); // card -> review panel opened or closed by hand; survives redraws. Untouched, a Not done or Unsure opens itself.
const reviewAnswers = new Map(); // review receipt -> typed answers to its questions: a newer review's questions start from its own suggestions
const readOnlyBox = (text, label) => el("textarea", { readOnly: true, rows: Math.min(24, text.split("\n").length + 2), value: text, ariaLabel: label });
// F97 section 9: an orchestrator's self-finish, while its request stands (the step it is on or stopped at), its error, or its report.
function doneReviewView(t) {
  const sf = t.selfFinish, panel = reviewPanel(t);
  if (!sf || !(sf.report || sf.error || t.finishAsked)) return panel;
  return el("div", {}, el("div", { className: "completion" },
    sf.step ? el("div", { className: "muted", role: "status", textContent: `Finishing: ${sf.step}` }) : null,
    sf.error ? el("div", { className: "error", role: "alert", textContent: sf.error }) : null,
    sf.report ? button("Open report", () => send("openReview", { id: t.id, kind: "report" })) : null,
    sf.error ? showLogButton(t) : null), panel);
}
// F103: a review or an automatic finish that did not complete is in the error log; Show log opens the Entomatical Output channel.
const showLogButton = (t) => button("Show log", () => send("showErrorLog", { id: t.id }), "Open the Entomatical Output channel, where each Review or Finish that did not complete is logged");
function reviewPanel(t) {
  const run = t.doneReviewRun, r = t.doneReview;
  if (run) {
    if (run.error) return el("div", { className: "completion" }, el("div", { className: "error", role: "alert", textContent: run.error }),
      button("Dismiss", () => send("dismissReview", { id: t.id })), showLogButton(t));
    return el("div", { className: "completion" },
      el("div", { className: "muted", role: "status", textContent: run.model ? `Reviewing… (${run.model} · ${run.effort} effort)` : "Reviewing… (the agent's default model)" }),
      el("div", { className: "row" }, showProgress(run.requestId), button("Cancel review", () => send("cancelReview", { id: t.id }))));
  }
  if (!r) return null;
  const word = r.verdict === "done" ? "Done" : r.verdict === "not-done" ? "Not done" : "Unsure";
  const kids = [el("summary", { textContent: `Review: ${word}` })];
  if (t.reviewFindings) kids.push(el("label", {}, "Review findings", readOnlyBox(t.reviewFindings, "Review findings")));
  if (r.verdict === "not-done" && r.prompt) kids.push(el("label", {}, "Prompt for the session", readOnlyBox(r.prompt, "Prompt for the session")));
  const row = [];
  if (r.verdict === "not-done" && !r.sent) row.push(button("Accept prompt", () => send("acceptReview", { id: t.id }), "Send this prompt to the card's session"));
  if (r.sent === "copied") kids.push(el("div", { className: "muted", textContent: "On the clipboard: paste it into the session." }));
  else if (r.sent) kids.push(el("div", { className: "muted", textContent: "Sent to the session." }));
  if (r.verdict === "unsure" && r.questions?.length) {
    const saved = reviewAnswers.get(r.receipt) || [];
    const boxes = r.questions.map((q, i) => {
      const box = el("textarea", { rows: 2, value: saved[i] ?? q.suggested ?? "", ariaLabel: q.question });
      box.dataset.reviewAnswer = JSON.stringify([t.id, r.receipt, i]);
      box.oninput = () => { saved[i] = box.value; reviewAnswers.set(r.receipt, saved); };
      kids.push(el("label", {}, q.question, box)); return box;
    });
    // The host refuses a review of a card not in Review (canReview): the button waits, and the typed answers stay (reviewAnswers).
    const sendAnswers = button("Send answers", () => send("reviewWork", { id: t.id, answers: answerText(r, boxes) }), "The reviewer reviews this card again with your answers");
    sendAnswers.disabled = !!t.reviewBlocked;
    row.push(sendAnswers);
    if (t.reviewBlocked) kids.push(el("div", { className: "muted", textContent: `Send answers is off: ${t.reviewBlocked} Your answers are kept.` }));
  }
  row.push(button("Open findings", () => send("openReview", { id: t.id, kind: "findings" }), "Open the review's findings, reasoning and prompt in an editor tab"));
  kids.push(el("div", { className: "row" }, ...row));
  return el("div", { className: "completion" }, el("details", { className: "rules", open: reviewOpen.get(t.id) ?? r.verdict !== "done", ontoggle(e) { reviewOpen.set(t.id, e.target.open); } }, ...kids));
}

// Historical comparisons remain readable on cards created before single-model completion rules.
const rulesOpen = new Set(); // cards whose panel is open; survives redraws
const yesNo = (b) => (b ? "yes" : "no");
function rulesText(c) {
  const rule = (name, r) => !r ? `${name}: no rule.` : r.error ? `${name} could not write a rule: ${r.error}`
    : [`${name} (${r.model}):`, `Goal: ${r.goal}`, `Done when: ${r.doneWhen}`, `Checks: ${r.commands.length ? r.commands.join(" · ") : "none"}`].join("\n");
  const j = c.judgment, rv = c.review;
  const before = !j ? "" : j.error ? `Fable could not compare the rules: ${j.error}` : [`Fable before the start (${j.model}): used ${j.pick === "opus" ? "Opus" : "Haiku"}'s rule. Haiku good enough: ${yesNo(j.haikuGoodEnough)}.`, j.verdict].join("\n");
  const after = !rv ? "Fable at Review: not yet. It judges once the work reaches Review and its checks have run."
    : rv.error ? `Fable could not review the rules: ${rv.error}` : [`Fable at Review (${rv.model}): Haiku good enough: ${yesNo(rv.haikuGoodEnough)}.`, rv.checks, rv.verdict].join("\n");
  return [rule("Haiku", c.haiku), rule("Opus", c.opus), before, after].filter(Boolean).join("\n\n");
}
function rulesPanel(t) {
  const text = rulesText(t.completion);
  return el("details", { className: "rules", open: rulesOpen.has(t.id), ontoggle(e) { if (e.target.open) rulesOpen.add(t.id); else rulesOpen.delete(t.id); } },
    el("summary", { textContent: "Previous completion-rule comparison" }),
    el("textarea", { readOnly: true, rows: Math.min(24, text.split("\n").length + 2), value: text, ariaLabel: "Completion rules and Fable's verdicts" }));
}

const detailOpen = new Set();
const profileOpen = new Set(); // cards whose blocked-profile chip is open
let drawnColumns; // columnsKey of the state the columns were last drawn from
// fromHost: a state message. It leaves the columns alone when their part of the state is unchanged (the 15-second usage re-post).
function render(fromHost = false) {
  renderAccounts();
  renderModels();
  errorBox.textContent = state.error || "";
  const parent = state.tasks.find((t) => t.id === parentId);
  if (snapshotReady && parentId && !parent) parentId = null;
  const clearParent = () => { parentId = ""; render(); saveDrafts(); };
  subtaskOf.replaceChildren(...(parent ? [`Subtask of ${parent.title} `, button("×", clearParent, "Not a subtask"), el("span", { textContent: "This subtask is grouped under another card. You control its lifecycle." })]
    : parentId === null ? [button("Use no parent", clearParent)] : []));
  // Rebuilt only when the list changes, so an open dropdown is not closed by a status update.
  if (snapshotReady && draftAccount && !state.accounts.includes(draftAccount)) draftAccount = null;
  const names = JSON.stringify([state.accounts, state.activeAccount, state.externalProviders, draftAccount === null]);
  if (accountBox.dataset.names !== names) {
    const chosen = accountBox.value;
    const options = (names) => names.map((a) => el("option", { value: a, textContent: a }));
    const groups = [["Claude", state.accounts.filter((a) => !isCodex(a) && !externalProvider(a))],
      ["Codex", state.accounts.filter(isCodex)], ["Grok", state.accounts.filter((a) => externalProvider(a) === "grok")],
      ["Antigravity", state.accounts.filter((a) => externalProvider(a) === "antigravity")]].filter(([, names]) => names.length);
    const placeholder = !groups.length || draftAccount === null ? el("option", { value: "", textContent: "Select account" }) : null;
    const choices = groups.length === 1 ? options(groups[0][1]) : groups.map(([label, names]) => el("optgroup", { label }, ...options(names)));
    accountBox.replaceChildren(...(placeholder ? [placeholder, ...choices] : choices));
    const changedDefault = accountBox.dataset.active !== (state.activeAccount || "");
    accountBox.value = draftAccount !== undefined ? draftAccount || "" : changedDefault && state.accounts.includes(state.activeAccount) ? state.activeAccount
      : state.accounts.includes(chosen) ? chosen : state.activeAccount || state.accounts[0] || "";
    accountBox.dataset.active = state.activeAccount || "";
    accountBox.dataset.names = names;
  }
  if (state.orchestratorEnabled === false) orchestrator.box.checked = false;
  syncChoices();
  syncAsana();
  syncProfiles();
  syncObsidian();
  syncDraftBlock();
  orchestrator.label.hidden = !!selectedPlan || state.orchestratorEnabled === false;
  battleButton.hidden = !state.battleRoyale; // entomatical.battleRoyale.enabled
  battleButton.title = BATTLE_TIPS[battleRound % BATTLE_TIPS.length](battleSize());
  if (!state.battleRoyale) closeBattle(battleStep === 2); // switched off while the popup is open
  paintAsanaButton();
  updateRefinementControls();

  const drawing = columnsKey(state);
  if (fromHost && drawing === drawnColumns) return;
  // A background workbench retains its active textarea. Carry that field and its selection across a redraw.
  const active = document.activeElement;
  const terminalFocus = active?.closest?.(".xterm")?.closest(".card-terminal")?.dataset.terminalTask;
  const focused = active?.closest?.(".card")?.dataset.task;
  const field = ["data-draft-target", "data-refine-focus", "data-review-answer"].find(attr => active?.matches?.(`textarea[${attr}]`));
  const planFocus = active?.closest?.(".plan") ? active.ariaLabel || active.textContent : undefined; // a control of a plan-approval row
  const selection = field && [active.selectionStart, active.selectionEnd, active.selectionDirection];
  const page = document.scrollingElement, scrolled = page?.scrollTop;
  // Newest first, one column at a time: a child sits right after its parent only when both are in the column, otherwise it is ranked on its own.
  const byNewest = (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const hiddenIds = hiddenChildren();
  waitingOn = new Map(state.tasks.map((t) => [t.id, waitingOnCards(t, state.tasks)]));
  const columnOf = (t) => (waitingOn.get(t.id) ? "running" : t.status);
  const drawn = COLUMNS.map(([key, label]) => {
    const here = state.tasks.filter((t) => columnOf(t) === key && !hiddenIds.has(t.id));
    const cards = [];
    const visit = (t) => { cards.push(t); here.filter((c) => c.parentId === t.id).sort(byNewest).forEach(visit); };
    here.filter((t) => !here.some((p) => p.id === t.parentId)).sort(byNewest).forEach(visit);
    const head = el("h3", { textContent: `${label} (${cards.length})` });
    head.dataset.status = key; // Needs input's header turns its colour while it holds cards (board.css)
    head.dataset.count = cards.length;
    // A column with nothing to show shrinks to its header, so the columns that do have cards share the width.
    if (key !== "done") return el("section", { className: "column" + (cards.length ? "" : " empty") }, head, ...cards.map(card));
    const box = el("details", { className: "column", open: doneOpen }, el("summary", {}, head), ...cards.map(card), archivedRuns());
    // The header opens and closes the column, so it carries the cue the hidden marker used to give: ▸ closed, ▾ open.
    const cue = () => {
      head.textContent = `${box.open ? "▾" : "▸"} ${label} (${cards.length})`;
      box.classList.toggle("empty", !box.open || (!cards.length && !(state.archived || []).length));
    };
    cue();
    box.ontoggle = () => { doneOpen = box.open; cue(); };
    return box;
  });
  // Three stacks (STACKS): in a panel too narrow for five columns each stack is one column of the page, so Review sits right under
  // Needs input instead of below the tallest column of the row above. At full width a stack draws nothing of its own (board.css).
  let next = 0;
  columns.replaceChildren(...STACKS.map((size) => el("div", { className: "stack" }, ...drawn.slice(next, next += size))));
  drawnColumns = drawing;
  for (const box of columns.querySelectorAll("textarea[data-draft-target]")) grow(box);
  if (field) {
    const box = columns.querySelector(`textarea[${field}="${CSS.escape(active.getAttribute(field))}"]`);
    if (box) { box.focus({ preventScroll: true }); box.setSelectionRange(...selection); }
  }
  if (terminalFocus) cardTerminals?.focus(terminalFocus);
  if (document.hasFocus() && active?.matches(".card-terminal-header button") && active.isConnected) active.focus({ preventScroll: true });
  if (planFocus && focused) [...columns.querySelectorAll(`.card[data-task="${focused}"] .plan :is(input, select, button, summary)`)]
    .find((e) => (e.ariaLabel || e.textContent) === planFocus)?.focus({ preventScroll: true });
  if (page) page.scrollTop = scrolled;
}

window.addEventListener("message", (e) => {
  if (cardTerminals?.message(e.data)) return;
  if (e.data.refinement) {
    const r = e.data.refinement, current = refinements.get(r.target);
    if (!current || current.requestId !== r.requestId) return;
    // A reload already marked it interrupted; the cancel the reload caused must not replace that message (second review, item 2).
    if (r.error && !current.pending) return;
    // A failed "Use answers" round gives its questions and typed answers back (F59-6); a late result clears an earlier error (F19-3).
    if (r.error && current.previous) refinements.set(r.target, { ...current.previous, notice: `${r.error} Your answers are kept.` });
    else { const { previous, ...rest } = current; refinements.set(r.target, { ...rest, ...r, error: r.error, pending: false }); }
    saveDrafts(); refreshRefinement(r.target); return;
  }
  if (e.data.refinementMode) {
    const s = e.data.refinementMode, current = refinements.get(s.target);
    if (current?.pending && current.requestId === s.requestId) { current.handoff = s.handoff; saveDrafts(); refreshRefinement(s.target); }
    return;
  }
  if (e.data.compilationStage) {
    const s = e.data.compilationStage, current = compilations.get(s.target);
    if (current?.pending && current.requestId === s.requestId) { current.stage = s.stage; saveDrafts(); refreshRefinement(s.target); }
    return;
  }
  if (e.data.compilation) {
    const c = e.data.compilation, current = compilations.get(c.target);
    if (!current || current.requestId !== c.requestId) return;
    if (c.error && !current.pending) return;
    compilations.set(c.target, { ...current, ...c, error: c.error, pending: false });
    saveDrafts(); refreshRefinement(c.target); return;
  }
  if (e.data.cardAction) {
    const { type, id } = e.data.cardAction;
    if (type === "subtask") { parentId = id; render(); saveDrafts(); promptBox.focus(); }
    // Entomatical: Review Prompt (Experimental): the draft box it was opened on, or the new-task box.
    if (type === "reviewPrompt") requestReview(id && (id === "new" || drafts.has(id)) ? id : "new");
    if (type === "followUp" && !pendingSends.has(id)) {
      if (drafts.has(id)) drafts.delete(id); else drafts.set(id, "");
      saveDrafts(); render(); document.querySelector(`textarea[data-draft-target="${id}"]`)?.focus();
    }
    return;
  }
  if (e.data.sent) {
    const { sent: id, sendId } = e.data;
    if (!pendingSends.has(id) || pendingSends.get(id) !== sendId) return;
    pendingSends.delete(id); drafts.delete(id); clearRefinement(id); clearCompilation(id); saveDrafts(); render(); return;
  }
  if (e.data.created) { if (pendingCreates.delete(e.data.created)) saveDrafts(); return; }
  if (e.data.accountActionComplete) { switchingAccount = undefined; renderAccounts(); return; }
  if (e.data.selectedPlan) {
    if (!planSetup) return;
    selectedPlan ||= { draft: promptBox.value, account: accountBox.value, model: modelBox.dataset.want, effort: effortBox.dataset.want, permission: permissionBox.dataset.want, orchestrator: orchestrator.box.checked, planFirst: planFirst.box.checked, cardTerminal: cardTerminal.box.disabled ? cardTerminal.box.dataset.was === "true" : cardTerminal.box.checked, profile: profileBox.dataset.want };
    try { planSetup.load(e.data.selectedPlan, state); taskForm.hidden = true; saveDrafts(); planSetup.element.focus(); }
    catch (error) { send("cancelPlan"); leavePlan(); errorBox.textContent = `Cannot load this plan: ${error.message}`; }
    return;
  }
  if (e.data.planValidation) { planSetup?.validation(e.data.planValidation); return; }
  if (e.data.planPresets) { if (e.data.planPresets.selectionId === planSetup?.getSelection()?.selectionId) planSetup.setPresets(e.data.planPresets.presets); return; }
  if (e.data.planStarted) { leavePlan(); return; }
  if (e.data.planReady) { if (selectedPlan && planSetup) planSetup.setDraft(planSetup.getDraft()); return; }
  if (e.data.failed) {
    if (e.data.failed.type === "accountUse") { switchingAccount = undefined; renderAccounts(); }
    // The extension refused it: put the text back where it was typed.
    const m = e.data.failed;
    if (m.type === "create" && m.createId) {
      const pending = pendingCreates.get(m.createId);
      if (!pending) return;
      pendingCreates.delete(m.createId);
      const entry = { message: pending.message, issue: e.data.createContextIssue, compilation: pending.compilation, refinement: pending.refinement };
      if (m.createId === latestCreate && !selectedPlan && pending.emptyForm === createFormKey()) restoreCreate(entry);
      else { refusedCreates.set(m.createId, entry); saveDrafts(); }
    } else if (m.type === "create" || m.type === "battle") {
      pendingTitle = typeof m.title === "string" ? m.title : ""; promptBox.value = m.prompt || ""; parentId = m.parentId || ""; grow(promptBox);
      if (battleSubmitted?.compilation && !compilations.has("new")) compilations.set("new", battleSubmitted.compilation);
      if (battleSubmitted?.refinement && !refinements.has("new")) refinements.set("new", battleSubmitted.refinement);
      battleSubmitted = undefined; saveDrafts(); render(); refreshRefinement("new");
    }
    if (m.type === "send" && pendingSends.has(m.id) && pendingSends.get(m.id) === m.sendId) {
      pendingSends.delete(m.id); bounced.add(m.id); returnBounced(); saveDrafts(); render();
    }
    return;
  }
  // Battle Royale's popup (F105): the host's answer to battlePrepare or battleWarn. A refusal closes the popup and says why under the form.
  if (e.data.battleReady) {
    const r = e.data.battleReady;
    if (battleStep && state.battleRoyale?.clearArena !== false) { battleCount.textContent = `Cards to shut down: ${r.cards} · runs: ${r.runs}`; battleCount.hidden = false; }
    return;
  }
  if ("battleRefused" in e.data) {
    closeBattle(false);
    battleNote.textContent = String(e.data.battleRefused || ""); battleNote.hidden = !battleNote.textContent;
    return;
  }
  if (typeof e.data.insertPrompt === "string") {
    // Load handoff (F101): the picked doc's text, under a "<!-- handoff: <path> -->" line, replaces the prompt box. Nothing is started.
    if (selectedPlan) { send("cancelPlan"); leavePlan(); }
    promptBox.value = e.data.insertPrompt; grow(promptBox); promptBox.focus(); saveDrafts();
    return;
  }
  if ("dictating" in e.data) { recording = e.data.dictating || ""; if (!recording) liveText = ""; paintMics(); return; }
  const live = typeof e.data.dictatedLive === "string";
  if (live || typeof e.data.dictated === "string") {
    // Dictation: append the text to the box the mic was pressed for. Live text (Parakeet) replaces the live text before it, and the final text replaces that.
    const box = draftBox(dictateInto) || promptBox; // its follow-up box was closed meanwhile: keep the text where it can be seen
    const text = live ? e.data.dictatedLive : e.data.dictated;
    // Typed after the live text meanwhile: nothing is removed, the new text is appended.
    const head = (liveText && box.value.endsWith(liveText) ? box.value.slice(0, -liveText.length) : box.value).trimEnd();
    box.value = (head ? head + " " : "") + text;
    liveText = live ? text : "";
    box.dispatchEvent(new Event("input"));
    box.focus();
    return;
  }
  state = e.data;
  snapshotReady = !state.error;
  if (selectedPlan && planSetup) {
    const choices = JSON.stringify([state.accounts, state.codex, state.externalProviders, state.acpCatalogs, (state.tasks || []).map((t) => [t.id, t.title])]);
    if (choices !== planSetup.element.dataset.choices) { planSetup.element.dataset.choices = choices; planSetup.updateState(state); }
  }
  cardTerminals?.prune(state.tasks || []);
  returnBounced();
  forgetDeleted();
  document.body.classList.toggle("no-dictation", !state.dictation);
  render(true);
  saveDrafts();
  paintMics();
});
// Keep an unavailable card's text copyable even while the operator is using the new-task form or plan setup.
function returnBounced() {
  for (const id of bounced) {
    const row = [...unsentFollowUps.children].find((r) => r.dataset.card === id);
    if (!drafts.has(id) || canFollowUp(state.tasks.find((t) => t.id === id))) {
      row?.remove();
      if (!drafts.has(id)) bounced.delete(id);
      continue;
    }
    const r = refinements.get(id), c = compilations.get(id);
    if (!selectedPlan && !promptBox.value && !refinements.has("new") && !compilations.has("new") && !r?.pending && !c?.pending) {
      promptBox.value = drafts.get(id);
      if (r) refinements.set("new", r);
      if (c) compilations.set("new", c);
      drafts.delete(id); refinements.delete(id); compilations.delete(id); bounced.delete(id); row?.remove();
      grow(promptBox); refreshRefinement("new");
      if (document.activeElement === document.body) promptBox.focus();
    } else if (!row) {
      const label = `Unsent follow-up for ${id}`;
      const recovered = el("div", {}, el("label", {}, label, el("textarea", { readOnly: true, ariaLabel: label, value: drafts.get(id) })),
        button("Dismiss", () => {
          bounced.delete(id); drafts.delete(id); clearRefinement(id); clearCompilation(id);
          recovered.remove(); unsentFollowUps.hidden = !unsentFollowUps.childElementCount; saveDrafts();
        }));
      recovered.dataset.card = id; unsentFollowUps.append(recovered);
    }
  }
  unsentFollowUps.hidden = !unsentFollowUps.childElementCount;
}
// Delete removes a card for good: drop what the webview kept for it, and cancel its refine or Improve still running.
function forgetDeleted() {
  if (state.error) return; // no board: nothing was deleted
  const kept = new Set(state.tasks.map((t) => t.id));
  const gone = (id) => id !== "new" && !kept.has(id) && !pendingSends.has(id) && !bounced.has(id);
  let changed = false;
  for (const id of [...refinements.keys()].filter(gone)) { clearRefinement(id); changed = true; }
  for (const id of [...compilations.keys()].filter(gone)) { clearCompilation(id); changed = true; }
  for (const map of [drafts, agentToggle]) for (const id of [...map.keys()].filter(gone)) { map.delete(id); changed = true; }
  for (const set of [openPrompts, showAll, detailOpen, runOpen]) for (const id of [...set].filter(gone)) set.delete(id);
  if (changed) saveDrafts();
}
send("ready", { planSetupOpen: savedDrafts.planSetupOpen === true });
