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

  async function toggle() {
    setBusy(true);
    try {
      await fetch(`/api/objectives/${objectiveId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended: !suspended }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
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
  );
}
