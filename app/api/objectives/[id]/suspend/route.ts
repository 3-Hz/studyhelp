import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";

/**
 * Dark green: stop quizzing this objective until it is reactivated.
 *
 * A row state, not a dashboard cell — writing a cell would claim the objective
 * was tested that day, and untested cells stay blank by construction.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const loId = Number(id);
    if (!Number.isInteger(loId)) {
      return NextResponse.json({ error: "Bad objective id." }, { status: 400 });
    }

    const body = (await request.json()) as { suspended?: boolean };
    const suspended = body.suspended === true;

    const [updated] = await db
      .update(schema.learningObjectives)
      .set({ suspended })
      .where(eq(schema.learningObjectives.id, loId))
      .returning({ suspended: schema.learningObjectives.suspended });

    if (!updated) {
      return NextResponse.json({ error: "No such objective." }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update the objective.";
    console.error("Suspend failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
