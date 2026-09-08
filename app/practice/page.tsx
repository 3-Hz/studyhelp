import { and, eq, gte, isNull } from "drizzle-orm";
import Link from "next/link";
import { StartDailyButton } from "@/app/components/StartDailyButton";
import { db, schema } from "@/lib/db";
import { startOfToday, todayIso } from "@/lib/schedule";
import { dailyBudget, DEFAULT_MINUTES } from "@/lib/session/budget";
import { dailyCandidates } from "@/lib/session/candidates";
import { isEligible, isItemDue } from "@/lib/session/select";

export const dynamic = "force-dynamic";

export default async function PracticePage() {
  const today = todayIso();
  const candidates = await dailyCandidates();
  const eligible = candidates.filter(isEligible);

  const items = eligible.flatMap((candidate) => candidate.items);
  const due = items.filter((item) => isItemDue(item, today));
  const objectives = new Set(eligible.map((candidate) => candidate.loId));
  const lectures = new Set(eligible.map((candidate) => candidate.lectureId));
  const defaultQuestions = dailyBudget(DEFAULT_MINUTES).questions;

  // Bounded to today, so this matches exactly what startDailySession will
  // rejoin — otherwise the button could offer "Resume today's session" for a
  // session actually started days ago.
  const open = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.type, "daily"),
      isNull(schema.sessions.endedAt),
      gte(schema.sessions.startedAt, startOfToday()),
    ),
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

          {items.length < defaultQuestions && (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Only {items.length} concept{items.length === 1 ? "" : "s"}{" "}
              {items.length === 1 ? "exists" : "exist"} so far, so
              today&rsquo;s session may run shorter than its time budget.
            </p>
          )}

          <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
            Pick how long you have. Twenty minutes is ten questions on five
            objectives, two each; longer goes deeper, shorter goes wider.
            Objectives whose concepts are most overdue come first, a weaker
            history breaking ties; at most a third of the session comes from
            one lecture, and consecutive objectives come from different
            lectures. Each question is first-, second- or third-order by how
            the objective went last time. Nothing due yet is practised early
            rather than skipped.
          </p>

          <StartDailyButton resuming={open !== undefined} />

          {finished.length > 0 && (
            <p className="mt-6 text-xs text-stone-500">
              {finished.length} session{finished.length === 1 ? "" : "s"} already
              finished today. Another is fine — today&rsquo;s dashboard cell keeps
              the lowest score of them all.
            </p>
          )}
        </>
      )}
    </div>
  );
}
