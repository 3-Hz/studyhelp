import { expect, test } from "bun:test";
import { filesFromForm } from "./formFiles";

function file(name: string, text: string): File {
  return new File([text], name, { type: "text/plain" });
}

test("each box's files carry the role of that box, deck first", async () => {
  const form = new FormData();
  form.append("additional", file("handout.pdf", "handout"));
  form.append("quiz", file("quiz.pdf", "quiz"));
  form.append("transcript", file("talk.vtt", "talk"));
  form.append("deck", file("lecture.pptx", "deck"));
  form.append("additional", file("figure.png", "figure"));

  const files = await filesFromForm(form);

  // Box order, not form order: the deck leads, so it takes upload index 1
  // and lends the lecture its fallback title.
  expect(files.map((f) => [f.filename, f.role])).toEqual([
    ["lecture.pptx", "deck"],
    ["talk.vtt", "transcript"],
    ["quiz.pdf", "quiz"],
    ["handout.pdf", "additional"],
    ["figure.png", "additional"],
  ]);
  expect(new TextDecoder().decode(files[0].bytes)).toBe("deck");
});

test("a form with nothing in any box yields no files", async () => {
  const form = new FormData();
  form.set("title", "Amyloidosis");
  expect(await filesFromForm(form)).toEqual([]);
});
