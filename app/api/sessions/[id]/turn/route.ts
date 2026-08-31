import { NextResponse } from "next/server";
import { currentTurn } from "@/lib/session/sameDay";

/**
 * The question in hand, generated on first request and persisted, so this is
 * safe to call again on a reload.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const sessionId = Number(id);
    if (!Number.isInteger(sessionId)) {
      return NextResponse.json({ error: "Bad session id." }, { status: 400 });
    }

    const turn = await currentTurn(sessionId);
    return NextResponse.json(turn ? { turn } : { done: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not load the question.";
    console.error("Turn generation failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
