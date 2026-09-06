import type { DebriefOutput } from "@/lib/tutor/schema";

export function Debrief({ debrief }: { debrief: DebriefOutput }) {
  return (
    <div className="mt-6 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
      <List title="Held up" items={debrief.heldUp} />
      <List title="Shaky" items={debrief.shaky} />
      <List title="Misconceptions to fix" items={debrief.misconceptions} />
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Next
        </h3>
        <p className="mt-1 text-sm">{debrief.focusNext}</p>
      </div>
      {debrief.calibration && debrief.calibration.trim().length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Your account versus the record
          </h3>
          <p className="mt-1 text-sm">{debrief.calibration}</p>
        </div>
      )}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
