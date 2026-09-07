"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_MINUTES } from "@/lib/session/budget";
import { MinutesSelect } from "./MinutesSelect";

export function StartDailyButton({ resuming }: { resuming: boolean }) {
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
        body: JSON.stringify({ type: "daily", minutes }),
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
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-4">
        {/* A rejoined session keeps the budget it began with; the select is moot then. */}
        {!resuming && <MinutesSelect value={minutes} onChange={setMinutes} />}
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy ? "Starting…" : resuming ? "Resume today's session" : "Start today's session"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
