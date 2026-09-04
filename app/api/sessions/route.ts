import { NextResponse } from "next/server";
import { startDailySession } from "@/lib/session/daily";
import { startSameDaySession } from "@/lib/session/sameDay";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { lectureId?: number; type?: string };

    if (body.type === "daily") {
      const sessionId = await startDailySession();
      return NextResponse.json({ sessionId });
    }

    const lectureId = Number(body.lectureId);
    if (!Number.isInteger(lectureId)) {
      return NextResponse.json({ error: "Bad lecture id." }, { status: 400 });
    }

    const sessionId = await startSameDaySession(lectureId);
    return NextResponse.json({ sessionId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start the session.";
    console.error("Session start failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
