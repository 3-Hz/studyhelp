import { expect, test } from "bun:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import * as z from "zod";
import type { ModelProfile } from "./config";
import {
  extractJsonObject,
  generateStructured,
  StructuredOutputError,
} from "./structured";

const Person = z.object({ name: z.string(), age: z.number() });

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    role: "extract",
    providerId: "openai-compatible",
    modelId: "mock",
    contextTokens: 8_192,
    maxOutputTokens: 1_024,
    supportsFileParts: false,
    supportsImages: false,
    structuredOutput: "prompted",
    ...overrides,
  };
}

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    warnings: [],
  };
}

function generate(model: MockLanguageModelV4, p: ModelProfile) {
  return generateStructured({
    profile: p,
    model,
    schema: Person,
    system: "Extract a person.",
    messages: [{ role: "user", content: "Ada Lovelace, 36" }],
  });
}

test("accepts clean JSON on the prompted path", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => textResult('{"name":"Ada Lovelace","age":36}'),
  });

  const result = await generate(model, profile());
  expect(result.value).toEqual({ name: "Ada Lovelace", age: 36 });
  expect(result.repairs).toBe(0);
  expect(result.mode).toBe("prompted");
});

test("repairs malformed output by feeding validation errors back", async () => {
  // First response is the classic small-model failure: prose plus a wrong type.
  const model = new MockLanguageModelV4({
    doGenerate: [
      textResult('Sure! Here you go:\n```json\n{"name":"Ada","age":"thirty-six"}\n```'),
      textResult('{"name":"Ada","age":36}'),
    ],
  });

  const result = await generate(model, profile());
  expect(result.value).toEqual({ name: "Ada", age: 36 });
  expect(result.repairs).toBe(1);
  expect(result.mode).toBe("repaired");
});

test("gives up after the repair budget and reports why", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => textResult("I am afraid I cannot do that."),
  });

  let caught: unknown;
  try {
    await generate(model, profile());
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(StructuredOutputError);
  const error = caught as StructuredOutputError;
  // The raw text is attached so a failed ingest is debuggable.
  expect(error.rawText).toContain("cannot do that");
  expect(error.issues.length).toBeGreaterThan(0);
});

test("a native profile that returns junk still falls through to prompted", async () => {
  // This is the Ollama case: `response_format: json_schema` is accepted and
  // then ignored, so a declared-native model hands back prose with a 200.
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      call++;
      return call === 1
        ? textResult("Certainly! Ada is 36 years old.")
        : textResult('{"name":"Ada","age":36}');
    },
  });

  const result = await generate(model, profile({ structuredOutput: "native" }));
  expect(result.value).toEqual({ name: "Ada", age: 36 });
  expect(call).toBeGreaterThan(1);
});

test("extractJsonObject handles fences, prose and nesting", () => {
  expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(extractJsonObject('Here: {"a":{"b":[1,2]}} — done')).toEqual({
    a: { b: [1, 2] },
  });
  expect(extractJsonObject("no json here")).toBeUndefined();
});

test("extractJsonObject is not fooled by braces inside strings", () => {
  expect(extractJsonObject('{"note":"a } brace","ok":true}')).toEqual({
    note: "a } brace",
    ok: true,
  });
  expect(extractJsonObject('{"note":"escaped \\" quote }","ok":1}')).toEqual({
    note: 'escaped " quote }',
    ok: 1,
  });
});
