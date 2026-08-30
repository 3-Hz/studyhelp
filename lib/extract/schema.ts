import * as z from "zod";

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
        kind: z.enum(["fact", "mechanism", "application"]),
        provenance: z
          .enum(["taught", "derived", "supplemental"])
          .describe(
            "taught = stated in the slides or notes; derived = a reasonable " +
              "inference from them; supplemental = outside medical knowledge " +
              "not present in the materials.",
          ),
        relatedObjectiveIndexes: z
          .array(z.number())
          .describe("Indexes into learningObjectives (0-based)."),
      }),
    )
    .describe("High-yield concepts, mechanisms, comparisons and pathways."),
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

Identify every explicitly stated Learning Objective and preserve its wording closely. Copy each objective verbatim. Do not split one objective into several unless the lecture itself lists them separately, and do not merge separate objectives into one. If the lecture states no objectives, return an empty list rather than composing your own.

Then identify the major topics, high-yield concepts, mechanisms, comparisons, diagrams, pathways, clinical correlations, precise terminology, likely testable details, connections to prior knowledge, and common confusions.

Label every concept by provenance, and be strict about it:
- "taught" — stated in the slides or presenter notes
- "derived" — a reasonable explanation following from the materials
- "supplemental" — accurate medical knowledge that is NOT in these materials

Never invent facts. Never attribute supplemental knowledge to the lecture. Where the course material conflicts with general medical knowledge, record it in conflicts rather than silently correcting the lecture.

Presenter notes carry the explanations the slides omit. Weight them accordingly.`;

/** Appended when a lecture is processed in pieces. */
export const CHUNK_NOTE = `You are seeing ONE SECTION of a longer lecture. Extract only what this section states. Do not speculate about content in other sections, and do not invent objectives to fill gaps.`;
