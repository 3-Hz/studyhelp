import { NextResponse } from "next/server";
import { filesFromForm } from "@/lib/ingest/formFiles";
import {
  ingestLecture,
  UnsupportedFilesError,
} from "@/lib/ingest/ingestLecture";

/** Extraction over a full deck takes a while; don't cut it short. */
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = await filesFromForm(form);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

    // Files arrive in box order, so the first is the deck when one was given.
    const fallbackTitle =
      (form.get("title") as string | null)?.trim() ||
      files[0].filename.replace(/\.[^.]+$/, "");

    const result = await ingestLecture(files, fallbackTitle);

    return NextResponse.json({
      lectureId: result.lectureId,
      objectiveCount: result.extract.learningObjectives.length,
      conceptCount: result.extract.concepts.length,
      skipped: result.skipped,
      warnings: result.warnings,
      meta: result.meta,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error during ingest.";
    console.error("Lecture ingest failed:", error);
    // Uploading the wrong kind of file is the user's mistake, not a fault.
    const status = error instanceof UnsupportedFilesError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
