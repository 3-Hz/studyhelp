import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import type { ExtractInput, ExtractResult } from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import { concept, extract } from "@/lib/extract/testUtils";
import { buildPptx } from "@/lib/fixtures/pptxBuilder";
import type { ModelProfile } from "@/lib/llm/config";

const TEST_DB = `./.test-ingest-${process.pid}.db`;
const TEST_UPLOADS = `./.test-uploads-ingest-${process.pid}`;
process.env.DATABASE_URL = TEST_DB;
process.env.UPLOAD_DIR = TEST_UPLOADS;

// Imported after DATABASE_URL is set, since the db module reads it on load.
const { db, schema } = await import("@/lib/db");
const { createLecture, extractLecture } = await import("./ingestLecture");
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

function deck(bodies: string[][]): Uint8Array {
  return buildPptx(bodies.map((body) => ({ body })));
}

function text(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

const META = {
  provider: "test",
  model: "stub",
  profile: "stub",
  chunked: false,
  chunkCount: 1,
  repairs: 0,
  mode: "stub",
};

/** Stands in for the model: remembers what it was shown, answers as told. */
function stubModel(answer: LectureExtract) {
  const inputs: ExtractInput[] = [];
  const extract = async (input: ExtractInput, _profile: ModelProfile): Promise<ExtractResult> => {
    inputs.push(input);
    return { extract: answer, meta: META };
  };
  return { extract, inputs };
}

const firstRead = extract({
  title: "The model's idea of a title",
  learningObjectives: [{ text: "Describe fibrils.", slideRefs: [1] }],
  concepts: [concept({ label: "Beta-pleated sheet", detail: "Cross-beta." })],
});

async function itemsOf(lectureId: number) {
  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
  });
  if (objectives.length === 0) return [];
  return db.query.reviewItems.findMany({
    where: inArray(
      schema.reviewItems.loId,
      objectives.map((o) => o.id),
    ),
    orderBy: [asc(schema.reviewItems.id)],
  });
}

test("createLecture stores the trimmed title and nothing else", async () => {
  const lectureId = await createLecture("  Amyloidosis  ");

  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });
  expect(lecture?.title).toBe("Amyloidosis");
  expect(lecture?.extractedAt).toBeNull();
});

test("createLecture refuses a blank title", async () => {
  await expect(createLecture("   ")).rejects.toThrow(/title/i);
});

test("extractLecture stores the files, reads the whole lecture with what it holds, and appends", async () => {
  const lectureId = await createLecture("Amyloidosis");

  const first = stubModel(firstRead);
  const one = await extractLecture(
    lectureId,
    [{ filename: "deck.pptx", role: "deck", bytes: deck([["Fibrils"]]) }],
    { extract: first.extract },
  );

  expect(one.stored).toEqual(["deck.pptx"]);
  expect(one.applied).toMatchObject({ objectivesCreated: 1, reviewItemsCreated: 1 });
  // A first read has nothing to anchor on.
  expect(first.inputs[0].prior).toEqual([]);
  const [sheet] = await itemsOf(lectureId);

  const second = stubModel(
    extract({
      learningObjectives: [{ text: "Describe fibrils.", slideRefs: [1] }],
      concepts: [
        concept({ label: "Beta-pleated sheet", detail: "Reworded." }),
        concept({ label: "Congo red", detail: "Apple-green." }),
      ],
    }),
  );
  const two = await extractLecture(
    lectureId,
    [{ filename: "talk.vtt", role: "transcript", bytes: text("so today we cover fibrils") }],
    { extract: second.extract },
  );

  expect(two.stored).toEqual(["talk.vtt"]);
  // The model saw both files, and what the lecture already held.
  expect(second.inputs[0].slides).toHaveLength(1);
  expect(second.inputs[0].transcriptChunks).toHaveLength(1);
  expect(second.inputs[0].prior).toEqual([
    { text: "Describe fibrils.", concepts: ["Beta-pleated sheet"] },
  ]);
  expect(two.applied).toMatchObject({
    objectivesMatched: 1,
    reviewItemsMatched: 1,
    reviewItemsCreated: 1,
  });

  const after = await itemsOf(lectureId);
  expect(after.map((item) => [item.id, item.label, item.ordinal])).toEqual([
    [sheet.id, "Beta-pleated sheet", 1],
    [after[1].id, "Congo red", 2],
  ]);

  const lecture = (await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  }))!;
  // The student's title stands; the model's is never written over it.
  expect(lecture.title).toBe("Amyloidosis");
  expect(lecture.extractedAt).not.toBeNull();
  expect((lecture.lastExtract as LectureExtract).concepts).toHaveLength(2);
  const sources = await db.query.lectureSources.findMany({
    where: eq(schema.lectureSources.lectureId, lectureId),
  });
  expect(sources.map((s) => s.filename)).toEqual(["deck.pptx", "talk.vtt"]);
});

test("with no new files, extractLecture reads the stored sources again", async () => {
  const lectureId = await createLecture("Re-run");
  await extractLecture(
    lectureId,
    [{ filename: "deck.pptx", role: "deck", bytes: deck([["One"]]) }],
    { extract: stubModel(firstRead).extract },
  );

  const again = stubModel(firstRead);
  const result = await extractLecture(lectureId, [], { extract: again.extract });

  expect(result.stored).toEqual([]);
  expect(again.inputs).toHaveLength(1);
  expect(again.inputs[0].slides).toHaveLength(1);
  expect(result.applied).toMatchObject({ reviewItemsCreated: 0, reviewItemsMatched: 1 });
});

test("a lecture with no files at all has nothing to extract", async () => {
  const lectureId = await createLecture("Empty");

  await expect(
    extractLecture(lectureId, [], { extract: stubModel(firstRead).extract }),
  ).rejects.toThrow(/at least one file/i);
});

test("an unknown lecture is refused", async () => {
  await expect(
    extractLecture(999_999, [], { extract: stubModel(firstRead).extract }),
  ).rejects.toThrow(/not found/);
});

test("an upload of only unsupported files is refused before the model runs", async () => {
  const lectureId = await createLecture("Bad file");
  const model = stubModel(firstRead);

  await expect(
    extractLecture(
      lectureId,
      [{ filename: "notes.docx", role: "additional", bytes: text("not a deck") }],
      { extract: model.extract },
    ),
  ).rejects.toThrow(/No supported files/);
  expect(model.inputs).toHaveLength(0);
});
