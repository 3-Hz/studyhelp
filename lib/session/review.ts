import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { startOfToday } from "@/lib/schedule";
import type {
  ConceptContext,
  PracticeQuestionContext,
  QuestionFormat,
} from "@/lib/tutor";
import { DEFAULT_MINUTES, reviewBudget } from "./budget";
import { practiceContext } from "./practice";
import type { SessionKind } from "./kind";
import { planNextTurn, type GradedTurn, type PlannedObjective } from "./plan";
import { allowedFormats, FORMAT_FAMILY } from "./select";

/** The chosen lectures as the session row stores them: unique, ascending. */
function normalise(lectureIds: number[]): number[] {
  return [...new Set(lectureIds)].sort((a, b) => a - b);
}

function sameSet(a: number[], b: number[]): boolean {
  const left = normalise(a);
  const right = normalise(b);
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * A review of one or more lectures, chosen ad hoc (new_prompt.txt "Review
 * Quiz Session"): every id must name a lecture with something to ask, an
 * unsuspended objective with an unsuspended concept under it.
 */
export async function startReviewSession(
  lectureIds: number[],
  minutes: number = DEFAULT_MINUTES,
  now: Date = new Date(),
): Promise<number> {
  const chosen = normalise(lectureIds);
  if (chosen.length === 0) throw new Error("Pick at least one lecture to review.");

  const lectures = await db.query.lectures.findMany({
    where: inArray(schema.lectures.id, chosen),
  });
  const byId = new Map(lectures.map((lecture) => [lecture.id, lecture]));

  const objectives = await db.query.learningObjectives.findMany({
    where: and(
      inArray(schema.learningObjectives.lectureId, chosen),
      eq(schema.learningObjectives.suspended, false),
    ),
  });
  const items =
    objectives.length === 0
      ? []
      : await db.query.reviewItems.findMany({
          where: and(
            inArray(
              schema.reviewItems.loId,
              objectives.map((objective) => objective.id),
            ),
            eq(schema.reviewItems.suspended, false),
          ),
        });
  const askable = new Set(items.map((item) => item.loId));
  const ready = new Set(
    objectives.filter((objective) => askable.has(objective.id)).map((o) => o.lectureId),
  );

  for (const id of chosen) {
    const lecture = byId.get(id);
    if (!lecture) throw new Error(`Lecture ${id} not found.`);
    if (!ready.has(id)) {
      throw new Error(
        `"${lecture.title}" has nothing to review yet: extract its objectives first, or reactivate a suspended one.`,
      );
    }
  }

  // Rejoin an unfinished review of the same lectures started today, so a
  // closed tab does not split a sitting across two sessions. Only today's,
  // as for daily practice: an older open session stays orphaned rather than
  // resumed. A new budget is ignored on rejoin: the plan runs on the one the
  // session began with.
  const open = await db.query.sessions.findMany({
    where: and(
      eq(schema.sessions.type, "review"),
      isNull(schema.sessions.endedAt),
      gte(schema.sessions.startedAt, startOfToday(now)),
    ),
  });
  const same = open.find((session) => sameSet(session.lectureIds ?? [], chosen));
  if (same) return same.id;

  const [created] = await db
    .insert(schema.sessions)
    .values({ type: "review", lectureIds: chosen, minutes })
    .returning({ id: schema.sessions.id });

  return created.id;
}

type ReviewItemRow = typeof schema.reviewItems.$inferSelect;
type ObjectiveRow = typeof schema.learningObjectives.$inferSelect;

export interface ReviewMaterial {
  lectureTitleById: Map<number, string>;
  /** Every objective of every chosen lecture, by lecture then by position. */
  objectives: ObjectiveRow[];
  /** Each objective's concepts, in numbered order. */
  itemsByLo: Map<number, ReviewItemRow[]>;
  /** The lectures' own questions, by the objective they serve. */
  practiceByLo: Map<number, PracticeQuestionContext[]>;
  /** How many objectives to cover and how many questions each, from the minutes given. */
  budget: { los: number; perLo: number };
}

/**
 * The review: first-order only (new_prompt.txt "Review Quiz Session"). Each
 * objective in the budget's subset is recalled whole, then probed on the
 * concepts the recall left untested or short, with the lectures taking
 * turns.
 */
export const reviewKind: SessionKind<ReviewMaterial> = {
  async loadMaterial(session) {
    const chosen = session.lectureIds ?? [];
    if (chosen.length === 0) {
      throw new Error("This session is not attached to any lecture.");
    }

    const lectures = await db.query.lectures.findMany({
      where: inArray(schema.lectures.id, chosen),
    });
    if (lectures.length === 0) throw new Error("The session's lectures no longer exist.");
    const lectureIds = lectures.map((lecture) => lecture.id);

    const objectives = await db.query.learningObjectives.findMany({
      where: inArray(schema.learningObjectives.lectureId, lectureIds),
      orderBy: [
        asc(schema.learningObjectives.lectureId),
        asc(schema.learningObjectives.orderIndex),
      ],
    });

    const itemsByLo = new Map<number, ReviewItemRow[]>();
    const practiceByLo = new Map<number, PracticeQuestionContext[]>();

    if (objectives.length > 0) {
      const loIds = objectives.map((objective) => objective.id);

      const items = await db.query.reviewItems.findMany({
        where: inArray(schema.reviewItems.loId, loIds),
        orderBy: [asc(schema.reviewItems.ordinal), asc(schema.reviewItems.id)],
      });
      for (const item of items) {
        // Left out of the material altogether: never probed, never in the
        // numbered list the grader marks, and so never moved by finishing.
        if (item.suspended) continue;
        const list = itemsByLo.get(item.loId) ?? [];
        list.push(item);
        itemsByLo.set(item.loId, list);
      }

      const questions = await db.query.practiceQuestions.findMany({
        where: inArray(schema.practiceQuestions.lectureId, lectureIds),
        orderBy: [asc(schema.practiceQuestions.id)],
      });
      for (const question of questions) {
        if (question.loId === null) continue;
        const list = practiceByLo.get(question.loId) ?? [];
        list.push(practiceContext(question, itemsByLo.get(question.loId) ?? []));
        practiceByLo.set(question.loId, list);
      }
    }

    const active = objectives.filter((objective) => !objective.suspended).length;
    const { los, perLo } = reviewBudget(session.minutes ?? DEFAULT_MINUTES, active);

    return {
      lectureTitleById: new Map(lectures.map((lecture) => [lecture.id, lecture.title])),
      objectives,
      itemsByLo,
      practiceByLo,
      budget: { los, perLo },
    };
  },

  planNext(material, attempts) {
    const graded: GradedTurn[] = attempts
      .filter((attempt) => attempt.score !== null)
      .map((attempt) => ({
        stage: attempt.stage,
        loId: attempt.loId,
        reviewItemId: attempt.reviewItemId,
        marks: attempt.conceptMarks ?? [],
      }));
    const reflected = attempts.some((attempt) => attempt.stage === "reflection");

    const objectives: PlannedObjective[] = material.objectives.map((objective) => ({
      id: objective.id,
      lectureId: objective.lectureId,
      orderIndex: objective.orderIndex,
      suspended: objective.suspended,
      items: (material.itemsByLo.get(objective.id) ?? []).map((item) => ({
        id: item.id,
        ordinal: item.ordinal,
      })),
    }));

    const plan = planNextTurn(objectives, graded, { reflected, ...material.budget });
    if (!plan) return null;

    if (plan.stage === "lo_probe") {
      // A probe is a first-order question on one concept, shaped by that
      // concept's kind and varied against what the session has already asked.
      const item = material.itemsByLo
        .get(plan.loId!)
        ?.find((candidate) => candidate.id === plan.reviewItemId);
      const used = attempts.map((attempt) => attempt.format as QuestionFormat);
      return {
        ...plan,
        order: "first",
        allowedFormats: item
          ? allowedFormats(FORMAT_FAMILY[item.kind], used, used[used.length - 1])
          : undefined,
      };
    }

    // The recall is first-order by nature — everything the student can
    // retrieve about the objective — so it carries no order brief, which
    // would narrow it to one part.
    return plan;
  },

  turnContext(turn, material) {
    // Every graded review turn is about one objective; the reflection never
    // reaches here. A turn that cannot find its objective means loadMaterial
    // and planNext have drifted apart, which is a bug to surface.
    const objective = material.objectives.find((o) => o.id === turn.loId);
    if (!objective) {
      throw new Error(`Review turn has no matching objective for loId ${turn.loId}.`);
    }
    const lectureTitle = material.lectureTitleById.get(objective.lectureId);
    if (!lectureTitle) {
      throw new Error(`No lecture title found for lecture ${objective.lectureId}.`);
    }

    const items = material.itemsByLo.get(objective.id) ?? [];

    const concepts: ConceptContext[] = items.map((item) => ({
      concept: item.concept,
      kind: item.kind,
      provenance: item.provenance,
      ordinal: item.ordinal,
      reviewItemId: item.id,
    }));

    const target =
      turn.reviewItemId === null
        ? undefined
        : items.find((item) => item.id === turn.reviewItemId);

    return {
      stage: turn.stage,
      lectureTitle,
      objective: objective.text,
      concepts,
      ...(target ? { targetConcept: target.concept } : {}),
      ...(material.practiceByLo.has(objective.id)
        ? { practiceQuestions: material.practiceByLo.get(objective.id) }
        : {}),
    };
  },
};
