import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * Ratings mirror the LO Dashboard colors defined in prompt.txt:
 *   green  — accurate, complete, independently retrieved, appropriately explained
 *   yellow — partly correct, missing important content, or needed meaningful hints
 *   red    — central answer not recalled, or a major misconception stated
 *   suspended (dark green) — do not quiz again unless reactivated
 */
export const RATINGS = ["green", "yellow", "red", "suspended"] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * Provenance keeps supplemental medical knowledge from ever being silently
 * attributed to the lecture (prompt.txt "Lecture Processing").
 */
export const PROVENANCE = ["taught", "derived", "supplemental"] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const REVIEW_KINDS = ["fact", "mechanism", "application"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/**
 * The same-day review runs these in order (prompt.txt "Same-Day Retrieval
 * Practice"). Only lo_recall and elaboration name an objective; the summary
 * stage is about the lecture as a whole.
 */
export const SESSION_STAGES = ["lo_recall", "summary", "elaboration"] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];

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

export const lectureAssets = sqliteTable(
  "lecture_assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lectureId: integer("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["slide", "transcript", "pdf", "image"],
    }).notNull(),
    /** Slide number for decks, chunk index for transcripts. 1-based. */
    ordinal: integer("ordinal").notNull(),
    filename: text("filename"),
    /** Extracted slide body text. Null for assets Claude reads natively. */
    slideText: text("slide_text"),
    /** Presenter notes, kept separate — they carry the real explanations. */
    notesText: text("notes_text"),
    /** On-disk path under /uploads for PDFs and images, kept for re-extraction. */
    storagePath: text("storage_path"),
  },
  (t) => [index("lecture_assets_lecture_idx").on(t.lectureId, t.ordinal)],
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
    rating: text("rating", { enum: RATINGS }).notNull(),
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
    kind: text("kind", { enum: REVIEW_KINDS }).notNull(),
    provenance: text("provenance", { enum: PROVENANCE })
      .notNull()
      .default("taught"),
    /** ISO date the item is next due. */
    dueOn: text("due_on").notNull(),
    intervalDays: integer("interval_days").notNull().default(0),
    lastRating: text("last_rating", { enum: RATINGS }),
    lapses: integer("lapses").notNull().default(0),
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
    /**
     * Null for the lecture-summary stage, which assesses the whole lecture
     * rather than any single objective — and so contributes no dashboard cell.
     */
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
    rating: text("rating", { enum: RATINGS }),
    feedback: text("feedback"),
    /** Hinted recall never counts as independent mastery — caps rating at yellow. */
    hintsUsed: integer("hints_used", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(now),
  },
  (t) => [index("attempts_session_idx").on(t.sessionId)],
);
