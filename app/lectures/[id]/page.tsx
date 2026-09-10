import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { lectureConcepts } from "@/lib/concepts";
import { db, schema } from "@/lib/db";
import type { ExtractionMeta } from "@/lib/extract";
import type { LectureExtract } from "@/lib/extract/schema";
import ExtractionNotes from "./ExtractionNotes";
import LectureFiles, { type SourceSummary } from "./LectureFiles";
import ObjectivesTable from "./ObjectivesTable";

export const dynamic = "force-dynamic";

/**
 * One page per lecture: its files and the boxes for more, the button that
 * reads them, what the last read reported, and the objectives with their
 * concepts. The LO Map, with each concept's marks by date, is one link away.
 */
export default async function LecturePage({
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

  const sourceSummaries: SourceSummary[] = sources.map((source) => ({
    id: source.id,
    filename: source.filename,
    kind: source.kind,
    role: source.role,
    itemCount: assets.filter((asset) => asset.sourceId === source.id).length,
    byteSize: source.byteSize,
  }));

  const view = (await lectureConcepts(lectureId))!;
  const lastExtract = lecture.lastExtract as LectureExtract | null;
  const meta = lecture.extractionMeta as ExtractionMeta | null;
  const warnings = (lecture.extractionWarnings as string[] | null) ?? [];
  const extractedOn = lecture.extractedAt?.toISOString().slice(0, 10) ?? null;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{lecture.title}</h1>
      <p className="mt-1 text-sm text-stone-500">
        {extractedOn ? `Last extracted ${extractedOn}` : "Not extracted yet"}
        {view.objectives.length > 0 && (
          <>
            {" · "}
            <Link href={`/lectures/${lectureId}/concepts`} className="underline">
              LO Map: each concept&rsquo;s marks by date
            </Link>
          </>
        )}
      </p>

      <LectureFiles
        lectureId={lectureId}
        sources={sourceSummaries}
        hasObjectives={view.objectives.length > 0}
      />

      {extractedOn && (
        <ExtractionNotes
          extractedOn={extractedOn}
          meta={meta}
          warnings={warnings}
          conflicts={lastExtract?.conflicts ?? []}
          commonConfusions={lastExtract?.commonConfusions ?? []}
        />
      )}

      <ObjectivesTable objectives={view.objectives} />
    </div>
  );
}
