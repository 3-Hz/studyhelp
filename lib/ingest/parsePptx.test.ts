import { expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import {
  LAYOUT_TYPE,
  NOTES_TYPE,
  P_NS,
  R_NS,
  SLIDE_TYPE,
  notesXml,
  relsXml,
  slideXml,
} from "@/lib/fixtures/pptxBuilder";
import { parsePptx } from "./parsePptx";

/**
 * A deck built to break naive parsers:
 *   - presentation order is slide3, slide1, slide2 (filename order is a lie)
 *   - slide1 owns notesSlide2, slide3 owns notesSlide1 (numbering is a lie)
 *   - slide2 has no notes at all (the case that shifts every later mapping)
 */
function buildDeck(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(`<?xml version="1.0"?>
<p:presentation ${P_NS} ${R_NS}>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId3"/>
    <p:sldId id="257" r:id="rId1"/>
    <p:sldId id="258" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(
      relsXml([
        { id: "rId1", type: SLIDE_TYPE, target: "slides/slide1.xml" },
        { id: "rId2", type: SLIDE_TYPE, target: "slides/slide2.xml" },
        { id: "rId3", type: SLIDE_TYPE, target: "slides/slide3.xml" },
      ]),
    ),

    "ppt/slides/slide1.xml": strToU8(slideXml(["Body of slide ONE"])),
    "ppt/slides/slide2.xml": strToU8(slideXml(["Body of slide TWO"])),
    "ppt/slides/slide3.xml": strToU8(
      slideXml(["Body of slide THREE", "second paragraph"]),
    ),

    "ppt/slides/_rels/slide1.xml.rels": strToU8(
      relsXml([
        { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/l.xml" },
        { id: "rId2", type: NOTES_TYPE, target: "../notesSlides/notesSlide2.xml" },
      ]),
    ),
    // No notes relationship at all.
    "ppt/slides/_rels/slide2.xml.rels": strToU8(
      relsXml([
        { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/l.xml" },
      ]),
    ),
    "ppt/slides/_rels/slide3.xml.rels": strToU8(
      relsXml([
        { id: "rId1", type: LAYOUT_TYPE, target: "../slideLayouts/l.xml" },
        { id: "rId2", type: NOTES_TYPE, target: "../notesSlides/notesSlide1.xml" },
      ]),
    ),

    "ppt/notesSlides/notesSlide1.xml": strToU8(
      notesXml("Notes belonging to slide THREE"),
    ),
    "ppt/notesSlides/notesSlide2.xml": strToU8(
      notesXml("Notes belonging to slide ONE"),
    ),
  };
  return zipSync(files);
}

test("orders slides by presentation.xml, not by filename", () => {
  const slides = parsePptx(buildDeck());
  expect(slides.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  expect(slides[0].slideText).toContain("slide THREE");
  expect(slides[1].slideText).toContain("slide ONE");
  expect(slides[2].slideText).toContain("slide TWO");
});

test("maps presenter notes through slide rels, not filename numbering", () => {
  const slides = parsePptx(buildDeck());
  // notesSlide1 belongs to slide3, which presents first.
  expect(slides[0].notesText).toBe("Notes belonging to slide THREE");
  expect(slides[1].notesText).toBe("Notes belonging to slide ONE");
});

test("a slide with no notes yields empty notes and does not shift its neighbours", () => {
  const slides = parsePptx(buildDeck());
  expect(slides[2].slideText).toContain("slide TWO");
  expect(slides[2].notesText).toBe("");
});

test("excludes slide-number placeholder text", () => {
  const slides = parsePptx(buildDeck());
  for (const slide of slides) {
    expect(slide.slideText).not.toContain("99");
    expect(slide.notesText).not.toContain("99");
  }
});

test("keeps multiple paragraphs on separate lines", () => {
  const slides = parsePptx(buildDeck());
  expect(slides[0].slideText).toBe("Body of slide THREE\nsecond paragraph");
});

test("falls back to filename order when the relationship graph is unusable", () => {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0"?><p:presentation ${P_NS} ${R_NS}></p:presentation>`,
    ),
    "ppt/slides/slide1.xml": strToU8(slideXml(["First"])),
    "ppt/slides/slide2.xml": strToU8(slideXml(["Second"])),
  };
  const slides = parsePptx(zipSync(files));
  expect(slides.map((s) => s.slideText)).toEqual(["First", "Second"]);
});

test("rejects a zip that is not a presentation", () => {
  const notADeck = zipSync({ "hello.txt": strToU8("hi") });
  expect(() => parsePptx(notADeck)).toThrow(/not a valid \.pptx/i);
});
