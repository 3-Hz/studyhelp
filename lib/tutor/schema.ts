import * as z from "zod";

/**
 * Question formats from prompt.txt "Daily Anki-Like Retrieval Practice".
 *
 * An enum rather than free text because the variety rule ("Do not ask 10
 * questions in the same format") has to be enforced by code counting formats,
 * not by asking the model to remember what it already did.
 */
export const QUESTION_FORMATS = [
  "free_recall",
  "short_answer",
  "mechanism",
  "comparison",
  "pathway",
  "consequence",
  "vignette",
  "discrimination",
  "patient_teaching",
  "error_correction",
  "summary",
  "synthesis",
] as const;

export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

export const QuestionOutput = z.object({
  format: z.enum(QUESTION_FORMATS),
  question: z
    .string()
    .describe(
      "The question to put to the student. One question only. It must not " +
        "contain or imply its own answer.",
    ),
  targetConcept: z
    .string()
    .optional()
    .describe("Which of the supplied concepts this question tests, if one."),
});

export type QuestionOutput = z.infer<typeof QuestionOutput>;

/**
 * The question contract for one slot.
 *
 * Narrowing the enum is how format variety is enforced — prompt.txt's "Do not
 * ask 10 questions in the same format" is a rule about the session, not a
 * judgement about the question, so the model gets no say in it. Validation and
 * repair are already handled by generateStructured.
 */
export function questionSchemaFor(allowed?: QuestionFormat[]) {
  if (!allowed || allowed.length === 0) return QuestionOutput;
  return QuestionOutput.extend({
    format: z.enum(allowed as [QuestionFormat, ...QuestionFormat[]]),
  });
}

/**
 * The grading contract.
 *
 * "suspended" is absent by design: dark green is the student's decision to stop
 * being quizzed on something, never a grade the model can hand out.
 */
export const GradeOutput = z.object({
  rating: z
    .enum(["green", "yellow", "red"])
    .describe(
      "green = accurate, complete and independently retrieved; yellow = " +
        "partly correct, missing important content, or needed meaningful " +
        "hints; red = the central answer was not recalled, or a major " +
        "misconception was stated.",
    ),
  correct: z.array(z.string()).describe("What the student got right."),
  missing: z
    .array(z.string())
    .describe("Important content the answer omitted."),
  incorrect: z
    .array(z.string())
    .describe("Statements that were wrong, as distinct from merely absent."),
  correction: z
    .string()
    .describe("The single most important correction, stated concisely."),
  modelAnswer: z
    .string()
    .describe("A concise model answer. Not a lecture — a few sentences."),
  followUp: z
    .string()
    .optional()
    .describe(
      "A retrieval question that sends the student back to recall rather " +
        "than rereading. Omit after a complete answer.",
    ),
});

export type GradeOutput = z.infer<typeof GradeOutput>;

export const HintOutput = z.object({
  hint: z
    .string()
    .describe(
      "The smallest cue that could unstick the student. It must not contain " +
        "the answer.",
    ),
});

export type HintOutput = z.infer<typeof HintOutput>;

/**
 * The close-out summary (prompt.txt "Session Completion").
 *
 * Short arrays, not paragraphs: the student has just done ten retrievals, and
 * a wall of text at the end invites rereading instead of recall.
 */
export const DebriefOutput = z.object({
  heldUp: z.array(z.string()).describe("What the student retrieved well."),
  shaky: z.array(z.string()).describe("What was partial or needed cues."),
  misconceptions: z
    .array(z.string())
    .describe("Specific wrong beliefs the session surfaced. Empty if none did."),
  focusNext: z
    .string()
    .describe("The single most useful thing to work on next, in one sentence."),
  calibration: z
    .string()
    .default("")
    .describe(
      "Where what the student told you about the session and the graded record " +
        "disagree — something they think they know that the record says they " +
        "missed, or the reverse — in one sentence. Empty when they agree, or " +
        "when no account was given.",
    ),
});

export type DebriefOutput = z.infer<typeof DebriefOutput>;

/**
 * Frozen instruction block, in the style of EXTRACTION_SYSTEM: kept byte-stable
 * so it forms a cacheable prefix. Nothing dynamic may be interpolated — the
 * lecture material and the stage instructions go in the user message.
 */
export const TUTOR_SYSTEM = `You are a medical school learning coach running retrieval practice. You work from *Make It Stick* principles: retrieval, spacing, interleaving, elaboration, and varied practice. Familiarity and recognition are not mastery.

The student does the cognitive work. Keep everything you write short.

Rules for asking:
- One question at a time.
- Never reveal the answer through the wording of the question.
- Prefer open-ended recall. Use multiple choice only when discriminating between plausible options is the point.
- Every question must test a meaningful concept, be answerable from the supplied material, and be unambiguous.
- Separate factual recall, mechanism, and clinical application rather than blurring them.
- Create difficulty through retrieval and application, never through obscurity or trick wording.

Rules for grading:
- Never call a meaningfully flawed answer correct. Being encouraging about a wrong answer is a failure.
- Distinguish major gaps from minor differences of wording.
- Content that is merely absent is not the same as content that is wrong. Keep them separate.
- Keep feedback after a correct answer very brief.
- Feedback must lead back to active retrieval, not to rereading.

Provenance discipline: some supplied concepts are marked supplemental, meaning they are accurate medical knowledge that was NOT in the lecture. Never present supplemental content as something the lecture taught, and never fault a student for omitting it.`;

/** Appended to the user message when the student has already taken a cue. */
export const HINTED_NOTE = `The student received a cue before answering. Grade what they produced on its merits, but hinted recall is not independent recall.`;
