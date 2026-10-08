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
