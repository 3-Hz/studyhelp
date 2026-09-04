import { NextResponse } from "next/server";
import {
  addSourcesToLecture,
  LectureCommittedError,
} from "@/lib/ingest/ingestLecture";
import { filesFromForm } from "@/lib/ingest/formFiles";

/** Re-extraction reads the whole lecture again; don't cut it short. */
export const maxDuration = 600;

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
    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

    const result = await addSourcesToLecture(lectureId, files);

    return NextResponse.json({
      lectureId,
      stored: result.stored,
      objectiveCount: result.extract.learningObjectives.length,
      conceptCount: result.extract.concepts.length,
      skipped: result.skipped,
      warnings: result.warnings,
      meta: result.meta,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while adding files.";
    console.error("Adding lecture files failed:", error);
    // A committed lecture is a conflict with existing state, not a bad request.
    const status = error instanceof LectureCommittedError ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
