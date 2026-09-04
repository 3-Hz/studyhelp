import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { StartDailyButton } from "@/app/components/StartDailyButton";
import { db, schema } from "@/lib/db";
import { todayIso } from "@/lib/schedule";
import { dailyCandidates } from "@/lib/session/candidates";

export const dynamic = "force-dynamic";

export default async function PracticePage() {
  const today = todayIso();
  const candidates = await dailyCandidates();
  const eligible = candidates.filter((candidate) => !candidate.loSuspended);

  const due = eligible.filter((candidate) => candidate.dueOn <= today);
  const objectives = new Set(eligible.map((candidate) => candidate.loId));
  const lectures = new Set(eligible.map((candidate) => candidate.lectureId));

  const open = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.type, "daily"), isNull(schema.sessions.endedAt)),
  });

  const finished = (
    await db.query.sessions.findMany({ where: eq(schema.sessions.type, "daily") })
  ).filter((session) => session.endedAt && todayIso(session.endedAt) === today);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Daily practice</h1>

      {eligible.length === 0 ? (
        <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
          {candidates.length === 0 ? (
            <>
              Nothing to practise yet.{" "}
              <Link href="/import" className="underline">
                Import a lecture
              </Link>{" "}
              and approve its objectives first.
            </>
          ) : (
            <>
              Every objective is suspended. Reactivate one on the{" "}
              <Link href="/dashboard" className="underline">
                dashboard
              </Link>{" "}
              to practise again.
            </>
          )}
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
            {due.length} concept{due.length === 1 ? "" : "s"} due today, from{" "}
            {objectives.size} objective{objectives.size === 1 ? "" : "s"} across{" "}
            {lectures.size} lecture{lectures.size === 1 ? "" : "s"}.
          </p>

          {eligible.length < 10 && (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Only {eligible.length} concept{eligible.length === 1 ? "" : "s"}{" "}
              {eligible.length === 1 ? "exists" : "exist"} so far, so
              today&rsquo;s session will be that long rather than ten
              questions.
            </p>
          )}

          <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
            Ten questions: four due for review, two weak, two from recent
            material, and two that cross lectures. Nothing due yet is practised
            early rather than skipped.
          </p>

          <StartDailyButton resuming={open !== undefined} />

          {finished.length > 0 && (
            <p className="mt-6 text-xs text-stone-500">
              {finished.length} session{finished.length === 1 ? "" : "s"} already
              finished today. Another is fine — today&rsquo;s dashboard cell keeps
              the worst rating of them all.
            </p>
          )}
        </>
      )}
    </div>
  );
}
