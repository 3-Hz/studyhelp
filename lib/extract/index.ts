import type { LanguageModel, UserContent } from "ai";
import type { ModelFilePart } from "@/lib/ingest/documents";
import { describeProfile, type ModelProfile } from "@/lib/llm/config";
import { resolveModel } from "@/lib/llm/provider";
import { generateStructured } from "@/lib/llm/structured";
import { estimateTokens } from "@/lib/llm/tokens";
import {
  chunkLecture,
  type ExtractSlide,
  type LectureChunk,
  type TranscriptSection,
} from "./chunk";
import { mergeExtracts } from "./merge";
import { formatPrior, type PriorObjective } from "./prior";
import { CHUNK_NOTE, EXTRACTION_SYSTEM, LectureExtract, PRIOR_NOTE } from "./schema";

export { LectureExtract } from "./schema";
export type { LectureExtract as LectureExtractType } from "./schema";

export interface ExtractInput {
  slides: ExtractSlide[];
  transcriptChunks: TranscriptSection[];
  /** PDF/image content already prepared for this profile's capabilities. */
  documentParts: ModelFilePart[];
  /** Roughly what documentParts will cost, so chunking can reserve for them. */
  documentTokens?: number;
  /**
   * What the lecture already holds, so a re-extraction reuses its wordings.
   * Absent or empty on a first extraction.
   */
  prior?: PriorObjective[];
}

export interface ExtractionMeta {
  provider: string;
  model: string;
  profile: string;
  chunked: boolean;
  chunkCount: number;
  repairs: number;
  mode: string;
}

export interface ExtractResult {
  extract: LectureExtract;
  meta: ExtractionMeta;
}

export async function extractLecture(
  input: ExtractInput,
  profile: ModelProfile,
  /** Injectable for tests; resolved once and shared across chunks otherwise. */
  model: LanguageModel = resolveModel(profile),
): Promise<ExtractResult> {
  // The block rides with every section, so it comes off every section's
  // budget, the way the documents do.
  const priorText =
    input.prior && input.prior.length > 0
      ? `${PRIOR_NOTE}\n\n${formatPrior(input.prior)}`
      : "";

  const chunks = chunkLecture(
    { slides: input.slides, transcriptChunks: input.transcriptChunks },
    profile,
    (input.documentTokens ?? 0) + estimateTokens(priorText),
  );

  const baseMeta = {
    provider: profile.providerId,
    model: profile.modelId,
    profile: describeProfile(profile),
  };

  // Single call: everything fits, so the model sees the whole lecture at once.
  if (chunks.length <= 1) {
    const { value, repairs, mode } = await generateStructured({
      profile,
      model,
      schema: LectureExtract,
      schemaName: "lecture_extract",
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildContent(chunks[0]?.text ?? "", input.documentParts, priorText),
        },
      ],
    });

    return {
      extract: value,
      meta: { ...baseMeta, chunked: false, chunkCount: 1, repairs, mode },
    };
  }

  // Chunked: extract each section, then merge deterministically.
  const partials: LectureExtract[] = [];
  let totalRepairs = 0;
  let mode = "chunked";

  for (const [position, chunk] of chunks.entries()) {
    const { value, repairs, mode: chunkMode } = await generateStructured({
      profile,
      model,
      schema: LectureExtract,
      schemaName: "lecture_extract",
      system: `${EXTRACTION_SYSTEM}\n\n${CHUNK_NOTE}`,
      messages: [
        {
          role: "user",
          content: buildContent(
            `(Section ${position + 1} of ${chunks.length})\n\n${chunk.text}`,
            // Documents ride along with the first chunk only: re-sending a PDF
            // per chunk would blow the budget the chunking exists to respect.
            position === 0 ? input.documentParts : [],
            // The anchor block rides with every chunk: each section is
            // extracted on its own and has to reuse the recorded wordings.
            priorText,
          ),
        },
      ],
    });

    partials.push(value);
    totalRepairs += repairs;
    if (chunkMode === "repaired") mode = "chunked+repaired";
  }

  return {
    extract: mergeExtracts(partials),
    meta: {
      ...baseMeta,
      chunked: true,
      chunkCount: chunks.length,
      repairs: totalRepairs,
      mode,
    },
  };
}

function buildContent(
  lectureText: string,
  documentParts: ModelFilePart[],
  priorText: string,
): UserContent {
  const parts: ModelFilePart[] = [...documentParts];

  if (lectureText.trim().length > 0) {
    parts.push({ type: "text", text: lectureText });
  }

  if (priorText.length > 0) {
    parts.push({ type: "text", text: priorText });
  }

  parts.push({
    type: "text",
    text: "Extract the learning objectives and high-yield content from this lecture.",
  });

  return parts as UserContent;
}

export type { ExtractSlide, LectureChunk, TranscriptSection };
