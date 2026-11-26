// Personal presets carry execution settings only. Storage and validation belong to the host.
(function (root) {
  const fields = ["account", "model", "effort", "permission"];
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => typeof value?.[key] === "string").map((key) => [key, value[key]]));
  function capture(plan) {
    const settings = { ...pick(plan, fields), steps: Object.fromEntries((plan.steps || []).map((step) => [step.id, pick(step, fields)]).filter(([, values]) => Object.keys(values).length)) };
    if (plan.reviewer) settings.reviewer = pick(plan.reviewer, ["account", "model", "effort"]);
    if (typeof plan.judge === "string") settings.judge = plan.judge;
    if (typeof plan.scribe?.model === "string") settings.scribe = { model: plan.scribe.model };
    return settings;
  }
  function clean(settings) {
    // Pass even imported/untrusted presets through the same explicit allowlist.
    return capture({ ...settings, steps: Object.entries(settings?.steps || {}).map(([id, values]) => ({ ...values, id })) });
  }
  function apply(plan, settings) {
    const next = JSON.parse(JSON.stringify(plan)), safe = clean(settings);
    for (const key of fields) { delete next[key]; if (key in safe) next[key] = safe[key]; }
    delete next.reviewer;
    if (safe.reviewer && next.review === "model") next.reviewer = safe.reviewer;
    if (next.review === "model" && plan.reviewer?.permission !== undefined)
      next.reviewer = { ...next.reviewer, permission: plan.reviewer.permission };
    // A preset changes an existing standing role's model; it never creates/removes a role or its scope.
    if (next.judge && safe.judge !== undefined) next.judge = safe.judge;
    if (next.scribe) { delete next.scribe.model; if (safe.scribe) next.scribe.model = safe.scribe.model; }
    for (const step of next.steps) {
      for (const key of fields) { delete step[key]; if (safe.steps[step.id] && key in safe.steps[step.id]) step[key] = safe.steps[step.id][key]; }
    }
    return next;
  }
  function replacementSummary(plan, settings) {
    const after = apply(plan, settings), removed = [];
    const compare = (before, next, prefix, keys) => { for (const key of keys) if (typeof before?.[key] === "string" && before[key] !== next?.[key]) removed.push(`${prefix}${key}: ${before[key]} → ${next?.[key] ?? "inherit/default"}`); };
    compare(plan, after, "defaults.", fields);
    compare(plan.reviewer, after.reviewer, "reviewer.", ["account", "model", "effort"]);
    compare(plan, after, "", ["judge"]); compare(plan.scribe, after.scribe, "scribe.", ["model"]);
    plan.steps.forEach((step, i) => compare(step, after.steps[i], `steps.${step.id}.`, fields));
    return removed;
  }
  function mount(container, options) {
    const doc = container.ownerDocument;
    function render() {
      const selectedId = container.querySelector?.('select[aria-label="Personal settings preset"]')?.value;
      const typedName = container.querySelector?.('input[aria-label="Preset name"]')?.value || "";
      container.replaceChildren();
      const note = doc.createElement("p"); note.textContent = "Save execution choices for another plan. Task text, variables and credentials are never saved."; container.append(note);
      const select = doc.createElement("select"); select.setAttribute("aria-label", "Personal settings preset");
      if (!(options.presets || []).length) { const empty = doc.createElement("option"); empty.value = ""; empty.textContent = "No saved presets"; select.append(empty); select.disabled = true; }
      for (const preset of options.presets || []) { const option = doc.createElement("option"); option.value = preset.id; option.textContent = preset.name; select.append(option); }
      const name = doc.createElement("input"); name.setAttribute("aria-label", "Preset name"); name.maxLength = 100; name.placeholder = "Name your settings";
      if ((options.presets || []).some((p) => p.id === selectedId)) select.value = selectedId;
      name.value = typedName;
      const current = () => (options.presets || []).find((p) => p.id === select.value);
      const fields = doc.createElement("div"); fields.className = "plan-presets-fields";
      const labeled = (label, input) => { const wrap = doc.createElement("label"); wrap.className = "plan-setup-field"; const title = doc.createElement("span"); title.textContent = label; wrap.append(title, input); return wrap; };
      fields.append(labeled("Saved preset", select), labeled("Preset name", name)); container.append(fields);
      const notice = doc.createElement("p"); notice.setAttribute("role", "status"); container.append(notice);
      const actions = doc.createElement("div"); actions.className = "plan-presets-actions"; container.append(actions);
      const button = (label, run, disabled = false) => { const b = doc.createElement("button"); b.type = "button"; b.textContent = label; b.disabled = disabled; b.addEventListener("click", run); actions.append(b); };
      const named = () => { const value = name.value.trim(); if (!value) { notice.textContent = "Enter a preset name first."; name.focus?.(); } else notice.textContent = ""; return value; };
      button("Save personal preset", () => { const value = named(); if (value) options.onSave?.(value, capture(options.plan)); });
      button("Apply personal preset", async () => {
        const preset = current(); if (!preset) return;
        const removed = replacementSummary(options.plan, preset.settings);
        // Without a concrete confirmation callback, replacing any explicit value is refused.
        if (removed.length && (!options.confirm || !await options.confirm(removed, preset))) return;
        options.onApply?.(apply(options.plan, preset.settings), preset.id);
      }, !(options.presets || []).length);
      button("Rename personal preset", () => { const value = named(); if (current() && value) options.onRename?.(current().id, value); }, !(options.presets || []).length);
      button("Delete personal preset", () => { if (current()) options.onDelete?.(current().id); }, !(options.presets || []).length);
    }
    render();
    return { update(next) { options = { ...options, ...next }; render(); }, destroy() { container.replaceChildren(); } };
  }
  const api = { capture, apply, replacementSummary, mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlanPresets = api;
})(typeof globalThis === "undefined" ? this : globalThis);
