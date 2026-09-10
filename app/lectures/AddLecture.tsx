"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * A lecture begins as a title. The button opens an inline form; submitting
 * creates the empty lecture and goes to its page, where the files are added
 * and read.
 */
export default function AddLecture() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (title.trim().length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/lectures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not add the lecture.");
      router.push(`/lectures/${data.lectureId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the lecture.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium dark:border-stone-700"
      >
        Add lecture
      </button>
    );
  }

  return (
    <form onSubmit={create} className="mt-4 flex flex-wrap items-center gap-2">
      <input
        autoFocus
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Lecture title"
        aria-label="Lecture title"
        disabled={busy}
        className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
      />
      <button
        type="submit"
        disabled={busy || title.trim().length === 0}
        className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
      >
        {busy ? "Adding…" : "Add lecture"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setTitle("");
          setError(null);
        }}
        disabled={busy}
        className="text-sm text-stone-500 underline"
      >
        Cancel
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}
