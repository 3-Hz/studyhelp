import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/lib/db";
import SessionTurn from "./SessionTurn";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) notFound();

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  if (!session || session.lectureId === null) notFound();

  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, session.lectureId),
  });
  if (!lecture) notFound();

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, session.lectureId),
    orderBy: [asc(schema.learningObjectives.orderIndex)],
  });

  if (session.endedAt) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          {lecture.title}
        </h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          This session is finished. Today&rsquo;s results are on the{" "}
          <Link href="/dashboard" className="underline">
            dashboard
          </Link>
          .
        </p>
      </div>
    );
  }

  // The turn itself is fetched by the client, not rendered here: generating a
  // question calls a model, and that does not belong in a render pass.
  return (
    <div className="max-w-3xl">
      <p className="text-xs uppercase tracking-wide text-stone-500">
        Same-day review
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {lecture.title}
      </h1>

      <SessionTurn
        sessionId={sessionId}
        objectiveCount={objectives.filter((o) => !o.suspended).length}
      />
    </div>
  );
}
