import { expect, test } from "bun:test";
import { SOURCE_ROLES } from "@/lib/db/schema";
import { BOXES } from "./MaterialInputs";

test("the upload boxes are the source roles, in upload order", () => {
  // filesFromForm reads one field per role; the boxes must post exactly those.
  expect(BOXES.map((box) => box.role)).toEqual([...SOURCE_ROLES]);
});
