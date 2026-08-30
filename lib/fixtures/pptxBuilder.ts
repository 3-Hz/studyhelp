/**
 * Minimal OOXML presentation builder, used to construct .pptx files in memory
 * for tests and fixtures. Shared so there is exactly one deck builder in the
 * repo rather than one per consumer.
 */
import { strToU8, zipSync } from "fflate";

export const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
export const A_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
export const R_NS =
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export const REL_NS =
  'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

export const NOTES_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
export const SLIDE_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
export const LAYOUT_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";

/** XML-escapes text destined for an <a:t> node. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A slide with a body placeholder plus a slide-number placeholder. */
export function slideXml(bodyLines: string[]): string {
  const paragraphs = bodyLines
    .map((line) => `<a:p><a:r><a:t>${esc(line)}</a:t></a:r></a:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld ${P_NS} ${A_NS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody>${paragraphs}</p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:fld id="x" type="slidenum"><a:t>99</a:t></a:fld></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
}

export function notesXml(paragraphs: string | string[]): string {
  const lines = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
  const body = lines
    .map((line) => `<a:p><a:r><a:t>${esc(line)}</a:t></a:r></a:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:notes ${P_NS} ${A_NS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody>${body}</p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:fld id="y" type="slidenum"><a:t>99</a:t></a:fld></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`;
}

export function relsXml(
  rels: { id: string; type: string; target: string }[],
): string {
  const entries = rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships ${REL_NS}>${entries}</Relationships>`;
}

export interface SlideSpec {
  body: string[];
  /** Omit for a slide with no presenter notes. */
  notes?: string | string[];
}

/**
 * Assembles a well-formed .pptx from slide specs, in the given order.
 *
 * Notes are wired through each slide's own `_rels` file, and the notesSlide
 * filenames are intentionally allocated independently of slide numbers — that
 * mismatch is the real-world condition the parser has to survive.
 */
export function buildPptx(slides: SlideSpec[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const presentationRels: { id: string; type: string; target: string }[] = [];
  const sldIds: string[] = [];

  let notesCounter = 0;

  slides.forEach((spec, index) => {
    const slideNumber = index + 1;
    const relId = `rId${slideNumber}`;

    files[`ppt/slides/slide${slideNumber}.xml`] = strToU8(slideXml(spec.body));
    presentationRels.push({
      id: relId,
      type: SLIDE_TYPE,
      target: `slides/slide${slideNumber}.xml`,
    });
    sldIds.push(`<p:sldId id="${255 + slideNumber}" r:id="${relId}"/>`);

    const slideRels: { id: string; type: string; target: string }[] = [
      { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/l.xml" },
    ];

    if (spec.notes !== undefined) {
      notesCounter++;
      files[`ppt/notesSlides/notesSlide${notesCounter}.xml`] = strToU8(
        notesXml(spec.notes),
      );
      slideRels.push({
        id: "rId2",
        type: NOTES_TYPE,
        target: `../notesSlides/notesSlide${notesCounter}.xml`,
      });
    }

    files[`ppt/slides/_rels/slide${slideNumber}.xml.rels`] = strToU8(
      relsXml(slideRels),
    );
  });

  files["ppt/presentation.xml"] = strToU8(`<?xml version="1.0"?>
<p:presentation ${P_NS} ${R_NS}>
  <p:sldIdLst>${sldIds.join("")}</p:sldIdLst>
</p:presentation>`);
  files["ppt/_rels/presentation.xml.rels"] = strToU8(relsXml(presentationRels));

  return zipSync(files);
}
