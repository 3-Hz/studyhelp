import { extractText, getDocumentProxy } from "unpdf";
import type { ModelProfile } from "@/lib/llm/config";
import { estimateTokens } from "@/lib/llm/tokens";

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
  /**
   * Roughly what these parts will cost the model. Chunking measures slide and
   * transcript text but cannot see inside a PDF or an image, so a document's
   * cost has to be declared here or it is spent without ever being counted.
   */
  estimatedTokens: number;
}

/**
 * A rendered page and an image both arrive as vision input, and both land near
 * this figure across the providers we target. Precision is not the point — the
 * point is that several documents can no longer be treated as free.
 */
const TOKENS_PER_RENDERED_PAGE = 1600;

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
      estimatedTokens: (await pageCount(bytes)) * TOKENS_PER_RENDERED_PAGE,
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
        estimatedTokens: 0,
      };
    }

    const rendered = `# PDF: ${filename} (text layer only, ${totalPages} pages)\n\n${body}`;

    return {
      parts: [{ type: "text", text: rendered }],
      warnings: [
        `${filename}: read as plain text because ${profile.modelId} has no native PDF support. Diagrams, figures and any image-only content were not seen by the model.`,
      ],
      estimatedTokens: estimateTokens(rendered),
    };
  } catch (error) {
    return {
      parts: [],
      warnings: [
        `${filename}: could not be parsed (${error instanceof Error ? error.message : "unknown error"}). Skipped.`,
      ],
      estimatedTokens: 0,
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
    return {
      parts: [],
      warnings: [`${filename}: unrecognised image type.`],
      estimatedTokens: 0,
    };
  }

  if (!profile.supportsImages) {
    return {
      parts: [],
      warnings: [
        `${filename}: skipped because ${profile.modelId} has no vision support.`,
      ],
      estimatedTokens: 0,
    };
  }

  return {
    parts: [{ type: "file", mediaType, data: bytes, filename }],
    warnings: [],
    estimatedTokens: TOKENS_PER_RENDERED_PAGE,
  };
}

/** Page count for budgeting. A PDF we cannot open is charged as one page. */
async function pageCount(bytes: Uint8Array): Promise<number> {
  try {
    const pdf = await getDocumentProxy(bytes);
    return pdf.numPages;
  } catch {
    return 1;
  }
}
