import * as z from "zod";

/**
 * How the lecturer weighted a concept, read off cues in the transcript and
 * the presenter notes. A draft-time signal only: it decides whether a concept
 * starts ticked on the review screen, and is not stored past commit.
 */
export const CONCEPT_EMPHASIS = ["emphasized", "neutral", "deemphasized"] as const;
export type ConceptEmphasis = (typeof CONCEPT_EMPHASIS)[number];

/**
 * The extraction contract. Provider-neutral by construction — it carried over
 * unchanged from the Anthropic-only implementation.
 */
export const LectureExtract = z.object({
  title: z
    .string()
    .describe("The lecture's title, as written on the title slide."),
  learningObjectives: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "The learning objective copied VERBATIM from the lecture. Do not " +
              "reword, summarise, expand, or renumber it.",
          ),
        slideRefs: z
          .array(z.number())
          .describe("Slide numbers where this objective appears."),
      }),
    )
    .describe(
      "Every objective the lecture states explicitly, in the order given. " +
        "If the lecture states none, return an empty array — do not invent them.",
    ),
  concepts: z
    .array(
      z.object({
        label: z.string().describe("A short name for the concept."),
        detail: z
          .string()
          .describe("One or two sentences a question could be built from."),
        kind: z
          .enum(["fact", "mechanism", "relationship", "distinction", "application"])
          .describe(
            "fact = a term, definition or stated fact; mechanism = how " +
              "something works or happens; relationship = how two things " +
              "depend on or affect each other; distinction = what separates " +
              "two things students confuse; application = clinical use or " +
              "reasoning.",
          ),
        provenance: z
          .enum(["taught", "derived", "supplemental"])
          .describe(
            "taught = stated in the slides or notes; derived = a reasonable " +
              "inference from them; supplemental = outside medical knowledge " +
              "not present in the materials.",
          ),
        emphasis: z
          .enum(CONCEPT_EMPHASIS)
          .describe(
            "How the lecturer weighted it: emphasized = they said it must be " +
              "known or will be examined; deemphasized = they said it need not " +
              "be known or will not be examined; neutral = no such cue.",
          ),
        emphasisCue: z
          .string()
          .describe(
            "The lecturer's words behind the emphasis, quoted closely from the " +
              "transcript or notes. Empty when neutral.",
          ),
        relatedObjectiveIndexes: z
          .array(z.number())
          .describe("Indexes into learningObjectives (0-based)."),
      }),
    )
    .describe(
      "Every independently testable idea as its own concept — terms, " +
        "mechanisms, relationships, distinctions, clinical applications — in " +
        "the order the lecture presents them, each linked to the objectives " +
        "it serves.",
    ),
  practiceQuestions: z
    .array(
      z.object({
        question: z
          .string()
          .describe(
            "A question the lecture itself puts to students — a quiz slide, " +
              "'test yourself', a clicker question, a case prompt — copied closely.",
          ),
        answer: z
          .string()
          .describe(
            "The answer the materials give, from the presenter notes or the " +
              "following slide. Empty only if the materials give none.",
          ),
        slideRefs: z.array(z.number()).describe("Slide numbers where it is posed."),
        relatedObjectiveIndexes: z
          .array(z.number())
          .describe("Indexes into learningObjectives (0-based)."),
      }),
    )
    .describe(
      "Questions the lecture poses to students, with the answers the " +
        "materials supply. Empty if it poses none — do not compose your own.",
    ),
  commonConfusions: z
    .array(z.string())
    .describe("Pairs or sets of ideas students routinely mix up."),
  conflicts: z
    .array(z.string())
    .describe(
      "Places where the course material disagrees with general medical " +
        "knowledge. Empty if none.",
    ),
});

export type LectureExtract = z.infer<typeof LectureExtract>;

/**
 * Frozen instruction block. Kept byte-stable so it forms a cacheable prefix on
 * providers that support prefix caching; nothing dynamic may be interpolated.
 */
export const EXTRACTION_SYSTEM = `You process medical school lecture materials for a spaced-repetition study tool.

You will receive slides, presenter notes, transcripts, and figures for a single lecture.

Identify every explicitly stated Learning Objective and preserve its wording closely. Objectives are usually listed on a slide titled "Learning Objectives", "Objectives", "Session Learning Objectives" or similar, near the start of the deck; take them from there. Copy each objective verbatim. Do not split one objective into several unless the lecture itself lists them separately, and do not merge separate objectives into one. If the lecture states no objectives, return an empty list rather than composing your own.

Then, for each objective, find the lecture content that satisfies it: the concepts, mechanisms, relationships, distinctions, and clinical applications a student needs. Record every independently testable idea as its own concept, in the order the lecture presents it, linked to the objectives it serves. Along the way, cover the major topics, high-yield concepts, comparisons, diagrams, pathways, clinical correlations, precise terminology, likely testable details, connections to prior knowledge, and common confusions.

Where the lecture puts questions to students — quiz slides, "test yourself", clicker questions, case prompts — record each with the answer the materials give, from the presenter notes or the following slide. Do not compose questions of your own.

Label every concept by provenance, and be strict about it:
- "taught" — stated in the slides or presenter notes
- "derived" — a reasonable explanation following from the materials
- "supplemental" — accurate medical knowledge that is NOT in these materials

Never invent facts. Never attribute supplemental knowledge to the lecture. Where the course material conflicts with general medical knowledge, record it in conflicts rather than silently correcting the lecture.

Lecturers say what matters. In the transcript and the presenter notes, watch for cues such as "you need to know this", "this will be on the exam", "I will ask about this", and the reverse: "you don't need to memorise this", "just for interest", "not examinable", "I won't test you on this". Mark a concept "emphasized" when the lecturer says it must be known and "deemphasized" when they say it need not be, and quote the cue in emphasisCue. Always extract an emphasized concept, even one you would otherwise judge minor. Extract a deemphasized concept too, rather than dropping it, so the student can see what was set aside. A cue applies to what the lecturer was discussing at that moment, not to the lecture as a whole. Everything else is "neutral" with an empty cue. Emphasis is independent of provenance: "not examinable" said of supplemental material sets both.

Presenter notes carry the explanations the slides omit. Weight them accordingly.`;

/** Appended when a lecture is processed in pieces. */
export const CHUNK_NOTE = `You are seeing ONE SECTION of a longer lecture. Extract only what this section states. Do not speculate about content in other sections, and do not invent objectives to fill gaps. A lecturer's cue about a concept counts as content this section states: extract the concept it refers to with that emphasis, even if the concept is explained more fully in another section.`;
