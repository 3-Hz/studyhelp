import { NextResponse } from "next/server";
import { finishSession } from "@/lib/session/runner";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "Bad session id." }, { status: 400 });
    }

    const result = await finishSession(sessionId);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not finish the session.";
    console.error("Session finish failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
