// Run-only overlays. Effective provider settings and the resulting plan are still checked by Board.checkPlan.
import { VAR_CAP } from "./plan";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const runtime = ["account", "model", "effort", "permission"];
const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Omission preserves the source; null or empty runtime values remove an override. Never modifies either input. */
export function applyPlanSetup(raw: unknown, draft: unknown): { raw: unknown; vars: Record<string, string> } | { errors: string[] } {
  if (!object(raw)) return { errors: ["The selected plan must be a JSON object."] };
  if (!object(draft)) return { errors: ["Plan setup must be an object."] };
  const errors: string[] = [];
  const allowed = (value: ObjectValue, keys: string[], where: string) => {
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${where}: unknown field "${key}".`);
  };
  allowed(draft, ["defaults", "vars", "steps", "reviewer", "judge", "scribe", "order", "dependencies"], "Plan setup");
  let result: ObjectValue;
  try { result = structuredClone(raw); } catch { return { errors: ["The selected plan must contain cloneable JSON data."] }; }
  const settings = (value: unknown, target: ObjectValue, keys: string[], where: string) => {
    if (!object(value)) { errors.push(`${where} must be an object.`); return; }
    allowed(value, keys, where);
    for (const key of keys) {
      if (!own(value, key)) continue;
      const v = value[key];
      if (v === null || v === "") delete target[key];
      else if (typeof v !== "string" || v.length > 200 || !v.trim() || control.test(v) || /[\r\n]/.test(v))
        errors.push(`${where}.${key} must be one line of text up to 200 characters, or null to inherit.`);
      else target[key] = v;
    }
  };
  if (own(draft, "defaults")) settings(draft.defaults, result, runtime, "Defaults");
  const vars: Record<string, string> = {};
  if (own(draft, "vars")) {
    if (!object(draft.vars)) errors.push("Variables must be an object of declared variable names and text values.");
    else for (const [name, value] of Object.entries(draft.vars)) {
      if (!object(raw.vars) || !own(raw.vars, name)) errors.push(`The plan has no variable "${name}".`);
      else if (typeof value !== "string" || value.length > VAR_CAP || control.test(value)) errors.push(`Variable "${name}" must be text up to ${VAR_CAP} characters without control characters.`);
      else Object.defineProperty(vars, name, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  if (own(draft, "steps")) {
    if (!object(draft.steps)) errors.push("Step overrides must be an object keyed by source step id.");
    else {
      const steps = Array.isArray(result.steps) ? result.steps : [];
      for (const [id, value] of Object.entries(draft.steps)) {
        const matches = steps.filter((step): step is ObjectValue => object(step) && step.id === id);
        if (matches.length !== 1) errors.push(`Step "${id}" must identify exactly one source step of the selected plan.`);
        else settings(value, matches[0], runtime, `Step "${id}"`);
      }
    }
  }
  if (own(draft, "order") || own(draft, "dependencies")) {
    const steps = Array.isArray(result.steps) ? result.steps : [];
    const ids = steps.map((step) => object(step) ? step.id : undefined);
    if (!steps.length || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
      errors.push("Graph edits require unique source step ids.");
    else {
      if (own(draft, "order")) {
        const order = draft.order;
        if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || !order.every((id) => typeof id === "string" && ids.includes(id)))
          errors.push("Step order must contain each original source step id exactly once.");
        else result.steps = order.map((id) => steps[ids.indexOf(id)]);
      }
      if (own(draft, "dependencies")) {
        if (!object(draft.dependencies)) errors.push("Dependencies must be an object keyed by source step id.");
        else for (const [id, value] of Object.entries(draft.dependencies)) {
          if (!ids.includes(id)) errors.push(`Dependencies name unknown source step "${id}".`);
          else if (!Array.isArray(value) || value.length > 1000 || new Set(value).size !== value.length || !value.every((v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,29}$/.test(v)))
            errors.push(`Dependencies for step "${id}" must be a list of distinct step or board card ids.`);
          else (steps[ids.indexOf(id)] as ObjectValue).after = [...value];
        }
      }
    }
  }
  if (own(draft, "reviewer")) {
    const reviewer = object(result.reviewer) ? result.reviewer : {};
    settings(draft.reviewer, reviewer, ["account", "model", "effort"], "Reviewer");
    if (own(result, "reviewer") || Object.keys(reviewer).length) result.reviewer = reviewer;
  }
  if (own(draft, "judge")) {
    if (draft.judge === "") errors.push("Judge model must be selected.");
    const target: ObjectValue = { model: result.judge };
    settings({ model: draft.judge }, target, ["model"], "Judge");
    if (own(target, "model")) result.judge = target.model; else delete result.judge;
  }
  if (own(draft, "scribe")) {
    if (!object(draft.scribe)) errors.push("Scribe must be an object.");
    else {
      const scribe = object(result.scribe) ? result.scribe : {};
      allowed(draft.scribe, ["model", "documents", "after"], "Scribe");
      if (own(draft.scribe, "model")) settings({ model: draft.scribe.model }, scribe, ["model"], "Scribe");
      for (const key of ["documents", "after"]) if (own(draft.scribe, key)) {
        const value = draft.scribe[key];
        if (!Array.isArray(value) || value.length > 20 || !value.every((v) => typeof v === "string" && v.trim() && v.length <= 200 && !control.test(v) && !/[\r\n]/.test(v)))
          errors.push(`Scribe.${key} must be a list of up to 20 one-line names or paths.`);
        else scribe[key] = [...value];
      }
      result.scribe = scribe;
    }
  }
  return errors.length ? { errors } : { raw: result, vars };
}
