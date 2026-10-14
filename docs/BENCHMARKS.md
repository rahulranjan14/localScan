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

---

## Run 004 — a real invoice with a real table

**2026-10-08** · `packages/eval/fixtures/sample-invoice.pdf` ·
`deepseek-ocr:3b` → `llama3.2:3b` · `always_vlm`

The first document with an actual line-item table, supplied by the project owner
rather than generated for the test.

### Transcription

`deepseek-ocr` preserved the table **as markdown**:

```
| Item      | Qty | Price | Amount |
|-----------|-----|-------|--------|
| Notebook  | 2   | 250   | 500    |
| Pen       | 5   | 40    | 200    |
```

373 characters, structure intact — which is what made the extraction below possible.

### Extraction: 11 correct, 2 invented

| Field | Got | |
|---|---|---|
| `vendor.name` | `the vendor name` | ✓ |
| `vendor.taxId` | `00AAAAA0000A0Z0` | ✓ |
| `total` | `2050` | ✓ |
| `lineItems` | all 4 rows, every cell correct | ✓ |
| `invoiceNumber`, `subtotal`, `taxTotal`, `dueDate`, `poNumber`, all buyer fields | `null` | ✓ correctly absent |
| `extraFields` | `[]` | ✓ |
| **`currency`** | **`USD`** | ✗ the document shows ₹ and a GSTIN |
| **`invoiceDate`** | **`2024-03-04`** | ✗ the document has no date at all |

### What this settles

**The `lineItems` invention in run 003 was document-specific.** That fixture had no
table and the model manufactured a row from the printed total; given a real table
it reads every cell correctly. The fault was the fixture, not the prompt or the
model — a conclusion no single document could have supported, and the reason the
fixture set has to grow.

**The two-stage split earns its place here.** Table structure survived
transcription and extraction consumed it. A flattened transcription would have
lost the Qty/Price/Amount association entirely, and no amount of prompting at
stage two could have recovered it.

### What it does not settle

Both errors invent a value where the document states none, and both are already
forbidden by the prompt in as many words — *"Never guess a date"*, *"Null is a
valid answer"*. The instruction exists and was not followed, so the next lever is
a different model or a different mechanism, not more wording. Distinguishing those
requires measurement.

`currency: USD` on a GSTIN invoice is the more commercially dangerous.
`invoiceDate: 2024-03-04` is the more dangerous in principle: well-formed,
plausible, and indistinguishable from a real value once stored.

Three runs in a row, a person reading the output found errors that counting would
have caught mechanically. That is the case for the harness, stated for the last
time before building it.

---

## Runs 005 and 006 — the harness, and the first measured prompt change

**2026-10-08** · 3 fixtures · `deepseek-ocr:3b` → `llama3.2:3b` · `always_vlm`

The first numbers in this project not produced by a person reading output.

### Baseline (run 005)

```
F1         90.4%        correct    33
precision  82.5%        wrong       0
recall    100.0%        invented    7
                        missed      0
classification accuracy 100%
```

**Every error was a fabrication.** Zero wrong values, zero misses, perfect recall:
the pipeline found everything on the page and misread none of it. The entire
17.5-point precision gap was supplying values where the document is silent — a far
more tractable problem than "82% accurate" would suggest, and visible only because
fabrication is counted apart from error.

### What counting found that reading had not

Two different documents produced the **same** invented `extraFields` key:

```
simple-invoice   extraFields[0].key   "Printed Total"
tiny-invoice     extraFields[0].key   "Printed Total"
```

The invoice prompt contained *"a single printed total is not a line item"* — a rule
written to prevent one invention, which the model converted into another. `D-010`
for the third time, and the first time it was found by a pattern across documents
rather than by reading a single result.

A second finding: `lineItems[0].amount` of `10000` on a document showing Qty 2 and
Unit Price 5000 with **no amount column**. The model multiplied.

### After the prompt change (run 006)

```
precision   82.5% → 91.7%    +9.2pp
F1          90.4% → 95.7%    +5.2pp
invented        7 →     3      −4

correct        33 →    33     +0     ← no regression
wrong           0 →     0     +0

tiny-invoice.pdf   83.3% → 100.0%   +16.7pp
simple-invoice.pdf 85.7% →  94.7%    +9.0pp
```

Four fabrications removed at the cost of nothing. `correct` held at 33 and `wrong`
stayed at 0, which is the half of the result that cannot be checked by eye — a
prompt change that removes an invention while quietly breaking a real field looks
identical from one document.

### The three that remain

| Document | Field | Value | Kind |
|---|---|---|---|
| simple-invoice | `lineItems[0].amount` | `10000` | computed from 2 × 5000 |
| sample-invoice | `currency` | `INR` | inferred — and probably true |
| sample-invoice | `invoiceDate` | `2024-03-04` | invented from nothing |

The `currency` case is worth stating plainly. It was `USD` in run 005 and `INR` in
run 006, which is almost certainly **correct in reality** — the document carries a
GSTIN and rupee amounts. It still scores as a fabrication because the label is
`null`: the currency glyph does not render, so the page does not state a currency,
and an inferred answer that happens to be true is still inference. The metric is
behaving as intended, and the label is a judgement that someone could reasonably
make differently.

### A timing correction

`sample-invoice.pdf` took **948s in run 005 and 113s in run 006** — same document,
same models, same host. Run 005's figure was reported earlier as though it meant
something about page density. It did not. Single-run timings on a shared CPU host
are not measurements, and none are quoted as such from here on.

---

## Run 007 — a 3B against a 12B for extraction

**2026-10-09** · 3 fixtures · `deepseek-ocr:3b` transcription for both · `always_vlm`

One variable changed: the model bound to the `extract` role.

| | `llama3.2:3b` | `gemma3:12b` | |
|---|---|---|---|
| Precision | 91.7% | **97.1%** | +5.4pp |
| Recall | 100.0% | 100.0% | — |
| F1 | 95.7% | **98.5%** | +2.9pp |
| Correct | 33 | 33 | no regression |
| Wrong | 0 | 0 | — |
| **Invented** | 3 | **1** | −2 |
| Classification | 100% | 100% | — |
| **Seconds per document** | **116s** | 270s | **2.3× slower** |

`sample-invoice.pdf` — the only fixture not written for this project — went from
95.0% to **100%**.

### What the larger model fixed

Both inventions on that invoice, each a value supplied where the document states
nothing:

```
currency      "USD" → "INR" → null        (the glyph does not render; the page says nothing)
invoiceDate   "2024-03-04" → null         (there is no date anywhere on it)
```

`llama3.2:3b` was told not to guess, in those words, and guessed anyway.
`gemma3:12b` was given the same prompt and did not. Prompt wording had already
been tried twice on exactly these fields (`D-010`); **this was a model problem,
and only a measurement could have told the difference.**

### The one that survived, and a label that deserves scrutiny

Both models return `lineItems[0].amount: 10000` on a document reading *Quantity:
2, Unit Price: 5000.00, Total: 10000.00* with no Amount column.

The ground truth says `null`, so it scores as fabricated. But for a single-line
invoice the line amount genuinely **is** 10000, and a person checking the page
would agree with the model. Two different models arriving at the same answer
independently is weak evidence for the model and against the label.

**This is probably a labelling error, not a model error.** It is recorded rather
than quietly corrected, because a benchmark whose labels are adjusted whenever
they disagree with the output measures nothing. Changing it is a decision to take
deliberately, not while writing up a favourable result.

### Choosing between them

2.3× the latency for 5.4pp of precision, and every point of that difference is
fabrication rather than error. Which is right depends on the use:

- **Review by a person** → `llama3.2:3b`. A fabricated field is caught in the
  review screen, and 116s beats 270s.
- **Unattended, or feeding something downstream** → `gemma3:12b`. An invented
  date that nobody checks is the failure that actually costs money.

That is a decision with numbers behind it rather than a preference, which is the
entire reason the harness exists.

---

## Run 008 — three vision models against the text layer they were replacing

**2026-10-13** · 1 fixture (`sampleinvoice.pdf`, digital, 1 page) · `always_vlm` forced

Not a corpus score. One page, read four ways, because a document extracted on
11 October came back with an invoice number and two dates that are not on it.

| | Characters | % of text layer | Seconds | Kept the boxed fields? |
|---|---|---|---|---|
| **text layer** (`pdfjs`) | **677** | 100% | 0.0 | **yes — exact** |
| `deepseek-ocr:3b` @150 dpi | 626 | 92% | 33.9 | no |
| `deepseek-ocr:3b` @300 dpi | 626 | 92% | 37.3 | no |
| `qwen2.5vl:3b` @150 dpi | 658 | 97% | **219.2** | partly, scrambled |
| `granite3.2-vision` @150 dpi | 1473 | **218%** | — | no — degenerated |

### What the page holds and what each model did with it

The invoice carries two boxed tables: a key/value block top right (`Invoice
Number INV-3337`, `Order Number 12345`, both dates, `Total Due $93.50`) and a
totals block under the line item (`Sub Total $85.00`, `Tax $8.50`, `Total
$93.50`).

`deepseek-ocr:3b` **dropped both entirely** while transcribing the line-item
table correctly as markdown. It can do tables; it did not do these.

`qwen2.5vl:3b` found them and destroyed their structure, reading the box down
its columns rather than across its rows:

```
Invoice Number        12345
Order Number          January 25, 2016
Invoice Date          January 31, 2016
Due Date              $93.50
Total Due
```

Five labels, four values, `INV-3337` missing altogether. **This is worse than
dropping the block.** An extract model reading that will confidently pair
*Invoice Number → 12345*, and nothing downstream can tell that the pairing is an
artefact of the transcription.

`granite3.2-vision` misread `123 Somewhere Street` as `1233 Snowwhere Street`
and then repeated it 27 times until it hit the token cap — 218% of the real text.
A degeneration loop, which is the failure `eval/robustness.ts` was written to
count.

### DPI is not the lever

150 and 300 dpi produced **byte-identical output** from `deepseek-ocr:3b`. The
dropped content is not too small to see; the model is not looking at it. Four
extra seconds bought nothing, and the obvious first guess was wrong.

### What it cost downstream

The stored extraction, from the 626-character transcription:

```
invoiceNumber  "INV001"      (page says INV-3337 — not in the transcription)
invoiceDate    "2024-03-04"  (page says January 25, 2016 — not in it either)
dueDate        "2024-03-04"  (same invented value twice)
total          85            (page says 93.50; 85 was the only figure present)
taxTotal       null          (page says 8.50)
vendor.taxId   "1234 1234"   (that is the bank account number, ACC #)
```

Thirteen fields correct, four invented, one wrong, two missed. **Every correct
field was present in the transcription and every incorrect one was absent** —
which locates the fault in transcription, not extraction, and is only visible
because the raw text is stored beside the result.

Three re-runs produced 626 characters every time. At temperature 0 this is
deterministic: retrying the same configuration cannot help.

### What this settles

A vision model is a worse reader of a digital PDF than the parser that was
already there, on accuracy and by two orders of magnitude on latency. `always_vlm`
was set to exercise the vision path during development and had quietly become the
reason a readable invoice produced invented data. See `D-017`.

### What it does not settle

Nothing here says which model is best on a **scan**, where there is no text layer
to beat. Both failures were layout rather than character recognition, so the next
variable to move is the OCR prompt, not the model.

---

## Run 009 — ten documents through the application, not the harness

**2026-10-14** · 5 invoices · 5 résumés · `auto` · `deepseek-ocr:3b` / `llama3.2:3b` / `gemma3:12b`

Submitted through the upload API rather than the eval CLI, which is why this run
found things the harness cannot: the harness calls the engine directly, so it
exercises no queue, no worker and no database write.

| | Outcome |
|---|---|
| Completed with data | 7 of 10 |
| Lost extraction to connection failures | 2 |
| Failed outright on a database write | 1 |
| Classification | 10 of 10 correct |

### Two defects, both invisible to the harness

**A NUL byte made a document unstorable.** `resume.pdf` failed on `persist`:
`invalid byte sequence for encoding "UTF8": 0x00`, retried five times, after
thirty-six minutes of model work. Its text layer holds two NUL bytes where a star
glyph maps to U+0000 in `8.2k ★ on GitHub`. Fixed at the point text enters the
system; the document now completes at 3562 characters where the raw text had 3564.

**Ten uploads meant ten simultaneous requests to one inference host.** The worker
had no concurrency limit.

```
alone                    ~210 s per document
ten at once      298 s · 432 s · 620 s · 855 s · 1518 s · 2191 s · 2192 s · 2912 s · 5906 s
```

Two of the ten — `invoice_Vivek` and `jakeresume` — exhausted all three attempts
with *Could not connect to the inference host* **while the box was up and
serving**. Both complete on a retry with the cap in place.

### The result that matters more than either

Two SuperStore invoices, same template, same model, same prompt, temperature 0:

| | Vivek · $9,999.94 | Aaron · $48.71 |
|---|---|---|
| `discount` / `shipping` | **999.99 / 118.26** | `null` / `null` |
| line items | **1, correct** | 3 — category row and an undescribed row |
| category subtitle | ignored correctly | became a line item |
| `extraFields` | Ship To, Ship Mode, Order ID | none |
| `subtotal` | wrong — copied the total | wrong — copied the total |
| `invoiceDate` | `2012-04-07` | `Mar 06 2012` |

Aaron's run was repeated alone, uncontended, and came back identical — so this is
not contention. Two documents that differ only in their numbers produce opposite
structural behaviour, and even the date format differs.

**Extraction quality at this scale is not reliably steerable by schema or prompt.
Detection is.** Of the five invoices, the three wrong ones were flagged
`needs_review` with true, specific reasons and the two correct ones were not:

```
The totals do not reconcile: subtotal 9118.21 + shipping 118.26 − discount 999.99
comes to 8236.48, but the total reads 9118.21.
The line items add up to 9999.94, but the subtotal reads 9118.21.
```

Two independent rules, both true, both pointing at the single wrong field. That
asymmetry holds whichever model is bound, which is why `D-018` puts the effort
there rather than into prompt wording.

### A third finding, unfixed

`Sample Vendor Invoice` has no subtotal and three line items — 462.00, 35.50,
70.00 against a total of 567.50. The amounts came back on the wrong rows: Linens
got 70.00, Aprons got `null`. The text layer emits the amount column before the
descriptions, so reading order and visual order disagree, and the model paired
them in the order it received them.

A text layer is exact about characters and says nothing about layout. The project
already knew a text layer can be wrong (`AIR_I NDIA` in the README); this is the
sharper version — it can be right about every character and wrong about every
relationship. Position-aware extraction would fix it and is not attempted here.

### Not settled

Whether the résumé extractions are accurate. Four of five completed and were read
by eye, but there is still no résumé fixture and no labels, so none of it is
scored. The harness measures invoices only.

---

## Run 010 — the corpus more than doubles, and the score falls by 25 points

**2026-10-14** · 7 invoice fixtures · `auto` · `deepseek-ocr:3b` / `llama3.2:3b` / `gemma3:12b`

| Fixture | F1 | |
|---|---|---|
| `tiny-invoice` | 100.0% | |
| `sample-invoice` | 97.4% | |
| `simple-invoice` | 94.7% | |
| `superstore-22902` | 87.8% | 1 wrong · 3 invented |
| `sliced-inv-3337` | 60.9% | 4 wrong · 5 invented · 5 missed |
| `superstore-36258` | 51.4% | 2 wrong · 5 invented · 8 missed |
| `vendor-laundry-invoice` | **42.1%** | 5 wrong · 9 invented · 3 missed |

```
precision 69.5%   recall 74.5%   F1 71.9%
82 correct · 12 wrong · 24 invented · 16 missed
classification 100%
```

### The headline is that the old headline was wrong

Runs 005 to 009 reported 94.7% to 98.5% on three fixtures. Four documents later
the same code on the same models scores **71.9%**. Nothing regressed — the three
original fixtures score exactly what they scored before. The corpus was the
measurement.

Two of the three were written for this project, which is the quiet way a corpus
becomes a mirror: documents that exercise the paths the author had in mind. The
four added here were not. The laundry invoice prints no subtotal and writes its
quantities inside the description text; the two SuperStore invoices carry a
discount, a shipping line and a category subtitle under each item.

**A benchmark that only contains documents the system handles is not a benchmark.**
This is the first number in this file that would survive a stranger's scrutiny,
and it is twenty-five points worse than the one it replaces.

### What the new fixtures actually fail at

Not transcription. Every one of these has a clean text layer, and `auto` mode
read all seven exactly. The failures are structural:

- **`subtotal` copied from the total**, on both SuperStore invoices and in the
  earlier UI runs. The single most repeated error in the corpus.
- **Totals rows read as purchases.** `superstore-36258` returned three line items
  for a one-item invoice, one of them with an amount and no description.
- **Amounts paired with the wrong descriptions** on the laundry invoice, because
  the text layer emits the amount column before the descriptions.
- **Dates left unnormalised** — `January 25, 2016` where the prompt asks for ISO.

### A scoring defect found while reading the results

`sliced-inv-3337` first scored 56.5% with 7 fields wrong. Only two were real.
`extraFields` is an unordered bag of labelled values and the scorer compared it
by index, so one extra entry at position 0 cascaded into every field after it.

Keyed by label instead, the same stored run scores **71.9%** rather than 69.3%,
and `superstore-22902` moves from 78.0% to 87.8%. **No model ran to establish
that** — scoring never calls one, which is why `run` and `score` are separate.

### Still unmeasured

Résumés. Seven fixtures, all invoices. Labelling a résumé means transcribing
every bullet exactly, and a wrong label is worse than no label, so the type is
still read by eye rather than scored.
