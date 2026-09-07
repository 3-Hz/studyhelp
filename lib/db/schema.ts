import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * A concept's mark for a day, per new_prompt.txt "Dashboard": green =
 * correct, yellow = partially correct or a minor error, red = incorrect. The
 * ladder moves on marks. Suspension (prompt.txt's dark green) is not a mark:
 * it is a state on the objective (learningObjectives.suspended).
 */
export const MARKS = ["green", "yellow", "red"] as const;
export type Mark = (typeof MARKS)[number];

/**
 * An objective's score for a day, per new_prompt.txt "Scoring":
 *   5 — correct without help
 *   4 — correct with help, or mostly correct
 *   3 — partially correct, with a big mistake
 *   2 — not correct
 *   1 — no idea
 */
export const SCORES = [1, 2, 3, 4, 5] as const;
export type Score = (typeof SCORES)[number];

/**
 * Provenance keeps supplemental medical knowledge from ever being silently
 * attributed to the lecture (prompt.txt "Lecture Processing").
 */
export const PROVENANCE = ["taught", "derived", "supplemental"] as const;
export type Provenance = (typeof PROVENANCE)[number];

/**
 * What a concept is, which decides the shape of question it gets. The five
 * kinds of idea new_prompt.txt counts: terms and facts, mechanisms,
 * relationships, distinctions, clinical applications.
 */
export const REVIEW_KINDS = [
  "fact",
  "mechanism",
  "relationship",
  "distinction",
  "application",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/**
 * The same-day review recalls each objective (lo_recall) and then probes the
 * concepts the recall left untested or short (lo_probe), first-order only
 * (new_prompt.txt "Review Quiz Session"). Daily practice has one graded
 * stage: its variety comes from the question format, not from a running
 * order. Both close with a reflection — the student's own account of the
 * session, ungraded. Rows from before Phase 5 may carry the retired stages
 * "summary" and "elaboration"; they are never asked again.
 */
export const SESSION_STAGES = ["lo_recall", "lo_probe", "daily", "reflection"] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];

/** What an uploaded file is, and therefore how it gets parsed. */
export const ASSET_KINDS = ["slide", "transcript", "pdf", "image"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

const now = sql`(unixepoch())`;

export const lectures = sqliteTable("lectures", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  block: text("block"),
  /** Raw model extraction, held as a draft until a human commits the LOs. */
  draftExtract: text("draft_extract", { mode: "json" }),
  /** Which provider/model produced the draft, and whether it was chunked. */
  extractionMeta: text("extraction_meta", { mode: "json" }),
  /** Capability shortfalls hit during ingest (PDF read as text, images skipped). */
  extractionWarnings: text("extraction_warnings", { mode: "json" }),
  extractedAt: integer("extracted_at", { mode: "timestamp" }),
  committedAt: integer("committed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(now),
});

/**
 * One row per uploaded file. A lecture routinely has several — the deck, the
 * PDF export, the video transcript, loose figures — and they arrive at
 * different times, so files are first-class rather than an attribute of the
 * content parsed out of them.
 */
export const lectureSources = sqliteTable(
  "lecture_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ASSET_KINDS }).notNull(),
    filename: text("filename").notNull(),
    /** 1-based upload order within the lecture. Stable once assigned. */
    uploadIndex: integer("upload_index").notNull(),
    /** On-disk path under /uploads, kept so a re-extraction needs no re-upload. */
    storagePath: text("storage_path"),
    byteSize: integer("byte_size"),
    /** Capability shortfalls hit parsing THIS file (PDF read as text, etc.). */
    warnings: text("warnings", { mode: "json" }),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull().default(now),
  },
  (t) => [
    unique("lecture_sources_upload_idx").on(t.lectureId, t.uploadIndex),
    index("lecture_sources_lecture_idx").on(t.lectureId),
  ],
);

export const lectureAssets = sqliteTable(
  "lecture_assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    /** The file this came out of. */
    sourceId: integer("source_id").references(() => lectureSources.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", { enum: ASSET_KINDS }).notNull(),
    /**
     * Position within its own source: slide N of that deck, chunk N of that
     * transcript. 1-based, and it restarts for every file.
     */
    ordinal: integer("ordinal").notNull(),
    /**
     * The slide number the model is shown, running continuously across every
     * deck in the lecture so `slideRefs` can never name two slides. Slides
     * only; null for everything else.
     */
    globalOrdinal: integer("global_ordinal"),
    filename: text("filename"),
    /** Extracted slide body text. Null for assets Claude reads natively. */
    slideText: text("slide_text"),
    /** Presenter notes, kept separate — they carry the real explanations. */
    notesText: text("notes_text"),
  },
  (t) => [
    index("lecture_assets_lecture_idx").on(t.lectureId, t.globalOrdinal),
    unique("lecture_assets_source_ordinal").on(t.sourceId, t.ordinal),
  ],
);

export const learningObjectives = sqliteTable(
  "learning_objectives",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    /** Verbatim from the lecture. Never split unless the lecture split it. */
    text: text("text").notNull(),
    orderIndex: integer("order_index").notNull(),
    suspended: integer("suspended", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [index("los_lecture_idx").on(t.lectureId, t.orderIndex)],
);

/** One row per dashboard column. */
export const studyDates = sqliteTable("study_dates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** ISO date, no time component: YYYY-MM-DD. */
  date: text("date").notNull().unique(),
});

/**
 * A cell in the dashboard. Rows exist ONLY where an LO was actually tested,
 * so untested cells are blank by construction rather than by convention.
 */
export const performances = sqliteTable(
  "performances",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    loId: integer("lo_id")
      .notNull()
      .references(() => learningObjectives.id, { onDelete: "cascade" }),
    studyDateId: integer("study_date_id")
      .notNull()
      .references(() => studyDates.id, { onDelete: "cascade" }),
    /** The objective's 1–5 score for the day (new_prompt.txt "Scoring"). */
    score: integer("score").$type<Score>().notNull(),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [unique("performances_lo_date_unq").on(t.loId, t.studyDateId)],
);

/**
 * Concept-level spaced repetition. Deliberately a separate table from
 * learningObjectives so scheduling can be fine-grained without ever adding
 * dashboard rows (prompt.txt "Spaced-Repetition Scheduling").
 */
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    loId: integer("lo_id")
      .notNull()
      .references(() => learningObjectives.id, { onDelete: "cascade" }),
    concept: text("concept").notNull(),
    /**
     * The concept's number within its objective, 1-based, in the order the
     * lecture presented it: column F of the new prompt's LO Map, and the
     * number a grader marks.
     */
    ordinal: integer("ordinal").notNull().default(0),
    kind: text("kind", { enum: REVIEW_KINDS }).notNull(),
    provenance: text("provenance", { enum: PROVENANCE })
      .notNull()
      .default("taught"),
    /** ISO date the item is next due. */
    dueOn: text("due_on").notNull(),
    intervalDays: integer("interval_days").notNull().default(0),
    /** The concept's most recent mark. */
    lastRating: text("last_rating", { enum: MARKS }),
    lapses: integer("lapses").notNull().default(0),
    /**
     * Consecutive greens; red or yellow resets it. With intervalDays, lapses
     * and lastRating this is the whole mastery state — see tierOf.
     */
    streak: integer("streak").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [index("review_items_due_idx").on(t.dueOn)],
);

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type", { enum: ["same_day", "daily"] }).notNull(),
  lectureId: integer("lecture_id").references(() => lectures.id, {
    onDelete: "set null",
  }),
  /**
   * The daily session's chosen slots, frozen at start. Selection depends on
   * the whole corpus at that moment, so freezing it keeps a reload, a tie
   * break and the "4 of 10" counter stable — and leaves the session's
   * reasoning readable afterwards.
   */
  plan: text("plan", { mode: "json" }),
  /** The close-out summary, written when the session is finished. */
  debrief: text("debrief", { mode: "json" }),
  /**
   * What finishing did to each review item: mark, tier before and after,
   * new due date. The code-owned half of the close-out, beside the
   * model-owned debrief.
   */
  outcomes: text("outcomes", { mode: "json" }),
  /**
   * The time budget given at start, which sized the plan. Null on sessions
   * from before budgets existed.
   */
  minutes: integer("minutes"),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .default(now),
  endedAt: integer("ended_at", { mode: "timestamp" }),
});

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [index("messages_session_idx").on(t.sessionId, t.createdAt)],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Which part of the session this turn belongs to. */
    stage: text("stage", { enum: SESSION_STAGES }).notNull(),
    /** Null for the reflection, which is about the session and earns no cell. */
    loId: integer("lo_id").references(() => learningObjectives.id, {
      onDelete: "cascade",
    }),
    reviewItemId: integer("review_item_id").references(() => reviewItems.id, {
      onDelete: "set null",
    }),
    /** The question's shape (free recall, vignette, comparison), which varies within a stage. */
    format: text("format").notNull(),
    question: text("question").notNull(),
    studentAnswer: text("student_answer"),
    /** The question's 1–5 score, after capScore. Null until graded. */
    score: integer("score").$type<Score>(),
    /**
     * The marks the grader gave the concepts this answer tested, after
     * capMark: `{ reviewItemId, mark }[]`. Concepts it did not test are
     * absent, and so do not move.
     */
    conceptMarks: text("concept_marks", { mode: "json" }).$type<ConceptMark[]>(),
    feedback: text("feedback"),
    /** Hinted recall never counts as independent mastery — caps the score at 4 and a green mark at yellow. */
    hintsUsed: integer("hints_used", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [index("attempts_session_idx").on(t.sessionId)],
);

/** One concept's mark from one graded answer. */
export interface ConceptMark {
  reviewItemId: number;
  mark: Mark;
}

/**
 * A concept's mark for a day: the new prompt's coloured concept numbers,
 * "columns Y onward". Rows exist only where a concept was tested, so an
 * untested concept is left unchanged by construction.
 */
export const conceptMarks = sqliteTable(
  "concept_marks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reviewItemId: integer("review_item_id")
      .notNull()
      .references(() => reviewItems.id, { onDelete: "cascade" }),
    studyDateId: integer("study_date_id")
      .notNull()
      .references(() => studyDates.id, { onDelete: "cascade" }),
    mark: text("mark", { enum: MARKS }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [
    unique("concept_marks_item_date_unq").on(t.reviewItemId, t.studyDateId),
    index("concept_marks_item_idx").on(t.reviewItemId),
  ],
);

/**
 * A question the lecture itself poses, with its answer from the notes or the
 * following slide (new_prompt.txt: "use practice questions from the slides
 * and their note-based answers when available"). Kept whole rather than
 * turned into review items: the tutor prefers one when it fits the target.
 */
export const practiceQuestions = sqliteTable(
  "practice_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    /** The objective it serves, when the extract could tell. */
    loId: integer("lo_id").references(() => learningObjectives.id, {
      onDelete: "set null",
    }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    slideRefs: text("slide_refs", { mode: "json" }).$type<number[]>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [index("practice_questions_lecture_idx").on(t.lectureId)],
);
