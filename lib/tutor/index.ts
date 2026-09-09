import type { LanguageModel } from "ai";
import type { Mark, Score, SessionStage } from "@/lib/db/schema";
import { profileFor, type ModelProfile } from "@/lib/llm/config";
import { generateStructured } from "@/lib/llm/structured";
import type { QuestionOrder, Tier } from "@/lib/schedule";
import {
  DebriefOutput,
  GradeOutput,
  HINTED_NOTE,
  HintOutput,
  QuestionOutput,
  questionSchemaFor,
  TUTOR_SYSTEM,
  type QuestionFormat,
} from "./schema";

export * from "./schema";

/** A review item, flattened to what the tutor needs to see. */
export interface ConceptContext {
  concept: string;
  kind: string;
  provenance: string;
  /**
   * The concept's number within its objective. Absent (or 0) for an item
   * that predates numbering; such a line is bulleted rather than numbered.
   */
  ordinal?: number;
  /** The review item behind it, so a numbered mark can be mapped back. Never shown. */
  reviewItemId?: number;
  /** Set only for concepts pulled in from another lecture. */
  lectureTitle?: string;
}

/** A question the lecture itself poses, with the answer its materials give. */
export interface PracticeQuestionContext {
  question: string;
  answer: string;
  /** The numbers, within the objective's list, of the concepts it tests. */
  conceptOrdinals?: number[];
}

/** The most recent graded attempt on a concept, from an earlier session. */
export interface PriorAttempt {
  daysAgo: number;
  /** The question's 1–5 score. */
  score: Score;
  /** This concept's mark in that attempt, when the answer touched it. */
  mark: Mark | null;
  hintsUsed: boolean;
  missing: string[];
  incorrect: string[];
  correction: string;
  /** True when the attempt graded the whole objective, not this concept. */
  aboutObjective: boolean;
}

export interface TurnContext {
  stage: SessionStage;
  lectureTitle: string;
  /** The objective under test. */
  objective?: string;
  concepts: ConceptContext[];
  /** Which concept this turn is about. Daily practice targets exactly one. */
  targetConcept?: string;
  /** Formats already used this session, so the next question varies. */
  usedFormats?: QuestionFormat[];
  /** The formats this turn may use. Enforced through the output schema. */
  allowedFormats?: QuestionFormat[];
  /** The item's mastery tier: shown on the badge after grading, not read by the prompt. */
  tier?: Tier;
  /**
   * How demanding the question should be, from the objective's latest score
   * (new_prompt.txt): first-order recall, second-order explanation,
   * third-order application. Absent means no steer.
   */
  order?: QuestionOrder;
  /** What happened last time this concept was tested, if it was. */
  lastAttempt?: PriorAttempt;
  /** The lecture's own questions for this objective, preferred when they fit. */
  practiceQuestions?: PracticeQuestionContext[];
}

/**
 * Shared plumbing for the three tutor calls. The profile is resolved per call
 * rather than at module load so an env change during dev takes effect, and the
 * model stays injectable for tests.
 */
export interface TutorOptions {
  profile?: ModelProfile;
  model?: LanguageModel;
}

/**
 * The concepts as a numbered list — the numbers are what the grader marks and
 * what the LO Map shows — with an unnumbered item bulleted instead.
 */
function conceptLines(concepts: ConceptContext[]): string {
  if (concepts.length === 0) return "(no concepts were extracted for this objective)";
  return concepts
    .map((c) => {
      const source = c.lectureTitle ? `, from ${c.lectureTitle}` : "";
      const marker = c.ordinal ? `${c.ordinal}.` : "-";
      return `${marker} [${c.kind}, ${c.provenance}${source}] ${c.concept}`;
    })
    .join("\n");
}

/** The target concept, named by its number when it has one. */
function targetLine(context: TurnContext): string {
  if (!context.targetConcept) return "";
  const target = context.concepts.find((c) => c.concept === context.targetConcept);
  const number = target?.ordinal ? `${target.ordinal}. ` : "";
  return `Target concept: ${number}${context.targetConcept}`;
}

/**
 * The lecture's own questions for the objective, each with the numbered
 * concepts it tests. Any that test the target concept lead, so the tutor
 * sees the fitting one first; the rest keep the order the lecture posed them.
 */
function practiceLines(context: TurnContext): string {
  const questions = context.practiceQuestions;
  if (!questions || questions.length === 0) return "";

  const target = context.targetConcept
    ? context.concepts.find((c) => c.concept === context.targetConcept)?.ordinal
    : undefined;
  const testsTarget = (q: PracticeQuestionContext) =>
    target !== undefined && (q.conceptOrdinals ?? []).includes(target);
  const ordered = [...questions].sort(
    (a, b) => Number(testsTarget(b)) - Number(testsTarget(a)),
  );

  const tests = (q: PracticeQuestionContext) => {
    const numbers = q.conceptOrdinals ?? [];
    if (numbers.length === 0) return "";
    return numbers.length === 1
      ? ` (tests concept ${numbers[0]})`
      : ` (tests concepts ${numbers.join(", ")})`;
  };

  return [
    "Practice questions the lecture itself provides for this objective, each with the numbered concepts it tests, any that test the target concept first. Prefer one of these, or a close variant, when it tests the target concept:",
    ...ordered.map(
      (q) => `- Q: ${q.question}${tests(q)}\n  A: ${q.answer || "(no answer given in the materials)"}`,
    ),
  ].join("\n");
}

/** The stages the tutor is asked to compose. The reflection is fixed text owned by the runner. */
type AskableStage = Exclude<SessionStage, "reflection">;

/** Per-stage instruction, kept out of the system block so that stays cacheable. */
const STAGE_BRIEF: Record<AskableStage, string> = {
  lo_recall: `This is LO recall. Ask the student to tell you everything they can about this one objective, before any answer is shown. Let them recite, outline, or work step by step.`,
  lo_probe: `This is a first-order probe: the recall of this objective left the target concept named below untested or short. Ask directly about that concept and nothing else — the fact, term, or step as the lecture taught it.`,
  daily: `This is daily retrieval practice, mixing material from several lectures. Ask about the target concept named below and nothing else. The student has met this material before, so do not re-teach it — ask them to retrieve it.`,
};

/**
 * How demanding the question should be, from the objective's latest score
 * (new_prompt.txt "Repetition Quiz Session": first-order on recent poor
 * performance, second on neutral, third on good). Kind decides the question's
 * shape through the format family; order decides its demand. Code sets the
 * order; the model shapes the question to it.
 */
const ORDER_BRIEF: Record<QuestionOrder, string> = {
  first:
    "This is a first-order question: direct recall of the material as it was taught. Ask a focused question about one part of this concept. Let the student work in steps. Do not combine it with other material.",
  second:
    "This is a second-order question. The student has retrieved this before. Ask for the whole concept, unscaffolded — why or how, not only what; nothing in the wording should narrow it.",
  third:
    "This is a third-order question. The student has retrieved this reliably. Test it through application or discrimination in a context the lecture did not use, combine it with the related concepts listed, and where plausible alternatives exist ask why the wrong ones are wrong.",
};

/**
 * Last time, as the model needs it: what was missed, what was wrong, the
 * correction given — and a steer that depends on order. A first-order
 * question targets the gap (prompt.txt: "target the missing component");
 * anything higher tests the same point by another route rather than
 * repeating the wording.
 */
function lastAttemptLines(last: PriorAttempt, order: QuestionOrder | undefined): string {
  const when =
    last.daysAgo === 0 ? "earlier today" : last.daysAgo === 1 ? "yesterday" : `${last.daysAgo} days ago`;
  const about = last.aboutObjective ? "on the objective as a whole" : "on this concept";
  const steer =
    order === undefined || order === "first"
      ? "Target what was missed."
      : "Do not repeat that wording: test the same point through a different route.";

  const marked = last.mark ? `, this concept ${last.mark}` : "";
  return [
    `Last attempt, ${when}, ${about}: scored ${last.score}/5${marked}${last.hintsUsed ? ", after a cue" : ""}.`,
    last.missing.length ? `  Missed: ${last.missing.join("; ")}` : "",
    last.incorrect.length ? `  Wrong: ${last.incorrect.join("; ")}` : "",
    last.correction ? `  Correction given: ${last.correction}` : "",
    steer,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function askQuestion(
  context: TurnContext,
  options: TutorOptions = {},
): Promise<QuestionOutput> {
  if (context.stage === "reflection") {
    throw new Error("The reflection question is fixed text; the tutor never composes it.");
  }

  const profile = options.profile ?? profileFor("tutor");

  const used = context.usedFormats?.length
    ? `\nFormats already used this session, which you should avoid repeating: ${context.usedFormats.join(", ")}.`
    : "";

  const orderBrief = context.order ? ORDER_BRIEF[context.order] : "";
  const lastAttempt = context.lastAttempt
    ? lastAttemptLines(context.lastAttempt, context.order)
    : "";

  const prompt = [
    STAGE_BRIEF[context.stage],
    orderBrief,
    lastAttempt,
    "",
    `Lecture: ${context.lectureTitle}`,
    context.objective ? `Objective: ${context.objective}` : "",
    targetLine(context),
    "",
    "Concepts available to build from:",
    conceptLines(context.concepts),
    practiceLines(context),
    used,
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await generateStructured({
    profile,
    model: options.model,
    schema: questionSchemaFor(context.allowedFormats),
    schemaName: "question",
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  return value;
}

export interface GradeRequest extends TurnContext {
  question: string;
  studentAnswer: string;
  hintsUsed: boolean;
}

export async function gradeAnswer(
  request: GradeRequest,
  options: TutorOptions = {},
): Promise<GradeOutput> {
  const profile = options.profile ?? profileFor("tutor");

  const prompt = [
    "Grade this retrieval attempt.",
    "",
    `Lecture: ${request.lectureTitle}`,
    request.objective ? `Objective: ${request.objective}` : "",
    "",
    "Concepts the answer could reasonably have drawn on:",
    conceptLines(request.concepts),
    "",
    "Mark each numbered concept the answer tested — green, yellow or red — and leave out the ones it did not touch.",
    "",
    `Question asked: ${request.question}`,
    "",
    "The student's answer, verbatim:",
    request.studentAnswer.trim() || "(the student gave no answer)",
    request.hintsUsed ? `\n${HINTED_NOTE}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await generateStructured({
    profile,
    model: options.model,
    schema: GradeOutput,
    schemaName: "grade",
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  return value;
}

export interface HintRequest extends TurnContext {
  question: string;
  /** What the student has written so far, if anything. */
  partialAnswer?: string;
}

/**
 * A cue, not an answer (prompt.txt Retrieval Rules 2–3). Asking for one is
 * recorded on the attempt and caps the score at 4 and a green mark at yellow
 * — see capScore and capMark.
 */
export async function giveHint(
  request: HintRequest,
  options: TutorOptions = {},
): Promise<HintOutput> {
  const profile = options.profile ?? profileFor("tutor");

  const prompt = [
    "The student is stuck and has asked for a cue.",
    "Give the smallest hint that could unstick them — a narrower question, or a",
    "pointer to the right part of the material. Do not state the answer.",
    "",
    `Lecture: ${request.lectureTitle}`,
    request.objective ? `Objective: ${request.objective}` : "",
    "",
    "Concepts:",
    conceptLines(request.concepts),
    "",
    `Question asked: ${request.question}`,
    request.partialAnswer?.trim()
      ? `\nWhat they have written so far:\n${request.partialAnswer.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await generateStructured({
    profile,
    model: options.model,
    schema: HintOutput,
    schemaName: "hint",
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  return value;
}

export interface DebriefRequest {
  answered: {
    question: string;
    /** The question's 1–5 score. */
    score: number;
    missing: string[];
    incorrect: string[];
  }[];
  /** The student's own account of the session, from the reflection turn. */
  reflection?: string | null;
}

/**
 * The session's close-out. Never marks anything mastered: one correct answer
 * is not mastery, and saying so would undo the point of the ladder.
 */
export async function summariseSession(
  request: DebriefRequest,
  options: TutorOptions = {},
): Promise<DebriefOutput> {
  const profile = options.profile ?? profileFor("tutor");

  const reflection = request.reflection?.trim();

  const prompt = [
    "Summarise this retrieval session for the student.",
    "Be brief. Do not call anything mastered — that takes repeated independent",
    "retrieval across increasing intervals, not one good answer.",
    "",
    ...request.answered.map((attempt, index) =>
      [
        `${index + 1}. [${attempt.score}/5] ${attempt.question}`,
        attempt.missing.length ? `   missing: ${attempt.missing.join("; ")}` : "",
        attempt.incorrect.length ? `   wrong: ${attempt.incorrect.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    ...(reflection
      ? [
          "",
          "The student's own account of the session, in their words:",
          reflection,
          "",
          "Compare it with the graded record above. Where they disagree — something",
          "the student believes they know that the record says they missed, or the",
          "reverse — say so in one sentence as `calibration`. Leave it empty if they agree.",
        ]
      : []),
  ].join("\n");

  const { value } = await generateStructured({
    profile,
    model: options.model,
    schema: DebriefOutput,
    schemaName: "debrief",
    system: TUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  return value;
}
