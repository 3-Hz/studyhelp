import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type {
  ConceptContext,
  PracticeQuestionContext,
  QuestionFormat,
} from "@/lib/tutor";
import { DEFAULT_MINUTES, reviewBudget } from "./budget";
import type { SessionKind } from "./kind";
import { planNextTurn, type GradedTurn, type PlannedObjective } from "./plan";
import { allowedFormats, FORMAT_FAMILY } from "./select";

export async function startSameDaySession(
  lectureId: number,
  minutes: number = DEFAULT_MINUTES,
): Promise<number> {
  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });

  if (!lecture) throw new Error(`Lecture ${lectureId} not found.`);
  if (!lecture.committedAt) {
    throw new Error(
      "Review the lecture's objectives and commit them before studying it.",
    );
  }

  // Rejoin an unfinished session rather than starting a parallel one, so a
  // closed tab does not silently split a sitting across two sessions. A new
  // budget is ignored on rejoin: the plan runs on the one the session began with.
  const open = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.lectureId, lectureId),
      eq(schema.sessions.type, "same_day"),
      isNull(schema.sessions.endedAt),
    ),
  });
  if (open) return open.id;

  const [created] = await db
    .insert(schema.sessions)
    .values({ type: "same_day", lectureId, minutes })
    .returning({ id: schema.sessions.id });

  return created.id;
}

type ReviewItemRow = typeof schema.reviewItems.$inferSelect;
type ObjectiveRow = typeof schema.learningObjectives.$inferSelect;

export interface SameDayMaterial {
  lectureTitle: string;
  objectives: ObjectiveRow[];
  /** Each objective's concepts, in numbered order. */
  itemsByLo: Map<number, ReviewItemRow[]>;
  /** The lecture's own questions, by the objective they serve. */
  practiceByLo: Map<number, PracticeQuestionContext[]>;
  /** How many objectives to cover and how many questions each, from the minutes given. */
  budget: { los: number; perLo: number };
}

/**
 * The same-day review: first-order only (new_prompt.txt "Review Quiz
 * Session"). Each objective in the budget's subset is recalled whole, then
 * probed on the concepts the recall left untested or short.
 */
export const sameDayKind: SessionKind<SameDayMaterial> = {
  async loadMaterial(session) {
    if (session.lectureId === null) {
      throw new Error("This session is not attached to a lecture.");
    }

    const lecture = await db.query.lectures.findFirst({
      where: eq(schema.lectures.id, session.lectureId),
    });
    if (!lecture) throw new Error("The session's lecture no longer exists.");

    const objectives = await db.query.learningObjectives.findMany({
      where: eq(schema.learningObjectives.lectureId, session.lectureId),
      orderBy: [asc(schema.learningObjectives.orderIndex)],
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
        const list = itemsByLo.get(item.loId) ?? [];
        list.push(item);
        itemsByLo.set(item.loId, list);
      }

      const questions = await db.query.practiceQuestions.findMany({
        where: eq(schema.practiceQuestions.lectureId, session.lectureId),
        orderBy: [asc(schema.practiceQuestions.id)],
      });
      for (const question of questions) {
        if (question.loId === null) continue;
        const list = practiceByLo.get(question.loId) ?? [];
        list.push({ question: question.question, answer: question.answer });
        practiceByLo.set(question.loId, list);
      }
    }

    const active = objectives.filter((objective) => !objective.suspended).length;
    const { los, perLo } = reviewBudget(session.minutes ?? DEFAULT_MINUTES, active);

    return { lectureTitle: lecture.title, objectives, itemsByLo, practiceByLo, budget: { los, perLo } };
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
    const objective = material.objectives.find((o) => o.id === turn.loId);
    const items = turn.loId === null ? [] : (material.itemsByLo.get(turn.loId) ?? []);

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
      lectureTitle: material.lectureTitle,
      objective: objective?.text,
      concepts,
      ...(target ? { targetConcept: target.concept } : {}),
      ...(turn.loId !== null && material.practiceByLo.has(turn.loId)
        ? { practiceQuestions: material.practiceByLo.get(turn.loId) }
        : {}),
    };
  },
};
