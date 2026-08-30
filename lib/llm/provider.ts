import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelProfile } from "./config";

/**
 * Resolves a capability profile into an AI SDK model.
 *
 * `openai-compatible` is the catch-all for local runtimes — Ollama, LM Studio,
 * vLLM, llama.cpp — and for hosted aggregators like OpenRouter and Groq. One
 * official package rather than a per-runner community provider.
 */
export function resolveModel(profile: ModelProfile): LanguageModel {
  switch (profile.providerId) {
    case "anthropic": {
      requireKey("ANTHROPIC_API_KEY", profile.providerId);
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
        profile.modelId,
      );
    }

    case "openai": {
      requireKey("OPENAI_API_KEY", profile.providerId);
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(
        profile.modelId,
      );
    }

    case "google": {
      requireKey("GOOGLE_GENERATIVE_AI_API_KEY", profile.providerId);
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      })(profile.modelId);
    }

    case "openai-compatible": {
      const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
      if (!baseURL) {
        throw new Error(
          "OPENAI_COMPATIBLE_BASE_URL is not set. For Ollama use http://localhost:11434/v1, " +
            "for LM Studio http://localhost:1234/v1.",
        );
      }
      return createOpenAICompatible({
        name: "local",
        baseURL,
        // Local servers ignore this, but the header must exist for some proxies.
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "not-needed",
      })(profile.modelId);
    }
  }
}

function requireKey(name: string, providerId: string): void {
  if (!process.env[name]) {
    throw new Error(
      `${name} is not set, but LLM provider is "${providerId}". Add it to .env.local.`,
    );
  }
}

/**
 * Provider-specific options. Anthropic prompt caching lives here rather than in
 * the call sites, so it stays an optimisation for one provider instead of an
 * assumption baked into the app. Other providers ignore the key entirely.
 */
export function providerOptionsFor(
  profile: ModelProfile,
): Record<string, Record<string, unknown>> | undefined {
  if (profile.providerId === "anthropic") {
    return { anthropic: { cacheControl: { type: "ephemeral" } } };
  }
  return undefined;
}
