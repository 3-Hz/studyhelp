"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_MINUTES } from "@/lib/session/budget";
import { MinutesSelect } from "./MinutesSelect";

/**
 * Starting a session is a POST rather than a link, because it creates a row —
 * and rejoins an unfinished session instead of opening a second one.
 */
export function StartSessionButton({ lectureId }: { lectureId: number }) {
  const router = useRouter();
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lectureId, minutes }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start.");
      router.push(`/sessions/${data.sessionId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start.");
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-2">
        <MinutesSelect value={minutes} onChange={setMinutes} compact />
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-50 disabled:opacity-40 dark:border-stone-700 dark:hover:bg-stone-900"
        >
          {busy ? "Starting…" : "Study"}
        </button>
      </span>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
