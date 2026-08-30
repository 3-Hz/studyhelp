import { expect, test } from "bun:test";
import { chunkTranscript, cleanTranscript } from "./parseTranscript";

test("strips WebVTT headers, timestamps and speaker tags", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Dr. Smith>Amyloid deposits stain with Congo red.</v>

00:00:04.000 --> 00:00:08.000
They show apple-green birefringence under polarized light.`;

  expect(cleanTranscript(vtt)).toBe(
    "Amyloid deposits stain with Congo red.\n" +
      "They show apple-green birefringence under polarized light.",
  );
});

test("strips SubRip indices and comma-style timestamps", () => {
  const srt = `1
00:00:01,000 --> 00:00:04,000
Transthyretin is the transport protein.

2
00:00:04,000 --> 00:00:07,500
Mutations destabilise the tetramer.`;

  expect(cleanTranscript(srt)).toBe(
    "Transthyretin is the transport protein.\nMutations destabilise the tetramer.",
  );
});

test("collapses rolling caption duplicates", () => {
  const rolling = `WEBVTT

00:00:01.000 --> 00:00:03.000
the light chain is deposited

00:00:03.000 --> 00:00:05.000
the light chain is deposited

00:00:05.000 --> 00:00:07.000
in the kidney and the heart`;

  expect(cleanTranscript(rolling)).toBe(
    "the light chain is deposited\nin the kidney and the heart",
  );
});

test("leaves plain text prose untouched", () => {
  const plain = "AL amyloidosis arises from a plasma cell dyscrasia.";
  expect(cleanTranscript(plain)).toBe(plain);
});

test("does not mistake a numeric content line for an SRT index", () => {
  // A bare number on its own line is ambiguous; inside a cue it is content.
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Normal serum free light chain ratio is 0.26 to 1.65`;
  expect(cleanTranscript(vtt)).toContain("0.26 to 1.65");
});

test("chunks long transcripts by line count", () => {
  const lines = Array.from({ length: 95 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = chunkTranscript(lines, 40);
  expect(chunks).toHaveLength(3);
  expect(chunks[0].ordinal).toBe(1);
  expect(chunks[0].text.split("\n")).toHaveLength(40);
  expect(chunks[2].text.split("\n")).toHaveLength(15);
});

test("returns no chunks for an empty transcript", () => {
  expect(chunkTranscript("   \n\n  ")).toEqual([]);
});
