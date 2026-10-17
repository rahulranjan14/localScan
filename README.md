# agentic-ocr

A local-first document intelligence application. PDF in, validated typed JSON out.

Every model runs on hardware you control. In the default configuration nothing
leaves your network.

> **All seven phases are built.** This README describes only what is built and verified today.
> Planned work is in [`docs/PRD.md`](docs/PRD.md); decisions, including the ones
> that turned out to be wrong, are in [`docs/DECISIONS.md`](docs/DECISIONS.md);
> measured results, including the ones that were worse than hoped, are in
> [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

---

## What works today

Upload a PDF — digital or scanned — and get editable, schema-validated JSON.

- **Text-layer first, by default.** If the PDF carries text it is read directly
  and **no vision model runs at all**: exact, instant, free. Only image-only
  documents reach the vision path. Configurable, because a text layer is not
  automatically better — one in this repository's own corpus yields `AIR_I NDIA`
  where a rendered page says `AIR_INDIA`.
- **Two-stage extraction.** Page image → vision model → raw text → text model →
  validated JSON. The two stages are independently bound to models, so the
  transcription and the structuring can be different models on different hosts.
- **Automatic classification** with a confidence and a reason you can check
  against the page.
- **Three outcomes:** `invoice`, `resume`, and `generic` for everything else.
  Generic is a success, not a failure — stored, searchable, read-only because
  there is no schema an edit could be validated against.
- **Content-addressed.** Files keyed by SHA-256, so re-uploading returns the
  stored result — 0.04s against 188s.
- **Validated or refused.** Output validates against the schema or the document
  is stored `needs_review` with no structured data. A partial result is never
  presented as fact.
- **Side-by-side review.** Document left, fields right, scrolling independently.
  The form is generated from the type's layout, so no document type has a
  hand-written screen.
- **Durable.** Extraction runs as a Temporal workflow. Upload returns a run id
  rather than holding a connection for minutes, and killing the worker mid-run
  loses nothing — it resumes on the next one.
- **Answerable.** Every document is chunked by page, embedded and searchable. A
  self-correcting retrieval loop grades its own results and rewrites the query
  when they are not enough, and answers cite the page they came from.
- **Usable by agents.** Six MCP tools on the same port as the HTTP API, so an
  agent can extract, browse and ask questions without a browser.
- **Checked for plausibility, not just validity.** A document type can publish a
  check beside its schema: an invoice whose parts do not add up to its total, or
  whose line items do not add up to its subtotal, is stored and marked
  `needs_review` with the arithmetic that disagrees. Nothing is inferred and
  nothing is repaired — an inconsistency is reported for a person to settle.
- **Open to sections nobody anticipated.** A résumé's Projects, Publications or
  Awards are kept under the heading the document printed above them, so a section
  the schema never named survives extraction instead of being forced into the
  nearest field that fits badly.
- **Measured.** `npm run eval` scores every field in the schema against committed
  ground truth, counting *invented* values separately from wrong ones.

## Honest limits

Accuracy is measured on a small corpus and the numbers are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), unfavourable ones included. Two
findings are worth knowing before trusting any output:

- **A 12B model is not reliably steerable at this scale.** Two invoices from the
  same template, same model, temperature 0, produced opposite structural results
  — one clean, one turning a category subtitle and a shipping amount into line
  items (run 009). That is why the plausibility checks exist: detection proved
  reliable where extraction did not.
- **A text layer is exact about characters and silent about layout.** One invoice
  came back with amounts on the wrong rows because `pdfjs` emits the amount
  column before the descriptions. Every character was right; every relationship
  was wrong.

## Not built yet

Hosted model providers (OpenAI, Google) and the settings screen that would bind
them — role bindings are set in `.env` for now. Three further document types are
deferred rather than cancelled: two are enough to prove a type is three files and
one registry entry.

## Deliberately not building

| | Why |
|---|---|
| Authentication | The trust boundary is your own machine. Auth on a single-user local tool is theatre. |
| Email ingestion | Orthogonal to document understanding; costs OAuth and credential storage. |
| Cloud deployment | Local-first is the product. |
| An LLM planning loop over extraction | Extraction is a fixed sequence. Model-chosen control flow would add nondeterminism and no capability. |

---

## Running it

Two machines are assumed: this one runs the application, another on your LAN runs
the models. Both on one machine works too — point the base URL at localhost.

**On the inference machine**

```bash
# Ollama binds to localhost by default, so it needs this to accept LAN traffic
OLLAMA_HOST=0.0.0.0 ollama serve
ollama pull qwen2.5:3b
```

**On this machine**

```bash
brew services start postgresql@14
createdb ocr
psql ocr -c 'CREATE EXTENSION IF NOT EXISTS vector;'

npm install
cp .env.example .env            # then set OLLAMA_BASE_URL
npm run migrate

npm run temporal                # in its own terminal — durable run history, UI on :8233
npm run dev                     # server :3000 · worker · interface :5173
```

`npm run dev` starts all three processes. Without the worker an upload is
accepted and then never runs — Temporal holds it and nothing executes it — so the
server checks at startup and says so plainly rather than leaving you to wonder.

On **macOS with inference on another machine**, run the forwarder first and point
`OLLAMA_BASE_URL` at loopback. macOS gates local-network access per application,
and a tool running inside an editor is usually not granted it:

```bash
npm run proxy -- 192.168.1.50
```

Confirm the inference host before trusting it. This probes whether the model
actually honours a JSON schema, which nothing it reports will tell you:

```bash
npm run check:inference -- --base-url http://192.168.1.50:11434 --model qwen2.5:3b
```

Run the engine on a single file, without the server or database:

```bash
npm run extract -- invoice.pdf --base-url http://192.168.1.50:11434
```

## Measuring it

```bash
npm run eval -- run --model-ocr deepseek-ocr:3b --model-extract llama3.2:3b
npm run eval -- score <runId>
npm run eval -- diff  <before> <after>
```

Fixtures, ground-truth labels and results are all committed. A result that cannot
be reproduced from this repository does not count.

Scoring never calls a model, so re-scoring a stored run after changing the metric
is free — if that cost an hour of inference, nobody would re-score and the metric
would stop improving.

Five verdicts per field, and the fourth is the one that matters:

| | |
|---|---|
| `correct` | matched ground truth |
| `wrong` | a different value |
| `missed` | the document had it, the model did not |
| **`invented`** | **the document said nothing and the model supplied a value** |
| `absent` | correctly empty — counted, not scored |

An invented value looks exactly like a real one and survives review, where a wrong
value can be caught by holding the output against the page. Counting them together
hides the failure that matters.

## Layout

```
documents/<type>/        schema + prompt.md + ui.json  ◄── adding a type lives here
documents/_ocr.<model>.md                              ◄── per-model OCR prompts
packages/shared/         schemas, types, the document-type registry
packages/core/           the engine: providers, PDF, guards, extraction
packages/server/         Express, Postgres, file storage
packages/web/            Vite + React review interface
packages/eval/           the harness — fixtures, labels and results, all committed
scripts/                 check-inference, check-vision, extract, spike-rasterise
```

### Where each idea lives

One concept, one place. Each file carries the reasoning for its own decisions,
including the ones that turned out to be wrong.

| | |
|---|---|
| **Durability** (Temporal) | [`packages/worker/src/workflows.ts`](packages/worker/src/workflows.ts) — the pipeline as a fixed sequence, with per-step timeouts and retry counts and why each differs. [`activities.ts`](packages/worker/src/activities.ts) holds the six steps; [`main.ts`](packages/worker/src/main.ts) the worker itself; [`server/src/services/runs.ts`](packages/server/src/services/runs.ts) the client that starts runs. |
| **Self-correcting retrieval** (LangGraph) | [`packages/core/src/qa/graph.ts`](packages/core/src/qa/graph.ts) — retrieve → grade → rewrite → generate, in one file. The only place a model decides control flow. |
| **RAG** | [`core/src/rag/chunk.ts`](packages/core/src/rag/chunk.ts) page-aware chunking, [`rag/index.ts`](packages/core/src/rag/index.ts) embedding, [`server/src/repositories/chunks.ts`](packages/server/src/repositories/chunks.ts) exact cosine search. |
| **Agent surface** (MCP) | [`server/src/mcp.ts`](packages/server/src/mcp.ts) — six tools on the same port as the REST API. |
| **Extraction** | [`core/src/pipeline/`](packages/core/src/pipeline/) — `run.ts` text acquisition, `classify.ts`, `extract.ts`, `repair.ts`. |
| **Safety** | [`core/src/guards/`](packages/core/src/guards/) — input validation, output capping, prompt-injection scanning, each with tests. |
| **Plausibility** | [`shared/src/documents/checks.ts`](packages/shared/src/documents/checks.ts) — what a schema cannot ask: whether a reading could be true. |
| **Adding a document type** | [`documents/<type>/`](documents/) — schema in [`shared/src/documents/`](packages/shared/src/documents/), prompt and layout as files. |

**The structural rule:** `packages/core` imports nothing from Express, Postgres
or any orchestrator. Given bytes and a model binding it returns a result. That is
what lets the interface, the agent surface and the evaluation harness share one
engine rather than drifting into three.

## Documentation

| | |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | What is being built, and why — including what is not |
| [`docs/FRD.md`](docs/FRD.md) | Numbered functional requirements with acceptance criteria |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Append-only log, written as decisions were made |

## Development

Every feature is developed on its own branch and merged with `--no-ff`, so the
history shows the structure of the work. CI runs typecheck and tests on every
push and pull request.

```bash
npm test            # 38 tests
npm run typecheck
```

Tests that need a live inference host are excluded by pattern. A suite that fails
because a particular machine is asleep stops being run, and then stops being
written.

## Licence

Not yet determined.
