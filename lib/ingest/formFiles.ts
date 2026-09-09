import { SOURCE_ROLES } from "@/lib/db/schema";
import type { IncomingFile } from "./storeSources";

/**
 * Pulls every uploaded file out of a multipart form: one field per box, named
 * for its role. Boxes are read in SOURCE_ROLES order whatever the form's
 * order, so the deck leads, takes upload index 1, and lends the lecture its
 * fallback title.
 */
export async function filesFromForm(form: FormData): Promise<IncomingFile[]> {
  const files: IncomingFile[] = [];

  for (const role of SOURCE_ROLES) {
    for (const entry of form.getAll(role)) {
      if (!(entry instanceof File)) continue;
      files.push({
        filename: entry.name,
        role,
        bytes: new Uint8Array(await entry.arrayBuffer()),
      });
    }
  }

  return files;
}
