import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { buildPptx } from "@/lib/fixtures/pptxBuilder";
import type { ModelProfile } from "@/lib/llm/config";

const TEST_DB = `./.test-build-input-${process.pid}.db`;
const TEST_UPLOADS = `./.test-uploads-build-input-${process.pid}`;
process.env.DATABASE_URL = TEST_DB;
process.env.UPLOAD_DIR = TEST_UPLOADS;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("@/lib/db");
const { storeSources } = await import("./storeSources");
const { buildExtractInput } = await import("./buildExtractInput");
const { addSourcesToLecture } = await import("./ingestLecture");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

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

beforeAll(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
  rmSync(TEST_UPLOADS, { recursive: true, force: true });
});

async function newLecture(title: string): Promise<number> {
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title })
    .returning({ id: schema.lectures.id });
  return lecture.id;
}

function deck(bodies: string[][]): Uint8Array {
  return buildPptx(bodies.map((body) => ({ body })));
}

function text(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

test("several files rebuild into one ordered, labelled input", async () => {
  const lectureId = await newLecture("Round trip");

  await storeSources(lectureId, [
    { filename: "part1.pptx", role: "deck", bytes: deck([["Systole"], ["Diastole"]]) },
    { filename: "lecture.vtt", role: "transcript", bytes: text("so today we cover the heart") },
    { filename: "part2.pptx", role: "deck", bytes: deck([["Valves"]]) },
  ]);

  const { input } = await buildExtractInput(lectureId, profile());

  // Slides run in global order, and each says which deck it came from.
  expect(input.slides.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  expect(input.slides.map((s) => s.slideText)).toEqual([
    "Systole",
    "Diastole",
    "Valves",
  ]);
  expect(input.slides.map((s) => s.sourceLabel)).toEqual([
    "part1.pptx",
    "part1.pptx",
    "part2.pptx",
  ]);

  expect(input.transcriptChunks).toHaveLength(1);
  expect(input.transcriptChunks[0].sourceLabel).toBe("lecture.vtt");
  expect(input.transcriptChunks[0].text).toContain("today we cover");

});

test("transcripts keep their upload order across files", async () => {
  const lectureId = await newLecture("Ordered transcripts");

  const long = (marker: string) =>
    Array.from({ length: 45 }, (_, i) => `${marker} line ${i}`).join("\n");

  await storeSources(lectureId, [
    { filename: "second-half.vtt", role: "transcript", bytes: text(long("b")) },
    { filename: "first-half.vtt", role: "transcript", bytes: text(long("a")) },
  ]);

  const { input } = await buildExtractInput(lectureId, profile());

  // Upload order, not filename order — the student chose the sequence.
  expect(input.transcriptChunks.map((c) => c.sourceLabel)).toEqual([
    "second-half.vtt",
    "second-half.vtt",
    "first-half.vtt",
    "first-half.vtt",
  ]);

});

test("an image is skipped, and says so, when the model has no vision", async () => {
  const lectureId = await newLecture("Blind model");

  await storeSources(lectureId, [
    { filename: "deck.pptx", role: "deck", bytes: deck([["One"]]) },
    { filename: "figure.png", role: "additional", bytes: text("pretend png bytes") },
  ]);

  const { input, warnings } = await buildExtractInput(
    lectureId,
    profile({ supportsImages: false }),
  );

  expect(input.documentParts).toHaveLength(0);
  expect(input.documentTokens).toBe(0);
  expect(warnings.join(" ")).toContain("figure.png");
  expect(warnings.join(" ")).toContain("no vision support");

});

test("a vision model gets the image, and it is charged to the budget", async () => {
  const lectureId = await newLecture("Seeing model");

  await storeSources(lectureId, [
    { filename: "figure.png", role: "additional", bytes: text("pretend png bytes") },
  ]);

  const { input, warnings } = await buildExtractInput(
    lectureId,
    profile({ supportsImages: true }),
  );

  // Announced first, so the model knows what it is looking at.
  expect(input.documentParts.map((part) => part.type)).toEqual(["text", "file"]);
  expect((input.documentParts[0] as { text: string }).text).toMatch(
    /^# Additional course material: figure\.png/,
  );
  expect(input.documentParts).toHaveLength( 2);
  expect(input.documentTokens).toBeGreaterThan(0);
  expect(warnings).toEqual([]);

});

test("a stored file that has gone missing is reported, not silently dropped", async () => {
  const lectureId = await newLecture("Missing file");

  await storeSources(lectureId, [
    { filename: "figure.png", role: "additional", bytes: text("pretend png bytes") },
  ]);

  // The row survives a file that does not — a moved uploads directory, say.
  rmSync(`${TEST_UPLOADS}/${lectureId}`, { recursive: true, force: true });

  const { input, warnings } = await buildExtractInput(
    lectureId,
    profile({ supportsImages: true }),
  );

  expect(input.documentParts).toHaveLength(0);
  expect(warnings.join(" ")).toContain("figure.png");
  expect(warnings.join(" ")).toContain("missing");
});

test("a committed lecture refuses new files", async () => {
  const lectureId = await newLecture("Already committed");

  await storeSources(lectureId, [
    { filename: "deck.pptx", role: "deck", bytes: deck([["One"]]) },
  ]);
  await db
    .update(schema.lectures)
    .set({ committedAt: new Date() })
    .where(eq(schema.lectures.id, lectureId));

  await expect(
    addSourcesToLecture(lectureId, [
      { filename: "late.vtt", role: "transcript", bytes: text("the transcript, too late") },
    ]),
  ).rejects.toThrow(/already been committed/);

  // And nothing was written on the way to refusing.
  const sources = await db
    .select()
    .from(schema.lectureSources)
    .where(eq(schema.lectureSources.lectureId, lectureId));
  expect(sources.map((s) => s.filename)).toEqual(["deck.pptx"]);

});

test("roles reach the slides and the transcript sections", async () => {
  const lectureId = await newLecture("Roles");

  await storeSources(lectureId, [
    { filename: "lecture.pptx", role: "deck", bytes: deck([["One"]]) },
    { filename: "quiz.pptx", role: "quiz", bytes: deck([["Q1"]]) },
    { filename: "talk.vtt", role: "transcript", bytes: text("the talk") },
    { filename: "reading.txt", role: "additional", bytes: text("a reading") },
  ]);

  const { input } = await buildExtractInput(lectureId, profile());

  expect(input.slides.map((s) => [s.sourceLabel, s.role])).toEqual([
    ["lecture.pptx", "deck"],
    ["quiz.pptx", "quiz"],
  ]);
  expect(input.transcriptChunks.map((c) => [c.sourceLabel, c.role])).toEqual([
    ["talk.vtt", "transcript"],
    ["reading.txt", "additional"],
  ]);
});

test("a quiz PDF is announced before its content", async () => {
  const lectureId = await newLecture("Quiz PDF");

  await storeSources(lectureId, [
    { filename: "quiz.pdf", role: "quiz", bytes: text("%PDF-1.4 not really a pdf") },
  ]);

  const { input } = await buildExtractInput(
    lectureId,
    profile({ supportsFileParts: true }),
  );

  expect(input.documentParts.map((part) => part.type)).toEqual(["text", "file"]);
  const announcement = (input.documentParts[0] as { text: string }).text;
  expect(announcement).toMatch(/^# Practice quiz: quiz\.pdf/);
  expect(announcement).toMatch(/answer key/);
});

test("what the lecture already holds rides along: objectives verbatim, labels in order", async () => {
  const lectureId = await newLecture("Anchored");
  await storeSources(lectureId, [
    { filename: "deck.pptx", role: "deck", bytes: deck([["One"]]) },
  ]);
  // Inserted out of order, to show the block follows the numbering, not ids.
  const [second, first] = await db
    .insert(schema.learningObjectives)
    .values([
      { lectureId, text: "Compare AL and ATTR amyloidosis.", orderIndex: 1 },
      { lectureId, text: "Describe the structure of amyloid fibrils.", orderIndex: 0 },
    ])
    .returning({ id: schema.learningObjectives.id });
  await db.insert(schema.reviewItems).values([
    { loId: first.id, ordinal: 2, label: "Fibril diameter", concept: "Fibril diameter — 7–10 nm.", kind: "fact", dueOn: "2026-09-09" },
    { loId: first.id, ordinal: 1, label: "Beta-pleated sheet", concept: "Beta-pleated sheet — Cross-beta.", kind: "fact", dueOn: "2026-09-09" },
    // Suspended items anchor wording too: the model must not re-add them.
    { loId: first.id, ordinal: 3, label: "Set aside", concept: "Set aside", kind: "fact", dueOn: "2026-09-09", suspended: true },
  ]);

  const { input } = await buildExtractInput(lectureId, profile());

  expect(input.prior).toEqual([
    {
      text: "Describe the structure of amyloid fibrils.",
      concepts: ["Beta-pleated sheet", "Fibril diameter", "Set aside"],
    },
    { text: "Compare AL and ATTR amyloidosis.", concepts: [] },
  ]);
  void second;
});

test("a lecture with nothing extracted has nothing to anchor on", async () => {
  const lectureId = await newLecture("Fresh");
  await storeSources(lectureId, [
    { filename: "deck.pptx", role: "deck", bytes: deck([["One"]]) },
  ]);

  const { input } = await buildExtractInput(lectureId, profile());

  expect(input.prior).toEqual([]);
});
