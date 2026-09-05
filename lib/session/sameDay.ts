import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Rating } from "@/lib/db/schema";
import { worstByLo } from "@/lib/schedule";
import type { ConceptContext } from "@/lib/tutor";
import type { SessionKind } from "./kind";
import { planNextTurn, type GradedTurn } from "./plan";

export async function startSameDaySession(lectureId: number): Promise<number> {
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
  // closed tab does not silently split a sitting across two sessions.
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
    .values({ type: "same_day", lectureId })
    .returning({ id: schema.sessions.id });

  return created.id;
}

export interface SameDayMaterial {
  lectureTitle: string;
  objectives: (typeof schema.learningObjectives.$inferSelect)[];
  conceptsByLo: Map<number, ConceptContext[]>;
  itemIdsByLo: Map<number, number[]>;
}

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

    const conceptsByLo = new Map<number, ConceptContext[]>();
    const itemIdsByLo = new Map<number, number[]>();

    if (objectives.length > 0) {
      const items = await db.query.reviewItems.findMany({
        where: inArray(
          schema.reviewItems.loId,
          objectives.map((objective) => objective.id),
        ),
      });

      for (const item of items) {
        const concepts = conceptsByLo.get(item.loId) ?? [];
        concepts.push({
          concept: item.concept,
          kind: item.kind,
          provenance: item.provenance,
        });
        conceptsByLo.set(item.loId, concepts);

        const ids = itemIdsByLo.get(item.loId) ?? [];
        ids.push(item.id);
        itemIdsByLo.set(item.loId, ids);
      }
    }

    return { lectureTitle: lecture.title, objectives, conceptsByLo, itemIdsByLo };
  },

  planNext(material, attempts) {
    const graded: GradedTurn[] = attempts
      .filter((attempt) => attempt.rating !== null)
      .map((attempt) => ({
        stage: attempt.stage,
        loId: attempt.loId,
        rating: attempt.rating as Rating,
      }));
    const reflected = attempts.some((attempt) => attempt.stage === "reflection");

    const plan = planNextTurn(material.objectives, graded, { reflected });
    if (!plan) return null;
    return { stage: plan.stage, loId: plan.loId, reviewItemId: null };
  },

  turnContext(turn, material) {
    const objective = material.objectives.find((o) => o.id === turn.loId);

    // The summary stage is about the whole lecture, so it sees every concept.
    const concepts =
      turn.loId === null
        ? [...material.conceptsByLo.values()].flat()
        : (material.conceptsByLo.get(turn.loId) ?? []);

    return {
      stage: turn.stage,
      lectureTitle: material.lectureTitle,
      objective: objective?.text,
      concepts,
    };
  },

  itemOutcomes(attempts, material) {
    // Phase 2 tests objectives, not concepts, so every item under a tested
    // objective moves on that objective's worst rating for the sitting.
    const outcomes = new Map<number, Rating>();
    for (const [loId, rating] of worstByLo(attempts)) {
      for (const itemId of material.itemIdsByLo.get(loId) ?? []) {
        outcomes.set(itemId, rating);
      }
    }
    return outcomes;
  },
};
