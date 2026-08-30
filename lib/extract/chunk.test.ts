import { expect, test } from "bun:test";
import type { ModelProfile } from "@/lib/llm/config";
import type { ParsedSlide } from "@/lib/ingest/parsePptx";
import { chunkLecture } from "./chunk";

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

function slide(ordinal: number, chars: number): ParsedSlide {
  return {
    ordinal,
    slideText: "x".repeat(chars),
    notesText: "",
  };
}

test("a lecture that fits produces exactly one chunk", () => {
  const chunks = chunkLecture(
    { slides: [slide(1, 200), slide(2, 200)], transcriptChunks: [] },
    profile({ contextTokens: 1_000_000, maxOutputTokens: 16_000 }),
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0].slideOrdinals).toEqual([1, 2]);
});

test("an oversized lecture splits into several chunks", () => {
  // Budget is (8192 - 2048) * 0.75 ≈ 4608 tokens ≈ 18k chars.
  const slides = Array.from({ length: 10 }, (_, i) => slide(i + 1, 4_000));
  const chunks = chunkLecture({ slides, transcriptChunks: [] }, profile());
  expect(chunks.length).toBeGreaterThan(1);
});

test("splitting never drops or duplicates a slide", () => {
  const slides = Array.from({ length: 25 }, (_, i) => slide(i + 1, 3_000));
  const chunks = chunkLecture({ slides, transcriptChunks: [] }, profile());

  const seen = chunks.flatMap((c) => c.slideOrdinals);
  expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect(new Set(seen).size).toBe(25);
});

test("chunk indexes are sequential from zero", () => {
  const slides = Array.from({ length: 12 }, (_, i) => slide(i + 1, 4_000));
  const chunks = chunkLecture({ slides, transcriptChunks: [] }, profile());
  expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
});

test("a single slide larger than the budget fails loudly", () => {
  // Silent truncation here would drop content the student believes was read.
  expect(() =>
    chunkLecture({ slides: [slide(1, 500_000)], transcriptChunks: [] }, profile()),
  ).toThrow(/over the .* input budget/i);
});

test("the error names the slide and suggests the context override", () => {
  expect(() =>
    chunkLecture({ slides: [slide(7, 500_000)], transcriptChunks: [] }, profile()),
  ).toThrow(/Slide 7[\s\S]*LLM_EXTRACT_CONTEXT_TOKENS/);
});

test("transcript sections are chunked alongside slides", () => {
  const chunks = chunkLecture(
    {
      slides: [slide(1, 100)],
      transcriptChunks: ["a".repeat(3_000), "b".repeat(3_000)],
    },
    profile(),
  );
  const combined = chunks.map((c) => c.text).join("");
  expect(combined).toContain("Lecture transcript");
  expect(combined).toContain("a".repeat(100));
  expect(combined).toContain("b".repeat(100));
});

test("an empty lecture produces no chunks", () => {
  expect(chunkLecture({ slides: [], transcriptChunks: [] }, profile())).toEqual(
    [],
  );
});
