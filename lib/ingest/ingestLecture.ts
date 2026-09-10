import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { applyExtract, type ApplyResult } from "@/lib/applyExtract";
import {
  extractLecture as readMaterials,
  type ExtractionMeta,
} from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import { profileFor, type ModelProfile } from "@/lib/llm/config";
import { buildExtractInput } from "./buildExtractInput";
import {
  storeSources,
  UnsupportedFilesError,
  type IncomingFile,
  type StoreResult,
} from "./storeSources";

export { UnsupportedFilesError } from "./storeSources";
export type { IncomingFile } from "./storeSources";

export class LectureNotFoundError extends Error {
  constructor(lectureId: number) {
    super(`Lecture ${lectureId} not found.`);
    this.name = "LectureNotFoundError";
  }
}

/** Extraction was asked of a lecture with no files, new or stored. */
export class NothingToExtractError extends Error {
  constructor() {
    super("Add at least one file: this lecture has none to read.");
    this.name = "NothingToExtractError";
  }
}

/** A lecture begins as a title. Its files, and their reading, come after. */
export async function createLecture(title: string): Promise<number> {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error("Give the lecture a title.");

  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: trimmed })
    .returning({ id: schema.lectures.id });
  return lecture.id;
}

export interface IngestDeps {
  /** The model read; injectable so tests need no provider. */
  extract?: typeof readMaterials;
}

export interface ExtractLectureResult {
  extract: LectureExtract;
  meta: ExtractionMeta;
  warnings: string[];
  skipped: string[];
  stored: string[];
  applied: ApplyResult;
}

/**
 * Stores any new files, reads everything the lecture holds, and fits the
 * result onto its rows. One path serves the first extraction and every
 * amend: the model is shown what is already recorded so it reuses the
 * wordings, and the rows it names again are kept with their numbers and
 * history while the rest append. With no new files it re-reads the stored
 * ones, which is how a lecture is re-run on a better model, or recovered
 * from a write that failed halfway.
 */
export async function extractLecture(
  lectureId: number,
  files: IncomingFile[],
  deps: IngestDeps = {},
): Promise<ExtractLectureResult> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });
  if (!lecture) throw new LectureNotFoundError(lectureId);

  let stored: StoreResult = { stored: [], skipped: [], warnings: [] };
  if (files.length > 0) {
    stored = await storeSources(lectureId, files);
    if (stored.stored.length === 0) throw new UnsupportedFilesError(stored);
  }

  const anySource = await db.query.lectureSources.findFirst({
    where: eq(schema.lectureSources.lectureId, lectureId),
  });
  if (!anySource) throw new NothingToExtractError();

  const extraction = await runExtraction(
    lectureId,
    profileFor("extract"),
    stored.warnings,
    deps.extract ?? readMaterials,
  );
  const applied = await applyExtract(lectureId, extraction.extract);

  return {
    ...extraction,
    skipped: stored.skipped,
    stored: stored.stored,
    applied,
  };
}

/**
 * Reads everything attached to a lecture and records the raw result. The
 * title is the student's and is never written over. The extract is saved
 * before it is applied, so a write that fails halfway leaves something to
 * inspect, and the next Extract completes it.
 */
async function runExtraction(
  lectureId: number,
  profile: ModelProfile,
  priorWarnings: string[],
  read: typeof readMaterials,
): Promise<{ extract: LectureExtract; meta: ExtractionMeta; warnings: string[] }> {
  const { input, warnings: inputWarnings } = await buildExtractInput(
    lectureId,
    profile,
  );

  const warnings = [...priorWarnings, ...inputWarnings];

  const { extract, meta } = await read(input, profile);

  if (meta.chunked) {
    warnings.push(
      `Lecture exceeded ${profile.modelId}'s context, so it was extracted in ${meta.chunkCount} sections and merged. Cross-section connections may be weaker than a single-pass read.`,
    );
  }

  await db
    .update(schema.lectures)
    .set({
      draftExtract: extract,
      extractionMeta: meta,
      extractionWarnings: warnings,
      extractedAt: new Date(),
    })
    .where(eq(schema.lectures.id, lectureId));

  return { extract, meta, warnings };
}
