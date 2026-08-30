import { formatSlideForModel, type ParsedSlide } from "@/lib/ingest/parsePptx";
import { estimateTokens, inputBudget } from "@/lib/llm/tokens";
import type { ModelProfile } from "@/lib/llm/config";

export interface LectureChunk {
  index: number;
  /** Slide ordinals included, for error messages and provenance. */
  slideOrdinals: number[];
  text: string;
}

export interface ChunkInput {
  slides: ParsedSlide[];
  transcriptChunks: string[];
}

/**
 * Splits lecture text into pieces that fit the model's input budget.
 *
 * A slide is the atomic unit: splitting mid-slide would separate a slide from
 * its presenter notes, which is exactly the pairing the extraction depends on.
 */
export function chunkLecture(
  input: ChunkInput,
  profile: ModelProfile,
): LectureChunk[] {
  const budget = inputBudget(profile);
  const units = buildUnits(input);

  if (units.length === 0) return [];

  // An oversized single unit cannot be honoured by silently truncating —
  // that would drop content the student believes was processed.
  for (const unit of units) {
    if (estimateTokens(unit.text) > budget) {
      throw new Error(
        `${unit.label} alone is about ${estimateTokens(unit.text)} tokens, over the ` +
          `${budget}-token input budget for ${profile.providerId}:${profile.modelId}. ` +
          `Use a model with a larger context, or raise LLM_${profile.role.toUpperCase()}_CONTEXT_TOKENS if this model supports more.`,
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

function buildUnits(input: ChunkInput): Unit[] {
  const units: Unit[] = [];

  if (input.slides.length > 0) {
    units.push({
      label: "The slide-deck header",
      text: "# Slide deck (body text and presenter notes)",
    });
    for (const slide of input.slides) {
      units.push({
        label: `Slide ${slide.ordinal}`,
        text: formatSlideForModel(slide),
        ordinal: slide.ordinal,
      });
    }
  }

  if (input.transcriptChunks.length > 0) {
    units.push({ label: "The transcript header", text: "# Lecture transcript" });
    input.transcriptChunks.forEach((text, i) => {
      units.push({ label: `Transcript section ${i + 1}`, text });
    });
  }

  return units;
}

/** True when the whole lecture fits in one call. */
export function fitsInOneCall(
  input: ChunkInput,
  profile: ModelProfile,
): boolean {
  return chunkLecture(input, profile).length <= 1;
}
