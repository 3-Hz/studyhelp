import { NextResponse } from "next/server";
import { ingestLecture, type IncomingFile } from "@/lib/ingest/ingestLecture";

/** Extraction over a full deck takes a while; don't cut it short. */
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const entries = form.getAll("files");

    const files: IncomingFile[] = [];
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      files.push({
        filename: entry.name,
        bytes: new Uint8Array(await entry.arrayBuffer()),
      });
    }

    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
