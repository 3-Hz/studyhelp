"use client";

import type { SourceRole } from "@/lib/db/schema";
import { ACCEPT } from "@/lib/ingest/accept";

/** The files chosen in each box, keyed by the role that box gives them. */
export type Materials = Record<SourceRole, File[]>;

export const EMPTY_MATERIALS: Materials = {
  deck: [],
  transcript: [],
  quiz: [],
  additional: [],
};

/**
 * The four boxes, in upload order. Kept in step with SOURCE_ROLES by a test:
 * the field names here are what filesFromForm reads back.
 */
export const BOXES: { role: SourceRole; label: string; hint: string }[] = [
  {
    role: "deck",
    label: "Slide deck",
    hint: "The .pptx, or its PDF export. Presenter notes come from the .pptx.",
  },
  {
    role: "transcript",
    label: "Lecture transcript",
    hint: "The video's captions: .vtt, .srt, .txt, or a PDF.",
  },
  {
    role: "quiz",
    label: "Practice quiz",
    hint: "The course's own questions with their answer key. Every concept it tests is filed under an objective and marked.",
  },
  {
    role: "additional",
    label: "Additional materials",
    hint: "Handouts, readings, figures. Read as course material, under the lecturer's cues like anything else.",
  },
];

export function materialCount(materials: Materials): number {
  return BOXES.reduce((sum, box) => sum + materials[box.role].length, 0);
}

/** One multipart field per box, named for its role. */
export function appendMaterials(form: FormData, materials: Materials): void {
  for (const box of BOXES) {
    for (const file of materials[box.role]) form.append(box.role, file);
  }
}

/**
 * Four file inputs, one per kind of material. Uploading each in its own box
 * is how the model learns which file is which: a quiz PDF and a lecture PDF
 * are the same file type.
 */
export default function MaterialInputs({
  idPrefix,
  materials,
  onChange,
  disabled = false,
  compact = false,
}: {
  idPrefix: string;
  materials: Materials;
  onChange: (materials: Materials) => void;
  disabled?: boolean;
  /** Tighter inputs for the add-more block on the review screen. */
  compact?: boolean;
}) {
  const padding = compact ? "py-3" : "py-6";

  return (
    <div className="space-y-5">
      {BOXES.map((box) => {
        const id = `${idPrefix}-${box.role}`;
        const chosen = materials[box.role];
        return (
          <div key={box.role}>
            <label
              htmlFor={id}
              className="block text-sm font-medium text-stone-700 dark:text-stone-300"
            >
              {box.label}
              <span className="ml-2 font-normal text-stone-500">{box.hint}</span>
            </label>
            <input
              id={id}
              type="file"
              multiple
              accept={ACCEPT}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...materials, [box.role]: Array.from(e.target.files ?? []) })
              }
              className={`mt-2 w-full rounded-md border border-dashed border-stone-300 bg-white px-3 ${padding} text-sm file:mr-4 file:rounded file:border-0 file:bg-stone-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:border-stone-700 dark:bg-stone-900 dark:file:bg-stone-100 dark:file:text-stone-900`}
            />
            {chosen.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm text-stone-600 dark:text-stone-400">
                {chosen.map((file, index) => (
                  <li key={`${file.name}-${index}`}>
                    {file.name}{" "}
                    <span className="text-stone-400">({Math.round(file.size / 1024)} KB)</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
