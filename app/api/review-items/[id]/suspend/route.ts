import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";

/**
 * Stop quizzing one concept until it is reactivated: the objective's dark
 * green, at the level of a single numbered item on the LO Map.
 *
 * A row state, not a mark — the concept keeps its number, its ladder position
 * and its history, and simply drops out of every session's material.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const itemId = Number(id);
    if (!Number.isInteger(itemId)) {
      return NextResponse.json({ error: "Bad concept id." }, { status: 400 });
    }

    const body = (await request.json()) as { suspended?: boolean };
    const suspended = body.suspended === true;

    const [updated] = await db
      .update(schema.reviewItems)
      .set({ suspended })
      .where(eq(schema.reviewItems.id, itemId))
      .returning({ suspended: schema.reviewItems.suspended });

    if (!updated) {
      return NextResponse.json({ error: "No such concept." }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update the concept.";
    console.error("Suspend failed:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
