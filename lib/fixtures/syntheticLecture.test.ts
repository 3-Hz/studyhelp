import { expect, test } from "bun:test";
import { parsePptx } from "@/lib/ingest/parsePptx";
import {
  groundTruth,
  syntheticDeck,
  syntheticSlideCount,
  syntheticTranscript,
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

test("the deck poses each practice question on a slide, with the answer only in its notes", () => {
  expect(groundTruth.practiceQuestions.length).toBeGreaterThan(0);
  for (const question of groundTruth.practiceQuestions) {
    const slide = slides.find((s) => s.slideText.includes(question));
    expect(slide).toBeDefined();
    expect(slide!.notesText).toContain("Answer:");
    expect(slide!.slideText).not.toContain("Answer:");
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

test("the lecturer's cues are planted in both the notes and the transcript", () => {
  const transcript = syntheticTranscript().toLowerCase();
  const materials = `${allText}\n${transcript}`;

  expect(groundTruth.emphasized.length).toBeGreaterThan(0);
  expect(groundTruth.deemphasized.length).toBeGreaterThan(0);
  for (const keyword of [...groundTruth.emphasized, ...groundTruth.deemphasized]) {
    expect(materials).toContain(keyword.toLowerCase());
  }

  // Both sources carry a cue, so a model that reads only one is caught.
  const inTranscript = (keyword: string) => transcript.includes(keyword.toLowerCase());
  const inNotes = (keyword: string) =>
    slides.some((s) => s.notesText.toLowerCase().includes(keyword.toLowerCase()));
  expect(groundTruth.emphasized.some(inTranscript)).toBe(true);
  expect(groundTruth.emphasized.some(inNotes)).toBe(true);
  expect(groundTruth.deemphasized.some(inTranscript)).toBe(true);
  expect(groundTruth.deemphasized.some(inNotes)).toBe(true);
});

test("a set-aside concept is taught material, not a supplemental trap", () => {
  // De-emphasis and provenance are separate axes; the fixture must not let a
  // model satisfy one by way of the other.
  for (const keyword of groundTruth.deemphasized) {
    expect(groundTruth.supplementalTraps).not.toContain(keyword);
    expect(allText).toContain(keyword.toLowerCase());
  }
});

test("the transcript reads as cleaned captions: lines of speech, no cue scaffolding", () => {
  const { cleanTranscript } = require("@/lib/ingest/parseTranscript");
  const transcript = syntheticTranscript();
  expect(cleanTranscript(transcript)).toBe(transcript.trim());
  expect(transcript.split("\n").length).toBeGreaterThan(5);
});

test("the deck and transcript together fit in one call on a long-context model", async () => {
  const { chunkLecture } = await import("@/lib/extract/chunk");
  const { chunkTranscript } = await import("@/lib/ingest/parseTranscript");
  const chunks = chunkLecture(
    {
      slides,
      transcriptChunks: chunkTranscript(syntheticTranscript()).map((c) => ({ text: c.text })),
    },
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
