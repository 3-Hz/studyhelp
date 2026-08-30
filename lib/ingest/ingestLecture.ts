import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { extractLecture, type ExtractionMeta } from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import { profileFor } from "@/lib/llm/config";
import {
  assetKindFor,
  prepareImage,
  preparePdf,
  type ModelFilePart,
} from "./documents";
import { parsePptx } from "./parsePptx";
import { chunkTranscript } from "./parseTranscript";

const UPLOAD_DIR = "uploads";

export interface IncomingFile {
  filename: string;
  bytes: Uint8Array;
}

export interface IngestResult {
  lectureId: number;
  extract: LectureExtract;
  meta: ExtractionMeta;
  warnings: string[];
  skipped: string[];
}

/**
 * Parses uploads, stores them as lecture assets, and runs extraction against
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

  const assetRows: (typeof schema.lectureAssets.$inferInsert)[] = [];
  const slides: ReturnType<typeof parsePptx> = [];
  const transcriptChunks: string[] = [];
  const documentParts: ModelFilePart[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];

  const lectureDir = join(UPLOAD_DIR, String(lecture.id));

  for (const file of files) {
    const kind = assetKindFor(file.filename);

    if (kind === "slide") {
      const parsed = parsePptx(file.bytes);
      slides.push(...parsed);
      for (const slide of parsed) {
        assetRows.push({
          lectureId: lecture.id,
          kind: "slide",
          ordinal: slide.ordinal,
          filename: file.filename,
          slideText: slide.slideText,
          notesText: slide.notesText,
        });
      }
      continue;
    }

    if (kind === "transcript") {
      const text = new TextDecoder().decode(file.bytes);
      const chunks = chunkTranscript(text);
      for (const chunk of chunks) {
        transcriptChunks.push(chunk.text);
        assetRows.push({
          lectureId: lecture.id,
          kind: "transcript",
          ordinal: chunk.ordinal,
          filename: file.filename,
          slideText: chunk.text,
        });
      }
      continue;
    }

    if (kind === "pdf" || kind === "image") {
      const storagePath = await persist(lectureDir, file);

      const result =
        kind === "pdf"
          ? await preparePdf(file.bytes, file.filename, profile)
          : prepareImage(file.bytes, file.filename, profile);

      documentParts.push(...result.parts);
      warnings.push(...result.warnings);

      assetRows.push({
        lectureId: lecture.id,
        kind,
        ordinal: assetRows.length + 1,
        filename: file.filename,
        storagePath,
      });
      continue;
    }

    skipped.push(file.filename);
  }

  if (assetRows.length === 0) {
    // Nothing usable came through — don't leave an orphan lecture behind.
    await db.delete(schema.lectures).where(eq(schema.lectures.id, lecture.id));
    throw new Error(
      `No supported files. Accepted: .pptx, .pdf, .txt, .vtt, .srt, .md, and images. Skipped: ${skipped.join(", ")}`,
    );
  }

  await db.insert(schema.lectureAssets).values(assetRows);

  const { extract, meta } = await extractLecture(
    { slides, transcriptChunks, documentParts },
    profile,
  );

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
    .where(eq(schema.lectures.id, lecture.id));

  return { lectureId: lecture.id, extract, meta, warnings, skipped };
}

/** Keeps the original bytes so a re-extraction doesn't need a re-upload. */
async function persist(dir: string, file: IncomingFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safeName = file.filename.replace(/[^\w.\-]+/g, "_");
  const path = join(dir, safeName);
  await writeFile(path, file.bytes);
  return path;
}
