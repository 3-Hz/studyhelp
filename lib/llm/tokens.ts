/**
 * Token estimation for chunking decisions.
 *
 * Deliberately a heuristic and not a tokenizer. Tokenizers are per-model, so
 * running one model's tokenizer against another's context limit produces a
 * precise number that is still wrong — false comfort. What we actually need is
 * "will this comfortably fit", and chars/4 with a safety margin answers that.
 */

const CHARS_PER_TOKEN = 4;

/** Headroom for prompt scaffolding and estimation error. */
const SAFETY_MARGIN = 0.25;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * How many input tokens are available for lecture content, once output and a
 * safety margin are reserved.
 */
export function inputBudget(profile: {
  contextTokens: number;
  maxOutputTokens: number;
}): number {
  const usable = profile.contextTokens - profile.maxOutputTokens;
  return Math.max(0, Math.floor(usable * (1 - SAFETY_MARGIN)));
}

export function fitsInBudget(
  text: string,
  profile: { contextTokens: number; maxOutputTokens: number },
): boolean {
  return estimateTokens(text) <= inputBudget(profile);
}
