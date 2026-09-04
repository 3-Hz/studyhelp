import type { IncomingFile } from "./storeSources";

/** Pulls every uploaded file out of a multipart form's `files` field. */
export async function filesFromForm(form: FormData): Promise<IncomingFile[]> {
  const files: IncomingFile[] = [];

  for (const entry of form.getAll("files")) {
    if (!(entry instanceof File)) continue;
    files.push({
      filename: entry.name,
      bytes: new Uint8Array(await entry.arrayBuffer()),
    });
  }

  return files;
}
