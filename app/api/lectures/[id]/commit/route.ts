import { NextResponse } from "next/server";
import { commitLecture, type ApprovedObjective } from "@/lib/commitLecture";

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

    const body = (await request.json()) as {
      objectives?: ApprovedObjective[];
    };

    const result = await commitLecture(lectureId, body.objectives ?? []);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error during commit.";
    console.error("Lecture commit failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
