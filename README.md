# studyhelp

A local study coach for medical school, built around *Make It Stick* principles:
same-day lecture review, daily retrieval practice, and a longitudinal Learning
Objective dashboard.

`prompt.txt` is the original system prompt this is built from. The app splits its
responsibilities deliberately:

- **Code owns the bookkeeping** — the dashboard, the color history, the
  spaced-repetition scheduler, and which items are due. Deterministic and
  inspectable.
- **Claude owns the pedagogy** — reading lectures, extracting objectives,
  generating varied questions, grading recall, and giving corrective feedback.

## Requirements

- [Bun](https://bun.sh) 1.3+ (this project is Bun-only; there is no Node.js
  dependency)
- An LLM: a hosted key (Anthropic, OpenAI, Google) **or** a local runner such as
  Ollama or LM Studio

## Setup

```bash
bun install
cp .env.local.example .env.local   # then pick a provider and add its key
bun run db:migrate
bun --bun run dev
```

Open http://localhost:3000.

> **Use `bun --bun run dev`, not `bun run dev`.** The `next` binary has a
> `#!/usr/bin/env node` shebang; without `--bun` it looks for a Node install that
> isn't here.

## Scripts

| Command | What it does |
|---|---|
| `bun --bun run dev` | Dev server |
| `bun --bun run build` | Production build |
| `bun test` | Unit and integration tests |
| `bun run eval` | Score LLM providers against the synthetic fixture |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:generate` | Generate a migration from `lib/db/schema.ts` |
| `bun run db:migrate` | Apply migrations to the SQLite file |

Two toolchain notes, both a consequence of running without Node:

- `db:generate` invokes `drizzle-kit`'s entry file directly with Bun, because its
  bin shebang points at Node.
- `db:migrate` runs `scripts/migrate.ts` rather than `drizzle-kit migrate`, whose
  CLI can only connect through `better-sqlite3` or `@libsql/client`. The
  drizzle-orm Bun migrator avoids adding a native module.

## Choosing a model

Two roles are configured independently, so ingest and tutoring can run on
different models:

| Role | Used for | Wants |
|---|---|---|
| `EXTRACT` | Reading lectures | Long context, native PDF and vision |
| `TUTOR` | Quiz and grading loop (Phases 2–3) | Cheap and fast; short calls |

Set `LLM_EXTRACT_PROVIDER` to `anthropic`, `openai`, `google`, or
`openai-compatible` (aliases: `ollama`, `lmstudio`, `vllm`, `llamacpp`,
`local`). Everything local speaks the OpenAI wire format, so one
`OPENAI_COMPATIBLE_BASE_URL` covers Ollama, LM Studio, vLLM, llama.cpp, and
hosted aggregators like OpenRouter.

### What degrades on a local model

The app declares each model's capabilities and adapts rather than assuming. On
a small local model you still get a usable draft, but three things change — and
each one is reported on the review screen, so a degraded draft never looks like
a full-fidelity one:

| Capability | Without it |
|---|---|
| **Native PDF** | PDFs are text-extracted locally. **Diagrams and figures are not seen by the model** — a real quality loss on slide decks. |
| **Vision** | Images are skipped entirely. |
| **Long context** | The lecture is split into sections, extracted separately, and merged. Cross-section connections are weaker. |
| **Reliable schemas** | The schema goes in the prompt and output is validated, with up to two repair retries. |

That last one is not optional defensiveness. Ollama's OpenAI-compatible
endpoint accepts `response_format: json_schema` and then
[ignores it on some models](https://github.com/ollama/ollama/issues/10001),
returning prose with a 200 — so every result is validated regardless of what
the provider claims to support, and a failed native attempt silently falls
through to the prompted path.

Capability presets are auto-detected for known hosted models. Anything behind an
OpenAI-compatible URL gets a deliberately pessimistic profile, since the app
cannot tell what is running there; override it in `.env.local` when you know
better. Guessing low only costs an unnecessary chunking pass, whereas guessing
high causes silent truncation.

## Testing against free providers

Iterating on extraction prompts against a frontier model gets expensive fast.
`bun run eval` runs one lecture through several providers and scores each
against a known answer key, so "is this cheaper model good enough" becomes a
measurement rather than a guess.

```bash
cp eval.config.example.ts eval.config.ts   # gitignored; edit to taste
bun run eval                               # every configured profile
bun run eval --profiles groq,gemini        # a subset
```

It uses a **synthetic lecture fixture** (`lib/fixtures/syntheticLecture.ts`) —
a fabricated deck whose objectives, taught concepts, and deliberately planted
out-of-scope content are all known. Scoring reports objectives reproduced
verbatim, objectives that were *paraphrased* (a defect: the dashboard is meant
to show the course's wording, not the model's), missed, hallucinated, and
supplemental content wrongly labelled as taught.

The eval never writes to the database.

### The data caveat

Most free tiers are paid for with your data. Google's [API terms](https://ai.google.dev/gemini-api/terms)
say that for unpaid use:

> "Google uses the content you submit to the Services and any generated
> responses to provide, improve, and develop Google products and services."

…and human reviewers may read it. The paid tier explicitly does not. Mistral's
free tier reportedly requires opting into training outright.

That matters more here than in most projects, because lecture decks are usually
institution-licensed course material that isn't yours to hand over. **This is
why the eval defaults to a synthetic fixture.** `--deck` exists for real
material — point it only at local or paid providers.

### What each free tier can and can't test

| Provider | Free tier | Exercises |
|---|---|---|
| **Ollama / LM Studio** | Unlimited, private, no key | Chunked + prompted-schema paths. No data question at all. |
| **Gemini** | Yes — limits unpublished | The **only** free option with native PDF, vision and long context, so the only free way to test high-fidelity ingest |
| **Groq** | Generous, text only | Fast iteration on the degraded paths |
| **OpenRouter** | 20 RPM / 50 RPD until you buy credits | Breadth across models through one key |

Gemini's free limits are **not published** — Google directs you to AI Studio,
and the specific figures circulating on blogs are invented. Check your own
account. Note also that enabling billing on a Gemini project reportedly removes
the free tier for that project entirely.

Capability presets for OpenAI-compatible endpoints are keyed on the **host**,
not the model id, because the same model id means very different things
depending on who serves it: `llama-3.3-70b` has a large window on Groq and
possibly 8k on a laptop. The Groq and Cerebras presets are also sized to their
free-tier **tokens-per-minute** ceiling rather than the model's true context
window — on a free plan, TPM binds long before context does, and a request
sized to the real window comes back rate-limited rather than served.

## Status

**Phase 1 (lecture ingest → learning objectives) is implemented.**

Upload a `.pptx`, `.pdf`, transcript (`.txt` / `.vtt` / `.srt`), and/or images for
one lecture. Slides and transcripts are parsed locally; PDFs and images go to the
Files API and are read by the model natively. Extraction returns a **draft** —
nothing reaches the dashboard until you approve it on the review screen, because
objective wording is preserved verbatim and worth checking.

**Phase 2 (same-day retrieval practice) is implemented.**

Studying a committed lecture walks its objectives one at a time: recall each
objective from memory, summarise the whole lecture, then elaborate on whatever
did not come back cleanly. Each answer is graded green, yellow, or red with the
correction and a model answer.

The pacing and the bookkeeping are code, not prompt. Asking for a cue caps the
answer at yellow — hinted recall is not independent recall, so the model is not
allowed to grade its way past it. A day's dashboard cell is the *worst* rating
the objective earned that sitting, since a green that follows a red is recall of
the correction just given. Objectives never tested stay blank, and finishing
schedules every concept beneath them on the 0 / 1 / 3 / 7 / 14 / 30 / 60 day
ladder.

Phase 3 (daily 10-question sessions interleaved across lectures) is planned but
not built.

## Data

Everything is local: a SQLite file in the project root, gitignored along with
`.env.local`. Lecture content and performance history never leave the machine
except in calls to whichever provider you configure — and with a local runner,
not even then.

## Layout

```
app/
  api/lectures/             ingest + commit endpoints
  api/sessions/             start, turn, answer, hint, finish
  dashboard/                the LO grid
  lectures/new/             upload
  lectures/[id]/review/     draft review before commit
  sessions/[id]/            the study session
lib/
  db/schema.ts              Drizzle schema
  schedule.ts               the interval ladder, the hint cap, worst-of-day
  eval/score.ts             scoring an extraction against the answer key
  fixtures/pptxBuilder.ts   minimal OOXML deck builder
  fixtures/syntheticLecture.ts  fabricated lecture + ground truth
  llm/config.ts             capability profiles + env resolution
  llm/provider.ts           profile → AI SDK model
  llm/structured.ts         schema output with fallback + repair
  llm/tokens.ts             token estimation for chunking
  ingest/parsePptx.ts       OOXML slide + presenter-notes extraction
  ingest/parseTranscript.ts caption cleanup
  ingest/documents.ts       PDF/image parts, with local text fallback
  extract/index.ts          single vs chunked orchestration
  extract/chunk.ts          splitting a lecture to fit the context window
  extract/merge.ts          deterministic merge of chunked extractions
  commitLecture.ts          draft → dashboard rows + review items
  tutor/schema.ts           question, grade and hint contracts
  tutor/index.ts            asking, grading and cueing
  session/plan.ts           the session's running order, as a pure function
  session/sameDay.ts        the session; writes the day and reschedules
```
