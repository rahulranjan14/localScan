# Benchmarks

Measured results, including the ones that were worse than expected. Every number
here was produced by a command in this repository against a fixture committed to
it.

---

## Run 001 — vision transcription, three models

**2026-10-08** · one page, CPU-only inference host (32 GB, no GPU) · Ollama

```bash
npm run check:vision -- packages/eval/fixtures/simple-invoice.pdf \
  --base-url http://HOST:11434 --model <model> --dpi 110 --force --max-tokens 600
```

### Read this first

**This is one page of one synthetic document.** It is an indication, not a
benchmark. It is recorded because what it shows is not what the obvious metric
says, and that is worth having written down before a larger run exists.

The fixture ([`packages/eval/fixtures/simple-invoice.pdf`](../packages/eval/fixtures/simple-invoice.pdf))
is deliberately trivial: 11 lines, one line item, no tables, no stamps, generated
rather than scanned. Its job is to be a document that any model should get
completely right, so a failure is unambiguous.

### Results

| Model | Size | Time | Chars vs text layer | Correct? |
|---|---|---|---|---|
| `granite3.2-vision` | 2.4 GB | **30.8s** | 186 / 187 (99%) | **no** — 3 errors |
| `qwen2.5vl:3b` | 3.2 GB | 173.5s | 188 / 187 (101%) | **no** — 1 error |
| `gemma3:12b` | 8.1 GB | 357.5s | 189 / 187 (101%) | **yes** |

### What each got wrong

**`granite3.2-vision`** — fastest by 5.6×, and wrong three ways:

- `From: the vendor line` dropped entirely
- `Invoice Date: 2026-01-15` transcribed as **`2023-01-15`**
- leading fragments before the transcription settled: `15`, `Pvt Ltd`, `airs`

**`qwen2.5vl:3b`** — vendor and date correct, and then:

- `Total: 10000.00` transcribed as **`100000.00`**

A 10× error on the payable amount. Arguably the worst single failure of the
three, because it is the field most likely to be acted on.

**`gemma3:12b`** — every field correct, including both parties, the date and the
total. 11.6× slower than granite.

### The finding that matters

**All three scored 99–101% on character count. One was right.**

A character-level or edit-distance metric would have called every one of these a
success. The errors were a dropped line, a changed year and a shifted decimal —
each of which leaves the character count almost untouched and the document
materially wrong.

This is the argument for field-level scoring against committed ground truth, and
it is now a measured example rather than a principle. It also validates two
existing decisions:

- **Text-layer-first** (`FR-2.2`). The free path transcribed this document
  perfectly at zero cost. The vision path is a fallback for a reason.
- **Self-reported confidence is not calibrated** (`FR-3.4`). None of these models
  signalled uncertainty about the fields they got wrong.

### On the latency

30.8s and 357.5s are both *far* below the 10–15 minutes this workload was
expected to take. Earlier attempts appeared to take 300s and fail; that was
undici's `headersTimeout` killing the request, not the model (`D-008`). CPU vision
inference is practical on this hardware — the constraint is accuracy, not speed.

### Not yet measured

- Any scanned document. Everything here is a digital PDF rendered to an image,
  which is a best case: no skew, no noise, no compression artefacts.
- More than one document, so there is no per-field precision or recall yet.
- Whether DPI changes any of this. All three runs used 110 DPI.
- `deepseek-ocr`, which the predecessor system used for this role.
- End-to-end extraction accuracy. This measures transcription only; the
  extraction step that turns text into typed JSON is scored separately.

---

## Run 002 — the two-stage pipeline, end to end

**2026-10-08** · `packages/eval/fixtures/tiny-invoice.pdf` (70 characters, 5 lines)
· CPU-only host · `OCR_TEXT_MODE=always_vlm`

The original design this project was asked to follow: document → VLM → raw text →
text model → validated JSON. Measured through the real HTTP endpoint, not a script.

```
OCR_MODEL_OCR=deepseek-ocr:3b      OCR_MODEL_EXTRACT=llama3.2:3b
OCR_MODEL_CLASSIFY=llama3.2:3b     OCR_MODEL_FALLBACK=qwen2.5:3b
```

### Result: 5 fields correct, 6 fabricated

> **Corrected after publication.** This entry originally read "5/5 fields correct".
> That counted the five fields listed below and ignored the other twenty in the
> schema, six of which held invented values. The corrected accounting is beneath
> the table, and `D-010` has the cause. The original claim is left visible because
> a benchmark that quietly edits its own results is worth less than one that does
> not.

| Field | Expected | Got | |
|---|---|---|---|
| `invoiceNumber` | `INV-7` | `INV-7` | ✓ |
| `invoiceDate` | `2026-02-01` | `2026-02-01` | ✓ |
| `currency` | `INR` | `INR` | ✓ |
| `total` | `2500.00` | `2500` | ✓ |
| `vendor.name` | `Bluebird Ltd` | `Bluebird Ltd` | ✓ |

Transcription was character-exact. Classification returned `invoice`. The fallback
model never fired, which also settles an open question: **`llama3.2:3b` does honour
a requested JSON schema.**

#### And the fields that were not checked

| Field | Got | Document says |
|---|---|---|
| `vendor.taxId` | `Bluebird Ltd` | nothing — the vendor's name, duplicated |
| `subtotal` | `2500` | nothing — only a Total is printed |
| `lineItems` | 1 row, amount 2500 | no line-item table at all |
| `extraFields[0]` | `paymentTerms: Net 30` | nothing |
| `extraFields[1]` | `deliveryNoteRef: DLN-123` | nothing |
| `extraFields[2]` | `vehicleNumber: VH-456` | nothing |

The last three were copied out of the prompt, which offered exactly those three as
examples of what `extraFields` is for. See `D-010`.

**2m 27s total**, including cold loads of two models that had never been resident.

### What the prompt convention was worth

The same stack, same document, differing only in the transcription prompt:

| OCR prompt | Transcription | Pipeline outcome |
|---|---|---|
| six-rule instruction prompt | **empty** | `generic`, 0.00 confidence, no data |
| `<image>\nFree OCR.` | character-exact | **`invoice`, 5/5 fields** |

A prompt, not a model, was the difference between complete failure and a perfect
result. See `D-009`.

### Two things that were wrong anyway

**Confidence came back as exactly `1.00`.** On a five-line document with no
ambiguity that is not unreasonable, but it is also what an uncalibrated model
returns when it has no mechanism for doubt. `FR-3.4` exists for this.

**The stated reason was partly confabulated** — "has an invoice number, a
line-item table and a payable total". There is no line-item table in a five-line
document. The classification was right and part of its justification was invented,
which is a useful reminder that a checkable reason is only valuable when someone
checks it.

### Still not measured

A real scan. Everything so far is a synthetic render: no skew, no noise, no
compression artefacts. That is the case where a specialist OCR model should pull
ahead of a general VLM, and it remains untested.

---

## Run 003 — the same document after fixing the prompts

**2026-10-08** · identical to run 002 except the prompts · `tiny-invoice.pdf`

Only the prompts changed. Same models, same document, same settings, so the
difference is attributable (see `D-010`).

| Field | Run 002 | Run 003 | |
|---|---|---|---|
| `extraFields` | 3 invented entries | **`[]`** | fixed |
| `vendor.taxId` | `"Bluebird Ltd"` | **`null`** | fixed |
| `subtotal` | `2500` | **`null`** | fixed |
| `lineItems` | 1 invented row | 1 invented row | **not fixed** |
| `invoiceNumber`, `invoiceDate`, `currency`, `total`, `vendor.name` | correct | correct | held |

**Score: 5 correct, 1 fabricated** (was 5 correct, 6 fabricated).

The classification reason changed from the prompt's own example sentence —
"has an invoice number, a line-item table and a payable total" — to
`Total: 2500.00 INR`. Terse, and quoting the document rather than the prompt,
which is the point.

### What did not fix, and why it is being left alone

`lineItems` still contains one row invented from the printed total, although the
prompt now states that a single printed total is not a line item. Confidence is
still exactly `1.00`, although the prompt now says not to default to 1.

Both may be limits of a 3B model rather than prompt problems. **They are being left
unfixed deliberately.** Four prompt revisions were made today, each from a single
observation on a single document; continuing would be overfitting to this fixture
and calling it progress. The next change to these prompts should be driven by a
score across a corpus, not by one more look at one invoice.

### 2m 18s

Marginally faster than run 002's 2m 27s, with both models already resident. Not a
meaningful difference and not treated as one.
