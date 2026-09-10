import { expect, test } from "bun:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelProfile } from "@/lib/llm/config";
import type { ParsedSlide } from "@/lib/ingest/parsePptx";
import { extractLecture, type ExtractInput } from "./index";
import type { PriorObjective } from "./prior";
import { CHUNK_NOTE, EXTRACTION_SYSTEM, PRIOR_NOTE } from "./schema";

/**
 * The anchor block: what the lecture already holds, shown to the model so
 * a re-extraction reuses the same wordings. It has to reach every call,
 * because the chunked path sends each section on its own.
 */

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    role: "extract",
    providerId: "openai-compatible",
    modelId: "test-model",
    contextTokens: 8_192,
    maxOutputTokens: 2_048,
    supportsFileParts: false,
    supportsImages: false,
    structuredOutput: "prompted",
    ...overrides,
  };
}

const EMPTY_EXTRACT = JSON.stringify({
  title: "Amyloidosis",
  learningObjectives: [],
  concepts: [],
  practiceQuestions: [],
  commonConfusions: [],
  conflicts: [],
});

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    warnings: [],
  };
}

interface Call {
  system: string;
  user: string;
}

/** A model that answers with an empty extract and remembers each call's prompt. */
function capturing(): { model: MockLanguageModelV4; calls: Call[] } {
  const calls: Call[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const messages = options.prompt as {
        role: string;
        content: string | { type: string; text?: string }[];
      }[];
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      const user = messages
        .filter((m) => m.role === "user")
        .flatMap((m): string[] =>
          typeof m.content === "string"
            ? [m.content]
            : m.content.map((part) => part.text ?? ""),
        )
        .join("\n");
      calls.push({ system, user });
      return textResult(EMPTY_EXTRACT);
    },
  });
  return { model, calls };
}

function slide(ordinal: number, chars: number): ParsedSlide {
  return { ordinal, slideText: "x".repeat(chars), notesText: "" };
}

function input(slides: ParsedSlide[], prior?: PriorObjective[]): ExtractInput {
  return { slides, transcriptChunks: [], documentParts: [], prior };
}

const prior: PriorObjective[] = [
  { text: "Describe the structure of amyloid fibrils.", concepts: ["Beta-pleated sheet"] },
];

test("the block follows the lecture text on a single call, and stays out of the system prompt", async () => {
  const { model, calls } = capturing();

  await extractLecture(input([slide(1, 100)], prior), profile(), model);

  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.user).toContain(PRIOR_NOTE);
  expect(call.user).toContain("Beta-pleated sheet");
  expect(call.user.indexOf("# Already extracted")).toBeGreaterThan(call.user.indexOf("xxxx"));
  // The system prompt is a cacheable prefix: it never changes with the lecture.
  expect(call.system.startsWith(EXTRACTION_SYSTEM)).toBe(true);
  expect(call.system).not.toContain(PRIOR_NOTE);
});

test("a lecture with nothing extracted sends no block", async () => {
  const { model, calls } = capturing();

  await extractLecture(input([slide(1, 100)], []), profile(), model);

  expect(calls[0].user).not.toContain(PRIOR_NOTE);
  expect(calls[0].user).not.toContain("# Already extracted");
});

test("every section of a chunked lecture carries the block", async () => {
  const { model, calls } = capturing();
  const slides = Array.from({ length: 10 }, (_, i) => slide(i + 1, 4_000));

  await extractLecture(input(slides, prior), profile(), model);

  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) {
    expect(call.user).toContain(PRIOR_NOTE);
    expect(call.user).toContain("Beta-pleated sheet");
    expect(call.system.startsWith(`${EXTRACTION_SYSTEM}\n\n${CHUNK_NOTE}`)).toBe(true);
  }
});

test("the block's tokens come off every section's budget", async () => {
  // Two slides that just fit one call; a long block has to push them to two.
  const slides = [slide(1, 8_000), slide(2, 8_000)];
  const long: PriorObjective[] = [
    { text: "Objective.", concepts: Array.from({ length: 200 }, (_, i) => `Concept number ${i}`) },
  ];

  const bare = capturing();
  await extractLecture(input(slides, []), profile(), bare.model);
  expect(bare.calls).toHaveLength(1);

  const anchored = capturing();
  await extractLecture(input(slides, long), profile(), anchored.model);
  expect(anchored.calls.length).toBeGreaterThan(1);
});
