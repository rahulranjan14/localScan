# Decisions

Append-only. One entry per decision, written when the decision is made, with the
reasoning rather than just the outcome. Entries are never edited after the fact —
if a decision is reversed, a new entry supersedes it.

---

## D-001 · Inference runs on a separate machine from the application

**2026-10-06**

All models run on a 32 GB Linux machine on the LAN, reached over HTTP. The
application host is an 8 GB MacBook Air and **never loads a model.**

The alternative was running Ollama on the Mac. Rejected: 8 GB leaves roughly
5 GB after the operating system, so only one ~2-3 GB model can be resident and
every role change forces an unload and reload.

Consequences, both of which are requirements rather than later features:

- The provider base URL must be configurable per role from day one (`FR-8.3`).
  Remote inference is the normal configuration here, not an advanced option.
- The application must behave sensibly when the inference host is unreachable,
  since it is a separate machine that can be asleep or off the network.

---

## D-002 · The application never administers the inference host

**2026-10-06**

When a model is missing, the application reports which model, on which host, and
prints the command to install it. It does not install it, does not start or stop
the service, and does not change any configuration there.

The inference host is not owned by the application. Treating a machine you
merely call over HTTP as infrastructure you can mutate is wrong in general, and
here it is also a hard constraint — the machine belongs to someone else.

This is `FR-9.5`. It is the reason there is no in-app model pull, which the
original plan had included.

---

## D-003 · PostgreSQL 14, not 16

**2026-10-06**

PostgreSQL 14.11 is already installed on the application host. `pgvector`
supports it, and nothing in the data model uses a feature introduced after 14.

A major-version upgrade would cost an afternoon and buy nothing measurable. If a
later phase needs a newer feature, this entry gets superseded.

---

## D-004 · `qwen2.5:3b` honours JSON schema output

**2026-10-06**

Verified by probe before writing any extraction code, because this property is
not detectable from model metadata and the entire extraction path depends on it.

Request: `/api/generate` with a two-field JSON schema in `format`,
`temperature: 0`, against a one-line invoice fragment.

Result: valid JSON, both fields correct, `10.8s` including cold model load.

```json
{ "invoice_number": "INV-2024-0042", "total": 15750.50 }
```

This is the measurement behind `FR-8.9`: structured-output reliability is probed,
never assumed. A model that fails this probe cannot serve the `extract` role, and
the application should say so rather than fail at extraction time.

---

## D-005 · Model-facing schemas are bounded and fully required

**2026-10-06**

Two rules for any schema sent to a model for constrained generation:

1. **No open-ended collections.** Every array has a maximum and no object is a
   free-form map. An unbounded collection gives the decoder no state in which it
   must stop, so a model that begins repeating cannot be stopped by the grammar.
2. **Every field required, nullable where unknown.** The key must be present with
   a value or an explicit `null`.

Both came from the same failing document — a travel invoice that took 474s, hit
the token ceiling and returned unparseable JSON.

`extraFields` was a `z.record()`. The model filled it with invented variations
(`Airline Airline Travel Date`, `Airline Airline Total Fare`) until it was cut
off at 2048 tokens. The prompt contributed by saying "anything left over goes in
`extraFields`", which it followed literally.

The schema was also emitted with `io: 'input'`, under which any field carrying a
default is optional. Offered 25 skippable fields, the model answered the easy
ones: vendor, buyer and extras were present, and invoice number, date, total and
line items were absent entirely. Not null — absent.

Measured on the same host, model and document:

| | Before | After |
|---|---|---|
| Duration | 474s | **121s** |
| Output tokens | 2048 | **1036** |
| Stop reason | `length` | **`stop`** |
| Result | unparseable | **valid, 10 line items** |

The host sustained 8.6 tok/s throughout, before and after. **This was never a
hardware problem**, which matters because the obvious response to a 474s
extraction is to rent a GPU — and that would have made the same broken output
arrive sooner.

Generalised: when a local model appears too slow, read `done_reason` before
reaching for faster hardware. `length` means it never stopped; `stop` with a low
token rate is the only one that is actually a speed problem.

---

## D-006 · PDF rasterisation uses PDFium via WebAssembly, not a native canvas

**2026-10-07**

Rasterisation was the one genuinely unknown part of the plan, so it was measured
before any code depended on it. `scripts/spike-rasterise.mts` is committed so the
numbers below can be reproduced.

### Candidates

| | Outcome |
|---|---|
| `pdfjs-dist` + `@napi-rs/canvas` | **Segfaults on ordinary documents** |
| `pdf-to-img` | Bundles its own pdfjs; worker/API version clash with ours |
| `node-poppler` | Not evaluated — needs a binary outside npm |
| **`@hyzyla/pdfium` + `sharp`** | **Chosen** |

### Why the native canvas was rejected

It rendered some pages and crashed the process on others. Tested alone, with no
state carried between them:

| Page | Result |
|---|---|
| CISO-Report p1 | rendered |
| CISO-Report p2 | **SIGSEGV** |
| CISO-Report p3 | rendered |
| ServiceCharge p1 | **SIGSEGV** |
| ServiceCharge p2 | **SIGSEGV** |

Content-specific, not a memory ceiling — the crash came at 139 MB RSS. Two
details made it worse than a normal bug:

1. **A segfault cannot be caught.** No `try`/`catch` and no promise rejection
   intercepts it; the process simply dies. In a pipeline that means one document
   takes down the server, and the run is lost rather than failed.
2. It needed `Path2D`, `DOMMatrix` and `ImageData` installed as globals before it
   would render at all, failing otherwise inside `paintChar` with *"Value is none
   of these types `String`, `Path`"* — an error naming neither pdfjs nor the
   missing global.

### Why WebAssembly specifically

PDFium compiled to WASM rendered **every page that crashed the native library**,
and the isolation is the point rather than a bonus: WASM traps instead of
corrupting the host process. For a pipeline whose input is untrusted PDFs, a
renderer that *cannot* take down the server is worth more than a faster one.

### Measured — CISO-Report.pdf, 5 pages

| DPI | Page size | Peak RSS | Time |
|---|---|---|---|
| 150 | 1239×1754 | 156 MB | 0.1s |
| 200 | 1652×2338 | 203 MB | 0.1s |
| 300 | 2479×3508 | 282 MB | 0.2s |
| 400 | 3305×4677 | 411 MB | 0.3s |

**300 DPI is affordable.** The original concern — that 300 DPI would be the memory
ceiling on an 8 GB machine — does not hold here, because the application host
never loads a model (`D-001`). 282 MB is unremarkable. The predecessor system
disabled Pillow's decompression-bomb guard to get around this, which removed the
warning rather than the cause.

**Default: 200 DPI**, revisited once the harness can measure accuracy against it.
150 is likely enough for digital text and 300 for dense scans, but that is a
guess until measured, and guesses do not belong in a default that is cheap to
change.

### Still unverified

Whether `granite3.2-vision` reads these images well enough to extract from. The
check was interrupted when the inference host became unavailable.

---

## D-007 · Model capabilities come from `capabilities`, not `families`

**2026-10-08**

Ollama's `/api/show` returns both `details.families` and a `capabilities` array.
**`capabilities` is authoritative. `families` is a weak heuristic.**

The commonly repeated rule — a vision model's `families` contains `clip` or
`mllama` — is false, and `ARCHITECTURE.md` in the handoff material asserts it.
Observed on this host:

| Model | `families` | `capabilities` | Vision? |
|---|---|---|---|
| `granite3.2-vision` | `['granite','clip']` | `['tools','completion','vision']` | yes |
| `qwen2.5vl:3b` | `['qwen25vl']` | `['completion','vision']` | **yes, no `clip`** |
| `nomic-embed-text` | `['nomic-bert']` | `['embedding']` | no |
| `gemma3:12b` | — | includes `vision` | yes |

`qwen2.5vl:3b` is a vision model whose `families` contains no `clip`. Relying on
the heuristic would silently exclude it from the `ocr` role, and the symptom is
the worst kind for a configuration screen: a dropdown quietly missing an option,
with no error anywhere.

So `capabilities` is checked first and `families` kept only as a fallback for
hosts too old to report it. Note also that `/api/tags` does **not** include
`capabilities` — only `/api/show` does, per model. Any capability check must call
`/api/show`.

This changes nothing about structured output, which no field reports at all and
which is still established by probe (`D-004`, `FR-8.9`).

---

## D-008 · Generation must stream, because `fetch` caps a request at 300 seconds

**2026-10-08**

Every Ollama call streams, including non-interactive ones where no progress is
displayed. This is a correctness requirement, not a UX choice.

Node's built-in `fetch` is undici, whose **`headersTimeout` defaults to 300
seconds**. With `stream: false`, Ollama sends no response headers until the whole
generation has finished. Any request over five minutes was therefore aborted by
the HTTP client regardless of the timeout this codebase asked for — and it
surfaced as a **connection error**, not a timeout:

```
page 1/1 done in 300.8s
page 1 failed: Could not connect to the inference host at http://…:11434
```

Two vision runs were lost to this and read as "CPU vision inference is
impractical, a GPU is required". Raising the timeout from 300s to 30 minutes
changed nothing and could not have, because the limit was never ours.

With streaming, headers arrive immediately and each chunk resets undici's body
timer, so a request survives as long as the model keeps producing tokens. The
same page then transcribed in **30.8 seconds**.

This is also why the predecessor Python system ran this workload happily at
10–15 minutes per document: `requests` has no comparable default.

### What the result then showed

Speed was never the problem. On an 11-line synthetic invoice, `granite3.2-vision`
produced 186 characters against the text layer's 187 — and got three things wrong:

- `From: the vendor line` dropped entirely
- `2026-01-15` transcribed as `2023-01-15`
- fragments (`15`, `Pvt Ltd`, `airs`) emitted before the transcription settled

A 99% character match concealing a changed year is exactly the failure the
evaluation harness exists to catch, and exactly what a character-level metric
would have reported as success. It also confirms the text-layer-first default
(`FR-2.2`): the free path was perfect on this document, the model path was not.

---

## D-009 · OCR prompts are per model, not shared

**2026-10-08**

`documents/_ocr.<model>.md` when it exists, otherwise `documents/_ocr.md`.

Transcription prompts are not portable. One image, one model (`deepseek-ocr:3b`),
four ways of asking:

| Prompt | Result |
|---|---|
| `<image>\nFree OCR.` | perfect, character-exact |
| `<image>\n<\|grounding\|>Convert the document to markdown.` | bounding-box markup, and `INV- 7` for `INV-7` |
| `Read all text in this image.` | silently dropped the first line |
| the project's six-rule instruction prompt | **empty output, after 119 seconds** |

The last row is the reason this decision exists. A specialist OCR model has a
fixed prompt convention; it is not a general instruction-following VLM. Careful
instructions written for `granite3.2-vision` produce *nothing at all* from it, with
no error — and the pipeline then stored the document as `completed` with 15
characters of text. The empty-transcription guard was added in the same session
because of it.

The tag is stripped from the model name (`deepseek-ocr:3b` → `_ocr.deepseek-ocr.md`)
because the convention belongs to the model, not to a quantisation of it.

A file on disk rather than a lookup table in the provider, so that whoever adds the
next vision model can see that per-model prompts are expected, and add one.

### Incidental, and contrary to the handoff notes

`deepseek-ocr:3b` took 71s on a cold load of 6.69 GB of F16 weights and **2-4
seconds warm**, against `granite3.2-vision`'s 30.8s. `CONTEXT.md` called the
unquantised F16 size "the worst case for CPU latency", which is true of the load
and false of the inference.

---

## D-010 · No concrete example values in an extraction prompt

**2026-10-08**

An extraction prompt may describe *what kind of thing* a field holds. It must never
give an example *value*, because a model will emit the example as data.

Found by inspecting a full extracted record rather than the handful of fields being
checked. The invoice prompt said:

> "At most a few document-level values that have no field of their own — payment
> terms, a delivery note reference, a vehicle number."

and the extraction of a five-line document containing none of those returned:

```json
"extraFields": [
  { "key": "paymentTerms",    "value": "Net 30" },
  { "key": "deliveryNoteRef", "value": "DLN-123" },
  { "key": "vehicleNumber",   "value": "VH-456" }
]
```

Three fabricated entries, one per example in the prompt. The hallucination was
written by hand, into the instructions, by me.

The same mistake was present in two other prompts and has been removed from all
three. `_generic.md` was the worst of them, offering `Reference No: AB-1234` and
`Valid until: 2026-03-31` — fully-formed fake values in a prompt whose whole job is
to extract only what the page states.

Two related fabrications in the same record, fixed by new rules rather than by
removing text:

- `subtotal` was `2500` on a document that prints only a Total.
- `vendor.taxId` was `"Bluebird Ltd"` — the vendor's own name, duplicated.
- `lineItems` held one row invented from the printed total, on a document with no
  line-item table.

So the prompt now forbids deriving one field from another, and says explicitly that
a single printed total is not a line item.

### The part worth remembering

The run that produced this had been recorded as **"5/5 fields correct"**. That was
true and misleading: five fields were checked and twenty were not. The same record
contained six fabricated values.

This is the argument for scoring *every* field in a schema against ground truth
rather than the fields someone thought to look at — made, inconveniently, against
my own benchmark entry.

---

## D-011 · pgvector is built from source against PostgreSQL 14

**2026-10-08**

`brew install pgvector` installs a bottle built for **PostgreSQL 17 and 18 only**.
This machine runs 14.11, so the extension installed cleanly and then could not be
loaded:

```
ERROR: could not open extension control file
       "/opt/homebrew/share/postgresql@14/extension/vector.control"
```

pgvector supports PostgreSQL 13 and up; the gap is Homebrew's bottle coverage, not
the extension. So it is built from source against this Postgres:

```bash
git clone --depth 1 --branch v0.8.0 https://github.com/pgvector/pgvector.git
make -C pgvector PG_CONFIG=/opt/homebrew/opt/postgresql@14/bin/pg_config
make -C pgvector install PG_CONFIG=/opt/homebrew/opt/postgresql@14/bin/pg_config
```

Verified: `'[1,2,3]'::vector <=> '[1,2,4]'::vector` returns `0.0085`.

The alternative was upgrading PostgreSQL to 17. Rejected as the larger change for
the smaller reason — a major-version upgrade to satisfy a packaging gap, when a
five-minute source build satisfies it exactly. `D-003` stands.

This is worth recording because the failure is confusing rather than obvious:
`brew install` succeeds, `CREATE EXTENSION` fails, and the error names a path
rather than a version mismatch.

---

## D-012 · No approximate vector index until there is data to justify one

**2026-10-08**

The `chunks` table has no vector index. Exact search only.

An IVFFlat index was added with `lists = 10` and immediately caused a correctness
failure. IVFFlat partitions vectors into `lists` clusters and probes only
`ivfflat.probes` of them — **one**, by default. With more lists than rows most
clusters are empty, so a probe can land on an empty cluster and the query returns
fewer rows than requested.

Observed with 5 chunks in the table:

```
Q: What is the GST registration number?
   (zero results)
```

Three chunks contained the answer. The query asked for two and got none.

**This is a correctness bug, not a performance tradeoff.** A retrieval layer that
silently returns nothing produces "I could not find that in the document" for a
fact plainly printed on the page, and nothing distinguishes that from a genuine
miss. The user has no way to tell they were lied to.

Dropping the index fixed it, and also fixed a ranking failure: "How much did the
mouse cost?" had been returning the wrong invoice entirely and now returns the
right one at distance 0.366.

Exact search over a local corpus is instant. An index belongs here when there are
enough rows to need one, and it should be **HNSW**, which has no equivalent
under-filled failure mode. Adding IVFFlat at this scale was optimising a
non-problem and introducing a real one.

The migration comment in `002` even warned that too many lists makes each probe
search near-empty partitions. Writing the warning and then setting `lists = 10`
on an empty table is its own lesson.

---

## D-013 · `heartbeatTimeout`, not `startToCloseTimeout`, is what makes a run resumable

**2026-10-08**

The OCR activity heartbeats once per page. Without a `heartbeatTimeout` on the
activity options, that achieves nothing: Temporal has no deadline to measure the
beats against, so a worker that dies mid-transcription is only noticed when
`startToCloseTimeout` expires — 35 minutes here.

"Kill the worker and the run resumes" was technically true and practically
useless until this was set.

With `heartbeatTimeout: '2 minutes'`, the recovery is visible in the history:

```
11  16:51:12  ActivityTaskScheduled     OCR queued, worker 1 claims it
              — worker 1 killed —
12  16:53:13  ActivityTaskStarted       worker 2 picks it up, 2 min later
13  16:54:23  ActivityTaskCompleted
41  16:55:33  WorkflowExecutionCompleted
```

The gap between 11 and 12 is the heartbeat deadline expiring.

### The corollary, which matters as much

`classify` and `extract` are in a **separate proxy with no heartbeat deadline**,
because they are single model calls with no progress to report. Giving them one
would kill them mid-call while they were working correctly — the exact opposite
of what the setting is for.

So the rule is: an activity gets a heartbeat deadline **only if it can heartbeat**.
The cost is that a worker dying during classification or extraction is noticed
only at start-to-close. That is an honest trade rather than an oversight: an
activity that cannot report progress cannot be monitored for progress.
