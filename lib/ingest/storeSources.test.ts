import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { buildPptx } from "@/lib/fixtures/pptxBuilder";

const TEST_DB = `./.test-sources-${process.pid}.db`;
const TEST_UPLOADS = `./.test-uploads-sources-${process.pid}`;
process.env.DATABASE_URL = TEST_DB;
process.env.UPLOAD_DIR = TEST_UPLOADS;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("@/lib/db");
const { storeSources } = await import("./storeSources");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");


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

async function assetsFor(lectureId: number) {
  return db
    .select()
    .from(schema.lectureAssets)
    .where(eq(schema.lectureAssets.lectureId, lectureId));
}

async function sourcesFor(lectureId: number) {
  return db
    .select()
    .from(schema.lectureSources)
    .where(eq(schema.lectureSources.lectureId, lectureId));
}

test("two decks share one run of slide numbers without colliding", async () => {
  const lectureId = await newLecture("Two decks");

  const result = await storeSources(lectureId, [
    { filename: "part1.pptx", bytes: deck([["Systole"], ["Diastole"]]) },
    { filename: "part2.pptx", bytes: deck([["Valves"], ["Murmurs"], ["S3"]]) },
  ]);

  expect(result.stored).toEqual(["part1.pptx", "part2.pptx"]);
  expect(result.skipped).toEqual([]);

  const slides = (await assetsFor(lectureId))
    .filter((asset) => asset.kind === "slide")
    .sort((a, b) => (a.globalOrdinal ?? 0) - (b.globalOrdinal ?? 0));

  // Continuous across both decks, so a slideRef names exactly one slide.
  expect(slides.map((s) => s.globalOrdinal)).toEqual([1, 2, 3, 4, 5]);
  // But each deck still knows its own numbering.
  expect(slides.map((s) => s.ordinal)).toEqual([1, 2, 1, 2, 3]);
  expect(slides.map((s) => s.filename)).toEqual([
    "part1.pptx",
    "part1.pptx",
    "part2.pptx",
    "part2.pptx",
    "part2.pptx",
  ]);
  expect(slides.map((s) => s.slideText)).toEqual([
    "Systole",
    "Diastole",
    "Valves",
    "Murmurs",
    "S3",
  ]);

  // Both slide 1s survive as distinct rows — this is what used to be lost.
  const firstSlides = slides.filter((s) => s.ordinal === 1);
  expect(firstSlides).toHaveLength(2);
  expect(new Set(firstSlides.map((s) => s.sourceId)).size).toBe(2);
});

test("two files with the same name are stored side by side", async () => {
  const lectureId = await newLecture("Duplicate names");

  await storeSources(lectureId, [
    { filename: "figure.png", bytes: text("first") },
    { filename: "figure.png", bytes: text("second") },
  ]);

  const sources = (await sourcesFor(lectureId)).sort(
    (a, b) => a.uploadIndex - b.uploadIndex,
  );

  expect(sources).toHaveLength(2);
  expect(sources[0].storagePath).not.toBe(sources[1].storagePath);
  expect(readFileSync(sources[0].storagePath!, "utf8")).toBe("first");
  expect(readFileSync(sources[1].storagePath!, "utf8")).toBe("second");

});

test("a PDF uploaded after a deck does not take a slide's number", async () => {
  const lectureId = await newLecture("Deck and handout");

  await storeSources(lectureId, [
    { filename: "deck.pptx", bytes: deck([["One"], ["Two"], ["Three"]]) },
    { filename: "handout.pdf", bytes: text("%PDF-1.4 not really a pdf") },
  ]);

  const assets = await assetsFor(lectureId);
  // A PDF has no text to hold: it lives as a source, re-read at extract time.
  expect(assets.every((a) => a.kind === "slide")).toBe(true);

  const sources = await sourcesFor(lectureId);
  expect(sources.map((s) => s.kind).sort()).toEqual(["pdf", "slide"]);
  expect(sources.find((s) => s.kind === "pdf")?.byteSize).toBeGreaterThan(0);

});

test("transcript chunks are numbered within their own file", async () => {
  const lectureId = await newLecture("Two transcripts");

  const long = (marker: string) =>
    Array.from({ length: 45 }, (_, i) => `${marker} line ${i}`).join("\n");

  await storeSources(lectureId, [
    { filename: "part1.vtt", bytes: text(long("a")) },
    { filename: "part2.vtt", bytes: text(long("b")) },
  ]);

  const chunks = await assetsFor(lectureId);
  const bySource = new Map<number, number[]>();
  for (const chunk of chunks) {
    const list = bySource.get(chunk.sourceId!) ?? [];
    list.push(chunk.ordinal);
    bySource.set(chunk.sourceId!, list);
  }

  expect(bySource.size).toBe(2);
  for (const ordinals of bySource.values()) {
    expect(ordinals.sort()).toEqual([1, 2]);
  }
  expect(chunks.every((c) => c.globalOrdinal === null)).toBe(true);

});

test("an unreadable deck is skipped without discarding the files beside it", async () => {
  const lectureId = await newLecture("One bad file");

  const result = await storeSources(lectureId, [
    { filename: "broken.pptx", bytes: text("this is not a zip") },
    { filename: "good.pptx", bytes: deck([["Survives"]]) },
  ]);

  expect(result.stored).toEqual(["good.pptx"]);
  expect(result.skipped).toEqual(["broken.pptx"]);
  expect(result.warnings.join(" ")).toContain("broken.pptx");

  const sources = await sourcesFor(lectureId);
  expect(sources.map((s) => s.filename)).toEqual(["good.pptx"]);

});

test("unsupported file types are reported, not stored", async () => {
  const lectureId = await newLecture("Unsupported");

  const result = await storeSources(lectureId, [
    { filename: "notes.docx", bytes: text("x") },
    { filename: "archive.zip", bytes: text("y") },
  ]);

  expect(result.stored).toEqual([]);
  expect(result.skipped).toEqual(["notes.docx", "archive.zip"]);
  expect(await sourcesFor(lectureId)).toHaveLength(0);
});

test("files added later continue the lecture's numbering", async () => {
  const lectureId = await newLecture("Added later");

  await storeSources(lectureId, [
    { filename: "deck.pptx", bytes: deck([["One"], ["Two"]]) },
  ]);

  // A week later, the video transcript and the second half of the deck.
  await storeSources(lectureId, [
    { filename: "lecture.vtt", bytes: text("the talk itself") },
    { filename: "deck-part2.pptx", bytes: deck([["Three"]]) },
  ]);

  const sources = (await sourcesFor(lectureId)).sort(
    (a, b) => a.uploadIndex - b.uploadIndex,
  );
  expect(sources.map((s) => s.uploadIndex)).toEqual([1, 2, 3]);
  expect(sources.map((s) => s.filename)).toEqual([
    "deck.pptx",
    "lecture.vtt",
    "deck-part2.pptx",
  ]);

  const slides = (await assetsFor(lectureId))
    .filter((a) => a.kind === "slide")
    .sort((a, b) => (a.globalOrdinal ?? 0) - (b.globalOrdinal ?? 0));

  // The original slides keep the numbers the draft already refers to.
  expect(slides.map((s) => s.globalOrdinal)).toEqual([1, 2, 3]);
  expect(slides.map((s) => s.slideText)).toEqual(["One", "Two", "Three"]);

});

test("the database refuses two assets at the same position in one file", async () => {
  const lectureId = await newLecture("Constraint");

  await storeSources(lectureId, [
    { filename: "deck.pptx", bytes: deck([["One"]]) },
  ]);

  const [slide] = await db
    .select()
    .from(schema.lectureAssets)
    .where(
      and(
        eq(schema.lectureAssets.lectureId, lectureId),
        eq(schema.lectureAssets.kind, "slide"),
      ),
    );

  let rejected: unknown;
  try {
    await db.insert(schema.lectureAssets).values({
      lectureId,
      sourceId: slide.sourceId,
      kind: "slide",
      ordinal: slide.ordinal,
      globalOrdinal: 99,
      slideText: "a duplicate",
    });
  } catch (error) {
    rejected = error;
  }

  expect(String(rejected)).toContain("UNIQUE");

});
