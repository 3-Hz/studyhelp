import { NextResponse } from "next/server";
import { DEFAULT_MINUTES } from "@/lib/session/budget";
import { startDailySession } from "@/lib/session/daily";
import { startSameDaySession } from "@/lib/session/sameDay";

/** The budgets the start buttons offer, and the widest a hand-typed one may be. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 180;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      lectureId?: number;
      type?: string;
      minutes?: number;
    };

    let minutes = DEFAULT_MINUTES;
    if (body.minutes !== undefined) {
      if (
        !Number.isInteger(body.minutes) ||
        body.minutes < MIN_MINUTES ||
        body.minutes > MAX_MINUTES
      ) {
        return NextResponse.json(
          { error: `Minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.` },
          { status: 400 },
        );
      }
      minutes = body.minutes;
    }

    if (body.type === "daily") {
      const sessionId = await startDailySession(new Date(), minutes);
      return NextResponse.json({ sessionId });
    }

    const lectureId = Number(body.lectureId);
    if (!Number.isInteger(lectureId)) {
      return NextResponse.json({ error: "Bad lecture id." }, { status: 400 });
    }

    const sessionId = await startSameDaySession(lectureId, minutes);
    return NextResponse.json({ sessionId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start the session.";
    console.error("Session start failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
