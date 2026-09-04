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
    { filename: "part1.pptx", bytes: deck([["Systole"], ["Diastole"]]) },
    { filename: "lecture.vtt", bytes: text("so today we cover the heart") },
    { filename: "part2.pptx", bytes: deck([["Valves"]]) },
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
    { filename: "second-half.vtt", bytes: text(long("b")) },
    { filename: "first-half.vtt", bytes: text(long("a")) },
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
    { filename: "deck.pptx", bytes: deck([["One"]]) },
    { filename: "figure.png", bytes: text("pretend png bytes") },
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
    { filename: "figure.png", bytes: text("pretend png bytes") },
  ]);

  const { input, warnings } = await buildExtractInput(
    lectureId,
    profile({ supportsImages: true }),
  );

  expect(input.documentParts).toHaveLength(1);
  expect(input.documentTokens).toBeGreaterThan(0);
  expect(warnings).toEqual([]);

});

test("a stored file that has gone missing is reported, not silently dropped", async () => {
  const lectureId = await newLecture("Missing file");

  await storeSources(lectureId, [
    { filename: "figure.png", bytes: text("pretend png bytes") },
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
    { filename: "deck.pptx", bytes: deck([["One"]]) },
  ]);
  await db
    .update(schema.lectures)
    .set({ committedAt: new Date() })
    .where(eq(schema.lectures.id, lectureId));

  await expect(
    addSourcesToLecture(lectureId, [
      { filename: "late.vtt", bytes: text("the transcript, too late") },
    ]),
  ).rejects.toThrow(/already been committed/);

  // And nothing was written on the way to refusing.
  const sources = await db
    .select()
    .from(schema.lectureSources)
    .where(eq(schema.lectureSources.lectureId, lectureId));
  expect(sources.map((s) => s.filename)).toEqual(["deck.pptx"]);

});
