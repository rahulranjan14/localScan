# Product Requirements Document — agentic-ocr

| | |
|---|---|
| **Status** | Approved, in development |
| **Author** | Rahul Ranjan |
| **Created** | 2026-10-06 |
| **Supersedes** | — |

---

## 1. Problem

Extracting structured data from PDFs is a solved problem *in the cloud* and an
unsolved one on a laptop. Commercial document-AI services are accurate but
require uploading documents that often contain bank details, tax identifiers and
personal data. The local alternatives are either traditional OCR engines that
return unstructured text, or research demos that assume a GPU.

What is missing is a modest, honest tool: **put a PDF in, get validated typed
JSON out, with every model running on hardware you control.**

## 2. Goals

**G1 — Correct structured extraction.** A PDF becomes JSON that validates
against a schema, or it is explicitly marked as needing review. A partial or
unvalidated result is never presented as truth.

**G2 — The user chooses the models.** Each pipeline stage — OCR, classification,
extraction, retry, embedding — is independently bound to a provider and model.
This is the product's distinguishing feature, not a settings-page afterthought.

**G3 — Nothing leaves the network by default.** The default configuration uses
only local models. Any configuration that sends document content off the network
says so explicitly, in the interface, at the moment it is chosen.

**G4 — Answers, not just fields.** Documents are queryable in natural language,
with page-level citations, including documents that have no schema.

**G5 — Measured, not asserted.** Extraction accuracy is reported from a
committed benchmark suite, including results that were worse than the baseline.

## 3. Non-goals

Each of these was considered and rejected. The reasons matter as much as the
decisions.

| Not building | Why |
|---|---|
| Authentication / multi-tenancy | The trust boundary is the user's own machine and LAN. Auth on a single-user local tool is theatre, and it is where the predecessor system spent most of its effort for no user-visible benefit. |
| Email / inbox ingestion | Orthogonal to document understanding. Costs OAuth, scheduling and credential storage; demonstrates nothing this project is about. |
| Cloud deployment, Kubernetes | Local-first is the product. There is no deployment story to build. The containers added later are for reproducible local setup -- one command instead of installing Postgres, pgvector and Temporal by hand -- and not a step toward hosting this anywhere. |
| An LLM planning loop over extraction | Extraction is a fixed sequence of steps. Model-chosen control flow here would add nondeterminism and no capability. Autonomy belongs in classification and retrieval, where it is earned. |
| Retention / archival policy | Single user, local disk. Deleting the data directory is the retention policy. |
| Horizontal scale, queuing for throughput | One user, a handful of documents at a time. Durability matters; throughput does not. |

## 4. Users

There is one user persona: **the operator**, who is also the owner of the
machine. They are technically capable, care about their documents staying local,
and are willing to trade latency for control.

Two consumer surfaces follow from that:

- **The web interface**, used by a human to upload, review and correct.
- **The MCP server**, used by an AI agent (Claude Desktop, Cursor, a script) to
  reach exactly the same capabilities without a browser.

Both are first-class. Neither is a wrapper over the other — they share one engine.

## 5. Success criteria

The product is successful when all of the following are true:

1. A digital PDF invoice becomes editable, schema-valid JSON **without any model
   loading a vision model** (text-layer path).
2. A scanned PDF invoice produces the same result via the vision path.
3. A résumé routes to a different schema automatically, with a stated reason.
4. A document matching neither type is still stored, indexed and answerable —
   not an error.
5. A question about a long document returns an answer **with the page number**.
6. Killing the worker mid-extraction and restarting it resumes the run rather
   than losing it.
7. An external MCP client extracts a document end to end.
8. `BENCHMARKS.md` contains field-level accuracy for at least two models on an
   identical document set.
9. Changing the extraction model from a local one to a different host's model is
   a dropdown change, not a code change.

## 6. Scope

### P0 — the product does not exist without these

- PDF upload; content-hash deduplication
- Text-layer detection, with vision-model OCR only when there is no text layer
- Document classification with a confidence score and a stated reason
- Two typed documents: **invoice** and **résumé**
- **`generic`** as a first-class third outcome — extracted, stored and queryable,
  but read-only, because there is no schema to validate an edit against
- Schema validation; `needs_review` status on failure
- Side-by-side review interface: document on the left, fields on the right
- Per-role model binding for five roles: OCR, classify, extract, fallback, embed

### P1 — what makes it defensible

- Durable pipeline: asynchronous submission, per-stage retries, resume after crash
- Retrieval-augmented Q&A with page citations, including a self-correcting
  retrieve → grade → rewrite loop
- MCP server exposing six tools over the same engine
- Evaluation harness: committed fixtures, committed labels, committed results
- Prompt-injection fencing and output validation

### P2 — valuable, not essential

- Additional providers beyond local inference (hosted APIs), added as
  configurable endpoints
- In-application model installation with progress
- Structured-output capability probing per model
- Token and cost accounting for metered providers

### Explicitly deferred

Three further document types (purchase order, bank statement, service
agreement) are **deferred, not cancelled.** Two typed documents are enough to
prove the extensibility claim; a third adds bulk without adding a concept. They
become the proof that adding a type is genuinely three files.

## 7. Constraints

### Hardware

| Machine | Role | Spec |
|---|---|---|
| Application host | API, database, orchestration, interface | 8 GB RAM |
| Inference host (LAN) | All models, reached over HTTP | 32 GB RAM |

This split is the central environmental fact. The application machine never
loads a model, so it stays responsive on 8 GB; the inference machine has room
for a 12B-class model, which makes a meaningful small-versus-large accuracy
comparison possible.

It follows that **the model endpoint must be configurable per role from the
start.** Inference being remote is the normal case here, not an advanced option.

### Product constraints

- **Lightweight above all.** Where breadth of capability conflicts with the
  codebase staying small and readable, the codebase wins.
- **No feature may be documented before it is built.** Documentation understates
  or matches reality; it never anticipates it.
- **Local-only must remain a complete configuration.** Every capability except
  hosted-provider support must work with no account, no key and no internet.

## 8. Delivery plan

Seven phases. Each one ends with an application that runs. Each is developed on
its own branch and merged with `--no-ff`.

| Phase | Delivers | Done when |
|---|---|---|
| **1 · Spine** | API, database, invoice only, remote Ollama, text-layer path, review interface | A digital invoice becomes editable structured JSON |
| **2 · Vision & types** | Rasterisation, vision OCR, résumé, generic, classifier, guards | A scanned invoice works and a résumé routes elsewhere |
| **3 · Measurement** | Fixtures, labels, scoring, `BENCHMARKS.md` | Real accuracy numbers for two models exist |
| **4 · Retrieval** | Chunking, embeddings, vector search, self-correcting Q&A graph | A question about a long document returns a cited answer |
| **5 · Agent surface** | MCP server, six tools, one port | An external agent extracts a document |
| **6 · Durability** | Workflow orchestration, retries, asynchronous submission | Killing the worker mid-run resumes it |
| **7 · Providers** *(partial)* | Configurable endpoints, capability detection, settings interface | Swapping a role's model is a dropdown change — **not met:** bindings are `.env` plus a restart |

Phase 3 precedes Phase 4 deliberately. Once measurement exists, every later
change is measurable — and that ordering is itself the argument.

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| PDF rasterisation in Node is unproven for this use | Blocks Phase 2 entirely | Prototype and measure **before** writing Phase 2 code. Record the result in `DECISIONS.md`. |
| Small models may not honour JSON output reliably | Extraction accuracy collapses | Repair-then-validate path; a different fallback model; measure the gap in Phase 3 |
| Inference host unreachable or asleep | Application appears broken | Explicit per-role reachability states that name the fix, never a generic "unhealthy" |
| Scope growth defeats the lightweight goal | The codebase stops being readable | Deferred items stay deferred unless a phase completes early |

## 10. Open questions

1. Which rasterisation library — to be settled by prototype, before Phase 2.
2. Which model wins each role — the purpose of Phase 3.
3. Chunk size and overlap for retrieval — to be measured, not guessed.
4. Whether the fallback role should be a genuinely *different* model. Retrying a
   deterministic model with the same inputs is a no-op; either bind a different
   model or remove the role.
