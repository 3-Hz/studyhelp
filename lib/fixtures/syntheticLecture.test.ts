import { expect, test } from "bun:test";
import { parsePptx } from "@/lib/ingest/parsePptx";
import {
  groundTruth,
  syntheticDeck,
  syntheticSlideCount,
} from "./syntheticLecture";

/**
 * The fixture is only useful if its answer key is true. A ground truth that
 * drifts from the deck silently corrupts every provider score, so these tests
 * assert the two stay in sync.
 */

const slides = parsePptx(syntheticDeck());
const allText = slides
  .map((s) => `${s.slideText}\n${s.notesText}`)
  .join("\n")
  .toLowerCase();

test("the deck parses to the expected number of slides", () => {
  expect(slides).toHaveLength(syntheticSlideCount());
});

test("every ground-truth objective appears verbatim in the deck", () => {
  const deckText = slides.map((s) => s.slideText).join("\n");
  for (const objective of groundTruth.objectives) {
    expect(deckText).toContain(objective);
  }
});

test("objectives are restated in different casing later in the deck", () => {
  // This is what forces cross-chunk dedupe to do real work: the recap slide
  // lowercases, drops the full stop, and adds a numeric list marker.
  const deckText = slides.map((s) => s.slideText).join("\n");
  const restated = groundTruth.objectives[1].toLowerCase().replace(/\.$/, "");

  expect(deckText).toContain(restated);
  expect(deckText).toContain(groundTruth.objectives[1]);
  expect(groundTruth.objectives[1]).not.toBe(restated);
});

test("the restated objectives collapse onto the originals under normalisation", async () => {
  // If this ever fails, the eval would double-count objectives and the merge
  // step would leave duplicates on the dashboard.
  const { normaliseKey } = await import("@/lib/extract/merge");
  const restated =
    "1. compare the precursor proteins and typical organ involvement of al and attr amyloidosis";
  expect(normaliseKey(restated)).toBe(normaliseKey(groundTruth.objectives[1]));
});

test("every taught concept is somewhere in the materials", () => {
  for (const concept of groundTruth.taughtConcepts) {
    expect(allText).toContain(concept.toLowerCase());
  }
});

test("supplemental traps appear only in notes, flagged as out of scope", () => {
  for (const trap of groundTruth.supplementalTraps) {
    const inNotes = slides.some((s) =>
      s.notesText.toLowerCase().includes(trap.toLowerCase()),
    );
    const inBodies = slides.some((s) =>
      s.slideText.toLowerCase().includes(trap.toLowerCase()),
    );
    expect(inNotes).toBe(true);
    expect(inBodies).toBe(false);
  }

  const trapNote = slides
    .map((s) => s.notesText)
    .find((n) => n.toLowerCase().includes("tafamidis"));
  expect(trapNote?.toLowerCase()).toContain("beyond the scope");
});

test("notes-only facts are absent from every slide body", () => {
  // If a model reports these, it read the presenter notes rather than guessing.
  for (const fact of groundTruth.notesOnlyFacts) {
    const inBodies = slides.some((s) =>
      s.slideText.toLowerCase().includes(fact.toLowerCase()),
    );
    const inNotes = slides.some((s) =>
      s.notesText.toLowerCase().includes(fact.toLowerCase()),
    );
    expect(inBodies).toBe(false);
    expect(inNotes).toBe(true);
  }
});

test("exactly one mid-deck slide has no presenter notes", () => {
  const withoutNotes = slides.filter((s) => s.notesText === "");
  expect(withoutNotes).toHaveLength(1);
  // Not first or last — that is the position that shifts naive notes mapping.
  expect(withoutNotes[0].ordinal).toBeGreaterThan(1);
  expect(withoutNotes[0].ordinal).toBeLessThan(slides.length);
});

test("slide-number placeholders never leak into extracted text", () => {
  for (const slide of slides) {
    expect(slide.slideText).not.toContain("99");
  }
});

test("the deck forces chunking on the real default local profile", async () => {
  // Asserted against the profile a local model ACTUALLY resolves to, not a
  // hand-picked one. An earlier version of this test used a tighter synthetic
  // profile and passed while the fixture comfortably fit the real default —
  // the chunked path was going untested by the very fixture meant to exercise it.
  const { chunkLecture } = await import("@/lib/extract/chunk");
  const { profileFor } = await import("@/lib/llm/config");

  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "ollama",
    OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
  });

  const chunks = chunkLecture({ slides, transcriptChunks: [] }, profile);
  expect(chunks.length).toBeGreaterThan(1);
});

test("the deck fits in one call on a long-context model", async () => {
  const { chunkLecture } = await import("@/lib/extract/chunk");
  const chunks = chunkLecture(
    { slides, transcriptChunks: [] },
    {
      role: "extract",
      providerId: "google",
      modelId: "gemini",
      contextTokens: 1_000_000,
      maxOutputTokens: 16_000,
      supportsFileParts: true,
      supportsImages: true,
      structuredOutput: "native",
    },
  );
  expect(chunks).toHaveLength(1);
});
