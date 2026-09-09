import { readFile } from "node:fs/promises";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { ExtractInput } from "@/lib/extract";
import { heading } from "@/lib/extract/chunk";
import type { SourceRole } from "@/lib/db/schema";
import { estimateTokens } from "@/lib/llm/tokens";
import type { ModelProfile } from "@/lib/llm/config";
import {
  prepareImage,
  preparePdf,
  type ModelFilePart,
} from "./documents";

export interface BuiltExtractInput {
  input: ExtractInput;
  warnings: string[];
}

/**
 * Assembles everything a lecture holds into one model input.
 *
 * This reads back from the database rather than from the upload that triggered
 * it, which is the whole point: adding a transcript next week has to produce
 * the same shape as uploading it alongside the deck, and one code path is the
 * only way to guarantee that.
 *
 * PDFs and images are re-read from disk and re-prepared against the current
 * profile every time, so a lecture first extracted by a text-only model gets a
 * genuinely better draft when re-run against one that can see.
 */
export async function buildExtractInput(
  lectureId: number,
  profile: ModelProfile,
): Promise<BuiltExtractInput> {
  const sources = await db
    .select()
    .from(schema.lectureSources)
    .where(eq(schema.lectureSources.lectureId, lectureId))
    .orderBy(asc(schema.lectureSources.uploadIndex));

  const assets = await db
    .select()
    .from(schema.lectureAssets)
    .where(eq(schema.lectureAssets.lectureId, lectureId));

  const filenameBySource = new Map(sources.map((s) => [s.id, s.filename]));
  const uploadIndexBySource = new Map(sources.map((s) => [s.id, s.uploadIndex]));
  const roleBySource = new Map(sources.map((s) => [s.id, s.role]));
  const roleFor = (asset: { sourceId: number | null }, fallback: SourceRole): SourceRole =>
    (asset.sourceId === null ? undefined : roleBySource.get(asset.sourceId)) ?? fallback;

  const slides = assets
    .filter((asset) => asset.kind === "slide")
    .sort((a, b) => (a.globalOrdinal ?? 0) - (b.globalOrdinal ?? 0))
    .map((asset) => ({
      // The model addresses slides by their global number, so that is the
      // ordinal it is shown. The per-deck number is recovered for humans.
      ordinal: asset.globalOrdinal ?? asset.ordinal,
      slideText: asset.slideText ?? "",
      notesText: asset.notesText ?? "",
      sourceLabel: sourceLabelFor(asset, filenameBySource),
      role: roleFor(asset, "deck"),
    }));

  const transcriptChunks = assets
    .filter((asset) => asset.kind === "transcript")
    .sort(
      (a, b) =>
        (uploadIndexBySource.get(a.sourceId ?? -1) ?? 0) -
          (uploadIndexBySource.get(b.sourceId ?? -1) ?? 0) ||
        a.ordinal - b.ordinal,
    )
    .map((asset) => ({
      text: asset.slideText ?? "",
      sourceLabel: sourceLabelFor(asset, filenameBySource),
      role: roleFor(asset, "transcript"),
    }));

  const documentParts: ModelFilePart[] = [];
  const warnings: string[] = [];
  let documentTokens = 0;

  for (const source of sources) {
    if (source.kind !== "pdf" && source.kind !== "image") continue;

    if (!source.storagePath) {
      warnings.push(
        `${source.filename}: no stored copy on disk, so it was not included. Re-upload it to have it read.`,
      );
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(source.storagePath));
    } catch {
      warnings.push(
        `${source.filename}: its stored copy is missing from ${source.storagePath}, so it was not included.`,
      );
      continue;
    }

    const result =
      source.kind === "pdf"
        ? await preparePdf(bytes, source.filename, profile)
        : prepareImage(bytes, source.filename, profile);

    warnings.push(...result.warnings);
    // A document that yielded nothing is not announced: the warning says why.
    if (result.parts.length > 0) {
      const text = announce(source.role, source.filename);
      documentParts.push({ type: "text", text }, ...result.parts);
      documentTokens += estimateTokens(text) + result.estimatedTokens;
    }
  }

  return {
    input: { slides, transcriptChunks, documentParts, documentTokens },
    warnings,
  };
}

/**
 * What a PDF or image is, said before its bytes: the heading chunking gives
 * a deck, plus what to make of the document. A quiz PDF and a lecture PDF
 * are the same file type, so this is the only way the model can tell.
 */
function announce(role: SourceRole, filename: string): string {
  const what: Record<SourceRole, string> = {
    deck: "The document that follows is the lecture's slide deck.",
    transcript: "The document that follows is the lecture transcript.",
    quiz:
      "The document that follows is the practice quiz supplied with this lecture. Its questions are practice questions, and its answer key gives their answers.",
    additional:
      "The document that follows is additional course material supplied with this lecture: a handout, a reading or a figure.",
  };
  return `${heading(role, filename)}\n\n${what[role]}`;
}

/** Legacy rows predate `source_id`; fall back to the filename they carry. */
function sourceLabelFor(
  asset: typeof schema.lectureAssets.$inferSelect,
  filenameBySource: Map<number, string>,
): string | undefined {
  const fromSource =
    asset.sourceId === null ? undefined : filenameBySource.get(asset.sourceId);
  return fromSource ?? asset.filename ?? undefined;
}
