import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { startOfToday, todayIso } from "@/lib/schedule";
import type { ConceptContext, QuestionFormat } from "@/lib/tutor";
import type { SessionKind } from "./kind";
import { dailyCandidates } from "./candidates";
import { allowedFormats, select, type PlannedSlot } from "./select";

/**
 * Daily interleaved practice: ten questions across every committed lecture,
 * chosen by select() and frozen on the session row.
 *
 * Unlike the same-day review, this tests concepts rather than objectives — one
 * review item per question — so only the item asked moves on the ladder.
 */

type ReviewItemRow = typeof schema.reviewItems.$inferSelect;
type ObjectiveRow = typeof schema.learningObjectives.$inferSelect;

export interface DailyMaterial {
  plan: PlannedSlot[];
  itemById: Map<number, ReviewItemRow>;
  objectiveById: Map<number, ObjectiveRow>;
  lectureTitleById: Map<number, string>;
  siblingsByLo: Map<number, ReviewItemRow[]>;
}

export async function startDailySession(now: Date = new Date()): Promise<number> {
  // Rejoin an unfinished session rather than starting a parallel one, so a
  // closed tab does not split a sitting in two — but only one started today.
  // A plan is a plan for the day it was chosen: yesterday's due dates are not
  // today's, so an older open session is left orphaned rather than resumed.
  // That costs a few dead rows, and buys the escape hatch that makes this fix
  // work — a session that becomes unplayable (turnContext throws if a lecture
  // is deleted while it's open) stops blocking every day after the one it
  // wedged on. It is not stamped with endedAt either: that would mark a
  // session finished that never was, and then miscount as "already finished
  // today" on /practice.
  const open = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.type, "daily"),
      isNull(schema.sessions.endedAt),
      gte(schema.sessions.startedAt, startOfToday(now)),
    ),
  });
  if (open) return open.id;

  const plan = select(await dailyCandidates(), { today: todayIso(now) });
  if (plan.length === 0) {
    throw new Error(
      "Nothing to practise yet. Commit a lecture's objectives, or reactivate a suspended one.",
    );
  }

  const [created] = await db
    .insert(schema.sessions)
    .values({ type: "daily", plan })
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

    const wanted = new Set<number>();
    for (const slot of plan) {
      wanted.add(slot.reviewItemId);
      for (const companion of slot.companionItemIds) wanted.add(companion);
    }

    const planned = await db.query.reviewItems.findMany({
      where: inArray(schema.reviewItems.id, [...wanted]),
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

    return {
      plan,
      itemById: new Map([...planned, ...siblings].map((item) => [item.id, item])),
      objectiveById: new Map(objectives.map((objective) => [objective.id, objective])),
      lectureTitleById: new Map(lectures.map((lecture) => [lecture.id, lecture.title])),
      siblingsByLo,
    };
  },

  planNext(material, attempts) {
    const asked = new Set(
      attempts
        .map((attempt) => attempt.reviewItemId)
        .filter((id): id is number => id !== null),
    );

    const next = material.plan.find((slot) => !asked.has(slot.reviewItemId));
    if (!next) return null;

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
      bucket: next.bucket,
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

    const lectureTitleFor = (objective: ObjectiveRow): string => {
      const title = material.lectureTitleById.get(objective.lectureId);
      if (!title) {
        throw new Error(`No lecture title found for lecture ${objective.lectureId}.`);
      }
      return title;
    };

    const item = turn.reviewItemId === null ? undefined : material.itemById.get(turn.reviewItemId);
    const slot = material.plan.find((s) => s.reviewItemId === turn.reviewItemId);

    const flatten = (row: ReviewItemRow, lectureTitle?: string): ConceptContext => ({
      concept: row.concept,
      kind: row.kind,
      provenance: row.provenance,
      ...(lectureTitle ? { lectureTitle } : {}),
    });

    const siblings = (material.siblingsByLo.get(objective.id) ?? []).filter(
      (row) => row.id !== item?.id,
    );

    const companions = (slot?.companionItemIds ?? [])
      .map((id) => material.itemById.get(id))
      .filter((row): row is ReviewItemRow => row !== undefined)
      .map((row) => {
        const owner = material.objectiveById.get(row.loId);
        if (!owner) {
          throw new Error(`Companion review item ${row.id} has no matching objective.`);
        }
        return flatten(row, lectureTitleFor(owner));
      });

    return {
      stage: "daily",
      lectureTitle: lectureTitleFor(objective),
      objective: objective.text,
      targetConcept: item?.concept,
      concepts: [
        ...(item ? [flatten(item)] : []),
        ...siblings.map((row) => flatten(row)),
        ...companions,
      ],
    };
  },

  itemOutcomes(attempts) {
    // One question, one item: the concept asked is the concept that moves.
    const outcomes = new Map<number, Rating>();
    for (const attempt of attempts) {
      if (attempt.rating === null || attempt.reviewItemId === null) continue;
      outcomes.set(attempt.reviewItemId, attempt.rating);
    }
    return outcomes;
  },

  progress(material, attempts) {
    // Graded attempts only: the question in hand is the one being counted, not
    // one already behind the student.
    const answered = attempts.filter((attempt) => attempt.rating !== null).length;
    return {
      position: Math.min(answered + 1, material.plan.length),
      total: material.plan.length,
    };
  },

  async closeOut({ attempts, deps }) {
    const answered = attempts
      .filter((attempt) => attempt.rating !== null)
      .map((attempt) => {
        const grade = attempt.feedback
          ? (JSON.parse(attempt.feedback) as {
              missing?: string[];
              incorrect?: string[];
            })
          : {};
        return {
          question: attempt.question,
          rating: attempt.rating as string,
          missing: grade.missing ?? [],
          incorrect: grade.incorrect ?? [],
        };
      });

    if (answered.length === 0) return null;
    return deps.summariseSession({ answered });
  },
};
