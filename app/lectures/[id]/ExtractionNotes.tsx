import type { ExtractionMeta } from "@/lib/extract";

/**
 * What the last read of the lecture reported: which model, whether it was
 * chunked or repaired, what it could not see, and what it found the
 * materials contradicting or confusing. Folded away by default; the
 * objectives below are the result that matters.
 */
export default function ExtractionNotes({
  extractedOn,
  meta,
  warnings,
  conflicts,
  commonConfusions,
}: {
  /** YYYY-MM-DD, formatted on the server so the two renders agree. */
  extractedOn: string;
  meta: ExtractionMeta | null;
  warnings: string[];
  conflicts: string[];
  commonConfusions: string[];
}) {
  return (
    <details className="mt-6 rounded-lg border border-stone-200 dark:border-stone-800">
      <summary className="cursor-pointer px-4 py-3 text-sm">
        <span className="font-semibold uppercase tracking-wide text-stone-500">
          Last extraction
        </span>
        <span className="ml-3 font-mono text-xs text-stone-500">
          {extractedOn}
          {meta && ` · ${meta.profile}`}
          {meta?.chunked && ` · ${meta.chunkCount} sections merged`}
          {meta && meta.repairs > 0 &&
            ` · ${meta.repairs} schema repair${meta.repairs === 1 ? "" : "s"}`}
          {warnings.length > 0 &&
            ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}
        </span>
      </summary>

      <div className="space-y-4 border-t border-stone-200 px-4 py-4 dark:border-stone-800">
        {warnings.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              This read came from a reduced-capability model
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
              {warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
              Check the objectives more carefully than usual, and consider
              running Amend on a model with the missing capability.
            </p>
          </div>
        )}

        {conflicts.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-red-700 dark:text-red-300">
              Where the materials conflict with general knowledge
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-700 dark:text-stone-300">
              {conflicts.map((conflict, index) => (
                <li key={index}>{conflict}</li>
              ))}
            </ul>
          </div>
        )}

        {commonConfusions.length > 0 && (
          <div>
            <h3 className="text-sm font-medium">Common confusions</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-700 dark:text-stone-300">
              {commonConfusions.map((confusion, index) => (
                <li key={index}>{confusion}</li>
              ))}
            </ul>
          </div>
        )}

        {warnings.length === 0 && conflicts.length === 0 && commonConfusions.length === 0 && (
          <p className="text-sm text-stone-500">Nothing to report from this read.</p>
        )}
      </div>
    </details>
  );
}
