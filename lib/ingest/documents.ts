import { extractText, getDocumentProxy } from "unpdf";
import type { ModelProfile } from "@/lib/llm/config";

/**
 * Turns uploaded PDFs and images into model content, degrading when the
 * configured model can't read them natively.
 *
 * The Anthropic Files API is gone from this path: it was provider-specific,
 * and passing bytes inline is the only thing every provider agrees on. We give
 * up cross-call file reuse, which is a fair trade for a single-user app that
 * ingests a lecture once.
 */

export type ModelFilePart =
  | { type: "file"; mediaType: string; data: Uint8Array; filename?: string }
  | { type: "text"; text: string };

export interface DocumentResult {
  parts: ModelFilePart[];
  /** Human-readable notes about anything lost, surfaced on the review screen. */
  warnings: string[];
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function mimeTypeFor(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  if (ext === "pdf") return "application/pdf";
  return IMAGE_MIME[ext];
}

export type AssetKind = "slide" | "transcript" | "pdf" | "image";

export function assetKindFor(filename: string): AssetKind | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  if (ext === "pptx") return "slide";
  if (ext === "pdf") return "pdf";
  if (ext in IMAGE_MIME) return "image";
  if (["txt", "vtt", "srt", "md"].includes(ext)) return "transcript";
  return undefined;
}

export async function preparePdf(
  bytes: Uint8Array,
  filename: string,
  profile: ModelProfile,
): Promise<DocumentResult> {
  if (profile.supportsFileParts) {
    return {
      parts: [
        {
          type: "file",
          mediaType: "application/pdf",
          data: bytes,
          filename,
        },
      ],
      warnings: [],
    };
  }

  // The model can't read a PDF, so pull the text out locally. This is a real
  // quality drop, not a transparent fallback: diagrams, figures and anything
  // rendered as an image are simply gone.
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const body = typeof text === "string" ? text.trim() : "";

    if (body.length === 0) {
      return {
        parts: [],
        warnings: [
          `${filename}: no extractable text (likely a scanned deck), and ${profile.modelId} cannot read PDFs directly. The file was skipped entirely.`,
        ],
      };
    }

    return {
      parts: [
        {
          type: "text",
          text: `# PDF: ${filename} (text layer only, ${totalPages} pages)\n\n${body}`,
        },
      ],
      warnings: [
        `${filename}: read as plain text because ${profile.modelId} has no native PDF support. Diagrams, figures and any image-only content were not seen by the model.`,
      ],
    };
  } catch (error) {
    return {
      parts: [],
      warnings: [
        `${filename}: could not be parsed (${error instanceof Error ? error.message : "unknown error"}). Skipped.`,
      ],
    };
  }
}

export function prepareImage(
  bytes: Uint8Array,
  filename: string,
  profile: ModelProfile,
): DocumentResult {
  const mediaType = mimeTypeFor(filename);

  if (!mediaType) {
    return { parts: [], warnings: [`${filename}: unrecognised image type.`] };
  }

  if (!profile.supportsImages) {
    return {
      parts: [],
      warnings: [
        `${filename}: skipped because ${profile.modelId} has no vision support.`,
      ],
    };
  }

  return {
    parts: [{ type: "file", mediaType, data: bytes, filename }],
    warnings: [],
  };
}
