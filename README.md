# localScan

Local-first document extraction. PDFs in, validated typed JSON out, every model
running on hardware you control.

Every model runs on hardware you control. In the default configuration nothing
leaves your network.

> **Phases 1 to 6 are complete; phase 7 is partial.** Role bindings, capability
> detection, the per-role probe and the system page are built; the settings
> screen that would make swapping a model a dropdown is not, so bindings live in
> `.env` and need a restart. This README describes only what is built and verified today.
> Planned work is in [`docs/PRD.md`](docs/PRD.md); decisions, including the ones
> that turned out to be wrong, are in [`docs/DECISIONS.md`](docs/DECISIONS.md);
> measured results, including the ones that were worse than hoped, are in
> [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

---

## What this is, and what it is not

**It is** a working local-first document extraction system, built to be
explained: PDFs become validated typed JSON, every model runs on hardware you
control, and the engineering decisions are written down with their reasoning —
including the ones that were wrong and the measurements that were worse than
hoped.

**It is not a product, and should not be run unattended.** The numbers are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) and the headline is 71.9% F1 across
seven invoice fixtures. A document that needs checking is marked for checking
rather than quietly stored, which is the design answering the accuracy rather
than hiding it.

Concretely, so nobody discovers these later:

| | |
|---|---|
| Accuracy | **71.9% F1** on 7 invoices. Résumés extract well by eye and are **not scored at all** — no labels exist for them |
| Users | One. No authentication, no multi-tenancy, no sharing. The trust boundary is your own machine |
| Scale | One document at a time, 1–3 minutes each. Durability matters here; throughput was never a goal |
| Models | Local only. OpenAI and Google are declared in the provider enum and **not implemented** |
| Configuration | Role bindings are `.env` plus a restart. The settings screen in phase 7 was not built (`D-019`) |
| Deployment | Containers exist so a stranger can run it locally in one command. There is no hosting story and none is planned |

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
- **Status you can act on.** The system page reports the database, Temporal and
  the inference host, every model installed on that host, and one of seven states
  per role — `ready`, `unreachable`, `not_installed`, `unconfigured`,
  `incapable` and the rest — each with the command or change that fixes it. A
  per-role **Test** probes something no provider reports: whether that model
  actually honours a JSON schema.
- **Exportable.** The review screen downloads the fields as JSON, including edits
  not yet saved — the copy you are looking at, not the copy on the server.
- **Fenced, and honest about what fencing achieves.** Document text is delimited
  and scanned for injection patterns, and the scan never blocks: a persuasive
  payload can still steer a 3B model. What contains it is that the model has no
  tools and its output is schema-validated before anything uses it.
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

- **The injection scan goes nowhere.** Every extraction scans its document text
  for injection patterns and the result is dropped — not stored, not shown, not
  counted across runs. The scanning is real; the reporting was never built.

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

## Quickstart

Everything except the models runs in containers, so nothing has to agree with
what is already installed on your machine.

**1. The models.** Ollama must be reachable from a container, which means binding
it to more than loopback:

```bash
ollama pull qwen2.5:3b && ollama pull nomic-embed-text && ollama pull qwen2.5vl:3b
OLLAMA_HOST=0.0.0.0 ollama serve
```

**2. The application.**

```bash
git clone <this repo> && cd localScan
cp .env.example .env
docker compose up
```

Then open **http://localhost:3000** — the interface, the REST API and the MCP
endpoint share that port. Temporal's console is on **http://localhost:8233**.

The first run builds the image and pulls Postgres and Temporal, so it takes a
few minutes; after that it is seconds. Nothing is installed outside Docker: your
own Postgres, Temporal and their versions are untouched.

Models elsewhere? Point the containers at them and skip step 1:

```bash
echo 'DOCKER_OLLAMA_BASE_URL=http://<host>:11434' >> .env
```

`docker compose down` stops it; `docker compose down -v` also deletes the
database and the stored documents.

## Running it without Docker



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
