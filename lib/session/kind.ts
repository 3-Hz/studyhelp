import type * as schema from "@/lib/db/schema";
import type { Rating, SessionStage } from "@/lib/db/schema";
import type { QuestionFormat, TurnContext } from "@/lib/tutor";

export type SessionRow = typeof schema.sessions.$inferSelect;
export type AttemptRow = typeof schema.attempts.$inferSelect;

/** Enough to identify what a turn is about, asked or already answered. */
export interface TurnRef {
  stage: SessionStage;
  loId: number | null;
  reviewItemId: number | null;
}

export interface PlannedTurn extends TurnRef {
  /** Formats the model may choose from. Omitted means any. */
  allowedFormats?: QuestionFormat[];
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

  /** Optional close-out. Whatever it returns is stored on sessions.debrief. */
  closeOut?(args: {
    session: SessionRow;
    attempts: AttemptRow[];
    material: M;
    deps: unknown;
  }): Promise<unknown>;
}
