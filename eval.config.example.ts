/**
 * Copy to `eval.config.ts` (gitignored) and edit.
 *
 * Each profile is a name plus the environment it implies. `bun run eval` builds
 * a ModelProfile from each and runs the same lecture through all of them.
 *
 * Keys are read from this object first, falling back to process.env — so put
 * secrets in .env.local and keep only the provider/model wiring here.
 */
export interface EvalProfile {
  name: string;
  env: Record<string, string>;
}

export const profiles: EvalProfile[] = [
  {
    name: "local",
    env: {
      LLM_EXTRACT_PROVIDER: "ollama",
      LLM_EXTRACT_MODEL: "qwen3:8b",
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
    },
  },
  {
    name: "groq",
    env: {
      LLM_EXTRACT_PROVIDER: "openai-compatible",
      LLM_EXTRACT_MODEL: "llama-3.3-70b-versatile",
      OPENAI_COMPATIBLE_BASE_URL: "https://api.groq.com/openai/v1",
      // OPENAI_COMPATIBLE_API_KEY comes from .env.local
    },
  },
  {
    name: "gemini",
    env: {
      LLM_EXTRACT_PROVIDER: "google",
      LLM_EXTRACT_MODEL: "gemini-2.5-flash",
      // GOOGLE_GENERATIVE_AI_API_KEY comes from .env.local
    },
  },
];
