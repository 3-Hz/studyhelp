"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ACCEPT = ".pptx,.pdf,.txt,.vtt,.srt,.md,.png,.jpg,.jpeg,.gif,.webp";

export default function NewLecturePage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (files.length === 0) return;

    setBusy(true);
    setError(null);

    const form = new FormData();
    if (title.trim()) form.set("title", title.trim());
    for (const file of files) form.append("files", file);

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
        Upload the deck, and anything else you have for the same lecture — the
        PDF export, the video transcript, figures. Slides and presenter notes
        are parsed locally; PDFs and images are read by the model directly.
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

        <div>
          <label
            htmlFor="files"
            className="block text-sm font-medium text-stone-700 dark:text-stone-300"
          >
            Lecture files
          </label>
          <input
            id="files"
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="mt-2 w-full rounded-md border border-dashed border-stone-300 bg-white px-3 py-6 text-sm file:mr-4 file:rounded file:border-0 file:bg-stone-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:border-stone-700 dark:bg-stone-900 dark:file:bg-stone-100 dark:file:text-stone-900"
          />
          {files.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-stone-600 dark:text-stone-400">
              {files.map((file) => (
                <li key={file.name}>
                  {file.name}{" "}
                  <span className="text-stone-400">
                    ({Math.round(file.size / 1024)} KB)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || files.length === 0}
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
