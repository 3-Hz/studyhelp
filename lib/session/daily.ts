import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { startOfToday, tierOf, todayIso } from "@/lib/schedule";
import type {
  ConceptContext,
  PracticeQuestionContext,
  PriorAttempt,
  QuestionFormat,
} from "@/lib/tutor";
import { dailyBudget, DEFAULT_MINUTES } from "./budget";
import { dailyCandidates } from "./candidates";
import type { SessionKind } from "./kind";
import { priorAttempts } from "./prior";
import { allowedFormats, select, type PlannedSlot } from "./select";

/**
 * Daily interleaved practice: a budget's worth of objectives across every
 * committed lecture, one to three questions on each, chosen by select() and
 * frozen on the session row.
 *
 * Unlike the same-day review, this tests concepts rather than objectives —
 * one review item per question — so only the item asked moves on the ladder.
 */

type ReviewItemRow = typeof schema.reviewItems.$inferSelect;
type ObjectiveRow = typeof schema.learningObjectives.$inferSelect;

export interface DailyMaterial {
  plan: PlannedSlot[];
  itemById: Map<number, ReviewItemRow>;
  objectiveById: Map<number, ObjectiveRow>;
  lectureTitleById: Map<number, string>;
  siblingsByLo: Map<number, ReviewItemRow[]>;
  priorByItem: Map<number, PriorAttempt>;
  /** The lectures' own questions, by the objective they serve. */
  practiceByLo: Map<number, PracticeQuestionContext[]>;
}

export async function startDailySession(
  now: Date = new Date(),
  minutes: number = DEFAULT_MINUTES,
): Promise<number> {
  // Rejoin an unfinished session rather than starting a parallel one, so a
  // closed tab does not split a sitting in two — but only one started today.
  // A plan is a plan for the day it was chosen: yesterday's due dates are not
  // today's, so an older open session is left orphaned rather than resumed.
  // That costs a few dead rows, and buys the escape hatch that makes this fix
  // work — a session that becomes unplayable (turnContext throws if a lecture
  // is deleted while it's open) stops blocking every day after the one it
  // wedged on. It is not stamped with endedAt either: that would mark a
  // session finished that never was, and then miscount as "already finished
  // today" on /practice. A new budget is ignored on rejoin: the plan was
  // frozen with the old one.
  const open = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.type, "daily"),
      isNull(schema.sessions.endedAt),
      gte(schema.sessions.startedAt, startOfToday(now)),
    ),
  });
  if (open) return open.id;

  const plan = select(await dailyCandidates(), { today: todayIso(now), ...dailyBudget(minutes) });
  if (plan.length === 0) {
    throw new Error(
      "Nothing to practise yet. Commit a lecture's objectives, or reactivate a suspended one.",
    );
  }

  const [created] = await db
    .insert(schema.sessions)
    .values({ type: "daily", plan, minutes })
    .returning({ id: schema.sessions.id });

  return created.id;
}

export const dailyKind: SessionKind<DailyMaterial> = {
  async loadMaterial(session) {
    // Array.isArray, not just a length check: a stored plan that is JSON but
    // not an array (e.g. an object) would otherwise pass a bare `.length ===
    // 0` guard with `undefined`, and fail two lines later with a bare
    // TypeError instead of this message.
    if (!Array.isArray(session.plan) || session.plan.length === 0) {
      throw new Error("This daily session has no plan.");
    }
    const plan = session.plan as PlannedSlot[];

    const planned = await db.query.reviewItems.findMany({
      where: inArray(
        schema.reviewItems.id,
        [...new Set(plan.map((slot) => slot.reviewItemId))],
      ),
    });

    const loIds = [...new Set(plan.map((slot) => slot.loId))];
    const objectives = await db.query.learningObjectives.findMany({
      where: inArray(schema.learningObjectives.id, loIds),
    });

    // Siblings give a question its surrounding context without becoming its
    // target: the slot asks about one concept, not the whole objective.
    const siblings = await db.query.reviewItems.findMany({
      where: inArray(schema.reviewItems.loId, loIds),
    });

    const lectures = await db.query.lectures.findMany({
      where: inArray(
        schema.lectures.id,
        [...new Set(objectives.map((objective) => objective.lectureId))],
      ),
    });

    const siblingsByLo = new Map<number, ReviewItemRow[]>();
    for (const item of siblings) {
      const list = siblingsByLo.get(item.loId) ?? [];
      list.push(item);
      siblingsByLo.set(item.loId, list);
    }

    const priorByItem = await priorAttempts(session.id, plan);

    const questions = await db.query.practiceQuestions.findMany({
      where: inArray(schema.practiceQuestions.loId, loIds),
      orderBy: [asc(schema.practiceQuestions.id)],
    });
    const practiceByLo = new Map<number, PracticeQuestionContext[]>();
    for (const question of questions) {
      if (question.loId === null) continue;
      const list = practiceByLo.get(question.loId) ?? [];
      list.push({ question: question.question, answer: question.answer });
      practiceByLo.set(question.loId, list);
    }

    return {
      plan,
      itemById: new Map([...planned, ...siblings].map((item) => [item.id, item])),
      objectiveById: new Map(objectives.map((objective) => [objective.id, objective])),
      lectureTitleById: new Map(lectures.map((lecture) => [lecture.id, lecture.title])),
      siblingsByLo,
      priorByItem,
      practiceByLo,
    };
  },

  planNext(material, attempts) {
    const asked = new Set(
      attempts
        .map((attempt) => attempt.reviewItemId)
        .filter((id): id is number => id !== null),
    );

    const next = material.plan.find((slot) => !asked.has(slot.reviewItemId));
    if (!next) {
      // The questions, then the student's own account of them.
      if (attempts.some((attempt) => attempt.stage === "reflection")) return null;
      return { stage: "reflection", loId: null, reviewItemId: null };
    }

    const used = attempts.map((attempt) => attempt.format as QuestionFormat);

    return {
      stage: "daily",
      loId: next.loId,
      reviewItemId: next.reviewItemId,
      allowedFormats: allowedFormats(
        next.formatFamily,
        used,
        used[used.length - 1],
      ),
      tier: next.tier,
      order: next.order,
    };
  },

  turnContext(turn, material) {
    // Daily practice always targets one review item under one objective —
    // unlike the same-day flavour, there is no whole-lecture stage with a
    // legitimately absent objective. A turn that can't resolve one, or an
    // objective whose lecture title is missing, means loadMaterial and
    // planNext have drifted out of sync; that is a bug to surface, not a
    // blank to paper over with "" (which the runner turns into a silent
    // `null` title for the UI) or an invented lecture name reaching the
    // model's prompt as if it were real.
    const objective = turn.loId === null ? undefined : material.objectiveById.get(turn.loId);
    if (!objective) {
      throw new Error(`Daily turn has no matching objective for loId ${turn.loId}.`);
    }

    const lectureTitle = material.lectureTitleById.get(objective.lectureId);
    if (!lectureTitle) {
      throw new Error(`No lecture title found for lecture ${objective.lectureId}.`);
    }

    const item = turn.reviewItemId === null ? undefined : material.itemById.get(turn.reviewItemId);

    const flatten = (row: ReviewItemRow): ConceptContext => ({
      concept: row.concept,
      kind: row.kind,
      provenance: row.provenance,
      ordinal: row.ordinal,
      reviewItemId: row.id,
    });

    // The objective's concepts in their numbered order, the target among them.
    const concepts = [...(material.siblingsByLo.get(objective.id) ?? [])]
      .sort((a, b) => a.ordinal - b.ordinal || a.id - b.id)
      .map(flatten);
    if (item && !concepts.some((c) => c.concept === item.concept)) {
      concepts.unshift(flatten(item));
    }

    return {
      stage: "daily",
      lectureTitle,
      objective: objective.text,
      targetConcept: item?.concept,
      ...(item && material.priorByItem.has(item.id)
        ? { lastAttempt: material.priorByItem.get(item.id) }
        : {}),
      ...(material.practiceByLo.has(objective.id)
        ? { practiceQuestions: material.practiceByLo.get(objective.id) }
        : {}),
      concepts,
    };
  },

  progress(material, attempts) {
    // Answered turns only: the question in hand is the one being counted, not
    // one already behind the student. The reflection is the last position.
    const answered = attempts.filter((attempt) => attempt.studentAnswer !== null).length;
    const total = material.plan.length + 1;
    return { position: Math.min(answered + 1, total), total };
  },

  explain(turn, material) {
    if (turn.reviewItemId === null) return undefined;
    const slot = material.plan.find((s) => s.reviewItemId === turn.reviewItemId);
    const item = material.itemById.get(turn.reviewItemId);
    if (!slot || !item) return undefined;
    return {
      // A plan frozen before tiers existed carries none; the row can say.
      tier: slot.tier ?? tierOf(item),
      order: slot.order,
      lapses: item.lapses,
      streak: item.streak,
      intervalDays: item.intervalDays,
      dueOn: item.dueOn,
    };
  },
};
