import type * as schema from "@/lib/db/schema";
import type { Rating, SessionStage } from "@/lib/db/schema";
import type { QuestionOrder, Tier } from "@/lib/schedule";
import type { QuestionFormat, TurnContext } from "@/lib/tutor";
import type {
  askQuestion,
  gradeAnswer,
  giveHint,
  summariseSession,
} from "@/lib/tutor";
import type { Bucket } from "./select";

export type SessionRow = typeof schema.sessions.$inferSelect;
export type AttemptRow = typeof schema.attempts.$inferSelect;

/** Injectable so tests can run a whole session without a provider. */
export interface TutorDeps {
  askQuestion: typeof askQuestion;
  gradeAnswer: typeof gradeAnswer;
  giveHint: typeof giveHint;
  summariseSession: typeof summariseSession;
}

/** Enough to identify what a turn is about, asked or already answered. */
export interface TurnRef {
  stage: SessionStage;
  loId: number | null;
  reviewItemId: number | null;
}

export interface PlannedTurn extends TurnRef {
  /** Formats the model may choose from. Omitted means any. */
  allowedFormats?: QuestionFormat[];
  /** Why select() picked this slot for daily practice. Absent for same-day turns. */
  bucket?: Bucket;
  /** The item's mastery tier, from the plan. Absent for same-day turns. */
  tier?: Tier;
  /** How demanding the question should be, from the plan. */
  order?: QuestionOrder;
}

/** What finishing did to one review item. Stored on sessions.outcomes. */
export interface Outcome {
  reviewItemId: number;
  /** Snapshotted: the concept as it was asked, so a finished session needs no join. */
  concept: string;
  rating: Rating;
  tierBefore: Tier;
  tierAfter: Tier;
  dueOn: string;
}

/**
 * Why a daily turn was shaped as it was. Shown only after grading: a
 * judgement of learning handed over before the attempt is the anchor the
 * calibration literature wants removed.
 */
export interface TurnWhy {
  bucket: Bucket;
  tier: Tier;
  /** Absent on a plan frozen before orders existed. */
  order?: QuestionOrder;
  lapses: number;
  streak: number;
  intervalDays: number;
  dueOn: string;
}

/**
 * What differs between the two session flavours. The runner owns everything
 * else: resuming a pending question, capping a hinted rating, writing the day.
 *
 * `M` is the flavour's material — one lecture for the same-day review, a set
 * of items across lectures for daily practice.
 */
export interface SessionKind<M> {
  loadMaterial(session: SessionRow): Promise<M>;

  /** The next thing to ask, or null when the session is complete. */
  planNext(material: M, attempts: AttemptRow[]): PlannedTurn | null;

  /** What the tutor sees, whether asking, grading or cueing. */
  turnContext(turn: TurnRef, material: M): TurnContext;

  /** Which review items move on finishing, and on what rating. */
  itemOutcomes(attempts: AttemptRow[], material: M): Map<number, Rating>;

  /** Where the student is. Omitted when the length is not known in advance. */
  progress?(material: M, attempts: AttemptRow[]): { position: number; total: number | null };

  /** The turn's selection story, for the badge. Omitted by kinds without one. */
  explain?(turn: TurnRef, material: M): TurnWhy | undefined;
}
