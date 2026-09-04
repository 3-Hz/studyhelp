"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SuspendToggle({
  objectiveId,
  suspended,
}: {
  objectiveId: number;
  suspended: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/objectives/${objectiveId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: !suspended }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not update.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={
          suspended
            ? "Reactivate: this objective can be quizzed again"
            : "Suspend: stop quizzing this objective"
        }
        className="text-[10px] uppercase tracking-wide text-stone-400 underline hover:text-stone-700 disabled:opacity-40 dark:hover:text-stone-200"
      >
        {suspended ? "Reactivate" : "Suspend"}
      </button>
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </span>
  );
}
