import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { extractLecture, type ExtractionMeta } from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import { profileFor, type ModelProfile } from "@/lib/llm/config";
import { buildExtractInput } from "./buildExtractInput";
import {
  storeSources,
  UnsupportedFilesError,
  type IncomingFile,
} from "./storeSources";

export { UnsupportedFilesError } from "./storeSources";
export type { IncomingFile } from "./storeSources";

/** A lecture whose objectives are already scheduled will not take new files. */
export class LectureCommittedError extends Error {
  constructor() {
    super(
      "This lecture has already been committed, so its files are fixed. Its objectives are on the dashboard with their review history.",
    );
    this.name = "LectureCommittedError";
  }
}

export interface IngestResult {
  lectureId: number;
  extract: LectureExtract;
  meta: ExtractionMeta;
  warnings: string[];
  skipped: string[];
}

/**
 * Parses uploads, stores them as lecture sources, and runs extraction against
 * whichever model is configured for the `extract` role.
 *
 * The result is written to `lectures.draft_extract` as a DRAFT — nothing lands
 * in `learning_objectives` until a human approves it. Any capability warnings
 * (PDF read as text, images skipped) ride along so a degraded draft is visibly
 * degraded rather than quietly worse.
 */
export async function ingestLecture(
  files: IncomingFile[],
  fallbackTitle: string,
): Promise<IngestResult> {
  if (files.length === 0) {
    throw new Error("No files were uploaded.");
  }

  const profile = profileFor("extract");

  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: fallbackTitle })
    .returning({ id: schema.lectures.id });

  let stored: Awaited<ReturnType<typeof storeSources>>;
  try {
    stored = await storeSources(lecture.id, files);
  } catch (error) {
    await db.delete(schema.lectures).where(eq(schema.lectures.id, lecture.id));
    throw error;
  }

  if (stored.stored.length === 0) {
    // Nothing usable came through — don't leave an orphan lecture behind.
    await db.delete(schema.lectures).where(eq(schema.lectures.id, lecture.id));
    throw new UnsupportedFilesError(stored);
  }

  const extraction = await runExtraction(
    lecture.id,
    fallbackTitle,
    profile,
    stored.warnings,
  );

  return {
    lectureId: lecture.id,
    ...extraction,
    skipped: stored.skipped,
  };
}

export interface AddSourcesResult {
  extract: LectureExtract;
  meta: ExtractionMeta;
  warnings: string[];
  skipped: string[];
  stored: string[];
}

/**
 * Adds files to a lecture that already exists, then rebuilds its draft from
 * everything the lecture now holds. Slides keep the numbers they were given,
 * so a reference to slide 12 still means slide 12 after a transcript arrives.
 *
 * Committed lectures are refused: their objectives are already scheduled and
 * carry performance history, so silently redrafting underneath them would
 * rewrite what the student has been revising.
 */
export async function addSourcesToLecture(
  lectureId: number,
  files: IncomingFile[],
): Promise<AddSourcesResult> {
  if (files.length === 0) {
    throw new Error("No files were uploaded.");
  }

  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });

  if (!lecture) throw new Error(`Lecture ${lectureId} not found.`);
  if (lecture.committedAt) throw new LectureCommittedError();

  const profile = profileFor("extract");
  const stored = await storeSources(lectureId, files);

  if (stored.stored.length === 0) {
    throw new UnsupportedFilesError(stored);
  }

  const extraction = await runExtraction(
    lectureId,
    lecture.title,
    profile,
    stored.warnings,
  );

  return { ...extraction, skipped: stored.skipped, stored: stored.stored };
}

/**
 * Re-reads everything attached to a lecture and rewrites its draft. Shared by
 * first ingest and later additions so the two cannot drift apart.
 */
async function runExtraction(
  lectureId: number,
  fallbackTitle: string,
  profile: ModelProfile,
  priorWarnings: string[],
): Promise<{
  extract: LectureExtract;
  meta: ExtractionMeta;
  warnings: string[];
}> {
  const { input, warnings: inputWarnings } = await buildExtractInput(
    lectureId,
    profile,
  );

  const warnings = [...priorWarnings, ...inputWarnings];

  const { extract, meta } = await extractLecture(input, profile);

  if (meta.chunked) {
    warnings.push(
      `Lecture exceeded ${profile.modelId}'s context, so it was extracted in ${meta.chunkCount} sections and merged. Cross-section connections may be weaker than a single-pass read.`,
    );
  }

  await db
    .update(schema.lectures)
    .set({
      title: extract.title || fallbackTitle,
      draftExtract: extract,
      extractionMeta: meta,
      extractionWarnings: warnings,
      extractedAt: new Date(),
    })
    .where(eq(schema.lectures.id, lectureId));

  return { extract, meta, warnings };
}
