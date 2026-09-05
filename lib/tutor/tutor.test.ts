import { expect, test } from "bun:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelProfile } from "@/lib/llm/config";
import { askQuestion, gradeAnswer, giveHint, summariseSession } from "./index";
import { GradeOutput, QuestionOutput } from "./schema";

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
        'Certainly! Here is my assessment:\n```json\n{"rating":"yellow",' +
          '"correct":["Named both precursors"],"missing":["Organ tropism"],' +
          '"incorrect":[],"correction":"ATTR is transthyretin.",' +
          '"modelAnswer":"AL comes from light chains; ATTR from transthyretin."}\n```',
      ),
  });

  const grade = await gradeAnswer(
    { ...context, question: "Compare them.", studentAnswer: "AL is light chains.", hintsUsed: false },
    { profile, model },
  );

  expect(grade.rating).toBe("yellow");
  expect(grade.missing).toEqual(["Organ tropism"]);
  expect(grade.followUp).toBeUndefined();
});

test("the model cannot hand out a suspended rating", () => {
  const parsed = GradeOutput.safeParse({
    rating: "suspended",
    correct: [],
    missing: [],
    incorrect: [],
    correction: "x",
    modelAnswer: "y",
  });

  expect(parsed.success).toBe(false);
});

test("a hinted attempt tells the grader so in the prompt", async () => {
  const { prompts } = capture();
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return textResult(
        '{"rating":"green","correct":[],"missing":[],"incorrect":[],' +
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
      answered: [{ question: "Name the precursor.", rating: "red", missing: ["The precursor"], incorrect: [] }],
      reflection: "I think I have the precursors down.",
    },
    { profile, model },
  );

  expect(prompts[0]).toMatch(/own account/i);
  expect(prompts[0]).toMatch(/precursors down/);
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
    { answered: [{ question: "Q", rating: "yellow", missing: [], incorrect: [] }], reflection: null },
    { profile, model },
  );

  expect(prompts[0]).not.toMatch(/own account/i);
  expect(debrief.calibration).toBe("");
});
