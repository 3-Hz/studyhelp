import type { LanguageModel, UserContent } from "ai";
import type { ParsedSlide } from "@/lib/ingest/parsePptx";
import type { ModelFilePart } from "@/lib/ingest/documents";
import { describeProfile, type ModelProfile } from "@/lib/llm/config";
import { resolveModel } from "@/lib/llm/provider";
import { generateStructured } from "@/lib/llm/structured";
import { chunkLecture, type LectureChunk } from "./chunk";
import { mergeExtracts } from "./merge";
import { CHUNK_NOTE, EXTRACTION_SYSTEM, LectureExtract } from "./schema";

export { LectureExtract } from "./schema";
export type { LectureExtract as LectureExtractType } from "./schema";

export interface ExtractInput {
  slides: ParsedSlide[];
  transcriptChunks: string[];
  /** PDF/image content already prepared for this profile's capabilities. */
  documentParts: ModelFilePart[];
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
  const chunks = chunkLecture(
    { slides: input.slides, transcriptChunks: input.transcriptChunks },
    profile,
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
          content: buildContent(chunks[0]?.text ?? "", input.documentParts),
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
): UserContent {
  const parts: ModelFilePart[] = [...documentParts];

  if (lectureText.trim().length > 0) {
    parts.push({ type: "text", text: lectureText });
  }

  parts.push({
    type: "text",
    text: "Extract the learning objectives and high-yield content from this lecture.",
  });

  return parts as UserContent;
}

export type { LectureChunk };
