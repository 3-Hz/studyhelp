import type { Outcome } from "@/lib/session/kind";

/** What the session did to the ladder, as two short lists. */
export function Outcomes({ outcomes }: { outcomes: Outcome[] }) {
  const promoted = outcomes.filter(
    (outcome) => outcome.tierAfter === "mature" && outcome.tierBefore !== "mature",
  );
  const relearning = outcomes.filter((outcome) => outcome.tierAfter === "relearning");
  if (promoted.length === 0 && relearning.length === 0) return null;

  return (
    <div className="mt-6 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
      <List title="Promoted to mature" items={promoted} />
      <List title="Now relearning" items={relearning} />
    </div>
  );
}

function List({ title, items }: { title: string; items: Outcome[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((outcome) => (
          <li key={outcome.reviewItemId}>
            {outcome.concept}{" "}
            <span className="text-stone-500">— due {outcome.dueOn}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
