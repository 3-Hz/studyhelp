import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const TEST_DB = `./.test-concepts-${process.pid}.db`;
process.env.DATABASE_URL = TEST_DB;

const { db, schema } = await import("./db");
const { applyExtract } = await import("./applyExtract");
const { extract } = await import("./extract/testUtils");
const { lectureConcepts } = await import("./concepts");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

const TODAY = "2026-09-04";

const draft = {
  title: "Amyloidosis",
  learningObjectives: [
    { text: "Describe the structure of amyloid fibrils.", slideRefs: [2] },
    { text: "Compare AL and ATTR amyloidosis.", slideRefs: [5] },
  ],
  concepts: [
    {
      label: "Beta-pleated sheet",
      detail: "Cross-beta conformation.",
      kind: "fact" as const,
      provenance: "taught" as const,
      emphasis: "neutral" as const,
      emphasisCue: "",
      relatedObjectiveIndexes: [0],
    },
    {
      label: "Congo red",
      detail: "Apple-green birefringence.",
      kind: "fact" as const,
      provenance: "taught" as const,
      emphasis: "neutral" as const,
      emphasisCue: "",
      relatedObjectiveIndexes: [0],
    },
    {
      label: "AL vs ATTR precursor",
      detail: "Light chains versus transthyretin.",
      kind: "mechanism" as const,
      provenance: "supplemental" as const,
      emphasis: "neutral" as const,
      emphasisCue: "",
      relatedObjectiveIndexes: [1],
    },
  ],
  practiceQuestions: [],
  commonConfusions: [],
  conflicts: [],
};

let lectureId: number;
let draftId: number;

beforeAll(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: draft.title, committedAt: new Date() })
    .returning({ id: schema.lectures.id });
  lectureId = lecture.id;
  await applyExtract(lectureId, draft);

  const [uncommitted] = await db
    .insert(schema.lectures)
    .values({ title: "Draft only", draftExtract: draft })
    .returning({ id: schema.lectures.id });
  draftId = uncommitted.id;

  const objectives = await db.query.learningObjectives.findMany({
    where: eq(schema.learningObjectives.lectureId, lectureId),
    orderBy: [schema.learningObjectives.orderIndex],
  });
  await db
    .update(schema.learningObjectives)
    .set({ suspended: true })
    .where(eq(schema.learningObjectives.id, objectives[1].id));

  const items = await db.query.reviewItems.findMany({
    orderBy: [schema.reviewItems.id],
  });
  // Overdue and mature; due tomorrow and relearning; the third untouched.
  await db
    .update(schema.reviewItems)
    .set({ dueOn: "2026-09-01", intervalDays: 14, lapses: 0, streak: 4, lastRating: "green" })
    .where(eq(schema.reviewItems.id, items[0].id));
  await db
    .update(schema.reviewItems)
    .set({ dueOn: "2026-09-05", intervalDays: 1, lapses: 2, streak: 0, lastRating: "red" })
    .where(eq(schema.reviewItems.id, items[1].id));
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

test("lists every objective in order with its items, suspended ones included", async () => {
  const view = await lectureConcepts(lectureId, TODAY);

  expect(view?.title).toBe("Amyloidosis");
  expect(view?.committedAt).not.toBeNull();
  expect(view?.objectives.map((o) => o.text)).toEqual([
    "Describe the structure of amyloid fibrils.",
    "Compare AL and ATTR amyloidosis.",
  ]);
  expect(view?.objectives[1].suspended).toBe(true);
  expect(view?.objectives[0].items).toHaveLength(2);
  expect(view?.objectives[1].items).toHaveLength(1);
  expect(view?.objectives[1].items[0].provenance).toBe("supplemental");
});

test("each item carries its state, its tier, and a signed days-until-due", async () => {
  const view = await lectureConcepts(lectureId, TODAY);
  const [overdue, tomorrow] = view!.objectives[0].items;

  expect(overdue).toMatchObject({
    concept: "Beta-pleated sheet — Cross-beta conformation.",
    kind: "fact",
    tier: "mature",
    intervalDays: 14,
    lapses: 0,
    streak: 4,
    lastRating: "green",
    dueOn: "2026-09-01",
    dueIn: -3,
  });
  expect(tomorrow).toMatchObject({ tier: "relearning", lapses: 2, dueIn: 1 });

  const untouched = view!.objectives[1].items[0];
  expect(untouched.tier).toBe("new");
  expect(untouched.dueIn).toBeGreaterThanOrEqual(0);
});

test("each item is numbered within its objective", async () => {
  const view = await lectureConcepts(lectureId, TODAY);
  expect(view!.objectives[0].items.map((item) => item.ordinal)).toEqual([1, 2]);
  expect(view!.objectives[1].items.map((item) => item.ordinal)).toEqual([1]);
});

test("each item carries its marks by date, and the lecture lists the dates it was marked on", async () => {
  const items = await db.query.reviewItems.findMany({ orderBy: [schema.reviewItems.id] });
  const [first] = await db
    .insert(schema.studyDates)
    .values({ date: "2026-09-01" })
    .returning({ id: schema.studyDates.id });
  const [third] = await db
    .insert(schema.studyDates)
    .values({ date: "2026-09-03" })
    .returning({ id: schema.studyDates.id });
  await db.insert(schema.conceptMarks).values([
    { reviewItemId: items[0].id, studyDateId: third.id, mark: "red" },
    { reviewItemId: items[0].id, studyDateId: first.id, mark: "green" },
    { reviewItemId: items[1].id, studyDateId: third.id, mark: "yellow" },
  ]);

  const view = await lectureConcepts(lectureId, TODAY);

  expect(view!.dates).toEqual(["2026-09-01", "2026-09-03"]);
  const [sheet, congoRed] = view!.objectives[0].items;
  expect(sheet.marks).toEqual({ "2026-09-01": "green", "2026-09-03": "red" });
  expect(congoRed.marks).toEqual({ "2026-09-03": "yellow" });
  // Never tested: no marks, and nothing invented for the dates others were tested on.
  expect(view!.objectives[1].items[0].marks).toEqual({});
});

test("an uncommitted lecture has no objectives yet", async () => {
  const view = await lectureConcepts(draftId, TODAY);
  expect(view?.committedAt).toBeNull();
  expect(view?.objectives).toEqual([]);
});

test("an unknown lecture is null", async () => {
  expect(await lectureConcepts(9_999, TODAY)).toBeNull();
});

test("the LO Map says which concepts are suspended", async () => {
  const [first, second] = (await lectureConcepts(lectureId, TODAY))!.objectives[0].items;
  await db
    .update(schema.reviewItems)
    .set({ suspended: true })
    .where(eq(schema.reviewItems.id, second.id));

  const view = await lectureConcepts(lectureId, TODAY);
  const items = view!.objectives[0].items;
  expect(items.map((item) => item.suspended)).toEqual([false, true]);
  // Suspended, not gone: it keeps its number.
  expect(items[1].id).toBe(second.id);
  expect(items[1].ordinal).toBe(2);
  expect(items[0].id).toBe(first.id);
});

test("the LO Map says which of the lecture's practice questions test each concept", async () => {
  const linked = extract({
    title: "Linked",
    learningObjectives: [{ text: "Explain Congo red staining.", slideRefs: [7] }],
    concepts: [
      {
        label: "Congo red",
        detail: "The confirmatory stain.",
        kind: "fact",
        provenance: "taught",
        emphasis: "neutral",
        emphasisCue: "",
        relatedObjectiveIndexes: [0],
      },
      {
        label: "Apple-green birefringence",
        detail: "Under polarised light.",
        kind: "fact",
        provenance: "taught",
        emphasis: "neutral",
        emphasisCue: "",
        relatedObjectiveIndexes: [0],
      },
    ],
    practiceQuestions: [
      {
        question: "Which stain confirms amyloid, and what do you see?",
        answer: "Congo red; apple-green birefringence.",
        slideRefs: [8],
        relatedObjectiveIndexes: [0],
        conceptIndexes: [0, 1],
      },
      {
        question: "What do you see under polarised light?",
        answer: "Apple-green birefringence.",
        slideRefs: [8],
        relatedObjectiveIndexes: [0],
        conceptIndexes: [1],
      },
    ],
  });
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: "Linked", committedAt: new Date() })
    .returning({ id: schema.lectures.id });
  await applyExtract(lecture.id, linked);

  const view = (await lectureConcepts(lecture.id, TODAY))!;
  expect(view.objectives[0].items.map((item) => item.practiceQuestions)).toEqual([
    ["Which stain confirms amyloid, and what do you see?"],
    ["Which stain confirms amyloid, and what do you see?", "What do you see under polarised light?"],
  ]);
});

test("each concept carries its label and the lecturer's cue, for the badge", async () => {
  const cued = extract({
    title: "Cued",
    learningObjectives: [{ text: "Describe fibrils.", slideRefs: [1] }],
    concepts: [
      {
        label: "Fibril diameter",
        detail: "Seven to ten nanometres.",
        kind: "fact",
        provenance: "taught",
        emphasis: "deemphasized",
        emphasisCue: "You do not need the diameter.",
        relatedObjectiveIndexes: [0],
      },
    ],
  });
  const [lecture] = await db
    .insert(schema.lectures)
    .values({ title: "Cued", committedAt: new Date() })
    .returning({ id: schema.lectures.id });
  await applyExtract(lecture.id, cued);

  const [item] = (await lectureConcepts(lecture.id, TODAY))!.objectives[0].items;
  expect(item).toMatchObject({
    label: "Fibril diameter",
    concept: "Fibril diameter — Seven to ten nanometres.",
    emphasis: "deemphasized",
    emphasisCue: "You do not need the diameter.",
    suspended: true,
  });
});
