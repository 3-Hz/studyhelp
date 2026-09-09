"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import MaterialInputs, {
  appendMaterials,
  EMPTY_MATERIALS,
  materialCount,
  type Materials,
} from "@/app/components/MaterialInputs";

export default function NewLecturePage() {
  const router = useRouter();
  const [materials, setMaterials] = useState<Materials>(EMPTY_MATERIALS);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = materialCount(materials);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (count === 0) return;

    setBusy(true);
    setError(null);

    const form = new FormData();
    if (title.trim()) form.set("title", title.trim());
    appendMaterials(form, materials);

    try {
      const response = await fetch("/api/lectures", {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Ingest failed.");
      router.push(`/lectures/${data.lectureId}/review`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ingest failed.");
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Add a lecture</h1>
      <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
        Upload the deck, the transcript, the practice quiz and any additional
        materials for one lecture, each in its own box, so the model knows
        which file is which. Slides and presenter notes are parsed locally;
        PDFs and images are read by the model directly.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-6">
        <div>
          <label
            htmlFor="title"
            className="block text-sm font-medium text-stone-700 dark:text-stone-300"
          >
            Title <span className="font-normal text-stone-500">(optional)</span>
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Taken from the title slide if left blank"
            className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />
        </div>

        <MaterialInputs
          idPrefix="new"
          materials={materials}
          onChange={setMaterials}
          disabled={busy}
        />

        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || count === 0}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy ? "Reading the lecture…" : "Extract objectives"}
        </button>

        {busy && (
          <p className="text-sm text-stone-500">
            This takes a minute or two for a full deck. Nothing is written to
            the dashboard until you review what comes back.
          </p>
        )}
      </form>
    </div>
  );
}
