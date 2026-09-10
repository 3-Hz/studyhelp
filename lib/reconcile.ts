import type { ConceptEmphasis, Provenance, ReviewKind } from "@/lib/db/schema";
import { EMPHASIS_RANK, normaliseKey } from "@/lib/extract/merge";
import type { LectureExtract } from "@/lib/extract/schema";

/**
 * Fits an extraction onto the rows a lecture already has.
 *
 * Every extraction re-reads the whole lecture, so the result names what is
 * already recorded as well as what is new. Rows are matched by wording and
 * kept as they are, with their number, ladder state, marks and suspension;
 * what is new appends with the next number. Nothing here deletes or
 * renumbers: history hangs off a row's id, and its number is what a grader
 * marks. Pure functions over plain data, so the rules are testable without
 * a database; `applyExtract` runs them in order and writes.
 */

export interface ExistingObjective {
  id: number;
  text: string;
  orderIndex: number;
}

export interface ExistingItem {
  id: number;
  loId: number;
  ordinal: number;
  label: string;
  emphasis: ConceptEmphasis;
  emphasisCue: string;
}

export interface ExistingQuestion {
  id: number;
  question: string;
  reviewItemIds: number[] | null;
}

export interface ObjectiveInsert {
  text: string;
  orderIndex: number;
  /** Every extract index this row stands for: repeats collapse onto the first. */
  extractIndexes: number[];
}

export interface ObjectivePlan {
  inserts: ObjectiveInsert[];
  /** Extract index → the id of the row it matched. */
  matched: Map<number, number>;
}

type ExtractObjective = LectureExtract["learningObjectives"][number];
type ExtractConcept = LectureExtract["concepts"][number];
type ExtractQuestion = LectureExtract["practiceQuestions"][number];

export function reconcileObjectives(
  existing: ExistingObjective[],
  extracted: ExtractObjective[],
): ObjectivePlan {
  const idByKey = new Map(existing.map((o) => [normaliseKey(o.text), o.id]));
  const pendingByKey = new Map<string, ObjectiveInsert>();
  const inserts: ObjectiveInsert[] = [];
  const matched = new Map<number, number>();
  let nextOrder = Math.max(-1, ...existing.map((o) => o.orderIndex)) + 1;

  extracted.forEach((objective, index) => {
    const key = normaliseKey(objective.text);
    if (key.length === 0) return;

    const id = idByKey.get(key);
    if (id !== undefined) {
      matched.set(index, id);
      return;
    }

    const pending = pendingByKey.get(key);
    if (pending) {
      pending.extractIndexes.push(index);
      return;
    }

    const insert = { text: objective.text.trim(), orderIndex: nextOrder++, extractIndexes: [index] };
    pendingByKey.set(key, insert);
    inserts.push(insert);
  });

  return { inserts, matched };
}

export interface ItemInsert {
  loId: number;
  ordinal: number;
  label: string;
  concept: string;
  kind: ReviewKind;
  provenance: Provenance;
  emphasis: ConceptEmphasis;
  emphasisCue: string;
  suspended: boolean;
  dueOn: string;
  intervalDays: 0;
  extractIndexes: number[];
}

export interface ItemUpdate {
  id: number;
  emphasis: ConceptEmphasis;
  emphasisCue: string;
}

export interface ItemPlan {
  inserts: ItemInsert[];
  updates: ItemUpdate[];
  matched: Map<number, number>;
}

/** Drafts from before emphasis existed carry no cue. */
function emphasisOf(concept: ExtractConcept): Pick<ItemInsert, "emphasis" | "emphasisCue"> {
  return {
    emphasis: concept.emphasis ?? "neutral",
    emphasisCue: concept.emphasisCue ?? "",
  };
}

/** The first of the indexes that names a row, if any. */
function resolveFirst(indexes: number[], idByIndex: Map<number, number>): number | undefined {
  for (const index of indexes) {
    const id = idByIndex.get(index);
    if (id !== undefined) return id;
  }
  return undefined;
}

export function reconcileConcepts(
  existing: ExistingItem[],
  extracted: ExtractConcept[],
  loIdByExtractIndex: Map<number, number>,
  today: string,
): ItemPlan {
  // Matched on the label anywhere in the lecture, not only under the
  // objective the model chose this time: a concept it refiled is matched
  // where it is rather than moved or duplicated, the rule the chunk merge
  // already follows.
  const rowByKey = new Map(existing.map((item) => [normaliseKey(item.label), item]));
  const pendingByKey = new Map<string, ItemInsert>();
  const nextOrdinal = new Map<number, number>();
  for (const item of existing) {
    nextOrdinal.set(item.loId, Math.max(nextOrdinal.get(item.loId) ?? 0, item.ordinal) + 1);
  }

  const inserts: ItemInsert[] = [];
  const updates: ItemUpdate[] = [];
  const matched = new Map<number, number>();

  extracted.forEach((concept, index) => {
    const key = normaliseKey(concept.label);
    const { emphasis, emphasisCue } = emphasisOf(concept);

    const row = rowByKey.get(key);
    if (row) {
      matched.set(index, row.id);
      // A stronger cue is news; a weaker one, or none, is a run that could
      // not see the transcript, and must not erase what an earlier run saw.
      if (
        EMPHASIS_RANK[emphasis] > EMPHASIS_RANK[row.emphasis] &&
        !updates.some((update) => update.id === row.id)
      ) {
        updates.push({ id: row.id, emphasis, emphasisCue });
      }
      return;
    }

    const pending = pendingByKey.get(key);
    if (pending) {
      pending.extractIndexes.push(index);
      return;
    }

    const loId = resolveFirst(concept.relatedObjectiveIndexes, loIdByExtractIndex);
    // A concept whose objectives all failed to resolve has nothing to hang from.
    if (loId === undefined) return;

    const ordinal = nextOrdinal.get(loId) ?? 1;
    nextOrdinal.set(loId, ordinal + 1);

    const insert: ItemInsert = {
      loId,
      ordinal,
      label: concept.label,
      concept: concept.detail ? `${concept.label} — ${concept.detail}` : concept.label,
      kind: concept.kind,
      provenance: concept.provenance,
      emphasis,
      emphasisCue,
      suspended: emphasis === "deemphasized",
      dueOn: today,
      intervalDays: 0,
      extractIndexes: [index],
    };
    pendingByKey.set(key, insert);
    inserts.push(insert);
  });

  return { inserts, updates, matched };
}

export interface QuestionInsert {
  loId: number | null;
  question: string;
  answer: string;
  slideRefs: number[];
  /** Null when the draft predates links, as the stored rows from then are. */
  reviewItemIds: number[] | null;
}

export interface QuestionUpdate {
  id: number;
  reviewItemIds: number[];
}

export interface QuestionPlan {
  inserts: QuestionInsert[];
  updates: QuestionUpdate[];
}

export function reconcileQuestions(
  existing: ExistingQuestion[],
  extracted: ExtractQuestion[],
  loIdByExtractIndex: Map<number, number>,
  itemIdByExtractIndex: Map<number, number>,
): QuestionPlan {
  const rowByKey = new Map(existing.map((q) => [normaliseKey(q.question), q]));
  const inserts: QuestionInsert[] = [];
  const updates: QuestionUpdate[] = [];

  for (const question of extracted) {
    const links = question.conceptIndexes as number[] | undefined;
    const resolved =
      links === undefined
        ? null
        : [...new Set(links.flatMap((index) => {
            const id = itemIdByExtractIndex.get(index);
            return id === undefined ? [] : [id];
          }))];

    const row = rowByKey.get(normaliseKey(question.question));
    if (row) {
      // Links only ever grow: a later extraction may name a concept this
      // question tests that the earlier one did not record.
      const had = row.reviewItemIds ?? [];
      const gained = (resolved ?? []).filter((id) => !had.includes(id));
      if (gained.length > 0) {
        updates.push({ id: row.id, reviewItemIds: [...had, ...gained] });
      }
      continue;
    }

    inserts.push({
      loId: resolveFirst(question.relatedObjectiveIndexes, loIdByExtractIndex) ?? null,
      question: question.question,
      answer: question.answer,
      slideRefs: question.slideRefs,
      reviewItemIds: resolved,
    });
  }

  return { inserts, updates };
}
