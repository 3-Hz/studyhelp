import { NextResponse } from "next/server";
import { DEFAULT_MINUTES } from "@/lib/session/budget";
import { startDailySession } from "@/lib/session/daily";
import { startReviewSession } from "@/lib/session/review";

/** The budgets the start buttons offer, and the widest a hand-typed one may be. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 180;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      type?: string;
      lectureIds?: unknown;
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

    if (body.type === "review") {
      const ids = body.lectureIds;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every((id) => Number.isInteger(id))
      ) {
        return NextResponse.json({ error: "Pick at least one lecture." }, { status: 400 });
      }
      const sessionId = await startReviewSession(ids as number[], minutes);
      return NextResponse.json({ sessionId });
    }

    return NextResponse.json({ error: "Unknown session type." }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start the session.";
    console.error("Session start failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
