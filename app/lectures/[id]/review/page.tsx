import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/lib/db";
import type { ExtractionMeta } from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import LectureFiles, { type SourceSummary } from "./LectureFiles";
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

  const sources = await db
    .select()
    .from(schema.lectureSources)
    .where(eq(schema.lectureSources.lectureId, lectureId))
    .orderBy(asc(schema.lectureSources.uploadIndex));

  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const sourceSummaries: SourceSummary[] = sources.map((source) => ({
    id: source.id,
    filename: source.filename,
    kind: source.kind,
    role: source.role,
    itemCount: assets.filter((asset) => asset.sourceId === source.id).length,
    byteSize: source.byteSize,
  }));

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
          No extraction is attached to this lecture yet. Its files are below —
          adding another runs the extraction again.
        </p>
        <LectureFiles lectureId={lectureId} sources={sourceSummaries} />
      </div>
    );
  }

  // Keyed by the global slide number the model was shown, which is what
  // `slideRefs` points at. Several decks share one run of numbers, so the label
  // says which file a slide actually came from and where it sits inside it.
  const slidesByOrdinal = new Map<number, { text: string; label: string }>();
  for (const asset of assets) {
    if (asset.kind !== "slide") continue;
    const body = [asset.slideText, asset.notesText]
      .filter((text) => text && text.length > 0)
      .join("\n\n— presenter notes —\n");
    const filename =
      (asset.sourceId === null
        ? undefined
        : sourceById.get(asset.sourceId)?.filename) ?? asset.filename;
    slidesByOrdinal.set(asset.globalOrdinal ?? asset.ordinal, {
      text: body,
      label: filename
        ? `${filename} · slide ${asset.ordinal}`
        : `Slide ${asset.ordinal}`,
    });
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

      <LectureFiles lectureId={lectureId} sources={sourceSummaries} />

      <ReviewForm
        lectureId={lectureId}
        draft={draft}
        slidesByOrdinal={Object.fromEntries(slidesByOrdinal)}
      />
    </div>
  );
}
