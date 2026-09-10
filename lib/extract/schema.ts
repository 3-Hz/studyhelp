import * as z from "zod";
import { CONCEPT_EMPHASIS } from "@/lib/db/schema";

export { CONCEPT_EMPHASIS } from "@/lib/db/schema";
export type { ConceptEmphasis } from "@/lib/db/schema";

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
            "taught = stated in any of the lecture's materials (slides, notes, " +
              "transcript, practice quiz, additional course material); derived " +
              "= a reasonable inference from them; supplemental = outside " +
              "medical knowledge not present in any of them.",
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
        conceptIndexes: z
          .array(z.number())
          .min(1)
          .describe(
            "Indexes into concepts (0-based) of the concepts this question " +
              "tests. At least one: what a question tests is a key concept, " +
              "so it is always among the concepts.",
          ),
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

You will receive the materials for a single lecture, each headed by what it is: the slide deck with its presenter notes, the lecture transcript, a practice quiz, and additional course material such as handouts, readings and figures.

Identify every explicitly stated Learning Objective and preserve its wording closely. Objectives are usually listed on a slide titled "Learning Objectives", "Objectives", "Session Learning Objectives" or similar, near the start of the deck; take them from there. Copy each objective verbatim. Do not split one objective into several unless the lecture itself lists them separately, and do not merge separate objectives into one. If the lecture states no objectives, return an empty list rather than composing your own.

Then, for each objective, find the lecture content that satisfies it: the concepts, mechanisms, relationships, distinctions, and clinical applications a student needs. Record every independently testable idea as its own concept, in the order the lecture presents it, linked to the objectives it serves. Along the way, cover the major topics, high-yield concepts, comparisons, diagrams, pathways, clinical correlations, precise terminology, likely testable details, connections to prior knowledge, and common confusions.

Where the lecture puts questions to students — quiz slides, "test yourself", clicker questions, case prompts — record each with the answer the materials give, from the presenter notes or the following slide. Do not compose questions of your own. A practice quiz supplied as its own document, headed "Practice quiz", holds practice questions too: record every question in it, with the answer from its answer key.

A practice question shows what the course thinks is worth testing. Every concept a question tests is a key concept: record it as its own concept under the objective it serves, even when the slides mention it only in passing or only the quiz states it, and name it in the question's conceptIndexes. A concept only the quiz states is still taught: the quiz is course material. Read the questions before you list the concepts, so the concepts they test are in the list.

Label every concept by provenance, and be strict about it:
- "taught" — stated in any of the lecture's materials: slides, presenter notes, transcript, practice quiz, additional course material
- "derived" — a reasonable explanation following from the materials
- "supplemental" — accurate medical knowledge that is NOT in any of these materials

Never invent facts. Never attribute supplemental knowledge to the lecture. Where the course material conflicts with general medical knowledge, record it in conflicts rather than silently correcting the lecture.

Lecturers say what matters. In the transcript and the presenter notes, watch for cues such as "you need to know this", "this will be on the exam", "I will ask about this", and the reverse: "you don't need to memorise this", "just for interest", "not examinable", "I won't test you on this". Mark a concept "emphasized" when the lecturer says it must be known and "deemphasized" when they say it need not be, and quote the cue in emphasisCue. Always extract an emphasized concept, even one you would otherwise judge minor. Extract a deemphasized concept too, rather than dropping it, so the student can see what was set aside. A cue applies to what the lecturer was discussing at that moment, not to the lecture as a whole. Everything else is "neutral" with an empty cue. Emphasis never changes provenance. Content the lecturer flags as outside the course ("beyond the scope of this course", "only so you recognise the names") stays "supplemental", and is "deemphasized" as well; "deemphasized" on its own is for content the lecture does teach but says need not be known.

Additional course material — handouts, readings, figures — is course material. Extract its concepts as taught, under the objectives they serve, and weight it like the presenter notes. The lecturer's cues apply to it as to anything else, and where a concept came from never changes its provenance or drops it.

Presenter notes carry the explanations the slides omit. Weight them accordingly.`;

/**
 * Precedes the "Already extracted" block in the user message when a lecture
 * is extracted again. Fixed text, and in the user message rather than the
 * system prompt, so the system prompt stays a cacheable prefix.
 */
export const PRIOR_NOTE = `This lecture has been extracted before. The block headed "Already extracted" lists its recorded objectives and, under each, the labels of the concepts recorded so far. Where the materials state a recorded objective or concept, copy the recorded wording exactly — the same objective text, the same concept label — so the new extraction lines up with the old. Record anything the materials state that is not listed, under the objective it serves, with a label of its own. Do not rephrase, merge or renumber recorded items, and do not list a recorded item these materials do not state.`;

/** Appended when a lecture is processed in pieces. */
export const CHUNK_NOTE =`You are seeing ONE SECTION of a longer lecture. Extract only what this section states. Do not speculate about content in other sections, and do not invent objectives to fill gaps. A lecturer's cue about a concept counts as content this section states: extract the concept it refers to with that emphasis, even if the concept is explained more fully in another section. A practice question in this section may test a concept explained in another section: extract that concept here too, so the question can name it; the merge collapses the duplicate.`;
