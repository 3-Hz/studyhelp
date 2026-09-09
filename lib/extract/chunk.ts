import { formatSlideForModel, type ParsedSlide } from "@/lib/ingest/parsePptx";
import { estimateTokens, inputBudget } from "@/lib/llm/tokens";
import type { SourceRole } from "@/lib/db/schema";
import type { ModelProfile } from "@/lib/llm/config";

export interface LectureChunk {
  index: number;
  /** Slide ordinals included, for error messages and provenance. */
  slideOrdinals: number[];
  text: string;
}

/**
 * A slide, plus which uploaded file it came from. A lecture often has more than
 * one deck, and the model has to be told where one ends and the next begins.
 */
export interface ExtractSlide extends ParsedSlide {
  sourceLabel?: string;
  /** Which box the deck came from. Absent means the lecture's own deck. */
  role?: SourceRole;
}

export interface TranscriptSection {
  text: string;
  sourceLabel?: string;
  /** Which box the file came from. Absent means the lecture transcript. */
  role?: SourceRole;
}

export interface ChunkInput {
  slides: ExtractSlide[];
  transcriptChunks: TranscriptSection[];
}

/**
 * Splits lecture text into pieces that fit the model's input budget.
 *
 * A slide is the atomic unit: splitting mid-slide would separate a slide from
 * its presenter notes, which is exactly the pairing the extraction depends on.
 *
 * `reservedTokens` covers PDFs and images, which ride along with the first
 * chunk. They cost tokens no measurement of the text can see, so the caller
 * declares them and they come off the budget before anything is packed.
 */
export function chunkLecture(
  input: ChunkInput,
  profile: ModelProfile,
  reservedTokens = 0,
): LectureChunk[] {
  const fullBudget = inputBudget(profile);
  const budget = Math.max(0, fullBudget - reservedTokens);
  const units = buildUnits(input);

  if (units.length === 0) return [];

  // Documents alone over budget leaves nothing for the lecture itself. Say so
  // directly rather than reporting whichever slide happened to be measured
  // first as being "over the 0-token budget".
  if (reservedTokens >= fullBudget) {
    throw new Error(
      `The attached PDFs and images are about ${reservedTokens} tokens on their own, which fills ` +
        `the whole ${fullBudget}-token input budget for ${profile.providerId}:${profile.modelId} and ` +
        "leaves no room for the slides or transcript. Remove some, or use a model with a larger context.",
    );
  }

  // An oversized single unit cannot be honoured by silently truncating —
  // that would drop content the student believes was processed.
  for (const unit of units) {
    if (estimateTokens(unit.text) > budget) {
      const reserved =
        reservedTokens > 0
          ? ` Attached PDFs and images have already claimed about ${reservedTokens} of the ${fullBudget}-token budget; removing some would make room.`
          : "";
      throw new Error(
        `${unit.label} alone is about ${estimateTokens(unit.text)} tokens, over the ` +
          `${budget}-token input budget for ${profile.providerId}:${profile.modelId}. ` +
          `Use a model with a larger context, or raise LLM_${profile.role.toUpperCase()}_CONTEXT_TOKENS if this model supports more.${reserved}`,
      );
    }
  }

  const chunks: LectureChunk[] = [];
  let current: string[] = [];
  let currentOrdinals: number[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      index: chunks.length,
      slideOrdinals: currentOrdinals,
      text: current.join("\n\n"),
    });
    current = [];
    currentOrdinals = [];
    currentTokens = 0;
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit.text);
    if (currentTokens > 0 && currentTokens + unitTokens > budget) flush();
    current.push(unit.text);
    if (unit.ordinal !== undefined) currentOrdinals.push(unit.ordinal);
    currentTokens += unitTokens;
  }
  flush();

  return chunks;
}

interface Unit {
  label: string;
  text: string;
  ordinal?: number;
}

/** The heading each kind of material gets, so the model knows what it is reading. */
export const ROLE_HEADING: Record<SourceRole, string> = {
  deck: "Slide deck",
  transcript: "Lecture transcript",
  quiz: "Practice quiz",
  additional: "Additional course material",
};

export function heading(role: SourceRole, label: string | undefined, suffix = ""): string {
  return `# ${ROLE_HEADING[role]}${label ? `: ${label}` : ""}${suffix}`;
}

function buildUnits(input: ChunkInput): Unit[] {
  const units: Unit[] = [];

  // A header per run of one file in one role, so consecutive decks never
  // read as one, and a quiz deck never reads as the lecture's. Slide numbers
  // stay globally unique across them, which is what `slideRefs` resolves
  // against.
  let run: string | undefined;
  for (const slide of input.slides) {
    const role = slide.role ?? "deck";
    const key = `${role}\n${slide.sourceLabel ?? ""}`;
    if (key !== run) {
      units.push({
        label: "The slide-deck header",
        text: heading(role, slide.sourceLabel, " (body text and presenter notes)"),
      });
      run = key;
    }
    units.push({
      label: `Slide ${slide.ordinal}`,
      text: formatSlideForModel(slide),
      ordinal: slide.ordinal,
    });
  }

  run = undefined;
  input.transcriptChunks.forEach((section, i) => {
    const role = section.role ?? "transcript";
    const key = `${role}\n${section.sourceLabel ?? ""}`;
    if (key !== run) {
      units.push({
        label: "The transcript header",
        text: heading(role, section.sourceLabel),
      });
      run = key;
    }
    units.push({ label: `Transcript section ${i + 1}`, text: section.text });
  });

  return units;
}

/** True when the whole lecture fits in one call. */
export function fitsInOneCall(
  input: ChunkInput,
  profile: ModelProfile,
  reservedTokens = 0,
): boolean {
  return chunkLecture(input, profile, reservedTokens).length <= 1;
}
