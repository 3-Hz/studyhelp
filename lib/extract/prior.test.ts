import { expect, test } from "bun:test";
import { formatPrior } from "./prior";

test("renders each objective verbatim with its concept labels in order", () => {
  const text = formatPrior([
    {
      text: "Describe the structure of amyloid fibrils.",
      concepts: ["Beta-pleated sheet", "Fibril diameter"],
    },
    { text: "Compare AL and ATTR amyloidosis.", concepts: [] },
  ]);

  expect(text).toBe(
    [
      "# Already extracted",
      "",
      "Objective 1: Describe the structure of amyloid fibrils.",
      "- Beta-pleated sheet",
      "- Fibril diameter",
      "",
      "Objective 2: Compare AL and ATTR amyloidosis.",
      "(no concepts recorded)",
    ].join("\n"),
  );
});

test("a lecture with nothing extracted has no block", () => {
  expect(formatPrior([])).toBe("");
});
