/**
 * Size limits shared by the helpers (4 November 2026 review, item 2.4). A draft or prompt longer than DRAFT_LIMIT cannot be refined,
 * improved or given a completion rule, so a helper's own output over the limit is flagged before it can be applied, never truncated.
 * Manually typed task prompts are not limited by this.
 */
export const DRAFT_LIMIT = 24_000;
export const ANSWERS_LIMIT = 8_000;
export const TITLE_DRAFT_LIMIT = 6_000;
/** Refine draft's handoff mode (plan 70d079 step 4): the handoff doc's text may be this long. The task prompt it becomes keeps DRAFT_LIMIT. */
export const HANDOFF_LIMIT = 60_000;
/** The size of text against DRAFT_LIMIT, for a message that names both. undefined when it fits. */
export function oversize(text: string): { chars: number; limit: number } | undefined {
  return text.length > DRAFT_LIMIT ? { chars: text.length, limit: DRAFT_LIMIT } : undefined;
}
