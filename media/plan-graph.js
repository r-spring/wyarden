// In-memory source-step edits only. The extension host validates all graph semantics.
(function (root) {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  function edit(plan, action) {
    const next = copy(plan), steps = next.steps;
    const index = steps.findIndex((step) => step.id === action.id);
    if (index < 0 || steps.filter((step) => step.id === action.id).length !== 1) throw new Error("Choose a unique source step.");
    const step = steps[index];
    if (action.type === "move") {
      const to = index + action.direction;
      if (![1, -1].includes(action.direction) || to < 0 || to >= steps.length) return next;
      steps.splice(to, 0, steps.splice(index, 1)[0]);
    } else if (action.type === "addDependency") {
      if (typeof action.dependency !== "string" || !action.dependency) throw new Error("Choose a dependency.");
      if (!(step.after || []).includes(action.dependency)) step.after = [...(step.after || []), action.dependency];
    } else if (action.type === "removeDependency") {
      step.after = (step.after || []).filter((id) => id !== action.dependency);
    } else throw new Error("Unknown graph edit.");
    return next;
  }
  function mount(container, options) {
    let plan = copy(options.plan), original = copy(plan), history = [];
    const doc = container.ownerDocument;
    const element = (tag, text) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
    const button = (text, run, disabled = false) => { const node = element("button", text); node.type = "button"; node.disabled = disabled; node.addEventListener("click", run); return node; };
    function change(action) {
      const next = edit(plan, action); if (JSON.stringify(next) === JSON.stringify(plan)) return;
      const focusedLabel = doc.activeElement?.textContent;
      history.push(copy(plan)); plan = next; render();
      const buttons = [...(container.querySelectorAll?.("button") || [])];
      const focus = buttons.find((b) => !b.disabled && b.textContent === focusedLabel) || buttons.find((b) => !b.disabled && b.textContent.includes(action.id));
      focus?.focus(); options.onChange?.(copy(plan), action);
    }
    function undo() { if (!history.length) return; plan = history.pop(); render(); options.onChange?.(copy(plan), { type: "undo" }); }
    function reset() { history = []; plan = copy(original); render(); options.onChange?.(copy(plan), { type: "reset" }); }
    function render() {
      const previous = new Map([...(container.querySelectorAll?.("select[aria-label]") || [])].map((s) => [s.getAttribute("aria-label"), s.value]));
      const openGoals = new Set([...(container.querySelectorAll?.("li[data-step] > details") || [])].filter((d) => d.open).map((d) => d.parentElement.dataset.step));
      const focused = container.contains?.(doc.activeElement) ? doc.activeElement?.getAttribute?.("aria-label") : undefined;
      container.replaceChildren();
      container.append(element("h3", "Dependencies"), element("p", "Reordering changes display order only. Dependency edits require host validation before running or saving."));
      container.append(button("Undo dependency edit", undo, !history.length), button("Cancel dependency edits", reset, !history.length));
      if (options.onSaveAs) container.append(button("Save dependency edits as new plan", () => options.onSaveAs(copy(plan))));
      const list = element("ol"); container.append(list);
      plan.steps.forEach((step, index) => {
        const row = element("li"); row.dataset.step = step.id;
        row.draggable = true;
        row.addEventListener("dragstart", (event) => { event.stopPropagation(); event.dataTransfer.setData("application/x-entomatical-step", step.id); });
        row.addEventListener("dragover", (event) => { event.preventDefault(); event.stopPropagation(); });
        row.addEventListener("drop", (event) => {
          event.preventDefault(); event.stopPropagation();
          const id = event.dataTransfer.getData("application/x-entomatical-step");
          const from = plan.steps.findIndex((s) => s.id === id), to = plan.steps.findIndex((s) => s.id === step.id);
          if (from < 0 || from === to) return;
          const next = copy(plan); next.steps.splice(to, 0, next.steps.splice(from, 1)[0]);
          history.push(copy(plan)); plan = next; render(); options.onChange?.(copy(plan), { type: "reorder", id, before: step.id });
        });
        row.append(element("strong", `${step.id}: ${step.title || step.id}`));
        if (step.each) row.append(element("p", `Repeated group: ${step.each}. These edits apply to every generated card.`));
        if (step.goal) { const details = element("details"); details.open = openGoals.has(step.id); details.append(element("summary", "Goal"), element("p", step.goal)); row.append(details); }
        row.append(button(`Move ${step.id} up`, () => change({ type: "move", id: step.id, direction: -1 }), index === 0), button(`Move ${step.id} down`, () => change({ type: "move", id: step.id, direction: 1 }), index === plan.steps.length - 1));
        const dependencies = element("ul");
        for (const id of step.after || []) {
          const item = element("li", `${id}${plan.steps.some((s) => s.id === id) ? "" : " (external board card or unresolved)"} `);
          item.append(button(`Remove ${id} from ${step.id}`, () => change({ type: "removeDependency", id: step.id, dependency: id }))); dependencies.append(item);
        }
        row.append(dependencies);
        const select = element("select"); select.setAttribute("aria-label", `Dependency for ${step.id}`);
        const ids = [...new Set([...plan.steps.map((s) => s.id), ...(options.externalCards || []).map((s) => typeof s === "string" ? s : s.id)])].filter((id) => id && id !== step.id && !(step.after || []).includes(id));
        for (const id of ids) { const option = element("option", id); option.value = id; select.append(option); }
        const wanted = previous.get(`Dependency for ${step.id}`);
        if (wanted && !ids.includes(wanted)) { const option = element("option", `${wanted} (no longer available)`); option.value = wanted; select.append(option); }
        if (wanted) select.value = wanted;
        select.disabled = !ids.length;
        row.append(select, button(`Add dependency to ${step.id}`, () => change({ type: "addDependency", id: step.id, dependency: select.value }), !ids.length));
        const expanded = (options.expanded || []).filter((card) => card.sourceStepId === step.id || card.step?.id === step.id);
        if (expanded.length) row.append(element("p", `Expanded cards: ${expanded.map((card) => card.key || card.id).join(", ")}`));
        list.append(row);
      });
      if (focused) [...(container.querySelectorAll?.("select[aria-label]") || [])].find((s) => s.getAttribute("aria-label") === focused)?.focus();
    }
    render();
    return { update(next) { options = { ...options, ...next }; if (next.plan) { plan = copy(next.plan); original = copy(plan); history = []; } render(); }, undo, reset, destroy() { container.replaceChildren(); } };
  }
  const api = { edit, mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlanGraph = api;
})(typeof globalThis === "undefined" ? this : globalThis);
