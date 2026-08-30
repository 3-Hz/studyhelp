import { expect, test } from "bun:test";
import { describeProfile, profileFor } from "./config";

test("defaults to Anthropic when nothing is configured", () => {
  const profile = profileFor("extract", {});
  expect(profile.providerId).toBe("anthropic");
  expect(profile.structuredOutput).toBe("native");
  expect(profile.supportsFileParts).toBe(true);
});

test("a known hosted model gets its preset capabilities", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "google",
    LLM_EXTRACT_MODEL: "gemini-3-pro",
  });
  expect(profile.contextTokens).toBe(1_000_000);
  expect(profile.supportsFileParts).toBe(true);
  expect(profile.structuredOutput).toBe("native");
});

test("an unknown openai-compatible model gets the conservative profile", () => {
  // We know nothing about what is behind a local URL, so assume the worst:
  // guessing high causes silent truncation, guessing low only costs a chunk pass.
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    LLM_EXTRACT_MODEL: "some-random-7b",
  });
  expect(profile.contextTokens).toBe(8_192);
  expect(profile.supportsFileParts).toBe(false);
  expect(profile.supportsImages).toBe(false);
  expect(profile.structuredOutput).toBe("prompted");
});

test("local runner aliases map to openai-compatible", () => {
  for (const alias of ["ollama", "lmstudio", "vllm", "llamacpp", "local"]) {
    expect(profileFor("extract", { LLM_EXTRACT_PROVIDER: alias }).providerId).toBe(
      "openai-compatible",
    );
  }
});

test("env overrides beat presets", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    LLM_EXTRACT_MODEL: "qwen3:32b",
    LLM_EXTRACT_CONTEXT_TOKENS: "131072",
    LLM_EXTRACT_SUPPORTS_IMAGES: "true",
    LLM_EXTRACT_STRUCTURED: "native",
  });
  expect(profile.contextTokens).toBe(131_072);
  expect(profile.supportsImages).toBe(true);
  expect(profile.structuredOutput).toBe("native");
  // Untouched fields still come from the conservative preset.
  expect(profile.supportsFileParts).toBe(false);
});

test("roles are configured independently", () => {
  const env = {
    LLM_EXTRACT_PROVIDER: "google",
    LLM_EXTRACT_MODEL: "gemini-3-pro",
    LLM_TUTOR_PROVIDER: "ollama",
    LLM_TUTOR_MODEL: "qwen3:8b",
  };
  expect(profileFor("extract", env).providerId).toBe("google");
  expect(profileFor("tutor", env).providerId).toBe("openai-compatible");
  expect(profileFor("tutor", env).modelId).toBe("qwen3:8b");
});

test("a known host sets capabilities even for an unrecognised model id", () => {
  // The host is the trustworthy signal: api.groq.com IS Groq, whatever the
  // model is called.
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    LLM_EXTRACT_MODEL: "some-new-model-nobody-has-heard-of",
    OPENAI_COMPATIBLE_BASE_URL: "https://api.groq.com/openai/v1",
  });
  expect(profile.contextTokens).toBe(12_000);
  expect(profile.structuredOutput).toBe("native");
  expect(profile.supportsFileParts).toBe(false);
});

test("the same model id stays conservative when served locally", () => {
  // This is the case model-id matching would get wrong: identical weights,
  // wildly different context depending on who is serving them.
  const groq = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    LLM_EXTRACT_MODEL: "llama-3.3-70b-versatile",
    OPENAI_COMPATIBLE_BASE_URL: "https://api.groq.com/openai/v1",
  });
  const local = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    LLM_EXTRACT_MODEL: "llama-3.3-70b-versatile",
    OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
  });

  expect(groq.contextTokens).toBe(12_000);
  expect(local.contextTokens).toBe(8_192);
  expect(local.structuredOutput).toBe("prompted");
});

test("localhost variants all resolve to the conservative profile", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://0.0.0.0:8000/v1",
  ]) {
    const profile = profileFor("extract", {
      LLM_EXTRACT_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL: url,
    });
    expect(profile.contextTokens).toBe(8_192);
    expect(profile.structuredOutput).toBe("prompted");
  }
});

test("an unknown host gets the conservative profile", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "https://some-vendor.example.com/v1",
  });
  expect(profile.contextTokens).toBe(8_192);
  expect(profile.supportsImages).toBe(false);
});

test("a malformed base URL does not throw and stays conservative", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "not a url",
  });
  expect(profile.contextTokens).toBe(8_192);
});

test("env overrides still beat a host preset", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "https://api.groq.com/openai/v1",
    LLM_EXTRACT_CONTEXT_TOKENS: "128000",
  });
  expect(profile.contextTokens).toBe(128_000);
  // Unset fields still come from the host preset.
  expect(profile.structuredOutput).toBe("native");
});

test("openrouter is treated cautiously because any model can sit behind it", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "https://openrouter.ai/api/v1",
  });
  expect(profile.structuredOutput).toBe("prompted");
});

test("an unknown provider name fails loudly", () => {
  expect(() => profileFor("extract", { LLM_EXTRACT_PROVIDER: "hal9000" })).toThrow(
    /Unknown LLM provider/,
  );
});

test("invalid numeric overrides fall back to the preset", () => {
  const profile = profileFor("extract", {
    LLM_EXTRACT_PROVIDER: "openai-compatible",
    LLM_EXTRACT_CONTEXT_TOKENS: "not-a-number",
  });
  expect(profile.contextTokens).toBe(8_192);
});

test("describeProfile summarises the capabilities that matter", () => {
  const summary = describeProfile(
    profileFor("extract", {
      LLM_EXTRACT_PROVIDER: "openai-compatible",
      LLM_EXTRACT_MODEL: "qwen3:8b",
    }),
  );
  expect(summary).toContain("openai-compatible:qwen3:8b");
  expect(summary).toContain("no PDF");
  expect(summary).toContain("no vision");
  expect(summary).toContain("prompted schema");
});
