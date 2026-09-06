import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/lib/db";
import type { Outcome } from "@/lib/session/kind";
import type { DebriefOutput } from "@/lib/tutor/schema";
import { Debrief } from "./Debrief";
import { Outcomes } from "./Outcomes";
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
  if (!session) notFound();

  let heading = "Daily practice";
  if (session.lectureId !== null) {
    const lecture = await db.query.lectures.findFirst({
      where: eq(schema.lectures.id, session.lectureId),
    });
    if (!lecture) notFound();
    heading = lecture.title;
  }

  if (session.endedAt) {
    const debrief = session.debrief as DebriefOutput | null;
    const outcomes = session.outcomes as Outcome[] | null;
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          This session is finished. Today&rsquo;s results are on the{" "}
          <Link href="/dashboard" className="underline">
            dashboard
          </Link>
          .
        </p>
        {session.type === "daily" && outcomes && <Outcomes outcomes={outcomes} />}
        {debrief && <Debrief debrief={debrief} />}
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
      <SessionTurn sessionId={sessionId} sessionType={session.type} />
    </div>
  );
}
