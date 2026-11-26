// Run-only plan setup. The extension host owns validation and execution; text is never parsed as HTML.
(() => {
  const fields = ["account", "model", "effort", "permission"];
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const node = (tag, props = {}, ...children) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children.filter((c) => c != null)); return e;
  };
  window.createPlanSetup = ({ send, onCancel }) => {
    const element = node("section", { className: "plan-setup", ariaLabel: "Run a plan setup", hidden: true, tabIndex: -1 });
    let selection, state = {}, draft, revision = 0, result, pending = false, bulk = false, graph, presets, presetList = [], presetKey = "";
    let activeTab = "setup", reviewOpen = false, rolesOpen = false, sourceOpen = false;
    const tabs = [["setup", "Setup"], ["steps", "Steps"], ["dependencies", "Dependencies"], ["presets", "Presets"]];
    let scribeDocuments = "", scribeMilestones = "";
    const graphBox = node("section", { className: "plan-setup-section" });
    const presetsBox = node("section", { className: "plan-setup-section" });
    const opened = new Set();
    const accounts = () => (state.accounts || []).map((a) => typeof a === "string" ? a : a.name).filter(Boolean);
    const defaultAccount = () => accounts().find((a) => !(state.codex?.accounts || []).includes(a) && !state.externalProviders?.[a]) || accounts()[0] || "";
    const resolveAccount = (value) => {
      if (!value) return defaultAccount();
      if (accounts().includes(value)) return value;
      const key = value.toLowerCase();
      const matches = accounts().filter((a) => a.toLowerCase() === key || ((state.codex?.accounts || []).includes(a) && a.replace(/^Codex\s*[·:]\s*/i, "").toLowerCase() === key) || (((state.codex?.accounts || []).includes(a) ? "codex" : state.externalProviders?.[a]) === key));
      return matches.length === 1 ? matches[0] : value;
    };
    const accountFor = (settings) => resolveAccount(settings.account || draft.defaults.account);
    function options(key, account, model) {
      const codex = (state.codex?.accounts || []).includes(account), external = state.externalProviders?.[account];
      const catalog = state.acpCatalogs?.[account];
      if (key === "account") return accounts().map((a) => [a, a]);
      if (account && !accounts().includes(account)) return [];
      if (key === "permission") return (external ? ["ask", "bypass"] : codex ? ["ask", "auto", "bypass"] : ["ask", "edits", "auto", "bypass"]).filter((p) => p !== "ask" || catalog?.ask !== null).map((v) => [v, v]);
      if (external) return catalog?.[key === "model" ? "models" : "efforts"] || [];
      if (key === "model") return codex ? (state.codex?.models || []).map((m) => [m.model, m.label && m.label !== m.model ? `${m.label} (${m.model})` : m.model]) : state.claudeModels || ["opus", "sonnet", "haiku", "fable"].map((v) => [v, v]);
      return (codex ? (state.codex?.models || []).find((m) => m.model === model)?.efforts || [] : ["low", "medium", "high", "xhigh", "max"]).map((v) => [v, v]);
    }
    function request() {
      revision++; result = undefined; pending = false; bulk = false;
      send("previewSelectedPlan", { selectionId: selection.selectionId, revision, draft: copy(draft) });
    }
    function change(set) { set(); request(); render(); }
    function sourceDraft() {
      const plan = copy(selection.raw);
      for (const key of fields) { if (draft.defaults[key]) plan[key] = draft.defaults[key]; else delete plan[key]; }
      if (plan.review === "model") {
        plan.reviewer = plan.reviewer?.permission === undefined ? {} : { permission: plan.reviewer.permission };
        for (const key of fields.slice(0, 3)) if (draft.reviewer[key]) plan.reviewer[key] = draft.reviewer[key];
      }
      if (plan.judge && draft.judge) plan.judge = draft.judge;
      if (plan.scribe && draft.scribe && typeof draft.scribe === "object") { if (draft.scribe.model) plan.scribe.model = draft.scribe.model; else delete plan.scribe.model; }
      for (const step of plan.steps) for (const key of fields) { if (draft.steps[step.id]?.[key]) step[key] = draft.steps[step.id][key]; else delete step[key]; }
      if (draft.order) plan.steps.sort((a, b) => draft.order.indexOf(a.id) - draft.order.indexOf(b.id));
      for (const step of plan.steps) if (draft.dependencies?.[step.id]) step.after = [...draft.dependencies[step.id]];
      return plan;
    }
    function graphDraft(plan) { return { order: plan.steps.map((s) => s.id), dependencies: Object.fromEntries(plan.steps.map((s) => [s.id, s.after || []])) }; }
    function confirmChanges(lines) {
      const confirmedRevision = revision;
      return new Promise((resolve) => {
        const box = node("div", { className: "plan-setup-confirm", role: "group", ariaLabel: "Confirm preset changes" }, node("p", { textContent: "Replace these existing settings?" }), node("ul", {}, ...lines.map((line) => node("li", { textContent: line }))));
        const finish = (answer) => { box.remove(); resolve(answer && revision === confirmedRevision); };
        box.append(node("button", { textContent: "Apply changes", onclick: () => finish(true) }), node("button", { textContent: "Keep current settings", onclick: () => finish(false) }));
        presetsBox.append(box); box.querySelector("button")?.focus();
      });
    }
    function mountExtras() {
      if (window.PlanGraph) {
        graph = window.PlanGraph.mount(graphBox, { plan: sourceDraft(), externalCards: state.tasks || [], expanded: result?.cards || [],
          onChange: (plan) => change(() => Object.assign(draft, graphDraft(plan))),
          onSaveAs: (plan) => send("savePlanAs", { selectionId: selection.selectionId, ...graphDraft(plan) }) });
      }
      if (window.PlanPresets) {
        presets = window.PlanPresets.mount(presetsBox, { plan: sourceDraft(), presets: presetList,
          onSave: (name, settings) => send("savePlanPreset", { selectionId: selection.selectionId, name, settings }),
          onRename: (id, name) => send("renamePlanPreset", { selectionId: selection.selectionId, id, name }),
          onDelete: async (id) => { if (await confirmChanges(["Delete this personal preset?"])) send("deletePlanPreset", { selectionId: selection.selectionId, id }); },
          confirm: (lines) => confirmChanges(lines),
          onApply: (plan) => change(() => {
            for (const key of fields) draft.defaults[key] = plan[key] || null;
            for (const key of fields.slice(0, 3)) draft.reviewer[key] = plan.reviewer?.[key] || null;
            if (plan.judge && draft.judge !== undefined) draft.judge = plan.judge;
            if (plan.scribe && draft.scribe) draft.scribe.model = plan.scribe.model || null;
            for (const step of plan.steps) for (const key of fields) draft.steps[step.id][key] = step[key] || null;
          }) });
      }
      presetKey = "";
    }
    function field(label, control, hint) {
      return node("label", { className: "plan-setup-field" }, node("span", { textContent: label }), control, hint ? node("small", { textContent: hint }) : null);
    }
    function picker(settings, key, label, inherit, account, model, visibleLabel = label) {
      // An account default is named where the host knows it: "Default: Fable 5.2" (the user, 23 November 2026).
      const known = key === "model" && state.defaultModels?.[account];
      if (known && /account default/.test(inherit)) inherit = `Default: ${known}`;
      const choices = [["", inherit], ...options(key, account, model).map((v) => Array.isArray(v) ? v : [v, v])];
      const value = settings[key] || "";
      if (value && !choices.some(([v]) => v === value)) choices.push([value, `${value} (not currently offered)`]);
      const select = node("select", { ariaLabel: label }, ...choices.map(([value, text]) => node("option", { value, textContent: text })));
      select.value = value;
      select.onchange = () => change(() => { settings[key] = select.value || null; });
      return field(visibleLabel, select);
    }
    function settingsRow(settings, prefix, step = false, reviewer = false) {
      const account = reviewer ? resolveAccount(settings.account || draft.defaults.account) : accountFor(settings);
      const model = settings.model || (!reviewer && step ? draft.defaults.model : "");
      return node("div", { className: "plan-setup-grid" }, ...(reviewer ? fields.slice(0, 3) : fields).map((key) => picker(settings, key, `${prefix} ${key}`, step ? `Use plan default (${draft.defaults[key] || (key === "permission" ? "bypass" : "account default / unknown")})` : key === "account" && reviewer ? "Use plan account" : key === "permission" ? "Default permissions (bypass)" : "Use account default", account, model, key === "permission" ? "Permissions" : key[0].toUpperCase() + key.slice(1))));
    }
    function multiline(label, value, update, hint) {
      const input = node("textarea", { ariaLabel: label, rows: 2, value });
      input.oninput = () => { update(input.value); request(); refreshSummary(); };
      return field(label, input, hint);
    }
    const section = (title, ...content) => node("section", { className: "plan-setup-section" }, node("h3", { textContent: title }), ...content);
    function selectTab(id, focus = false) {
      activeTab = id;
      for (const [key] of tabs) {
        const tab = element.querySelector(`#plan-tab-${key}`), panel = element.querySelector(`#plan-panel-${key}`);
        if (tab) { tab.setAttribute("aria-selected", String(key === id)); tab.tabIndex = key === id ? 0 : -1; }
        if (panel) panel.hidden = key !== id;
      }
      if (focus) element.querySelector(`#plan-tab-${id}`)?.focus();
    }
    function navigation() {
      const bar = node("div", { className: "plan-setup-tabs", role: "tablist", ariaLabel: "Plan setup sections" });
      for (const [index, [id, label]] of tabs.entries()) {
        const tab = node("button", { type: "button", id: `plan-tab-${id}`, role: "tab", textContent: label, tabIndex: id === activeTab ? 0 : -1 });
        tab.setAttribute("aria-controls", `plan-panel-${id}`); tab.setAttribute("aria-selected", String(id === activeTab));
        tab.onclick = () => selectTab(id);
        tab.onkeydown = (event) => {
          const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
          if (target >= 0) { event.preventDefault(); selectTab(tabs[target][0], true); }
        };
        bar.append(tab);
      }
      return bar;
    }
    function panel(id, content) {
      content.id = `plan-panel-${id}`; content.setAttribute("role", "tabpanel"); content.setAttribute("aria-labelledby", `plan-tab-${id}`); content.hidden = activeTab !== id;
      return content;
    }
    function summaryNode() {
      const errors = result?.errors || [], cards = result?.cards || [];
      const summary = section("Run summary"); summary.id = "plan-setup-summary";
      const status = pending ? "Starting plan…" : result ? errors.length ? `${errors.length} ${errors.length === 1 ? "issue" : "issues"} to resolve` : `Ready to run · ${cards.length} ${cards.length === 1 ? "step card" : "step cards"}` : "Checking this setup…";
      summary.append(node("p", { className: `plan-setup-status${errors.length ? " is-error" : result ? " is-ready" : ""}`, role: "status", textContent: status }));
      const plan = result?.plan, defaults = plan?.permission ?? "bypass";
      const roleBypass = (plan?.review === "model" && (plan.reviewer?.permission ?? "bypass") === "bypass")
        || result?.judgePermission?.permission === "bypass" || (plan?.scribe && defaults === "bypass");
      if (result && !errors.length && (roleBypass || cards.some((c) => (c.step.permission ?? defaults) === "bypass")))
        summary.append(node("p", { className: "plan-setup-permission-note", textContent: "Includes bypass permissions. Review the effective settings before running." }));
      if (plan?.deliveryChecks?.length) {
        const commands = plan.deliveryChecks.map(name => result.catalogue[name].run);
        summary.append(node("p", { textContent: `Required on the integrated commit: ${commands.join(", ")}.` }));
      }
      if (plan?.mayOpen === true) summary.append(node("p", { textContent: "The reviewer may open additional cards within this run’s limits." }));
      if (errors.length) {
        const list = node("ul", { role: "alert", ariaLabel: "Plan setup errors" });
        for (const error of errors) {
          const text = typeof error === "string" ? error : error.message || JSON.stringify(error);
          const step = selection.raw.steps?.find((s) => text.includes(`"${s.id}"`));
          const link = node("a", { href: step ? `#plan-setup-step-${step.id}` : "#plan-setup-summary", textContent: text });
          link.onclick = (event) => {
            event.preventDefault();
            if (step) { activeTab = "steps"; opened.add(step.id); const detail = document.getElementById(`plan-setup-step-${step.id}`); if (detail) detail.open = true; render(); document.getElementById(`plan-setup-step-${step.id}`)?.focus(); }
            else {
              selectTab("setup");
              const details = element.querySelector(".plan-setup-roles");
              if (/reviewer|judge|scribe/i.test(text)) {
                rolesOpen = true; if (details) details.open = true;
                const label = /reviewer/i.test(text) ? `Reviewer ${/account/i.test(text) ? "account" : /effort/i.test(text) ? "effort" : "model"}`
                  : /judge/i.test(text) ? "Standing judge model" : /after|milestone/i.test(text) ? "Scribe milestones" : /document/i.test(text) ? "Scribe documents" : "Standing scribe model";
                [...element.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === label)?.focus();
              } else element.querySelector('#plan-panel-setup [aria-invalid="true"]')?.focus();
            }
          };
          list.append(node("li", {}, link));
        }
        summary.append(list);
      }
      const review = node("details", { className: "plan-setup-review", open: reviewOpen }, node("summary", { textContent: "Review effective run settings" }));
      review.ontoggle = () => { reviewOpen = review.open; };
      if (result?.judgePermission) review.append(node("p", { textContent: result.judgePermission.detail }));
      review.append(node("p", { textContent: `${cards.length} step cards; ${cards.filter((c) => !c.after?.length).length} have no dependencies. Other dependencies may already be complete; run/global capacity may hold cards in the queue.` }));
      review.append(node("p", { className: "plan-setup-note", textContent: "Absent model and effort values use account defaults; their eventual values may be unknown. Default worker permissions are bypass. Ask in an unattended run depends on provider support. Duration and cost: unknown." }));
      const declaredChecks = [...new Set(cards.flatMap((c) => c.step.checks || []))].filter((name) => typeof result?.catalogue?.[name]?.minutes === "number");
      if (declaredChecks.length) review.append(node("p", { textContent: `Declared check durations (catalogue; not a run estimate): ${declaredChecks.map((name) => `${name}: ${result.catalogue[name].minutes} min`).join(", ")}` }));
      const waitingAccounts = [...new Set(cards.map((c) => resolveAccount(c.step.account || result.plan?.account)).filter((account) => state.externalProviders?.[account] && !state.acpCatalogs?.[account]))];
      if (waitingAccounts.length) review.append(node("p", { textContent: `Provider options have not yet been advertised for ${waitingAccounts.join(", ")}; final model and effort checks wait until the agent opens.` }));
      if (cards.length) review.append(node("ul", { className: "plan-setup-effective" }, ...cards.map((c) => node("li", { textContent: `${c.step.title}: ${c.step.account || result.plan?.account || "default account"} · ${c.step.model || result.plan?.model || (state.defaultModels?.[resolveAccount(c.step.account || result.plan?.account)] ? `Default: ${state.defaultModels[resolveAccount(c.step.account || result.plan?.account)]}` : "account default model")} · ${c.step.effort || result.plan?.effort || "account default effort"} · ${c.step.permission || result.plan?.permission || "bypass"} permissions${c.after?.length ? ` · depends on ${c.after.join(", ")}` : " · no dependencies"}${c.step.mayOpen === true ? " · may open its own cards" : ""}` }))));
      summary.append(review);
      const run = node("button", { textContent: pending ? "Starting plan…" : "Run plan", disabled: pending || !result || errors.length > 0, className: "primary" });
      run.onclick = () => { if (run.disabled) return; pending = true; bulk = false; render(); send("startSelectedPlan", { selectionId: selection.selectionId, revision, draft: copy(draft) }); };
      summary.append(node("div", { className: "plan-setup-actions" }, run, node("button", { textContent: "Cancel plan", disabled: pending, onclick: onCancel })));
      return summary;
    }
    function refreshSummary() { const old = element.querySelector(".plan-setup-review"); if (old) reviewOpen = old.open; element.querySelector("#plan-setup-summary")?.replaceWith(summaryNode()); }
    function render() {
      if (!selection) return;
      const currentRoles = element.querySelector(".plan-setup-roles"), currentSource = element.querySelector(".plan-setup-source-file"), currentReview = element.querySelector(".plan-setup-review");
      if (currentRoles) rolesOpen = currentRoles.open;
      if (currentSource) sourceOpen = currentSource.open;
      if (currentReview) reviewOpen = currentReview.open;
      for (const detail of element.querySelectorAll('[id^="plan-setup-step-"]')) {
        const id = detail.id.slice("plan-setup-step-".length);
        if (detail.open) opened.add(id); else opened.delete(id);
      }
      const active = element.contains(document.activeElement) ? document.activeElement : undefined;
      const focusLabel = active?.getAttribute("aria-label"), start = active?.selectionStart, end = active?.selectionEnd;
      const focusedTab = active?.getAttribute("role") === "tab" ? active.id : "";
      const graphButton = active?.tagName === "BUTTON" && graphBox.contains(active) ? active.textContent : "";
      const raw = selection.raw, visiblePlan = sourceDraft();
      const source = node("details", { className: "plan-setup-source-file", open: sourceOpen }, node("summary", { textContent: "View original plan file" }), node("pre", { textContent: JSON.stringify(raw, null, 2) }));
      source.ontoggle = () => { sourceOpen = source.open; };
      const intro = node("header", { className: "plan-setup-header" }, node("p", { className: "plan-setup-eyebrow", textContent: "RUN A PLAN" }), node("h2", { textContent: raw.name || "Run a plan" }), raw.about ? node("p", { className: "plan-setup-description", textContent: raw.about }) : null,
        node("div", { className: "plan-setup-meta" }, node("span", { textContent: `${raw.steps?.length || 0} source steps` }), node("span", { textContent: raw.review === "model" ? "Model review" : "Checks review" })),
        node("p", { className: "plan-setup-source", textContent: selection.file || "Selected plan" }));
      const general = panel("setup", node("div", { className: "plan-setup-panel" }));
      general.append(node("p", { className: "plan-setup-note", textContent: "Changes apply to this run. The original plan file is preserved." }), source);
      element.replaceChildren(intro, navigation());
      const vars = Object.entries(draft.vars);
      if (vars.length) general.append(section("Variables", ...vars.map(([name, value]) => multiline(`Variable ${name}`, value, (v) => { draft.vars[name] = v; }, raw.steps?.some((s) => s.each === name) ? "One item per semicolon or newline when present; otherwise split on spaces and commas. Each item creates a step card." : undefined))));
      const defaults = section("Worker defaults", settingsRow(draft.defaults, "Worker default"));
      const affected = Object.values(draft.steps).filter((s) => fields.some((k) => typeof s[k] === "string" && s[k]));
      const count = affected.reduce((n, s) => n + fields.filter((k) => typeof s[k] === "string" && s[k]).length, 0);
      defaults.append(node("button", { textContent: "Apply defaults to all steps", disabled: !count || pending, onclick: () => { bulk = true; render(); } }));
      if (bulk) defaults.append(node("div", { className: "plan-setup-confirm", role: "group", ariaLabel: "Confirm replacing step overrides" }, node("p", { textContent: `Remove ${count} execution overrides from ${affected.length} source steps? All their generated cards will inherit worker defaults. Roles keep their settings.` }), node("button", { textContent: "Remove step overrides", onclick: () => change(() => { for (const s of Object.values(draft.steps)) for (const k of fields) if (typeof s[k] === "string" && s[k]) s[k] = null; }) }), node("button", { textContent: "Keep overrides", onclick: () => { bulk = false; render(); } })));
      general.append(defaults);
      const roles = node("div", { className: "plan-setup-role-fields" });
      if (raw.review === "model") roles.append(node("p", { textContent: `Reviewer reads each finished step and merges it or requests a fix. Reviewer permissions: ${raw.reviewer?.permission ?? "bypass"}. Its absent model/effort use its account defaults.` }), settingsRow(draft.reviewer, "Reviewer", false, true));
      else roles.append(node("p", { textContent: "The board accepts and merges steps when their configured checks pass." }));
      if (draft.judge !== undefined) {
        const holder = { model: draft.judge };
        const control = picker(holder, "model", "Standing judge model", "Choose an explicit judge model (required)", resolveAccount(draft.defaults.account), "");
        control.querySelector("select").onchange = (e) => change(() => { draft.judge = e.target.value; });
        roles.append(control, node("p", { textContent: result?.judgePermission?.detail ?? "The judge uses the plan account. Its permission mode appears after validation." }));
      }
      if (draft.scribe && typeof draft.scribe === "object" && !Array.isArray(draft.scribe)) roles.append(picker(draft.scribe, "model", "Standing scribe model", "Use account default", resolveAccount(draft.defaults.account), ""), multiline("Scribe documents", scribeDocuments, (v) => { scribeDocuments = v; draft.scribe.documents = v.split(/\r?\n/).filter(Boolean); }, "One repository-relative path per line."), multiline("Scribe milestones", scribeMilestones, (v) => { scribeMilestones = v; draft.scribe.after = v.split(/\r?\n/).filter(Boolean); }, "One source step ID per line."), node("p", { textContent: "Scribe inherits the plan account and permission; it updates these documents at the listed milestones." }));
      const roleDetails = node("details", { className: "plan-setup-roles", open: rolesOpen }, node("summary", { textContent: "Review and standing roles" }), roles);
      roleDetails.ontoggle = () => { rolesOpen = roleDetails.open; };
      general.append(roleDetails);
      const steps = section("Steps");
      for (const [index, s] of (visiblePlan.steps || []).entries()) {
        const settings = draft.steps[s.id], overrides = fields.filter((k) => typeof settings[k] === "string" && settings[k]);
        const detail = node("details", { id: `plan-setup-step-${s.id}`, open: opened.has(s.id), tabIndex: -1 }, node("summary", { textContent: `${index + 1}. ${s.title} · ${overrides.length ? `${overrides.length} overrides` : "inherits defaults"}${s.each ? ` · one card per ${s.each} item` : ""}` }));
        detail.ontoggle = () => { if (detail.open) opened.add(s.id); else opened.delete(s.id); };
        detail.append(settingsRow(settings, `Step ${s.id}`, true), node("p", { textContent: s.goal || "" }));
        const listText = (v) => Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v);
        for (const [label, value] of [["Source", s.source], ["Files", listText(s.files)], ["Avoid", listText(s.avoid)], ["Expected reply", s.reply], ["Checks", listText(s.checks) || "none"], ["Waits for", listText(s.after) || "nothing"], ["Judge", s.judge ? "required" : "not requested"]]) if (value) detail.append(node("p", { textContent: `${label}: ${value}` }));
        for (const check of Array.isArray(s.checks) ? s.checks : []) if (result?.catalogue?.[check]?.run) detail.append(node("p", { textContent: `Check ${check}: ${result.catalogue[check].run}` }));
        const expanded = result?.cards?.filter((c) => c.step.id === s.id) || [];
        if (s.each) detail.append(node("p", { textContent: "Execution overrides apply to every card generated from this source step." }));
        for (const card of expanded) {
          const content = node("div", { className: "plan-setup-expanded" }, node("strong", { textContent: card.step.title }), node("p", { textContent: card.step.goal }), node("p", { textContent: `Waits for: ${card.after?.join(", ") || "nothing"}` }));
          for (const [label, value] of [["Source", card.step.source], ["Files", listText(card.step.files)], ["Avoid", listText(card.step.avoid)], ["Expected reply", card.step.reply]]) if (value) content.append(node("p", { textContent: `${label}: ${value}` }));
          detail.append(content);
        }
        const errors = result?.errors?.filter((e) => (typeof e === "string" ? e : e.message || "").includes(`"${s.id}"`)) || [];
        for (const error of errors) detail.append(node("p", { className: "plan-setup-error", textContent: typeof error === "string" ? error : error.message }));
        steps.append(detail);
      }
      element.append(general, panel("steps", steps), panel("dependencies", graphBox), panel("presets", presetsBox), summaryNode());
      graphBox.inert = presetsBox.inert = pending;
      if (graph) graph.update({ expanded: result?.cards || [], externalCards: state.tasks || [] });
      if (presets) {
        const plan = sourceDraft(), key = JSON.stringify(window.PlanPresets.capture(plan));
        if (key !== presetKey) { presetKey = key; presets.update({ plan, presets: presetList }); }
      }
      for (const e of element.querySelectorAll("select,textarea")) {
        if (pending && !e.disabled) { e.dataset.planTemporaryDisabled = "true"; e.disabled = true; }
        else if (!pending && e.dataset.planTemporaryDisabled) { e.disabled = false; delete e.dataset.planTemporaryDisabled; }
        const label = e.getAttribute("aria-label") || "";
        const messages = (result?.errors || []).map((v) => typeof v === "string" ? v : v.message || "").filter((text) => {
          if (label.startsWith("Variable ")) return text.includes(`"${label.slice(9)}"`);
          if (label.startsWith("Worker default ")) return text.startsWith(`"${label.slice(15)}"`);
          if (label.startsWith("Reviewer ")) return /reviewer/i.test(text) && text.toLowerCase().includes(label.slice(9).toLowerCase());
          if (label === "Standing judge model") return /judge/i.test(text) && /model/i.test(text);
          if (label === "Standing scribe model") return /scribe/i.test(text) && /model/i.test(text);
          if (label === "Scribe documents") return /scribe/i.test(text) && /documents|document/i.test(text);
          if (label === "Scribe milestones") return /scribe/i.test(text) && /after|milestone/i.test(text);
          return false;
        });
        if (messages.length) {
          const error = node("small", { className: "plan-setup-error", textContent: messages.join(" "), id: `plan-setup-error-${label.replace(/[^a-z0-9]/gi, "-")}` });
          e.setAttribute("aria-invalid", "true"); e.setAttribute("aria-describedby", error.id); e.parentNode.append(error);
        }
      }
      if (focusLabel && !pending) {
        const target = [...element.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === focusLabel);
        target?.focus(); if (target?.tagName === "TEXTAREA" && start != null) target.setSelectionRange(start, end);
      }
      else if (focusedTab && !pending) document.getElementById(focusedTab)?.focus();
      else if (graphButton && !pending) [...graphBox.querySelectorAll("button")].find((e) => !e.disabled && e.textContent === graphButton)?.focus();
    }
    return { element,
      getDraft() { return draft ? copy(draft) : undefined; },
      getSelection() { return selection ? copy(selection) : undefined; },
      ready() { pending = false; render(); },
      setPresets(next) { presetList = Array.isArray(next) ? next : []; if (presets) { presetKey = ""; presets.update({ presets: presetList, plan: sourceDraft() }); } },
      setDraft(next) {
        if (!selection || !next || typeof next !== "object" || !next.defaults || !next.vars || !next.steps || !next.reviewer) throw new Error("A complete plan setup draft is required.");
        for (const s of selection.raw.steps || []) if (!next.steps[s.id] || typeof next.steps[s.id] !== "object") throw new Error(`Missing source step ${s.id}.`);
        draft = copy(next); request(); render();
      },
      load(next, nextState = {}) {
        if (!next?.raw || typeof next.raw !== "object" || Array.isArray(next.raw) || !Array.isArray(next.raw.steps) || next.raw.steps.some((s) => !s || typeof s !== "object")) throw new Error("The selected plan must contain a list of source steps.");
        selection = next; state = nextState; revision = 0; result = undefined; pending = false; activeTab = "setup"; reviewOpen = rolesOpen = sourceOpen = false; opened.clear();
        const raw = next.raw;
        const vars = raw.vars && typeof raw.vars === "object" && !Array.isArray(raw.vars) ? raw.vars : {};
        const reviewer = raw.reviewer && typeof raw.reviewer === "object" && !Array.isArray(raw.reviewer) ? raw.reviewer : {};
        draft = { defaults: Object.fromEntries(fields.filter((k) => typeof raw[k] === "string").map((k) => [k, raw[k]])), vars: Object.fromEntries(Object.entries(vars).filter(([, v]) => typeof v === "string")), steps: Object.fromEntries((raw.steps || []).map((s) => [s.id, Object.fromEntries(fields.filter((k) => typeof s[k] === "string").map((k) => [k, s[k]]))])), reviewer: copy(reviewer), ...(raw.judge !== undefined ? { judge: raw.judge } : {}), ...(raw.scribe && typeof raw.scribe === "object" && !Array.isArray(raw.scribe) ? { scribe: copy(raw.scribe) } : {}) };
        // The source fixes reviewer permission. Setup sends only editable role settings.
        delete draft.reviewer.permission;
        scribeDocuments = Array.isArray(draft.scribe?.documents) ? draft.scribe.documents.join("\n") : "";
        scribeMilestones = Array.isArray(draft.scribe?.after) ? draft.scribe.after.join("\n") : "";
        presetList = []; graph?.destroy(); presets?.destroy(); graph = presets = undefined;
        element.replaceChildren();
        mountExtras(); send("getPlanPresets", { selectionId: selection.selectionId });
        element.hidden = false; request(); render();
      },
      updateState(next) { state = next; if (selection) render(); },
      validation(next) { if (!selection || next.selectionId !== selection.selectionId || next.revision !== revision) return; result = next; pending = false; render(); }
    };
  };
})();
