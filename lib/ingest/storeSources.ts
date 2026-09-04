import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, max } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { assetKindFor } from "./documents";
import { parsePptx } from "./parsePptx";
import { chunkTranscript } from "./parseTranscript";

/**
 * Where uploaded bytes live. Overridable so tests get their own directory
 * rather than writing into — and cleaning up — the running app's.
 */
export function uploadDir(): string {
  return process.env.UPLOAD_DIR ?? "uploads";
}

export interface IncomingFile {
  filename: string;
  bytes: Uint8Array;
}

/** Nothing in the upload could be used. A user mistake, not a server fault. */
export class UnsupportedFilesError extends Error {
  constructor(result: StoreResult) {
    super(
      [
        "No supported files. Accepted: .pptx, .pdf, .txt, .vtt, .srt, .md, and images.",
        `Skipped: ${result.skipped.join(", ")}`,
        ...result.warnings,
      ].join(" "),
    );
    this.name = "UnsupportedFilesError";
  }
}

export interface StoreResult {
  /** Files that were understood and recorded. */
  stored: string[];
  /** Files of a type we don't handle. */
  skipped: string[];
  /** Files of a handled type that would not parse. */
  warnings: string[];
}

/**
 * Records uploaded files against a lecture: one `lecture_sources` row each,
 * the original bytes on disk, and the parsed slides or transcript chunks as
 * `lecture_assets`.
 *
 * Numbering continues from whatever the lecture already holds, so a file added
 * a week after the deck slots in behind it rather than colliding with it. A
 * file that won't parse is reported and skipped — one unreadable deck must not
 * discard the three files uploaded alongside it.
 */
export async function storeSources(
  lectureId: number,
  files: IncomingFile[],
): Promise<StoreResult> {
  const [existing] = await db
    .select({
      uploadIndex: max(schema.lectureSources.uploadIndex),
    })
    .from(schema.lectureSources)
    .where(eq(schema.lectureSources.lectureId, lectureId));

  const [existingSlides] = await db
    .select({ globalOrdinal: max(schema.lectureAssets.globalOrdinal) })
    .from(schema.lectureAssets)
    .where(eq(schema.lectureAssets.lectureId, lectureId));

  let uploadIndex = (existing?.uploadIndex ?? 0) + 1;
  let globalOrdinal = (existingSlides?.globalOrdinal ?? 0) + 1;

  const stored: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const lectureDir = join(uploadDir(), String(lectureId));

  for (const file of files) {
    const kind = assetKindFor(file.filename);

    if (!kind) {
      skipped.push(file.filename);
      continue;
    }

    // Parse before writing anything, so a file that fails leaves no trace.
    let assets: Omit<
      typeof schema.lectureAssets.$inferInsert,
      "lectureId" | "sourceId" | "kind" | "filename"
    >[];

    try {
      assets = parseInto(kind, file, () => globalOrdinal++);
    } catch (error) {
      warnings.push(
        `${file.filename}: could not be read (${
          error instanceof Error ? error.message : "unknown error"
        }). Skipped.`,
      );
      skipped.push(file.filename);
      continue;
    }

    const storagePath = await persist(lectureDir, uploadIndex, file);

    const [source] = await db
      .insert(schema.lectureSources)
      .values({
        lectureId,
        kind,
        filename: file.filename,
        uploadIndex,
        storagePath,
        byteSize: file.bytes.byteLength,
      })
      .returning({ id: schema.lectureSources.id });

    if (assets.length > 0) {
      await db.insert(schema.lectureAssets).values(
        assets.map((asset) => ({
          ...asset,
          lectureId,
          sourceId: source.id,
          kind,
          filename: file.filename,
        })),
      );
    }

    stored.push(file.filename);
    uploadIndex++;
  }

  return { stored, skipped, warnings };
}

/**
 * Text-bearing formats are parsed now and kept as assets. PDFs and images have
 * no text to hold — they are re-read from disk at extraction time, so the model
 * of the day gets its best shot at them rather than a snapshot of an older
 * model's capabilities.
 */
function parseInto(
  kind: NonNullable<ReturnType<typeof assetKindFor>>,
  file: IncomingFile,
  nextGlobalOrdinal: () => number,
): Omit<
  typeof schema.lectureAssets.$inferInsert,
  "lectureId" | "sourceId" | "kind" | "filename"
>[] {
  if (kind === "slide") {
    return parsePptx(file.bytes).map((slide) => ({
      ordinal: slide.ordinal,
      globalOrdinal: nextGlobalOrdinal(),
      slideText: slide.slideText,
      notesText: slide.notesText,
    }));
  }

  if (kind === "transcript") {
    const text = new TextDecoder().decode(file.bytes);
    return chunkTranscript(text).map((chunk) => ({
      ordinal: chunk.ordinal,
      slideText: chunk.text,
    }));
  }

  return [];
}

/**
 * Keeps the original bytes so a re-extraction doesn't need a re-upload.
 *
 * The upload index prefixes the name because two files called `figure.png` in
 * one lecture is ordinary, and without it the second would overwrite the first.
 */
async function persist(
  dir: string,
  uploadIndex: number,
  file: IncomingFile,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safeName = file.filename.replace(/[^\w.\-]+/g, "_");
  const path = join(dir, `${uploadIndex}-${safeName}`);
  await writeFile(path, file.bytes);
  return path;
}
