/**
 * Compares LLM providers on the same lecture, scored against a known answer key.
 *
 *   bun run eval                          # all configured profiles, fixture deck
 *   bun run eval --profiles groq,gemini   # a subset
 *   bun run eval --deck ./lecture.pptx    # a real deck (see the warning below)
 *
 * Deliberately does NOT touch the database. It calls extractLecture directly,
 * so running an eval never leaves lectures or objectives behind.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extractLecture, type ExtractSlide, type TranscriptSection } from "@/lib/extract";
import { scoreExtract, verbatimRate, type Score } from "@/lib/eval/score";
import {
  groundTruth,
  syntheticDeck,
  syntheticHandout,
  syntheticQuizDeck,
  syntheticTranscript,
} from "@/lib/fixtures/syntheticLecture";
import { parsePptx } from "@/lib/ingest/parsePptx";
import { chunkTranscript } from "@/lib/ingest/parseTranscript";
import { describeProfile, profileFor } from "@/lib/llm/config";
import { resolveModel } from "@/lib/llm/provider";
import type { EvalProfile } from "../eval.config.example";

interface Args {
  profiles?: string[];
  deck?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profiles") args.profiles = argv[++i]?.split(",");
    else if (argv[i] === "--deck") args.deck = argv[++i];
  }
  return args;
}

async function loadProfiles(): Promise<EvalProfile[]> {
  // Resolved at runtime so TypeScript doesn't try to typecheck a gitignored
  // file that only exists on a configured machine.
  const configUrl = new URL("../eval.config.ts", import.meta.url);

  if (!existsSync(configUrl)) {
    console.error(
      "No eval.config.ts found.\n" +
        "Copy eval.config.example.ts to eval.config.ts and edit it:\n\n" +
        "  cp eval.config.example.ts eval.config.ts\n",
    );
    process.exit(1);
  }

  const mod = (await import(configUrl.href)) as { profiles?: EvalProfile[] };
  if (!Array.isArray(mod.profiles) || mod.profiles.length === 0) {
    console.error("eval.config.ts exports no profiles.");
    process.exit(1);
  }
  return mod.profiles;
}

interface Outcome {
  name: string;
  profile: string;
  ok: boolean;
  score?: Score;
  chunked?: boolean;
  chunkCount?: number;
  repairs?: number;
  mode?: string;
  ms?: number;
  error?: string;
  rateLimited?: boolean;
}

/**
 * Free tiers have tight per-minute limits, and a multi-provider run can trip
 * them mid-sweep. That is a different problem from a model doing badly, so it
 * gets reported distinctly rather than as a generic failure.
 */
function isRateLimit(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /rate.?limit|429|quota|too many requests|resource.?exhausted/i.test(
    text,
  );
}

async function run(
  entry: EvalProfile,
  slides: ExtractSlide[],
  transcriptChunks: TranscriptSection[],
): Promise<Outcome> {
  const env = { ...process.env, ...entry.env } as Record<
    string,
    string | undefined
  >;
  const profile = profileFor("extract", env);
  const started = performance.now();

  try {
    // resolveModel reads credentials from process.env, so apply the profile's
    // env for the duration of the call.
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(entry.env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    let result;
    try {
      const model = resolveModel(profile);
      result = await extractLecture(
        { slides, transcriptChunks, documentParts: [] },
        profile,
        model,
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    return {
      name: entry.name,
      profile: describeProfile(profile),
      ok: true,
      score: scoreExtract(result.extract, groundTruth),
      chunked: result.meta.chunked,
      chunkCount: result.meta.chunkCount,
      repairs: result.meta.repairs,
      mode: result.meta.mode,
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      name: entry.name,
      profile: describeProfile(profile),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rateLimited: isRateLimit(error),
      ms: Math.round(performance.now() - started),
    };
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The lecturer's cues honoured, over those planted. */
function cuesHonoured(s: Score): string {
  const planted = groundTruth.emphasized.length + groundTruth.deemphasized.length;
  return `${planted - s.emphasisMissed.length - s.deemphasisMissed.length}/${planted}`;
}

/** Quiz questions found and filed under the concept they test, over those planted. */
function quizHonoured(s: Score): string {
  const planted = groundTruth.quizTested.length;
  return `${planted - s.quizConceptsMissed.length}/${planted}`;
}

/** Handout concepts read as course material, over those planted. */
function additionalHonoured(s: Score): string {
  const planted = groundTruth.additionalOnlyConcepts.length;
  return `${planted - s.additionalMissed.length}/${planted}`;
}

function report(outcomes: Outcome[]): void {
  const total = groundTruth.objectives.length;

  console.log(
    `\n${pad("PROFILE", 12)} ${pad("VERBATIM", 10)} ${pad("PARA", 6)} ${pad("MISS", 6)} ${pad("HALLUC", 8)} ${pad("PROV", 6)} ${pad("EMPH", 6)} ${pad("QUIZ", 6)} ${pad("ADDL", 6)} ${pad("PATH", 20)} TIME`,
  );
  console.log("─".repeat(113));

  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.score) {
      const label = outcome.rateLimited ? "RATE LIMITED" : "ERROR";
      console.log(`${pad(outcome.name, 12)} ${label}`);
      continue;
    }

    const s = outcome.score;
    const path = outcome.chunked
      ? `${outcome.chunkCount} chunks/${outcome.mode}`
      : outcome.mode ?? "";

    console.log(
      `${pad(outcome.name, 12)} ` +
        `${pad(`${s.exact.length}/${total} (${Math.round(verbatimRate(s, groundTruth) * 100)}%)`, 10)} ` +
        `${pad(String(s.paraphrased.length), 6)} ` +
        `${pad(String(s.missed.length), 6)} ` +
        `${pad(String(s.hallucinated.length), 8)} ` +
        `${pad(String(s.provenanceErrors.length), 6)} ` +
        `${pad(cuesHonoured(s), 6)} ` +
        `${pad(quizHonoured(s), 6)} ` +
        `${pad(additionalHonoured(s), 6)} ` +
        `${pad(path, 20)} ` +
        `${((outcome.ms ?? 0) / 1000).toFixed(1)}s`,
    );
  }

  for (const outcome of outcomes) {
    console.log(`\n── ${outcome.name} ${"─".repeat(Math.max(0, 60 - outcome.name.length))}`);
    console.log(`   ${outcome.profile}`);

    if (!outcome.ok) {
      console.log(
        `   ${outcome.rateLimited ? "Rate limited" : "Failed"}: ${outcome.error}`,
      );
      continue;
    }

    const s = outcome.score!;
    if (s.paraphrased.length > 0) {
      console.log("   Paraphrased (verbatim wording lost):");
      for (const p of s.paraphrased) {
        console.log(`     expected: ${p.expected}`);
        console.log(`     got:      ${p.got}`);
      }
    }
    if (s.missed.length > 0) {
      console.log("   Missed:");
      for (const m of s.missed) console.log(`     ${m}`);
    }
    if (s.hallucinated.length > 0) {
      console.log("   Not in the deck:");
      for (const h of s.hallucinated) console.log(`     ${h}`);
    }
    if (s.provenanceErrors.length > 0) {
      console.log("   Supplemental content labelled as taught:");
      for (const p of s.provenanceErrors) console.log(`     ${p}`);
    }
    const cuesMissed = [...s.emphasisMissed, ...s.deemphasisMissed];
    if (cuesMissed.length > 0) {
      console.log("   Lecturer's cues not honoured:");
      for (const c of cuesMissed) console.log(`     ${c}`);
    }
    if (s.quizConceptsMissed.length > 0) {
      console.log("   Quiz questions not filed under the concept they test:");
      for (const q of s.quizConceptsMissed) console.log(`     ${q}`);
    }
    if (s.additionalMissed.length > 0) {
      console.log("   Handout concepts not read as course material:");
      for (const a of s.additionalMissed) console.log(`     ${a}`);
    }
    console.log(
      `   Concepts: ${s.conceptCount} · notes-only facts found: ` +
        `${s.notesFactsFound.length}/${groundTruth.notesOnlyFacts.length} · practice questions found: ` +
        `${s.practiceQuestionsFound.length}/${groundTruth.practiceQuestions.length} · repairs: ${outcome.repairs}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configured = await loadProfiles();

  const selected = args.profiles
    ? configured.filter((p) => args.profiles!.includes(p.name))
    : configured;

  if (selected.length === 0) {
    console.error("No matching profiles. Configured: " + configured.map((p) => p.name).join(", "));
    process.exit(1);
  }

  let slides: ExtractSlide[];
  let transcriptChunks: TranscriptSection[] = [];
  if (args.deck) {
    console.log(
      `\n⚠  Using a real deck (${args.deck}).\n` +
        `   Free tiers commonly train on submitted content. Point this only at\n` +
        `   local or paid providers, never at a free tier.\n`,
    );
    slides = parsePptx(await readFile(args.deck));
  } else {
    // Labelled and headed as the app would label an upload in each box.
    const lecture = parsePptx(syntheticDeck()).map((slide) => ({
      ...slide,
      sourceLabel: "lecture.pptx",
      role: "deck" as const,
    }));
    const quiz = parsePptx(syntheticQuizDeck()).map((slide) => ({
      ...slide,
      ordinal: lecture.length + slide.ordinal,
      sourceLabel: "practice-quiz.pptx",
      role: "quiz" as const,
    }));
    slides = [...lecture, ...quiz];
    transcriptChunks = [
      ...chunkTranscript(syntheticTranscript()).map((chunk) => ({
        text: chunk.text,
        sourceLabel: "lecture.vtt",
        role: "transcript" as const,
      })),
      ...chunkTranscript(syntheticHandout()).map((chunk) => ({
        text: chunk.text,
        sourceLabel: "handout.txt",
        role: "additional" as const,
      })),
    ];
    console.log(
      `\nFixture: synthetic lecture, ${lecture.length} slides plus a transcript, ` +
        `a ${quiz.length}-slide practice quiz and a handout, ` +
        `${groundTruth.objectives.length} known objectives.`,
    );
  }

  const outcomes: Outcome[] = [];
  for (const entry of selected) {
    process.stdout.write(`Running ${entry.name}… `);
    const outcome = await run(entry, slides, transcriptChunks);
    console.log(outcome.ok ? "done" : outcome.rateLimited ? "rate limited" : "failed");
    outcomes.push(outcome);
  }

  report(outcomes);

  // Non-zero exit so this can gate a change to the extraction prompt.
  if (outcomes.some((o) => !o.ok)) process.exit(1);
}

await main();
