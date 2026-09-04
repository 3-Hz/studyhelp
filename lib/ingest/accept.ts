/**
 * File types the ingest pipeline understands, as an `accept` attribute.
 *
 * Kept apart from `assetKindFor` — which is the real authority — because this
 * one is imported by client components, and `documents.ts` pulls in a PDF
 * parser they have no use for. Keep the two lists in step.
 */
export const ACCEPT =
  ".pptx,.pdf,.txt,.vtt,.srt,.md,.png,.jpg,.jpeg,.gif,.webp";
