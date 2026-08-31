import { NextResponse } from "next/server";
import { submitAnswer } from "@/lib/session/sameDay";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "Bad session id." }, { status: 400 });
    }

    const body = (await request.json()) as { answer?: string };
    const feedback = await submitAnswer(sessionId, body.answer ?? "");
    return NextResponse.json(feedback);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not grade the answer.";
    console.error("Grading failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
