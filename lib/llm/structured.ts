import {
  generateText,
  Output,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import * as z from "zod";
import type { ModelProfile } from "./config";
import { resolveModel } from "./provider";

/**
 * Schema-validated generation that works on models with no schema support.
 *
 * The ladder exists because "native structured output" is not a reliable
 * signal. Ollama's OpenAI-compatible endpoint accepts `response_format:
 * json_schema` and then ignores it on some models, returning prose with a
 * 200 — so a native attempt can appear to succeed and still hand back garbage.
 * Rather than trusting the declared capability, we validate every result and
 * fall back:
 *
 *   1. native   — provider enforces the schema
 *   2. prompted — schema in the prompt, we parse and validate
 *   3. repair   — feed the validation errors back, bounded retries
 */

const MAX_REPAIRS = 2;

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly rawText: string | undefined,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface StructuredRequest<T> {
  profile: ModelProfile;
  schema: z.ZodType<T>;
  system: string;
  messages: ModelMessage[];
  /** Names the object for providers that surface it as a tool/schema name. */
  schemaName?: string;
  /**
   * Pre-resolved model. Callers making several calls against one profile
   * (chunked extraction) should resolve once and pass it in; tests inject a
   * mock here. Defaults to resolving from the profile.
   */
  model?: LanguageModel;
}

export async function generateStructured<T>({
  profile,
  schema,
  system,
  messages,
  schemaName = "result",
  model: providedModel,
}: StructuredRequest<T>): Promise<{ value: T; repairs: number; mode: string }> {
  const model = providedModel ?? resolveModel(profile);

  if (profile.structuredOutput === "native") {
    try {
      const result = await generateText({
        model,
        system,
        messages,
        maxOutputTokens: profile.maxOutputTokens,
        output: Output.object({ schema, name: schemaName }),
      });

      // Validate regardless of the provider's claim — see the note above.
      const parsed = schema.safeParse(result.output);
      if (parsed.success) {
        return { value: parsed.data, repairs: 0, mode: "native" };
      }
    } catch {
      // Provider rejected the schema, or returned something unparseable.
      // Fall through to the prompted path rather than failing the ingest.
    }
  }

  return promptedWithRepair({
    profile,
    schema,
    system,
    messages,
    schemaName,
    model,
  });
}

async function promptedWithRepair<T>({
  profile,
  schema,
  system,
  messages,
  schemaName,
  model,
}: Omit<StructuredRequest<T>, "schemaName" | "model"> & {
  schemaName: string;
  model: LanguageModel;
}): Promise<{
  value: T;
  repairs: number;
  mode: string;
}> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);

  const schemaInstruction = [
    system,
    "",
    `Respond with a single JSON object named "${schemaName}" conforming to this JSON Schema:`,
    "",
    jsonSchema,
    "",
    "Output ONLY the JSON object. No markdown fences, no commentary before or after.",
  ].join("\n");

  let conversation = [...messages];
  let lastText: string | undefined;
  let lastIssues: string[] = [];

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const result = await generateText({
      model,
      system: schemaInstruction,
      messages: conversation,
      maxOutputTokens: profile.maxOutputTokens,
    });

    lastText = result.text;
    const candidate = extractJsonObject(result.text);

    if (candidate !== undefined) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) {
        return {
          value: parsed.data,
          repairs: attempt,
          mode: attempt === 0 ? "prompted" : "repaired",
        };
      }
      lastIssues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
    } else {
      lastIssues = ["Response contained no parseable JSON object."];
    }

    if (attempt === MAX_REPAIRS) break;

    conversation = [
      ...conversation,
      { role: "assistant", content: result.text },
      {
        role: "user",
        content: [
          "That response did not satisfy the schema:",
          ...lastIssues.map((issue) => `- ${issue}`),
          "",
          "Return the corrected JSON object only.",
        ].join("\n"),
      },
    ];
  }

  throw new StructuredOutputError(
    `Model did not produce schema-valid JSON after ${MAX_REPAIRS} repair attempts.`,
    lastText,
    lastIssues,
  );
}

/**
 * Pulls the first balanced JSON object out of a response, tolerating markdown
 * fences and leading prose — both of which small models emit constantly even
 * when told not to.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}
