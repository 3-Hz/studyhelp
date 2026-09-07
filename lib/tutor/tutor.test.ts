import { expect, test } from "bun:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelProfile } from "@/lib/llm/config";
import { askQuestion, gradeAnswer, giveHint, summariseSession } from "./index";
import { GradeOutput, QuestionOutput, TUTOR_SYSTEM } from "./schema";

/**
 * The tutor's contracts have to survive the prompted path, since a local model
 * is the realistic case for the cheap, high-frequency tutor role.
 */
const profile: ModelProfile = {
  role: "tutor",
  providerId: "openai-compatible",
  modelId: "mock",
  contextTokens: 8_192,
  maxOutputTokens: 1_024,
  supportsFileParts: false,
  supportsImages: false,
  structuredOutput: "prompted",
};

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    warnings: [],
  };
}

const context = {
  stage: "lo_recall" as const,
  lectureTitle: "Amyloidosis",
  objective: "Compare AL and ATTR amyloidosis.",
  concepts: [
    {
      concept: "AL vs ATTR precursor — light chains versus transthyretin.",
      kind: "mechanism",
      provenance: "taught",
    },
  ],
};

function capture() {
  const prompts: string[] = [];
  return { prompts };
}

test("a question comes back on the prompted path", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      textResult(
        '{"format":"comparison","question":"What distinguishes AL from ATTR?"}',
      ),
  });

  const question = await askQuestion(context, { profile, model });

  expect(question.format).toBe("comparison");
  expect(question.question).toMatch(/AL/);
});

test("an unknown question format is rejected rather than stored", async () => {
  // Two identical bad responses plus the repair attempts, so the ladder gives up.
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      textResult('{"format":"interpretive_dance","question":"Explain."}'),
  });

  await expect(askQuestion(context, { profile, model })).rejects.toThrow(
    /schema-valid/i,
  );
});

test("a grade survives markdown fences and leading prose", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      textResult(
        'Certainly! Here is my assessment:\n```json\n{"score":4,' +
          '"conceptMarks":[{"number":1,"mark":"yellow"}],' +
          '"correct":["Named both precursors"],"missing":["Organ tropism"],' +
          '"incorrect":[],"correction":"ATTR is transthyretin.",' +
          '"modelAnswer":"AL comes from light chains; ATTR from transthyretin."}\n```',
      ),
  });

  const grade = await gradeAnswer(
    { ...context, question: "Compare them.", studentAnswer: "AL is light chains.", hintsUsed: false },
    { profile, model },
  );

  expect(grade.score).toBe(4);
  expect(grade.conceptMarks).toEqual([{ number: 1, mark: "yellow" }]);
  expect(grade.missing).toEqual(["Organ tropism"]);
  expect(grade.followUp).toBeUndefined();
});

test("a score is a whole number from 1 to 5, and a mark is a colour", () => {
  const grade = (score: unknown, mark: unknown = "green") => ({
    score,
    conceptMarks: [{ number: 1, mark }],
    correct: [],
    missing: [],
    incorrect: [],
    correction: "x",
    modelAnswer: "y",
  });

  expect(GradeOutput.safeParse(grade(3)).success).toBe(true);
  expect(GradeOutput.safeParse(grade(0)).success).toBe(false);
  expect(GradeOutput.safeParse(grade(6)).success).toBe(false);
  expect(GradeOutput.safeParse(grade(3.5)).success).toBe(false);
  expect(GradeOutput.safeParse(grade("green")).success).toBe(false);
  expect(GradeOutput.safeParse(grade(5, "suspended")).success).toBe(false);
});

test("the system block carries the 1–5 rubric", () => {
  expect(TUTOR_SYSTEM).toMatch(/5 .*correct without help/i);
  expect(TUTOR_SYSTEM).toMatch(/1 .*no idea/i);
  expect(TUTOR_SYSTEM).toMatch(/mark .*each concept/i);
});

test("a hinted attempt tells the grader so in the prompt", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"score":5,"conceptMarks":[],"correct":[],"missing":[],"incorrect":[],' +
          '"correction":"none","modelAnswer":"ok"}',
      );
    },
  });

  await gradeAnswer(
    { ...context, question: "Compare them.", studentAnswer: "An answer.", hintsUsed: true },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/cue before answering/i);
});

test("concepts are numbered by their ordinal, and the target is named by number", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"free_recall","question":"Explain."}');
    },
  });

  const concepts = [
    { concept: "Cross-beta sheet — the shared fibril fold.", kind: "fact", provenance: "taught", ordinal: 1 },
    { concept: "Congo red — apple-green birefringence.", kind: "fact", provenance: "taught", ordinal: 2 },
    // Before the migration's backfill an item may carry no number.
    { concept: "Unnumbered.", kind: "fact", provenance: "derived" },
  ];

  await askQuestion(
    { ...context, stage: "daily", concepts, targetConcept: concepts[1].concept },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/1\. \[fact, taught\] Cross-beta/);
  expect(prompts[0]).toMatch(/2\. \[fact, taught\] Congo red/);
  expect(prompts[0]).toMatch(/- \[fact, derived\] Unnumbered/);
  expect(prompts[0]).toMatch(/Target concept: 2\. Congo red/);
});

test("the grader is asked to mark each numbered concept the answer tested", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"score":5,"conceptMarks":[{"number":1,"mark":"green"}],"correct":[],"missing":[],' +
          '"incorrect":[],"correction":"","modelAnswer":"ok"}',
      );
    },
  });

  await gradeAnswer(
    {
      ...context,
      concepts: [{ ...context.concepts[0], ordinal: 1 }],
      question: "Compare them.",
      studentAnswer: "An answer.",
      hintsUsed: false,
    },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/1\. \[mechanism, taught\]/);
  expect(prompts[0]).toMatch(/each numbered concept the answer tested/i);
  expect(prompts[0]).toMatch(/leave out/i);
});

test("the lecture's practice questions reach the ask prompt, to be preferred when they fit", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"short_answer","question":"Which stain?"}');
    },
  });

  await askQuestion(
    {
      ...context,
      practiceQuestions: [
        { question: "Which stain confirms amyloid?", answer: "Congo red." },
      ],
    },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/Practice questions the lecture/i);
  expect(prompts[0]).toMatch(/Which stain confirms amyloid\?/);
  expect(prompts[0]).toMatch(/Congo red\./);
  expect(prompts[0]).toMatch(/prefer one/i);

  await askQuestion(context, { profile, model });
  expect(prompts[1]).not.toMatch(/Practice questions/i);
});

test("supplied concepts carry their provenance into the prompt", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"free_recall","question":"Explain."}');
    },
  });

  await askQuestion(
    {
      ...context,
      concepts: [
        { concept: "Tafamidis stabilises TTR.", kind: "application", provenance: "supplemental" },
      ],
    },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/supplemental/);
});

test("used formats are passed on so the next question varies", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"vignette","question":"A patient presents…"}');
    },
  });

  await askQuestion(
    { ...context, usedFormats: ["free_recall", "comparison"] },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/already used/i);
  expect(prompts[0]).toMatch(/free_recall/);
});

test("a hint comes back as a cue", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      textResult('{"hint":"Think about which protein misfolds."}'),
  });

  const { hint } = await giveHint(
    { ...context, question: "Compare them." },
    { profile, model },
  );

  expect(hint).toMatch(/misfolds/);
});

test("the objective is omitted cleanly for the whole-lecture summary", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"summary","question":"Summarise the lecture."}');
    },
  });

  await askQuestion(
    { stage: "summary", lectureTitle: "Amyloidosis", concepts: [] },
    { profile, model },
  );

  expect(prompts[0]).not.toMatch(/Objective:/);
  expect(prompts[0]).toMatch(/no concepts were extracted/);
});

test("the tutor refuses to compose the reflection, which is fixed text", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => textResult('{"format":"summary","question":"Never asked."}'),
  });

  await expect(
    askQuestion({ stage: "reflection", lectureTitle: "Amyloidosis", concepts: [] }, { profile, model }),
  ).rejects.toThrow(/fixed text/i);
});

test("QuestionOutput accepts an absent targetConcept", () => {
  const parsed = QuestionOutput.safeParse({
    format: "free_recall",
    question: "Explain amyloid structure.",
  });

  expect(parsed.success).toBe(true);
});

test("the student's reflection reaches the debrief prompt and calibration comes back", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"heldUp":["Fibril structure"],"shaky":[],"misconceptions":[],' +
          '"focusNext":"Precursors.","calibration":"You felt sure of the precursor and missed it."}',
      );
    },
  });

  const debrief = await summariseSession(
    {
      answered: [{ question: "Name the precursor.", score: 2, missing: ["The precursor"], incorrect: [] }],
      reflection: "I think I have the precursors down.",
    },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/own account/i);
  expect(prompts[0]).toMatch(/precursors down/);
  expect(prompts[0]).toMatch(/\[2\/5\]/);
  expect(debrief.calibration).toMatch(/felt sure/);
});

test("a debrief without a reflection asks for no calibration, and parses without one", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"heldUp":[],"shaky":["Precursors"],"misconceptions":[],"focusNext":"Precursors."}',
      );
    },
  });

  const debrief = await summariseSession(
    { answered: [{ question: "Q", score: 4, missing: [], incorrect: [] }], reflection: null },
    { profile, model },
  );

  expect(prompts[0]).not.toMatch(/own account/i);
  expect(debrief.calibration).toBe("");
});

test("the order brief steers the question's demand", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"vignette","question":"A patient presents…"}');
    },
  });

  await askQuestion({ ...context, stage: "daily", order: "third" }, { profile, model });
  expect(prompts[0]).toMatch(/third-order/i);
  expect(prompts[0]).toMatch(/application or discrimination/i);
  expect(prompts[0]).toMatch(/wrong ones are wrong/i);

  await askQuestion({ ...context, stage: "daily", order: "first" }, { profile, model });
  expect(prompts[1]).toMatch(/first-order/i);
  expect(prompts[1]).toMatch(/one part of this concept/i);
  expect(prompts[1]).not.toMatch(/application or discrimination/i);

  await askQuestion({ ...context, stage: "daily", order: "second" }, { profile, model });
  expect(prompts[2]).toMatch(/second-order/i);
  expect(prompts[2]).toMatch(/whole concept/i);
});

test("the tier alone no longer steers the question", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"vignette","question":"A patient presents…"}');
    },
  });

  await askQuestion({ ...context, stage: "daily", tier: "mature" }, { profile, model });
  expect(prompts[0]).not.toMatch(/application or discrimination/i);
});

test("the bucket no longer reaches the prompt", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"free_recall","question":"Explain."}');
    },
  });

  await askQuestion({ ...context, stage: "daily", bucket: "due" }, { profile, model });
  expect(prompts[0]).not.toMatch(/spaced review/i);
  expect(prompts[0]).not.toMatch(/gone badly/i);
});

test("the last attempt reaches the prompt, with a steer that depends on order", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult('{"format":"mechanism","question":"Explain."}');
    },
  });
  const lastAttempt = {
    daysAgo: 3,
    rating: "red" as const,
    hintsUsed: false,
    missing: ["Organ tropism"],
    incorrect: ["Said ATTR comes from light chains"],
    correction: "ATTR is transthyretin.",
    aboutObjective: false,
  };

  await askQuestion(
    { ...context, stage: "daily", order: "first", lastAttempt },
    { profile, model },
  );
  expect(prompts[0]).toMatch(/3 days ago/);
  expect(prompts[0]).toMatch(/Organ tropism/);
  expect(prompts[0]).toMatch(/light chains/);
  expect(prompts[0]).toMatch(/transthyretin/);
  expect(prompts[0]).toMatch(/target what was missed/i);

  await askQuestion(
    {
      ...context,
      stage: "daily",
      order: "third",
      lastAttempt: { ...lastAttempt, daysAgo: 1, rating: "green", hintsUsed: true, aboutObjective: true },
    },
    { profile, model },
  );
  expect(prompts[1]).toMatch(/yesterday/);
  expect(prompts[1]).toMatch(/after a cue/);
  expect(prompts[1]).toMatch(/objective as a whole/);
  expect(prompts[1]).toMatch(/different route/i);
  expect(prompts[1]).not.toMatch(/target what was missed/i);
});
