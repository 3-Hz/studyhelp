"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ACCEPT } from "@/lib/ingest/accept";

export interface SourceSummary {
  id: number;
  filename: string;
  kind: "slide" | "transcript" | "pdf" | "image";
  /** Slides for a deck, sections for a transcript. Zero for PDFs and images. */
  itemCount: number;
  byteSize: number | null;
}

const KIND_LABEL: Record<SourceSummary["kind"], string> = {
  slide: "deck",
  transcript: "transcript",
  pdf: "PDF",
  image: "figure",
};

function describe(source: SourceSummary): string {
  if (source.kind === "slide") {
    return `${KIND_LABEL.slide} · ${source.itemCount} slide${source.itemCount === 1 ? "" : "s"}`;
  }
  if (source.kind === "transcript") {
    return `${KIND_LABEL.transcript} · ${source.itemCount} section${source.itemCount === 1 ? "" : "s"}`;
  }
  return `${KIND_LABEL[source.kind]}${size(source.byteSize)}`;
}

/** Rounding a small figure to "0 KB" reads as an empty file. Don't. */
function size(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return ` · ${bytes} B`;
  return ` · ${Math.round(bytes / 1024)} KB`;
}

/**
 * The files a lecture was built from, and a way to add more.
 *
 * Materials arrive at different times — the deck before the lecture, the
 * transcript once the video posts — so a lecture is never finished at upload.
 */
export default function LectureFiles({
  lectureId,
  sources,
}: {
  lectureId: number;
  sources: SourceSummary[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (pending.length === 0) return;

    setBusy(true);
    setError(null);

    const form = new FormData();
    for (const file of pending) form.append("files", file);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/sources`, {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not add the files.");
      setPending([]);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add the files.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
        Files in this lecture ({sources.length})
      </h2>

      <ul className="mt-3 space-y-1 text-sm">
        {sources.map((source) => (
          <li key={source.id} className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-xs">{source.filename}</span>
            <span className="text-xs text-stone-500">{describe(source)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 border-t border-stone-200 pt-4 dark:border-stone-800">
        <label
          htmlFor="add-files"
          className="block text-xs text-stone-600 dark:text-stone-400"
        >
          Add more — the transcript, a handout, a figure. The draft is extracted
          again over everything, and slide numbers stay put.
        </label>
        <input
          ref={inputRef}
          id="add-files"
          type="file"
          multiple
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => setPending(Array.from(e.target.files ?? []))}
          className="mt-2 w-full rounded-md border border-dashed border-stone-300 bg-white px-3 py-3 text-sm file:mr-4 file:rounded file:border-0 file:bg-stone-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:border-stone-700 dark:bg-stone-900 dark:file:bg-stone-100 dark:file:text-stone-900"
        />

        {error && (
          <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={add}
          disabled={busy || pending.length === 0}
          className="mt-3 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-stone-700"
        >
          {busy
            ? "Re-reading the lecture…"
            : `Add ${pending.length || ""} file${pending.length === 1 ? "" : "s"} and re-extract`}
        </button>

        {busy && (
          <p className="mt-2 text-xs text-stone-500">
            This re-runs extraction over every file, so it takes about as long
            as the first upload.
          </p>
        )}
      </div>
    </section>
  );
}
