import type { ConceptEmphasis, LectureExtract } from "./schema";

/**
 * Merges per-chunk extractions into one.
 *
 * This is deliberately plain code and NOT a second model call. Verbatim
 * objective wording is a hard requirement of the app; a model asked to merge
 * would paraphrase, renumber, or helpfully "clean up" the text. Pure code also
 * makes the merge unit-testable, which matters because a merge bug silently
 * duplicates or drops a student's objectives.
 */

/** Collapses casing, punctuation and whitespace so near-identical text matches. */
export function normaliseKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // Drop list markers the model may re-add per chunk: "1.", "a)", "-", "•".
    .replace(/^\s*(?:[-•*]|\(?[0-9a-z][.)])\s+/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function mergeExtracts(parts: LectureExtract[]): LectureExtract {
  if (parts.length === 0) {
    return {
      title: "",
      learningObjectives: [],
      concepts: [],
      practiceQuestions: [],
      commonConfusions: [],
      conflicts: [],
    };
  }
  if (parts.length === 1) return parts[0];

  // Title: first non-empty wins — the title slide is in the first chunk.
  const title = parts.find((p) => p.title.trim().length > 0)?.title ?? "";

  // Objectives: first occurrence keeps its verbatim text and position; later
  // duplicates only contribute additional slide references.
  const objectiveIndexByKey = new Map<string, number>();
  const learningObjectives: LectureExtract["learningObjectives"] = [];
  /** Per chunk: local objective index -> merged index. */
  const indexMaps: Map<number, number>[] = [];

  for (const part of parts) {
    const map = new Map<number, number>();
    part.learningObjectives.forEach((objective, localIndex) => {
      const key = normaliseKey(objective.text);
      if (key.length === 0) return;

      const existing = objectiveIndexByKey.get(key);
      if (existing !== undefined) {
        map.set(localIndex, existing);
        const merged = learningObjectives[existing];
        merged.slideRefs = unique([
          ...merged.slideRefs,
          ...objective.slideRefs,
        ]).sort((a, b) => a - b);
        return;
      }

      const mergedIndex = learningObjectives.length;
      learningObjectives.push({
        text: objective.text,
        slideRefs: unique(objective.slideRefs).sort((a, b) => a - b),
      });
      objectiveIndexByKey.set(key, mergedIndex);
      map.set(localIndex, mergedIndex);
    });
    indexMaps.push(map);
  }

  // Concepts: dedupe by label, remapping objective indexes onto merged ones.
  const conceptIndexByKey = new Map<string, number>();
  const concepts: LectureExtract["concepts"] = [];
  /** Per chunk: local concept index -> merged index, for the questions. */
  const conceptIndexMaps: Map<number, number>[] = [];

  parts.forEach((part, chunkIndex) => {
    const map = indexMaps[chunkIndex];
    const conceptMap = new Map<number, number>();
    conceptIndexMaps.push(conceptMap);
    part.concepts.forEach((concept, localIndex) => {
      const remapped = unique(
        concept.relatedObjectiveIndexes
          .map((local) => map.get(local))
          .filter((i): i is number => i !== undefined),
      ).sort((a, b) => a - b);

      const key = normaliseKey(concept.label);
      const existing = conceptIndexByKey.get(key);

      if (existing !== undefined) {
        const merged = concepts[existing];
        conceptMap.set(localIndex, existing);
        merged.relatedObjectiveIndexes = unique([
          ...merged.relatedObjectiveIndexes,
          ...remapped,
        ]).sort((a, b) => a - b);
        Object.assign(merged, strongerEmphasis(merged, concept));
        return;
      }

      conceptMap.set(localIndex, concepts.length);
      conceptIndexByKey.set(key, concepts.length);
      concepts.push({ ...concept, relatedObjectiveIndexes: remapped });
    });
  });

  // Practice questions: dedupe on the question — a recap slide repeats it —
  // keeping the first wording and answer, unioning the rest. Concept links
  // follow the concepts onto their merged positions.
  const questionIndexByKey = new Map<string, number>();
  const practiceQuestions: LectureExtract["practiceQuestions"] = [];

  parts.forEach((part, chunkIndex) => {
    const map = indexMaps[chunkIndex];
    const conceptMap = conceptIndexMaps[chunkIndex];
    for (const item of part.practiceQuestions) {
      const key = normaliseKey(item.question);
      if (key.length === 0) continue;

      const remapped = unique(
        item.relatedObjectiveIndexes
          .map((local) => map.get(local))
          .filter((i): i is number => i !== undefined),
      ).sort((a, b) => a - b);
      const remappedConcepts = unique(
        item.conceptIndexes
          .map((local) => conceptMap.get(local))
          .filter((i): i is number => i !== undefined),
      ).sort((a, b) => a - b);

      const existing = questionIndexByKey.get(key);
      if (existing !== undefined) {
        const merged = practiceQuestions[existing];
        merged.slideRefs = unique([...merged.slideRefs, ...item.slideRefs]).sort(
          (a, b) => a - b,
        );
        merged.relatedObjectiveIndexes = unique([
          ...merged.relatedObjectiveIndexes,
          ...remapped,
        ]).sort((a, b) => a - b);
        merged.conceptIndexes = unique([
          ...merged.conceptIndexes,
          ...remappedConcepts,
        ]).sort((a, b) => a - b);
        continue;
      }

      questionIndexByKey.set(key, practiceQuestions.length);
      practiceQuestions.push({
        ...item,
        slideRefs: unique(item.slideRefs).sort((a, b) => a - b),
        relatedObjectiveIndexes: remapped,
        conceptIndexes: remappedConcepts,
      });
    }
  });

  return {
    title,
    learningObjectives,
    concepts,
    practiceQuestions,
    commonConfusions: dedupeStrings(parts.flatMap((p) => p.commonConfusions)),
    conflicts: dedupeStrings(parts.flatMap((p) => p.conflicts)),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

type Concept = LectureExtract["concepts"][number];

/**
 * Across chunks the lecturer's stronger claim wins, whichever chunk made it.
 * Emphasized outranks deemphasized: wrongly keeping a concept costs a few
 * questions, wrongly cutting one costs an exam item. Either outranks neutral,
 * which is only the absence of a cue.
 */
const EMPHASIS_RANK: Record<ConceptEmphasis, number> = {
  neutral: 0,
  deemphasized: 1,
  emphasized: 2,
};

function strongerEmphasis(
  a: Concept,
  b: Concept,
): Pick<Concept, "emphasis" | "emphasisCue"> {
  const winner = EMPHASIS_RANK[b.emphasis] > EMPHASIS_RANK[a.emphasis] ? b : a;
  return { emphasis: winner.emphasis, emphasisCue: winner.emphasisCue };
}

/** Dedupes on the normalised key while emitting the original text. */
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normaliseKey(value);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
