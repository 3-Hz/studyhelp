import { NextResponse } from "next/server";
import { requestHint } from "@/lib/session/runner";

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

    const body = (await request.json()) as { partialAnswer?: string };
    const hint = await requestHint(sessionId, body.partialAnswer);
    return NextResponse.json({ hint });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not produce a cue.";
    console.error("Hint failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
