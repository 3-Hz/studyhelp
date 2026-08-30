import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/lib/db";
import type { ExtractionMeta } from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import ReviewForm from "./ReviewForm";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lectureId = Number(id);
  if (!Number.isInteger(lectureId)) notFound();

  const lecture = await db.query.lectures.findFirst({
    where: eq(schema.lectures.id, lectureId),
  });
  if (!lecture) notFound();

  const assets = await db.query.lectureAssets.findMany({
    where: eq(schema.lectureAssets.lectureId, lectureId),
  });

  const draft = lecture.draftExtract as LectureExtract | null;

  if (lecture.committedAt) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          {lecture.title}
        </h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          Already committed. Its objectives are on the{" "}
          <Link href="/dashboard" className="underline">
            dashboard
          </Link>
          .
        </p>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          {lecture.title}
        </h1>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
          No extraction is attached to this lecture yet.
        </p>
      </div>
    );
  }

  // Slide text, keyed by slide number, so each objective sits beside its source.
  const slideTextByOrdinal = new Map<number, string>();
  for (const asset of assets) {
    if (asset.kind !== "slide") continue;
    const body = [asset.slideText, asset.notesText]
      .filter((text) => text && text.length > 0)
      .join("\n\n— presenter notes —\n");
    slideTextByOrdinal.set(asset.ordinal, body);
  }

  const meta = lecture.extractionMeta as ExtractionMeta | null;
  const warnings = (lecture.extractionWarnings as string[] | null) ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{lecture.title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-stone-600 dark:text-stone-400">
        Nothing here is on the dashboard yet. Check each objective against its
        source text — wording is preserved verbatim on purpose, so fix anything
        the model paraphrased before committing.
      </p>

      {meta && (
        <p className="mt-4 font-mono text-xs text-stone-500">
          Extracted by {meta.profile}
          {meta.chunked && ` · ${meta.chunkCount} sections merged`}
          {meta.repairs > 0 &&
            ` · ${meta.repairs} schema repair${meta.repairs === 1 ? "" : "s"}`}
        </p>
      )}

      {warnings.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            This draft came from a reduced-capability read
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
            Check the objectives more carefully than usual, and consider
            re-running on a model with the missing capability.
          </p>
        </div>
      )}

      <ReviewForm
        lectureId={lectureId}
        draft={draft}
        slideTextByOrdinal={Object.fromEntries(slideTextByOrdinal)}
      />
    </div>
  );
}
