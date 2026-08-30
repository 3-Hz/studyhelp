/**
 * Lecture-video transcript cleanup for WebVTT, SubRip, and plain text.
 *
 * Auto-generated captions are the common case, and they carry three artifacts
 * that waste context and confuse extraction: timestamps, inline markup, and
 * rolling duplicate lines (each cue repeats the tail of the previous one).
 */

const VTT_TIMESTAMP =
  /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3}\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3}/;
const SRT_INDEX = /^\s*\d+\s*$/;
const TIMESTAMP_ONLY = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*$/;

/** <v Dr. Smith>text</v>, <c.colorE5E5E5>text</c>, <00:00:01.000> */
function stripInlineMarkup(line: string): string {
  return line
    .replace(/<v[^>]*>/gi, "")
    .replace(/<\/v>/gi, "")
    .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{3}>/g, "")
    .replace(/<\/?c[^>]*>/gi, "")
    .replace(/\{\\[^}]*\}/g, "")
    .trim();
}

export interface TranscriptChunk {
  ordinal: number;
  text: string;
}

/**
 * Returns cleaned transcript text with cue scaffolding removed.
 */
export function cleanTranscript(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "WEBVTT" || line.startsWith("WEBVTT ")) continue;
    if (line.startsWith("NOTE ") || line === "NOTE") continue;
    if (line.startsWith("STYLE") || line.startsWith("REGION")) continue;
    if (VTT_TIMESTAMP.test(line)) continue;
    if (SRT_INDEX.test(line)) continue;
    if (TIMESTAMP_ONLY.test(line)) continue;

    const cleaned = stripInlineMarkup(line);
    if (!cleaned) continue;

    // Rolling captions repeat the previous line verbatim; drop the echo.
    if (kept.length > 0 && kept[kept.length - 1] === cleaned) continue;
    kept.push(cleaned);
  }

  return kept.join("\n").trim();
}

/**
 * Groups cleaned transcript lines into paragraph-sized chunks so a long
 * lecture can be stored and shown as discrete assets rather than one blob.
 */
export function chunkTranscript(
  raw: string,
  linesPerChunk = 40,
): TranscriptChunk[] {
  const cleaned = cleanTranscript(raw);
  if (!cleaned) return [];

  const lines = cleaned.split("\n");
  const chunks: TranscriptChunk[] = [];

  for (let i = 0; i < lines.length; i += linesPerChunk) {
    chunks.push({
      ordinal: chunks.length + 1,
      text: lines.slice(i, i + linesPerChunk).join("\n"),
    });
  }

  return chunks;
}
