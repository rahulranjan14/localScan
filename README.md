# agentic-ocr

A local-first document intelligence application. PDF in, validated typed JSON out.

Every model runs on hardware you control. In the default configuration nothing
leaves your network.

> **Phase 1 of 7.** This README describes only what is built and verified today.
> Planned work is in [`docs/PRD.md`](docs/PRD.md); decisions, including the ones
> that turned out to be wrong, are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## What works today

Upload a digital PDF invoice and get editable, schema-validated JSON.

- **Text-layer first.** If the PDF carries text it is read directly and **no
  vision model runs at all.** Only scanned documents need one, and that path
  arrives in Phase 2.
- **Content-addressed.** Files are keyed by SHA-256, so re-uploading a document
  returns the stored result instead of extracting it again — 0.04s against 188s.
- **Validated or refused.** Output either validates against the schema or the
  document is stored as `needs_review` with no structured data. A partial result
  is never presented as fact.
- **Side-by-side review.** Document left, fields right, each scrolling
  independently. The form is generated from the document type's layout, so no
  document type has a hand-written screen.
- **Corrections are additive.** What the model produced is kept immutably beside
  what you corrected.

Measured on a 2-page invoice, `qwen2.5:3b` on CPU: **121s, 1036 output tokens,
8.6 tok/s.** Accuracy is not yet good — the measurement harness that makes it
improvable is Phase 3.

## Not built yet

Vision OCR for scanned PDFs · document classification · more than one document
type · retrieval and question answering · the agent (MCP) surface · durable
orchestration · hosted model providers · the settings screen.

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

npm install
cp .env.example .env            # then set OLLAMA_BASE_URL
npm run migrate
npm run dev                     # server :3000 · interface :5173
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

## Layout

```
documents/<type>/        schema + prompt.md + ui.json  ◄── adding a type lives here
packages/shared/         schemas, types, the document-type registry
packages/core/           the engine: providers, PDF, guards, extraction
packages/server/         Express, Postgres, file storage
packages/web/            Vite + React review interface
scripts/                 check-inference, extract
```

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
