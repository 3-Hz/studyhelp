/**
 * PPTX text extraction.
 *
 * A .pptx is an OOXML zip. The two things worth getting right:
 *
 *  1. Slide ORDER comes from `ppt/presentation.xml` (<p:sldIdLst>), resolved
 *     through `ppt/_rels/presentation.xml.rels`. The filename number in
 *     `slide7.xml` is an internal id, not a position — reordering slides in
 *     PowerPoint does not renumber the files.
 *
 *  2. Presenter notes are attached via each slide's own relationship file,
 *     `ppt/slides/_rels/slideN.xml.rels`. `notesSlide3.xml` does NOT reliably
 *     belong to `slide3.xml`; decks where some slides have no notes break any
 *     numeric mapping. Notes carry the actual explanations, so mis-attaching
 *     them silently corrupts every downstream extraction.
 */
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

export interface ParsedSlide {
  /** 1-based position in the deck as presented. */
  ordinal: number;
  slideText: string;
  notesText: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep everything as strings: a slide reading "2024" must not become a number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

const NOTES_SLIDE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const SLIDE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

type XmlNode = Record<string, unknown>;

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Resolves an OOXML relationship target against the part's own directory. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = baseDir.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

function parseRels(xml: string | undefined): Relationship[] {
  if (!xml) return [];
  const doc = parser.parse(xml) as XmlNode;
  const container = doc["Relationships"] as XmlNode | undefined;
  return toArray(container?.["Relationship"] as XmlNode | XmlNode[]).map(
    (r) => ({
      id: String(r["@_Id"] ?? ""),
      type: String(r["@_Type"] ?? ""),
      target: String(r["@_Target"] ?? ""),
    }),
  );
}

/** True for a shape that is a slide-number placeholder, whose text is noise. */
function isSlideNumberShape(node: XmlNode): boolean {
  const nvSpPr = node["p:nvSpPr"] as XmlNode | undefined;
  const nvPr = nvSpPr?.["p:nvPr"] as XmlNode | undefined;
  const ph = nvPr?.["p:ph"] as XmlNode | undefined;
  const type = ph?.["@_type"];
  return type === "sldNum";
}

/** Concatenates every <a:t> beneath a node, in document order. */
function runsToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(runsToText).join("");
  if (typeof node !== "object") return "";

  let out = "";
  for (const [key, value] of Object.entries(node as XmlNode)) {
    if (key.startsWith("@_")) continue;
    if (key === "a:t") {
      out += typeof value === "string" ? value : runsToText(value);
    } else if (key === "a:br") {
      out += "\n";
    } else {
      out += runsToText(value);
    }
  }
  return out;
}

/**
 * Walks a shape tree collecting one line per <a:p> paragraph. Recursing
 * generically (rather than special-casing <p:sp>) means grouped shapes,
 * SmartArt frames, and table cells all come through without extra handling.
 */
function collectParagraphs(node: unknown, out: string[]): void {
  if (node === null || node === undefined || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) collectParagraphs(child, out);
    return;
  }

  const obj = node as XmlNode;
  if (isSlideNumberShape(obj)) return;

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("@_")) continue;
    if (key === "a:p") {
      for (const paragraph of toArray(value as XmlNode | XmlNode[])) {
        const line = runsToText(paragraph).replace(/\s+$/g, "");
        if (line.trim().length > 0) out.push(line);
      }
    } else {
      collectParagraphs(value, out);
    }
  }
}

function extractText(xml: string | undefined): string {
  if (!xml) return "";
  const doc = parser.parse(xml) as XmlNode;
  const lines: string[] = [];
  collectParagraphs(doc, lines);
  return lines.join("\n").trim();
}

/**
 * Extracts slide body text and presenter notes from a .pptx buffer, in
 * presentation order.
 */
export function parsePptx(buffer: ArrayBuffer | Uint8Array): ParsedSlide[] {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const zip = unzipSync(bytes);

  const read = (path: string): string | undefined => {
    const entry = zip[path];
    return entry ? strFromU8(entry) : undefined;
  };

  const presentationXml = read("ppt/presentation.xml");
  if (!presentationXml) {
    throw new Error(
      "Not a valid .pptx: ppt/presentation.xml is missing from the archive.",
    );
  }

  // rId -> slide part path, via the presentation's relationships.
  const presentationRels = parseRels(read("ppt/_rels/presentation.xml.rels"));
  const slidePathById = new Map<string, string>();
  for (const rel of presentationRels) {
    if (rel.type === SLIDE_REL) {
      slidePathById.set(rel.id, resolveTarget("ppt", rel.target));
    }
  }

  // Authoritative slide order.
  const presentation = parser.parse(presentationXml) as XmlNode;
  const sldIdLst = (presentation["p:presentation"] as XmlNode | undefined)?.[
    "p:sldIdLst"
  ] as XmlNode | undefined;
  const sldIds = toArray(sldIdLst?.["p:sldId"] as XmlNode | XmlNode[]);

  const orderedSlidePaths = sldIds
    .map((s) => slidePathById.get(String(s["@_r:id"] ?? "")))
    .filter((p): p is string => Boolean(p));

  // Fall back to filename order only if the relationship graph is unusable.
  const slidePaths =
    orderedSlidePaths.length > 0
      ? orderedSlidePaths
      : Object.keys(zip)
          .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
          .sort((a, b) => slideNumber(a) - slideNumber(b));

  return slidePaths.map((slidePath, index) => {
    const relsPath = `${dirOf(slidePath)}/_rels/${basenameOf(slidePath)}.rels`;
    const notesRel = parseRels(read(relsPath)).find(
      (r) => r.type === NOTES_SLIDE_REL,
    );
    const notesPath = notesRel
      ? resolveTarget(dirOf(slidePath), notesRel.target)
      : undefined;

    return {
      ordinal: index + 1,
      slideText: extractText(read(slidePath)),
      notesText: notesPath ? extractText(read(notesPath)) : "",
    };
  });
}

function slideNumber(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/);
  return match ? Number(match[1]) : 0;
}

/** Renders a slide for the model, keeping notes clearly delimited from body text. */
export function formatSlideForModel(slide: ParsedSlide): string {
  const parts = [`## Slide ${slide.ordinal}`];
  parts.push(slide.slideText || "(no text on slide)");
  if (slide.notesText) {
    parts.push(`### Presenter notes\n${slide.notesText}`);
  }
  return parts.join("\n\n");
}
