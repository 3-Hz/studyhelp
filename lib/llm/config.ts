/**
 * Model capability declaration.
 *
 * The AI SDK gives a uniform call signature but does NOT expose what a model
 * can actually do — context size, native PDF reading, reliable schema output.
 * Those are declared here, because the app has to make real decisions from
 * them: whether to chunk a lecture, whether a PDF can be sent as a file, and
 * whether structured output can be trusted.
 *
 * Presets cover known hosted models. Anything behind an OpenAI-compatible URL
 * gets the conservative profile, since that endpoint could be a 3B model on a
 * laptop. Every field is overridable by env.
 */

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "openai-compatible";

export type Role = "extract" | "tutor";

/**
 * "native"   — the provider enforces a JSON schema server-side.
 * "prompted" — the schema goes in the prompt and we validate/repair ourselves.
 */
export type StructuredMode = "native" | "prompted";

export interface ModelProfile {
  role: Role;
  providerId: ProviderId;
  modelId: string;
  contextTokens: number;
  maxOutputTokens: number;
  /** Can accept a PDF as a file part and read it natively, diagrams included. */
  supportsFileParts: boolean;
  supportsImages: boolean;
  structuredOutput: StructuredMode;
}

interface Preset {
  match: RegExp;
  contextTokens: number;
  maxOutputTokens: number;
  supportsFileParts: boolean;
  supportsImages: boolean;
  structuredOutput: StructuredMode;
}

/** Ordered most-specific-first; the first match wins. */
const PRESETS: Record<ProviderId, Preset[]> = {
  anthropic: [
    {
      match: /^claude-(opus|sonnet)-(4|5)/,
      contextTokens: 1_000_000,
      maxOutputTokens: 16_000,
      supportsFileParts: true,
      supportsImages: true,
      structuredOutput: "native",
    },
    {
      match: /^claude-/,
      contextTokens: 200_000,
      maxOutputTokens: 8_000,
      supportsFileParts: true,
      supportsImages: true,
      structuredOutput: "native",
    },
  ],
  openai: [
    {
      match: /^gpt-/,
      contextTokens: 128_000,
      maxOutputTokens: 16_000,
      supportsFileParts: true,
      supportsImages: true,
      structuredOutput: "native",
    },
    {
      // o-series reasoning models: no image input on several of them.
      match: /^o\d/,
      contextTokens: 128_000,
      maxOutputTokens: 16_000,
      supportsFileParts: false,
      supportsImages: false,
      structuredOutput: "native",
    },
  ],
  google: [
    {
      match: /^gemini-/,
      contextTokens: 1_000_000,
      maxOutputTokens: 16_000,
      supportsFileParts: true,
      supportsImages: true,
      structuredOutput: "native",
    },
  ],
  "openai-compatible": [],
};

/**
 * What we assume when we know nothing: a small local model with no vision,
 * no document reading, and unreliable schema adherence. Deliberately
 * pessimistic — guessing high here produces silent truncation and bad drafts,
 * whereas guessing low only costs an unnecessary chunking pass.
 */
const CONSERVATIVE: Omit<Preset, "match"> = {
  contextTokens: 8_192,
  maxOutputTokens: 4_096,
  supportsFileParts: false,
  supportsImages: false,
  structuredOutput: "prompted",
};

/**
 * Capabilities for known OpenAI-compatible hosts, keyed by hostname.
 *
 * Keyed on the HOST rather than the model id on purpose. `llama-3.3-70b` on
 * Groq has a large context window; the same weights served from a laptop may
 * have 8k. The model id cannot tell those apart, but the host can — if the
 * base URL is api.groq.com, it is Groq.
 *
 * The context figures below are deliberately far lower than these models'
 * real windows. On a free tier the binding constraint is tokens-per-minute,
 * not the context window: Groq's free plan caps some models at 6K TPM, so a
 * request anywhere near the true 128k window is rejected as rate-limited
 * rather than served. Sizing to the TPM ceiling means we chunk instead of
 * failing. Raise these with LLM_*_CONTEXT_TOKENS on a paid plan.
 */
const HOST_PRESETS: { match: RegExp; preset: Omit<Preset, "match"> }[] = [
  {
    match: /(^|\.)groq\.com$/i,
    preset: {
      contextTokens: 12_000,
      maxOutputTokens: 4_096,
      supportsFileParts: false,
      supportsImages: false,
      structuredOutput: "native",
    },
  },
  {
    match: /(^|\.)cerebras\.ai$/i,
    preset: {
      contextTokens: 16_000,
      maxOutputTokens: 4_096,
      supportsFileParts: false,
      supportsImages: false,
      structuredOutput: "native",
    },
  },
  {
    // Any of ~hundreds of models can sit behind one OpenRouter key, so the
    // only safe assumption is the pessimistic one, with a little more context.
    match: /(^|\.)openrouter\.ai$/i,
    preset: {
      contextTokens: 16_000,
      maxOutputTokens: 4_096,
      supportsFileParts: false,
      supportsImages: false,
      structuredOutput: "prompted",
    },
  },
];

/** Localhost and friends: a local runtime, so keep the conservative profile. */
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i;

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function openAiCompatiblePreset(
  baseUrl: string | undefined,
): Omit<Preset, "match"> {
  const host = hostOf(baseUrl);
  if (!host || LOCAL_HOST.test(host)) return CONSERVATIVE;

  const known = HOST_PRESETS.find((entry) => entry.match.test(host));
  return known?.preset ?? CONSERVATIVE;
}

const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.4",
  google: "gemini-3-pro",
  "openai-compatible": "qwen3:8b",
};

function presetFor(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string | undefined,
): Omit<Preset, "match"> {
  if (providerId === "openai-compatible") {
    return openAiCompatiblePreset(baseUrl);
  }
  const found = PRESETS[providerId].find((p) => p.match.test(modelId));
  return found ?? CONSERVATIVE;
}

function envKey(role: Role, suffix: string): string {
  return `LLM_${role.toUpperCase()}_${suffix}`;
}

function readBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readProviderId(value: string | undefined): ProviderId | undefined {
  if (!value) return undefined;
  const normalised = value.trim().toLowerCase();
  // Friendly aliases: everything local speaks the OpenAI wire format.
  if (["ollama", "lmstudio", "lm-studio", "vllm", "llamacpp", "local"].includes(normalised)) {
    return "openai-compatible";
  }
  if (
    normalised === "anthropic" ||
    normalised === "openai" ||
    normalised === "google" ||
    normalised === "openai-compatible"
  ) {
    return normalised;
  }
  throw new Error(
    `Unknown LLM provider "${value}". Use anthropic, openai, google, or openai-compatible (aliases: ollama, lmstudio, vllm, llamacpp, local).`,
  );
}

export function profileFor(
  role: Role,
  env: Record<string, string | undefined> = process.env,
): ModelProfile {
  const providerId =
    readProviderId(env[envKey(role, "PROVIDER")]) ?? "anthropic";
  const modelId =
    env[envKey(role, "MODEL")]?.trim() || DEFAULT_MODEL[providerId];

  const preset = presetFor(
    providerId,
    modelId,
    env["OPENAI_COMPATIBLE_BASE_URL"],
  );

  return {
    role,
    providerId,
    modelId,
    contextTokens:
      readInt(env[envKey(role, "CONTEXT_TOKENS")]) ?? preset.contextTokens,
    maxOutputTokens:
      readInt(env[envKey(role, "MAX_OUTPUT_TOKENS")]) ?? preset.maxOutputTokens,
    supportsFileParts:
      readBool(env[envKey(role, "SUPPORTS_FILES")]) ?? preset.supportsFileParts,
    supportsImages:
      readBool(env[envKey(role, "SUPPORTS_IMAGES")]) ?? preset.supportsImages,
    structuredOutput:
      (env[envKey(role, "STRUCTURED")]?.trim() as StructuredMode | undefined) ??
      preset.structuredOutput,
  };
}

/** One-line summary for logs and the review screen. */
export function describeProfile(profile: ModelProfile): string {
  const bits = [
    `${profile.providerId}:${profile.modelId}`,
    `${Math.round(profile.contextTokens / 1000)}k ctx`,
    profile.supportsFileParts ? "native PDF" : "no PDF",
    profile.supportsImages ? "vision" : "no vision",
    `${profile.structuredOutput} schema`,
  ];
  return bits.join(" · ");
}
