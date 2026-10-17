# Functional Requirements Document — agentic-ocr

| | |
|---|---|
| **Status** | Approved, in development |
| **Author** | Rahul Ranjan |
| **Created** | 2026-10-06 |
| **Implements** | [`PRD.md`](PRD.md) |

Requirements are identified `FR-<area>.<n>` and referenced by commit messages and
branch names. Each carries acceptance criteria that can be checked without
reading the implementation.

---

## 1. System context

Two machines, four processes.

```
  ┌──────────────────────── application host · 8 GB ────────────────────────────┐
  │                                                                              │
  │   browser ──────► web interface ──┐                                          │
  │                                   │                                          │
  │   AI agent ───────────────────────┼──► API server ────► orchestrator         │
  │   (MCP client)                    │    REST + MCP        durable runs        │
  │                                   │       │                   │              │
  │                                   │       ▼                   ▼              │
  │                                   │   PostgreSQL        worker process       │
  │                                   │   + pgvector              │              │
  │                                   │   documents · chunks      │              │
  │                                   └───────────────────────────┤              │
  └───────────────────────────────────────────────────────────────┼──────────────┘
                                                                  │ HTTP
  ┌──────────────────────── inference host · 32 GB · LAN ──────────┼──────────────┐
  │                                                                ▼              │
  │   Ollama   ·   vision model  ·  text model  ·  embedding model                │
  └──────────────────────────────────────────────────────────────────────────────┘
```

**The application host never loads a model.** Every inference call is HTTP to the
inference host. The application does not administer that machine: it discovers
what is available and reports what is missing.

### Structural rule

The engine module imports nothing from the web framework, the orchestrator or
the database. Given bytes or text plus a model binding, it returns a result.
This is what lets the interface, the agent surface, the worker and the
evaluation harness share one implementation.

---

## 2. Data model

```
files       id · filename · mime · size_bytes · sha256 (unique) · path · created_at
documents   id · file_id → files · type · raw_text
            structured_data jsonb · edited_structured_data jsonb
            ui_schema jsonb · confidence · classification_reason
            status · error · created_at · updated_at
chunks      id · document_id → documents (on delete cascade) · page · content
            embedding vector(768)
config      id = 1 (enforced) · role_bindings jsonb · updated_at
```

Document status is one of `pending · processing · completed · needs_review · failed`.

File bytes are stored on disk at `data/files/<sha256>`, never in the database.
`sha256` is the deduplication key **and** the cache key for extracted text.

---

## 3. FR-1 · Document ingestion

**FR-1.1** The system accepts a PDF by drag-and-drop and by file picker.

**FR-1.2** Before any parsing, the upload is validated by: leading magic bytes
`%PDF-`, a byte-size ceiling, and a page-count ceiling. Validation uses no PDF
parsing library, so no parser is exercised on untrusted input.

> *Acceptance:* a renamed `.exe`, a 0-byte file and an oversized file are each
> rejected with a specific reason, and no parsing library is invoked.

**FR-1.3** The SHA-256 of the file content is computed on receipt. If a file with
that hash already exists, the existing document is returned and no model runs.

> *Acceptance:* uploading the same PDF twice produces one `files` row, one
> `documents` row, and zero inference calls on the second upload.

**FR-1.4** The user may restrict processing to selected pages.

**FR-1.5** Upload returns immediately with a run identifier; the client polls for
status. No HTTP request is held open for the duration of extraction.

> *Note:* satisfied inline in Phase 1 and by the orchestrator from Phase 6.

---

## 4. FR-2 · Text acquisition

**FR-2.1** The system first determines whether the PDF has an extractable text
layer.

**FR-2.2** If it does, text is extracted directly. **No vision model is called.**

> *Acceptance:* extracting a digital invoice produces zero requests to the
> inference host's vision endpoint.

**FR-2.3** If it does not, pages are rasterised to images and passed to the
model bound to the `ocr` role.

**FR-2.4** Extracted text is persisted against the file hash, so extraction can
be re-run — with a different prompt, schema or model — without repeating OCR.

> *Acceptance:* a second extraction of the same document performs no OCR.

**FR-2.5** Rasterisation DPI is configurable, with a default chosen by
measurement and recorded in `DECISIONS.md`.

---

## 5. FR-3 · Classification

**FR-3.1** Document text is classified into `invoice`, `resume` or `generic`.

**FR-3.2** Classification returns a confidence score **and a stated reason** in
natural language.

**FR-3.3** `generic` is a valid successful outcome, not a failure or an error
state.

> *Acceptance:* a document that is neither an invoice nor a résumé completes with
> status `completed`, type `generic`, and a reason explaining the decision.

**FR-3.4** Confidence is displayed to the user as self-reported and uncalibrated.
The interface must not present it as a probability of correctness.

---

## 6. FR-4 · Structured extraction

**FR-4.1** Each typed document has exactly three artifacts: a schema, a prompt in
markdown, and a form layout in JSON. Adding a type requires no change to the
engine.

> *Acceptance:* a new type can be added by creating three files and one registry
> entry, demonstrated by a commit that does exactly that.

**FR-4.2** Prompts are external markdown files, editable without recompiling.

**FR-4.3** Extraction output is validated against the type's schema.

**FR-4.4** Malformed or truncated JSON is repaired before the attempt is
abandoned.

**FR-4.5** On validation failure, the extraction is retried against the model
bound to the `fallback` role.

**FR-4.6** If validation fails again, the document is persisted with status
`needs_review` and **null** structured data. A partial or unvalidated result is
never stored as though it were valid.

> *Acceptance:* a forced schema failure yields `needs_review` with no structured
> data, and the raw text is still stored and still queryable.

**FR-4.7** Fields the model returned that the schema does not define are
preserved in an `extraFields` collector. Data the model actually read is never
silently discarded.

**FR-4.8** Extraction requests use temperature 0.

**FR-4.9** `generic` documents receive flat key-value extraction with no schema,
and a null form layout.

---

## 7. FR-5 · Review and correction

**FR-5.1** The review screen shows the source document on the left at full
height and the extracted fields on the right, scrolling independently.

**FR-5.2** The form is rendered entirely from the layout supplied by the server.
No document type has a hand-written screen.

> *Acceptance:* adding a document type produces a working review screen with no
> frontend change.

**FR-5.3** Field binding supports nested paths such as
`billingParty.address.city`.

**FR-5.4** Two invariants hold simultaneously: **never render a blank field that
has a value, and never hide extracted data.** Anything extracted but not in the
layout is still shown.

**FR-5.5** The user may add a custom field at document, group and line-item
level, and may add and remove line items.

**FR-5.6** The original extraction is stored immutably alongside the edited copy.
Corrections never overwrite what the model produced.

**FR-5.7** `generic` documents are read-only. Edits are rejected by the API, not
merely hidden in the interface.

> *Acceptance:* a modification request against a generic document is refused with
> an explanatory error.

**FR-5.8** For `generic` documents the raw text is the primary view, with
key-values shown beneath it.

**FR-5.9** A document library lists documents with filters for type and status.

---

## 8. FR-6 · Retrieval and question answering

**FR-6.1** Text is chunked within page boundaries, retaining the page number.

**FR-6.2** Chunks are embedded using the model bound to the `embed` role and
stored as vectors in the database.

**FR-6.3** Questions are answered by retrieving similar chunks, not by passing
the whole document to the model.

**FR-6.4** The answering agent is a graph: retrieve → grade sufficiency →
either generate, or rewrite the question and retrieve again. The loop is bounded.

> *Acceptance:* a question whose first retrieval is insufficient triggers exactly
> one rewrite, visible in the logs, and terminates.

**FR-6.5** Every answer cites the page numbers it drew on.

**FR-6.6** Questions may target one document or the whole corpus.

**FR-6.7** `generic` documents are indexed and answerable despite being
read-only.

---

## 9. FR-7 · Agent surface

**FR-7.1** The agent surface and the web API are served by one process on one
port. There is no second port with a different access policy.

**FR-7.2** Six tools are exposed: `list_document_types`, `extract_document`,
`get_document`, `list_documents`, `ask_document`, `get_engine_status`.

**FR-7.3** Tool input schemas are generated from the same schemas used for
runtime validation, so the published contract cannot drift from what is enforced.

**FR-7.4** Each tool is a thin wrapper over the same service the web API uses.
No capability exists on one surface only.

> *Acceptance:* an external client lists the tools and extracts a document end to
> end without using the browser.

---

## 10. FR-8 · Model and role configuration

**FR-8.1** Five roles are independently bound: `ocr`, `classify`, `extract`,
`fallback`, `embed`.

**FR-8.2** Configuration separates **credentials, which belong to a provider**,
from **model choice, which belongs to a role.**

**FR-8.3** Each provider has a configurable base URL. Inference being on another
machine is the normal configuration, not a special case.

> *Acceptance:* pointing a role at a different host is a configuration change
> with no code change and no restart.

**FR-8.4** Providers may be added and removed at runtime from the settings
screen.

**FR-8.5** Configuration persists to `data/config.json` with file mode `0600`.

**FR-8.6** Credentials are masked when read back. A stored secret is never
returned to the browser.

**FR-8.7** The system lists the models actually available on each configured
provider.

**FR-8.8** Vision and embedding capability are detected from provider metadata.

**FR-8.9** Reliable structured output **cannot** be detected and must be probed:
a per-role test action sends a minimal two-field schema request and reports
whether the result validated. The outcome is cached per model.

**FR-8.10** Role dropdowns are filtered to models capable of the role. Models
that do not fit available memory are shown but marked, and warn on selection
rather than being hidden.

---

## 11. FR-9 · System status

**FR-9.1** A single status endpoint serves both the header indicator and the
system screen.

**FR-9.2** Each role reports exactly one of seven states: `ready`,
`not_installed`, `wont_fit`, `unreachable`, `no_api_key`, `incapable`,
`unconfigured`. A single "unhealthy" flag is not acceptable — each state maps to
one user action.

**FR-9.3** `unreachable` reports the base URL that was tried.

**FR-9.4** Checks are split by cost. Cheap checks — reachability, a trivial
database query, a model listing — run on a 30-second poll. Expensive checks —
capability probes, credential validation — run only on demand.

> *Acceptance:* the polling loop performs no inference call.

**FR-9.5** When a model is missing on the inference host, the interface reports
which model, on which host, and the exact command to install it. The application
does not install it.

> *Constraint:* the inference host is operated by its owner. The application
> reports and instructs; it never administers that machine.

---

## 12. FR-10 · Evaluation

**FR-10.1** Fixtures, ground-truth labels and results are all committed to the
repository. A result that cannot be reproduced from the repository does not count.

**FR-10.2** `eval run` executes the pipeline over fixtures; `eval score`
computes metrics from stored results **without calling any model**; `eval diff`
compares two result sets.

**FR-10.3** Normal documents are scored on classification accuracy and
field-level precision, recall and F1.

**FR-10.4** Deliberately hard documents are scored pass/fail on garbage
signatures — base64 blobs, chat control tokens, HTML markup, hallucinated
preambles. These two metric classes are reported separately and never averaged
together.

**FR-10.5** `BENCHMARKS.md` records every run, including changes that made
results worse.

---

## 13. FR-11 · Safety

**FR-11.1** Untrusted document text is structurally fenced before entering any
prompt, including retrieved chunks at question time — not only at initial
extraction.

**FR-11.2** Known injection patterns are detected and counted, **not blocked.**
A false positive on a real document is worse than the attack, because the model
has no tools.

**FR-11.3** Output is re-validated against the schema and every string is length
capped.

**FR-11.4** The model is given no tools. It emits JSON or prose and cannot act.
This containment, not the fencing, is what limits the damage from an injection.

**FR-11.5** The database listens on the loopback interface only.

**FR-11.6** When a configuration would send document content off the local
network, the interface says so explicitly at the point of selection. Mixing a
local and a remote stage buys speed, not privacy — the full text still leaves.

---

## 14. Non-functional requirements

| | Requirement |
|---|---|
| **NFR-1** | The application host must remain responsive during extraction. It loads no model. |
| **NFR-2** | A failed stage must not lose the run. From Phase 6, killing the worker mid-extraction resumes on restart. |
| **NFR-3** | Every run carries a correlation identifier through the logs. |
| **NFR-4** | Per-stage latency, classification confidence, guard trips and tool calls are all recorded. |
| **NFR-5** | The default configuration requires no account, no credential and no internet access. |
| **NFR-6** | Documentation never describes behaviour that is not implemented. |

---

## 15. Phase acceptance

| Phase | Requirements | Accepted when |
|---|---|---|
| 1 | FR-1.1-1.4, FR-2.1-2.2, FR-4.1-4.3, FR-5.1-5.6, FR-8.1-8.3 | A digital invoice becomes editable structured JSON |
| 2 | FR-2.3-2.5, FR-3, FR-4.4-4.9, FR-5.7-5.9, FR-11.1-11.4 | A scanned invoice works; a résumé routes to its own schema |
| 3 | FR-10 | `BENCHMARKS.md` holds real numbers for two models |
| 4 | FR-6 | A long document answers a question with a page citation |
| 5 | FR-7 | An external agent extracts a document |
| 6 | FR-1.5, NFR-2 | The worker is killed mid-run and the run resumes |
| 7 | FR-8.4-8.10, FR-9 | Swapping a role's model is a dropdown change |
