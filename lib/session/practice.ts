import type { PracticeQuestionContext } from "@/lib/tutor";

type PracticeRow = { question: string; answer: string; reviewItemIds: number[] | null };

/**
 * A practice question as the tutor sees it: the text, the answer, and the
 * numbers of the concepts it tests among the items in play. A link to a
 * suspended concept has no number, since that concept is not in the list
 * the grader marks; a row from before the link existed names none.
 */
export function practiceContext(
  question: PracticeRow,
  itemsInPlay: { id: number; ordinal: number }[],
): PracticeQuestionContext {
  const ordinalById = new Map(itemsInPlay.map((item) => [item.id, item.ordinal]));
  return {
    question: question.question,
    answer: question.answer,
    conceptOrdinals: (question.reviewItemIds ?? []).flatMap((id) => {
      const ordinal = ordinalById.get(id);
      return ordinal === undefined ? [] : [ordinal];
    }),
  };
}
