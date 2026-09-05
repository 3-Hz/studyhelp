import type { LanguageModel } from "ai";
import type { SessionStage } from "@/lib/db/schema";
import { profileFor, type ModelProfile } from "@/lib/llm/config";
import { generateStructured } from "@/lib/llm/structured";
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

/**
 * Why select() put this item in today's plan, turned into a one-sentence
 * steer on difficulty — never a rule the grading could be talked around,
 * since selection itself stays in code (prompt.txt "Adaptive Difficulty").
 * `interleaved` gets nothing here: the daily brief's cross-lecture framing
 * above already covers it, and repeating it would just be noise.
 */
const BUCKET_HINT: Partial<Record<Bucket, string>> = {
  due: "This item is owed for spaced review, so ask for the whole thing rather than a fragment.",
  weak: "This has gone badly before, so ask a focused question and let the student reconstruct it in steps.",
  recent: "This was taught recently, so a focused question is appropriate.",
};

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

  const bucketHint =
    context.stage === "daily" && context.bucket
      ? BUCKET_HINT[context.bucket]
      : undefined;

  const prompt = [
    STAGE_BRIEF[context.stage],
    bucketHint ?? "",
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
