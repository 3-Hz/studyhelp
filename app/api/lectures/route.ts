import { NextResponse } from "next/server";
import { createLecture } from "@/lib/ingest/ingestLecture";

/** A lecture starts as a title; its files come through /extract. */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return NextResponse.json({ error: "Give the lecture a title." }, { status: 400 });
    }

    const lectureId = await createLecture(title);
    return NextResponse.json({ lectureId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create the lecture.";
    console.error("Lecture creation failed:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
