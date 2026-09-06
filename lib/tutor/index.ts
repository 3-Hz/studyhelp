import type { LanguageModel } from "ai";
import type { Rating, SessionStage } from "@/lib/db/schema";
import { profileFor, type ModelProfile } from "@/lib/llm/config";
import { generateStructured } from "@/lib/llm/structured";
import type { Tier } from "@/lib/schedule";
import type { Bucket } from "@/lib/session/select";
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
  /** Set only for concepts pulled in from another lecture. */
  lectureTitle?: string;
}

/** The most recent graded attempt on a concept, from an earlier session. */
export interface PriorAttempt {
  daysAgo: number;
  rating: Rating;
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
  /** The objective under test. Absent for the whole-lecture summary stage. */
  objective?: string;
  concepts: ConceptContext[];
  /** Which concept this turn is about. Daily practice targets exactly one. */
  targetConcept?: string;
  /** Formats already used this session, so the next question varies. */
  usedFormats?: QuestionFormat[];
  /** The formats this turn may use. Enforced through the output schema. */
  allowedFormats?: QuestionFormat[];
  /**
   * Why select() chose this item for today's daily plan — due, weak, recent,
   * interleaved, fill. Absent for same-day turns, which have no such notion.
   */
  bucket?: Bucket;
  /** The item's mastery tier. Steers how demanding the question is. */
  tier?: Tier;
  /** What happened last time this concept was tested, if it was. */
  lastAttempt?: PriorAttempt;
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

function conceptLines(concepts: ConceptContext[]): string {
  if (concepts.length === 0) return "(no concepts were extracted for this objective)";
  return concepts
    .map((c) => {
      const source = c.lectureTitle ? `, from ${c.lectureTitle}` : "";
      return `- [${c.kind}, ${c.provenance}${source}] ${c.concept}`;
    })
    .join("\n");
}

/** The stages the tutor is asked to compose. The reflection is fixed text owned by the runner. */
type AskableStage = Exclude<SessionStage, "reflection">;

/** Per-stage instruction, kept out of the system block so that stays cacheable. */
const STAGE_BRIEF: Record<AskableStage, string> = {
  lo_recall: `This is LO recall. Ask the student to tell you everything they can about this one objective, before any answer is shown. Let them recite, outline, or work step by step.`,
  summary: `This is the lecture summary. Ask the student to summarise the whole lecture from memory, without notes. Do not name the objectives — recalling what the lecture covered is part of the task.`,
  elaboration: `This is elaboration and reflection. Ask why or how, compare similar concepts, predict the consequence of a mechanism failing, connect to earlier material, or have the student explain the idea to a classmate or patient. Go beyond restating the objective.`,
  daily: `This is daily retrieval practice, mixing material from several lectures. Ask about the target concept named below and nothing else. The student has met this material before, so do not re-teach it — ask them to retrieve it. Where concepts from other lectures are listed, the question should make the student distinguish or connect them rather than recite either one.`,
};

/** A focused question, in steps: prompt.txt "Adaptive Difficulty" for new or weak material. */
const FOCUSED_BRIEF =
  "Ask a focused question about one part of this concept. Let the student work in steps. Do not combine it with other material.";

/**
 * How demanding the question should be, from the item's tier (prompt.txt
 * "Adaptive Difficulty"). Kind decides the question's shape through the
 * format family; tier decides its demand. Code sets the tier; the model
 * shapes the question to it.
 */
const TIER_BRIEF: Record<Tier, string> = {
  new: FOCUSED_BRIEF,
  relearning: `The student missed this last time. ${FOCUSED_BRIEF}`,
  consolidating:
    "The student has retrieved this before. Ask for the whole concept, unscaffolded; nothing in the wording should narrow it.",
  mature:
    "The student has retrieved this reliably across increasing intervals. Test it through application or discrimination in a context the lecture did not use, combine it with the related concepts listed, and where plausible alternatives exist ask why the wrong ones are wrong.",
};

/**
 * Last time, as the model needs it: what was missed, what was wrong, the
 * correction given — and a steer that depends on tier. Relearning targets the
 * gap (prompt.txt: "target the missing component"); anything more mature
 * tests the same point by another route rather than repeating the wording.
 */
function lastAttemptLines(last: PriorAttempt, tier: Tier | undefined): string {
  const when =
    last.daysAgo === 0 ? "earlier today" : last.daysAgo === 1 ? "yesterday" : `${last.daysAgo} days ago`;
  const about = last.aboutObjective ? "on the objective as a whole" : "on this concept";
  const steer =
    tier === "new" || tier === "relearning"
      ? "Target what was missed."
      : "Do not repeat that wording: test the same point through a different route.";

  return [
    `Last attempt, ${when}, ${about}: rated ${last.rating}${last.hintsUsed ? " after a cue" : ""}.`,
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

  const tierBrief = context.tier ? TIER_BRIEF[context.tier] : "";
  const lastAttempt = context.lastAttempt
    ? lastAttemptLines(context.lastAttempt, context.tier)
    : "";

  const prompt = [
    STAGE_BRIEF[context.stage],
    tierBrief,
    lastAttempt,
    "",
    `Lecture: ${context.lectureTitle}`,
    context.objective ? `Objective: ${context.objective}` : "",
    context.targetConcept ? `Target concept: ${context.targetConcept}` : "",
    "",
    "Concepts available to build from:",
    conceptLines(context.concepts),
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
 * recorded on the attempt and caps the rating at yellow — see capRating.
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
    rating: string;
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
        `${index + 1}. [${attempt.rating}] ${attempt.question}`,
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
