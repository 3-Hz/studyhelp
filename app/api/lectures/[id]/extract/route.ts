import { NextResponse } from "next/server";
import { filesFromForm } from "@/lib/ingest/formFiles";
import {
  extractLecture,
  LectureNotFoundError,
  NothingToExtractError,
  UnsupportedFilesError,
} from "@/lib/ingest/ingestLecture";

/** Extraction reads the whole lecture, every time; don't cut it short. */
export const maxDuration = 600;

/**
 * Stores whatever files came in the four boxes (none is fine once the
 * lecture has some), reads the whole lecture again, and fits the result
 * onto its rows. Extract and Amend on the lecture page both come here.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const lectureId = Number(id);
    if (!Number.isInteger(lectureId)) {
      return NextResponse.json({ error: "Bad lecture id." }, { status: 400 });
    }

    const files = await filesFromForm(await request.formData());
    const result = await extractLecture(lectureId, files);

    return NextResponse.json({
      lectureId,
      stored: result.stored,
      skipped: result.skipped,
      warnings: result.warnings,
      meta: result.meta,
      applied: result.applied,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error during extraction.";
    console.error("Lecture extraction failed:", error);
    const status =
      error instanceof LectureNotFoundError
        ? 404
        : // The wrong files, or none: the user's to fix, not a fault.
          error instanceof UnsupportedFilesError || error instanceof NothingToExtractError
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
