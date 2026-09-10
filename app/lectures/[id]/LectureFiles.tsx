"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import MaterialInputs, {
  appendMaterials,
  EMPTY_MATERIALS,
  materialCount,
  type Materials,
} from "@/app/components/MaterialInputs";
import type { SourceRole } from "@/lib/db/schema";

export interface SourceSummary {
  id: number;
  filename: string;
  kind: "slide" | "transcript" | "pdf" | "image";
  /** Which box it was uploaded in. */
  role: SourceRole;
  /** Slides for a deck, sections for a transcript. Zero for PDFs and images. */
  itemCount: number;
  byteSize: number | null;
}

const ROLE_LABEL: Record<SourceRole, string> = {
  deck: "slide deck",
  transcript: "transcript",
  quiz: "practice quiz",
  additional: "additional",
};

/** The role leads; the format follows, unless it would only repeat the role. */
function describe(source: SourceSummary): string {
  const role = ROLE_LABEL[source.role];
  if (source.kind === "slide") {
    return `${role} · ${source.itemCount} slide${source.itemCount === 1 ? "" : "s"}`;
  }
  if (source.kind === "transcript") {
    return `${role} · ${source.itemCount} section${source.itemCount === 1 ? "" : "s"}`;
  }
  return `${role} · ${source.kind === "pdf" ? "PDF" : "figure"}${size(source.byteSize)}`;
}

/** Rounding a small figure to "0 KB" reads as an empty file. Don't. */
function size(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return ` · ${bytes} B`;
  return ` · ${Math.round(bytes / 1024)} KB`;
}

interface Applied {
  objectivesCreated: number;
  reviewItemsCreated: number;
  reviewItemsMatched: number;
}

function summarise(applied: Applied): string {
  const parts = [
    `${applied.objectivesCreated} new objective${applied.objectivesCreated === 1 ? "" : "s"}`,
    `${applied.reviewItemsCreated} new concept${applied.reviewItemsCreated === 1 ? "" : "s"}`,
  ];
  if (applied.reviewItemsMatched > 0) {
    parts.push(`${applied.reviewItemsMatched} already recorded`);
  }
  return `Read the lecture: ${parts.join(", ")}.`;
}

/**
 * The files a lecture was built from, the four boxes for more, and the one
 * button that reads the lecture: Extract before it has objectives, Amend
 * after. Materials arrive at different times — the deck before the lecture,
 * the transcript once the video posts — so a lecture is never finished at
 * upload, and every read is over everything the lecture holds.
 */
export default function LectureFiles({
  lectureId,
  sources,
  hasObjectives,
}: {
  lectureId: number;
  sources: SourceSummary[];
  hasObjectives: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Materials>(EMPTY_MATERIALS);
  // Remounting the inputs is the one reliable way to clear four file boxes.
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const count = materialCount(pending);
  const canRead = count > 0 || sources.length > 0;
  const verb = hasObjectives ? "Amend" : "Extract";

  async function read() {
    if (!canRead) return;

    setBusy(true);
    setError(null);
    setDone(null);

    const form = new FormData();
    appendMaterials(form, pending);

    try {
      const response = await fetch(`/api/lectures/${lectureId}/extract`, {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not read the lecture.");
      setPending(EMPTY_MATERIALS);
      setGeneration((n) => n + 1);
      setDone(summarise(data.applied as Applied));
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not read the lecture.",
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

      {sources.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">No files yet.</p>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs">{source.filename}</span>
              <span className="text-xs text-stone-500">{describe(source)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-stone-200 pt-4 dark:border-stone-800">
        <p className="text-xs text-stone-600 dark:text-stone-400">
          Add the deck, the transcript, the practice quiz, a handout, in any
          order and at any time. {verb} stores them and reads the whole
          lecture again; the objectives and concepts it already holds keep
          their numbers and their history, and what is new joins them.
        </p>
        <div className="mt-3">
          <MaterialInputs
            key={generation}
            idPrefix="add"
            materials={pending}
            onChange={setPending}
            disabled={busy}
            compact
          />
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}

        {done && !busy && (
          <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{done}</p>
        )}

        <button
          type="button"
          onClick={read}
          disabled={busy || !canRead}
          className="mt-3 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy
            ? "Reading the lecture…"
            : count > 0
              ? `${verb} with ${count} new file${count === 1 ? "" : "s"}`
              : verb}
        </button>

        {busy && (
          <p className="mt-2 text-xs text-stone-500">
            This reads every file the lecture holds, so it takes a minute or
            two for a full deck, longer on a local model.
          </p>
        )}
      </div>
    </section>
  );
}
