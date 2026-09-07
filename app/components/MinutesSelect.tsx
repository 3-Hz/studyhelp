"use client";

/** The budgets on offer. Twenty is the ten questions of old. */
export const MINUTE_OPTIONS = [10, 20, 30, 45, 60] as const;

/**
 * How long the student has (new_prompt.txt: "note how much time I have"),
 * which sizes the session: how many objectives, how many questions on each.
 */
export function MinutesSelect({
  value,
  onChange,
  compact = false,
}: {
  value: number;
  onChange: (minutes: number) => void;
  compact?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-stone-600 dark:text-stone-400`}>
      {!compact && <span>I have</span>}
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Minutes available"
        className={`rounded-md border border-stone-300 bg-white ${compact ? "px-1.5 py-1 text-xs" : "px-2 py-1.5 text-sm"} dark:border-stone-700 dark:bg-stone-900`}
      >
        {MINUTE_OPTIONS.map((minutes) => (
          <option key={minutes} value={minutes}>
            {minutes} min
          </option>
        ))}
      </select>
    </label>
  );
}
